/**
 * SLF 데이터 로더.
 *
 * gallery/<name>/meta.json     - H, W, degree, coeff_min, coeff_max, ac_coeff_min, ac_coeff_max,
 *                                 u_extent, v_extent
 * gallery/<name>/k00.ktx2      - KTX2/UASTC, 단일 레이어 (DC 미리보기, u_k0)
 * gallery/<name>/coeffs.ktx2   - KTX2/UASTC, K개 레이어 텍스처 배열 (k00~k{K-1} 전체, u_coeffs)
 *
 * 둘 다 surface-light-fields-for-planar-paintings 쪽에서 sh_pngs/ 저장 시 basisu로
 * 미리 만들어두는 것을 전제로 한다 — scripts/convert_to_web.py가 그대로 복사해올 뿐,
 * SLF_web_gallery는 압축을 직접 하지 않는다. PNG 폴백은 지원하지 않으므로(구형 브라우저
 * 미대응) KTX2 트랜스코딩을 지원하지 않는 환경에서는 로드가 실패한다.
 *
 * 텍스처에는 [0,1] 정규화 값만 담고, 실제 계수 범위로의 환산은 slfShader.js의
 * u_coeff_min/u_coeff_range(k00)와 u_coeff_min_ac/u_coeff_range_ac(k01+)가 수행한다.
 */

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

/** ktx2Loader.load를 Promise화. onProgress는 THREE.FileLoader의 바이트 단위 진행률 이벤트를 그대로 전달한다. */
function loadKTX2(ktx2Loader, url, onProgress) {
  return new Promise((resolve, reject) => {
    ktx2Loader.load(url, resolve, onProgress, reject);
  });
}

// 같은 basePath(전시 중 동일 작품을 여러 벽면에 중복으로 거는 경우)를 여러 번 요청해도
// 실제 fetch + KTX2 트랜스코딩은 한 번만 하고 결과 텍스처를 공유하기 위한 캐시.
// 값은 Promise 자체를 저장해, 동시에 들어온 중복 요청도 하나의 인플라이트 작업을 같이 기다린다.
const _dcCache   = new Map(); // basePath -> Promise<{ textures, meta, K }>
const _fullCache = new Map(); // basePath -> Promise<{ coeffs, meta, K }>

/**
 * @param {string} basePath  '/gallery/<name>'
 * @param {THREE.WebGLRenderer} renderer  KTX2 트랜스코딩에 필요 (PNG 폴백 없음).
 * @returns {Promise<{ textures: THREE.CompressedTexture[], meta: object, K: number }>}
 */
/** meta + k00만 로드 (즉시 표시용). 같은 basePath가 여러 번 걸리면(중복 전시) 캐시를 공유한다. */
export function loadSLFPaintingDC(basePath, renderer) {
  if (_dcCache.has(basePath)) return _dcCache.get(basePath);

  const promise = (async () => {
    const meta = await fetch(`${basePath}/meta.json`).then(r => {
      if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
      return r.json();
    });
    const { degree } = meta;
    const K = (degree + 1) ** 2;

    const ktx2Loader = getKTX2Loader(renderer);
    if (!ktx2Loader) throw new Error('KTX2 트랜스코딩을 지원하지 않는 환경입니다 (renderer 필요).');

    const k0 = await loadKTX2(ktx2Loader, `${basePath}/k00.ktx2`);
    return { textures: [k0], meta, K };
  })();

  _dcCache.set(basePath, promise);
  return promise;
}

/**
 * 전체 SLF(coeffs.ktx2, K-레이어 텍스처 배열) 로드.
 * @returns {Promise<{ coeffs: THREE.CompressedArrayTexture, meta: object, K: number }>}
 */
export function loadSLFPainting(basePath, onProgress, renderer) {
  // 이미 같은 작품이 캐시돼 있으면(중복 전시) 재다운로드/재트랜스코딩 없이 텍스처를
  // 공유한다 — 진행 중이 아니므로 HUD 진행률은 즉시 100%로 알린다.
  if (_fullCache.has(basePath)) {
    return _fullCache.get(basePath).then(result => {
      onProgress?.(1, 1);
      return result;
    });
  }

  const promise = (async () => {
    const meta = await fetch(`${basePath}/meta.json`).then(r => {
      if (!r.ok) throw new Error(`meta.json not found at ${basePath}`);
      return r.json();
    });
    const { degree } = meta;
    const K = (degree + 1) ** 2;

    const ktx2Loader = getKTX2Loader(renderer);
    if (!ktx2Loader) throw new Error('KTX2 트랜스코딩을 지원하지 않는 환경입니다 (renderer 필요).');

    // coeffs.ktx2는 파일 하나에 K개 레이어를 전부 담고 있어 로드 완료 전까지는 "몇 개 중
    // 몇 개"를 알 수 없으므로, 대신 바이트 다운로드 진행률로 HUD 진행 표시를 대체한다.
    const coeffs = await loadKTX2(ktx2Loader, `${basePath}/coeffs.ktx2`, evt => {
      if (evt.total) onProgress?.(evt.loaded, evt.total);
    });

    return { coeffs, meta, K };
  })();

  _fullCache.set(basePath, promise);
  return promise;
}
