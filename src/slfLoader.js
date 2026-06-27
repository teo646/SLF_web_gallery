/**
 * SLF 데이터 로더.
 *
 * gallery/<name>/meta.json  - H, W, degree, coeff_min, coeff_max
 * gallery/<name>/k00.png … k{K-1}.png  - 16-bit RGB PNG (float32 계수 인코딩)
 *
 * cv2 imwrite는 BGR→RGB 변환 후 PNG에 저장하므로,
 * fast-png가 읽은 채널 순서 [R, G, B]가 곧 [R_coeff, G_coeff, B_coeff].
 */

import * as THREE from 'three';
import { decode } from 'fast-png';

/**
 * @param {string} basePath  '/gallery/<name>'
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<{ textures: THREE.DataTexture[], meta: object, K: number }>}
 */
/** meta + k00만 로드 (즉시 표시용) */
export async function loadSLFPaintingDC(basePath) {
  const meta = await fetch(`${basePath}/meta.json`).then(r => {
    if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
    return r.json();
  });
  const { H, W, degree, coeff_min = -8.0, coeff_max = 8.0 } = meta;
  const K  = (degree + 1) ** 2;
  const k0 = await loadCoeffTexture(`${basePath}/k00.png`, W, H, coeff_min, coeff_max);
  return { textures: [k0], meta, K };
}

export async function loadSLFPainting(basePath, onProgress) {
  const meta = await fetch(`${basePath}/meta.json`).then(r => {
    if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
    return r.json();
  });

  const {
    H, W, degree,
    coeff_min = -8.0,
    coeff_max =  8.0,
  } = meta;

  const K = (degree + 1) ** 2;
  let loaded = 0;

  const textures = await Promise.all(
    Array.from({ length: K }, (_, k) => {
      const url = `${basePath}/k${String(k).padStart(2, '0')}.png`;
      return loadCoeffTexture(url, W, H, coeff_min, coeff_max).then(tex => {
        loaded++;
        onProgress?.(loaded, K);
        return tex;
      });
    })
  );

  return { textures, meta, K };
}

/**
 * 16-bit RGB PNG → THREE.DataTexture (FloatType, RGBAFormat)
 * float32[i*4+c] = uint16[i*3+c] / 65535 * (max - min) + min
 */
async function loadCoeffTexture(url, W, H, coeff_min, coeff_max) {
  const buf = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`PNG fetch failed: ${url}`);
    return r.arrayBuffer();
  });

  const img = decode(buf);
  const { width, height, data, channels, depth } = img;

  // data は Uint16Array (depth=16) または Uint8Array (depth=8)
  const maxVal = depth === 16 ? 65535 : 255;
  const range  = coeff_max - coeff_min;

  const float32 = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const dst = (row * width + col) * 4;
      const src = (row * width + col) * channels;
      float32[dst + 0] = data[src + 0] / maxVal * range + coeff_min; // R
      float32[dst + 1] = data[src + 1] / maxVal * range + coeff_min; // G
      float32[dst + 2] = data[src + 2] / maxVal * range + coeff_min; // B
      // float32[dst + 3] = 0  (alpha, unused)
    }
  }

  const tex = new THREE.DataTexture(
    float32, width, height,
    THREE.RGBAFormat, THREE.FloatType,
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
