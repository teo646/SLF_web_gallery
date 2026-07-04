/**
 * SLF 데이터 로더.
 *
 * gallery/<name>/meta.json  - H, W, degree, coeff_min, coeff_max,
 *                              num_steps, u_extent, v_extent, has_parallax,
 *                              parallax_min, parallax_max
 * gallery/<name>/k00.png … k{K-1}.png  - 16-bit RGB PNG (float32 계수 인코딩)
 * gallery/<name>/parallax.png          - 16-bit 단일채널 PNG (n_z·h 인코딩, has_parallax일 때만)
 * gallery/<name>/k00.ktx2 … / parallax.ktx2 - 위 PNG들을 8bit로 재양자화해 KTX2(UASTC)로
 *                              압축한 버전(scripts/build-ktx2.mjs). 있으면 우선 사용하고,
 *                              트랜스코딩 미지원 브라우저거나 파일이 없으면 PNG로 폴백한다.
 *
 * cv2 imwrite는 BGR→RGB 변환 후 PNG에 저장하므로,
 * fast-png가 읽은 채널 순서 [R, G, B]가 곧 [R_coeff, G_coeff, B_coeff].
 *
 * 두 경로 모두 텍스처에는 [0,1] 정규화 값만 담고, 실제 계수/parallax 범위로의 환산은
 * slfShader.js의 u_coeff_min/u_coeff_range(, u_parallax_min/u_parallax_range)가 수행한다.
 */

import * as THREE from 'three';
import { decode } from 'fast-png';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

// KTX2Loader는 렌더러당 하나만 두고 재사용한다(워커 풀을 매번 새로 만들지 않기 위해).
let _ktx2Loader   = null;
let _ktx2Renderer = null;

function getKTX2Loader(renderer) {
  if (!renderer) return null;
  if (_ktx2Loader && _ktx2Renderer === renderer) return _ktx2Loader;
  _ktx2Loader?.dispose();
  _ktx2Loader = new KTX2Loader()
    .setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)
    .detectSupport(renderer);
  _ktx2Renderer = renderer;
  return _ktx2Loader;
}

/** ktx2Loader.load를 Promise화. 파일이 없거나(404) 트랜스코딩 실패 시 null로 resolve(→ PNG 폴백). */
function loadKTX2(ktx2Loader, url) {
  return new Promise(resolve => {
    ktx2Loader.load(url, resolve, undefined, () => resolve(null));
  });
}

/**
 * @param {string} basePath  '/gallery/<name>'
 * @param {THREE.WebGLRenderer} [renderer]  KTX2(압축 텍스처) 지원 감지용. 없으면 PNG만 사용.
 * @returns {Promise<{ textures: THREE.Texture[], meta: object, K: number }>}
 */
/** meta + k00만 로드 (즉시 표시용) */
export async function loadSLFPaintingDC(basePath, renderer) {
  const meta = await fetch(`${basePath}/meta.json`).then(r => {
    if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
    return r.json();
  });
  const { degree } = meta;
  const K  = (degree + 1) ** 2;
  const k0 = await loadCoeffTexture(`${basePath}/k00`, renderer);
  return { textures: [k0], meta, K };
}

export async function loadSLFPainting(basePath, onProgress, renderer) {
  const meta = await fetch(`${basePath}/meta.json`).then(r => {
    if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
    return r.json();
  });

  const { degree, has_parallax = false } = meta;
  const K = (degree + 1) ** 2;
  let loaded = 0;

  const texturesPromise = Promise.all(
    Array.from({ length: K }, (_, k) => {
      const base = `${basePath}/k${String(k).padStart(2, '0')}`;
      return loadCoeffTexture(base, renderer).then(tex => {
        loaded++;
        onProgress?.(loaded, K);
        return tex;
      });
    })
  );

  // parallax map은 진행률 계산에 포함하지 않는다 — 단일 채널 텍스처라 로드가 빠르다.
  const parallaxPromise = has_parallax
    ? loadParallaxTexture(`${basePath}/parallax`, renderer)
    : Promise.resolve(null);

  const [textures, parallaxTex] = await Promise.all([texturesPromise, parallaxPromise]);

  return { textures, meta, K, parallaxTex };
}

/**
 * `${base}.ktx2`(KTX2/UASTC, 지원 시) 또는 `${base}.png`(16-bit RGB, 폴백)를 로드해
 * [0,1] 정규화 값의 텍스처로 반환한다.
 */
async function loadCoeffTexture(base, renderer) {
  const ktx2Loader = getKTX2Loader(renderer);
  if (ktx2Loader) {
    const tex = await loadKTX2(ktx2Loader, `${base}.ktx2`);
    if (tex) {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }
  }
  return loadCoeffTexturePNG(`${base}.png`);
}

/** 16-bit RGB PNG → THREE.DataTexture (FloatType, RGBAFormat), 값은 [0,1] 정규화 상태로 둔다. */
async function loadCoeffTexturePNG(url) {
  const buf = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`PNG fetch failed: ${url}`);
    return r.arrayBuffer();
  });

  const img = decode(buf);
  const { width, height, data, channels, depth } = img;

  // data は Uint16Array (depth=16) または Uint8Array (depth=8)
  const maxVal = depth === 16 ? 65535 : 255;

  const float32 = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const dst = (row * width + col) * 4;
      const src = (row * width + col) * channels;
      float32[dst + 0] = data[src + 0] / maxVal; // R
      float32[dst + 1] = data[src + 1] / maxVal; // G
      float32[dst + 2] = data[src + 2] / maxVal; // B
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

/**
 * `${base}.ktx2`(지원 시) 또는 `${base}.png`(폴백)에서 parallax mapping의
 * u_parallax_map(= n_z·h, world 단위) 텍스처를 만든다. 값은 [0,1] 정규화 상태로 둔다.
 * render.py의 build_parallax_map_texture와 동일한 값을 인코딩한 것을 복원한다.
 */
async function loadParallaxTexture(base, renderer) {
  const ktx2Loader = getKTX2Loader(renderer);
  if (ktx2Loader) {
    const tex = await loadKTX2(ktx2Loader, `${base}.ktx2`);
    if (tex) {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }
  }
  return loadParallaxTexturePNG(`${base}.png`);
}

async function loadParallaxTexturePNG(url) {
  const buf = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`PNG fetch failed: ${url}`);
    return r.arrayBuffer();
  });

  const img = decode(buf);
  const { width, height, data, channels, depth } = img;

  const maxVal = depth === 16 ? 65535 : 255;

  const float32 = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    float32[i] = data[i * channels] / maxVal;
  }

  const tex = new THREE.DataTexture(
    float32, width, height,
    THREE.RedFormat, THREE.FloatType,
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
