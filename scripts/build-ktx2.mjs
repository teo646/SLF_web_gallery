#!/usr/bin/env node
/**
 * public/gallery/<name>/{k00..k(K-1)}.png, parallax.png (16-bit) 을
 * 모바일에서 GPU가 직접 압축 해제할 수 있는 KTX2(UASTC) 텍스처로 추가 변환한다.
 *
 * 원본 16-bit PNG는 그대로 남겨두고(구형 브라우저/트랜스코딩 미지원 시 폴백),
 * 같은 폴더에 k00.ktx2 … / parallax.ktx2 를 나란히 생성한다.
 *
 * 계수 데이터는 색이 아니라 SH 계수를 8bit로 재양자화한 값이므로 basisu에
 * -linear 를 지정해 sRGB 감마 보정이 끼어들지 않게 한다.
 *
 * Usage:
 *   node scripts/build-ktx2.mjs [name ...]   # 생략 시 gallery 전체
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
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
  return join(
    dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'basisu', 'bin',
    platform, sse ? `${arch}_sse` : arch,
    platform === 'win' ? 'basisu.exe' : 'basisu',
  );
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

function convertOne(srcPng, dstKtx2) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ktx2-'));
  const tmpPng = join(tmpDir, 'in.png');
  try {
    writeFileSync(tmpPng, requantizeTo8bit(srcPng));
    execFileSync(BASISU, [
      '-ktx2', '-uastc', '-uastc_level', '2', '-linear', '-no_alpha',
      '-file', tmpPng,
      '-output_file', dstKtx2,
    ], { stdio: 'pipe' });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
  let beforeTotal = 0, afterTotal = 0;

  for (let k = 0; k < K; k++) {
    const base = `k${String(k).padStart(2, '0')}`;
    const srcPng = join(dir, `${base}.png`);
    const dstKtx2 = join(dir, `${base}.ktx2`);
    convertOne(srcPng, dstKtx2);
    beforeTotal += fileSize(srcPng);
    afterTotal += fileSize(dstKtx2);
    console.log(`[${name}] ${base}.png (${(fileSize(srcPng)/1e6).toFixed(1)}MB) → ${base}.ktx2 (${(fileSize(dstKtx2)/1e6).toFixed(1)}MB)`);
  }

  if (meta.has_parallax) {
    const srcPng = join(dir, 'parallax.png');
    const dstKtx2 = join(dir, 'parallax.ktx2');
    convertOne(srcPng, dstKtx2);
    beforeTotal += fileSize(srcPng);
    afterTotal += fileSize(dstKtx2);
    console.log(`[${name}] parallax.png (${(fileSize(srcPng)/1e6).toFixed(1)}MB) → parallax.ktx2 (${(fileSize(dstKtx2)/1e6).toFixed(1)}MB)`);
  }

  console.log(`[${name}] 합계: ${(beforeTotal/1e6).toFixed(1)}MB → ${(afterTotal/1e6).toFixed(1)}MB (${(100 * afterTotal / beforeTotal).toFixed(0)}%)`);
}

function main() {
  const names = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : readdirSync(GALLERY_DIR).filter(n => statSync(join(GALLERY_DIR, n)).isDirectory());

  for (const name of names) convertPainting(name);
}

main();
