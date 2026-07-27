#!/usr/bin/env node
/**
 * public/gallery/<name>/{k00..k(K-1)}.png (16-bit) 을 모바일에서 GPU가 직접 압축 해제할 수
 * 있는 KTX2(UASTC) 텍스처로 변환한다:
 *
 *   k00.ktx2      - k00 단독, 단일 레이어 (DC 미리보기용, u_k0)
 *   coeffs.ktx2   - k00 ~ k{K-1} 전체를 K개 레이어로 묶은 텍스처 배열 (전체 SLF 렌더링용,
 *                   slfShader.js의 sampler2DArray u_coeffs가 그대로 대응)
 *
 * PNG 폴백은 지원하지 않으므로(구형 브라우저 미대응, slfLoader.js도 KTX2만 읽는다) 변환에
 * 성공하면 원본 k*.png는 지운다 — public/gallery/에는 최종적으로 KTX2만 남는다.
 *
 * 계수 데이터는 색이 아니라 SH 계수를 8bit로 재양자화한 값이므로 basisu에 -linear 를
 * 지정해 sRGB 감마 보정이 끼어들지 않게 한다.
 *
 * Usage:
 *   python scripts/convert_to_web.py <outputs 폴더>   # k00.png ... 를 먼저 받아온다
 *   node scripts/build-ktx2.mjs [name ...]            # 생략 시 gallery 전체
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { decode, encode } from 'fast-png';
import cpuFeatures from 'cpu-features';

const GALLERY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'gallery');

function resolveBasisuBinary() {
  let platform = os.platform();
  if (platform === 'win32') platform = 'win';
  if (!['linux', 'win', 'darwin'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const arch = os.arch();
  const sse = cpuFeatures().flags.sse4_1 === true;
  const binPath = join(
    dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'basisu', 'bin',
    platform, sse ? `${arch}_sse` : arch,
    platform === 'win' ? 'basisu.exe' : 'basisu',
  );
  // npm install 후 실행 권한이 풀려있는 경우가 있다(basisu 패키지 자체의 bin/basisu.js도
  // 실행 전 동일하게 방어적으로 chmod한다).
  if (platform !== 'win') chmodSync(binPath, 0o755);
  return binPath;
}

const BASISU = resolveBasisuBinary();

/**
 * UASTC/ETC1S는 4x4 블록 압축이라 가로/세로가 4의 배수가 아니면 three.js KTX2Loader가
 * "should use multiple-of-four dimensions" 경고를 내고 텍스처가 깨진다. 오른쪽/아래쪽에
 * 가장자리 픽셀을 복제(edge-clamp)해 다음 4의 배수까지 채운다 — uv(0~1)는 meta.W/H
 * 기준 그대로라 몇 픽셀 안 되는 패딩 영역은 우측/하단 끝에서만 미세하게 늘어나 보일 뿐이다.
 */
function padToMultipleOf4(width, height, data, channels) {
  const padW = Math.ceil(width  / 4) * 4;
  const padH = Math.ceil(height / 4) * 4;
  if (padW === width && padH === height) return { width, height, data };

  const out = new Uint8Array(padW * padH * channels);
  for (let row = 0; row < padH; row++) {
    const srcRow = Math.min(row, height - 1);
    for (let col = 0; col < padW; col++) {
      const srcCol = Math.min(col, width - 1);
      const srcOff = (srcRow * width + srcCol) * channels;
      const dstOff = (row * padW + col) * channels;
      for (let c = 0; c < channels; c++) out[dstOff + c] = data[srcOff + c];
    }
  }
  return { width: padW, height: padH, data: out };
}

/** 16-bit(또는 8-bit) PNG → 4의 배수 크기로 패딩된 8-bit PNG 버퍼로 재양자화 (basisu 입력용) */
function requantizeTo8bit(srcPath) {
  const { width, height, data, channels, depth } = decode(readFileSync(srcPath));
  const maxVal = depth === 16 ? 65535 : 255;
  const quantized = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height * channels; i++) {
    quantized[i] = Math.round((data[i] / maxVal) * 255);
  }
  const padded = padToMultipleOf4(width, height, quantized, channels);
  return encode({ width: padded.width, height: padded.height, data: padded.data, depth: 8, channels });
}

function runBasisu(args) {
  execFileSync(BASISU, args, { stdio: 'pipe' });
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function convertPainting(name) {
  const dir = join(GALLERY_DIR, name);
  const metaPath = join(dir, 'meta.json');
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    console.warn(`[skip] ${name}: meta.json 없음`);
    return;
  }

  const K = (meta.degree + 1) ** 2;
  const srcPngs = Array.from({ length: K }, (_, k) => join(dir, `k${String(k).padStart(2, '0')}.png`));
  const missing = srcPngs.filter(p => fileSize(p) === 0);
  if (missing.length > 0) {
    console.warn(`[skip] ${name}: PNG 없음 — ${missing.join(', ')}`);
    return;
  }

  const commonArgs = ['-ktx2', '-uastc', '-uastc_level', '2', '-linear', '-no_alpha'];
  const beforeTotal = srcPngs.reduce((sum, p) => sum + fileSize(p), 0);

  const tmpDir = mkdtempSync(join(tmpdir(), 'ktx2-'));
  try {
    const tmpPngs = srcPngs.map((srcPng, k) => {
      const tmpPng = join(tmpDir, `k${String(k).padStart(2, '0')}.png`);
      writeFileSync(tmpPng, requantizeTo8bit(srcPng));
      return tmpPng;
    });

    const k00Ktx2 = join(dir, 'k00.ktx2');
    runBasisu([...commonArgs, '-file', tmpPngs[0], '-output_file', k00Ktx2]);
    console.log(`[${name}] k00.png (${(fileSize(srcPngs[0])/1e6).toFixed(1)}MB) → k00.ktx2 (${(fileSize(k00Ktx2)/1e6).toFixed(1)}MB)`);

    const coeffsKtx2 = join(dir, 'coeffs.ktx2');
    const fileArgs = tmpPngs.flatMap(p => ['-file', p]);
    runBasisu([...commonArgs, '-tex_type', '2darray', ...fileArgs, '-output_file', coeffsKtx2]);
    console.log(`[${name}] ${K}개 레이어 (${(beforeTotal/1e6).toFixed(1)}MB) → coeffs.ktx2 (${(fileSize(coeffsKtx2)/1e6).toFixed(1)}MB)`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // PNG 폴백은 지원하지 않는다(slfLoader.js는 KTX2만 읽는다) — 변환에 성공했으니 원본은 지운다.
  for (const p of srcPngs) unlinkSync(p);

  const afterTotal = fileSize(join(dir, 'k00.ktx2')) + fileSize(join(dir, 'coeffs.ktx2'));
  console.log(`[${name}] 합계: ${(beforeTotal/1e6).toFixed(1)}MB → ${(afterTotal/1e6).toFixed(1)}MB (${(100 * afterTotal / beforeTotal).toFixed(0)}%)`);
}

function main() {
  const names = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : readdirSync(GALLERY_DIR).filter(n => statSync(join(GALLERY_DIR, n)).isDirectory());

  for (const name of names) convertPainting(name);
}

main();
