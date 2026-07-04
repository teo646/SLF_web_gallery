/**
 * SLF(SH 계수 + parallax) 렌더링에 쓰이는 GLSL 셰이더 빌더.
 * gallery(viewer.js)와 단일 그림 뷰어(paintingViewer.js)가 공유한다.
 */

// ── SH 상수 ─────────────────────────────────────────────────────────────────

const _C0 = 0.28209479177387814;
const _C1 = 0.4886025119029199;
const _C2 = [ 1.0925484305920792, -1.0925484305920792,  0.31539156525252005,
             -1.0925484305920792,  0.5462742152960396];
const _C3 = [-0.5900435899266435,  2.890611442640554,  -0.4570457994644658,
              0.3731763325901154, -0.4570457994644658,   1.445305721320277,
             -0.5900435899266435];

export const VERT = `
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// surface-light-fields-for-planar-paintings/src/render.py의 RESOLVE(resolve_uv)와 동일한
// parallax mapping. v_frag_pos(=pix_pos)는 고정한 채, 텍스처를 샘플링하는 uv만 반복 보정한다
// — 두 구현이 같은 grid에 대해 학습됐으므로 공식이 정확히 일치해야 한다. numSteps=0이면
// 이 블록 전체가 생성되지 않아 v_uv를 그대로 쓰는 예전 동작(평면 렌더링)과 같다.
export function buildFragShader(K, dcOnly = false, numSteps = 0) {
  const degree = Math.round(Math.sqrt(K)) - 1;
  const useParallax = !dcOnly && numSteps > 0;

  // dcOnly 모드에서는 u_k0만 선언 (나머지는 미로드 상태일 수 있음)
  const samplerDecls = Array.from({ length: dcOnly ? 1 : K }, (_, k) =>
    `uniform sampler2D u_k${k};`
  ).join('\n');

  const constLines = [
    `const float C0  = ${_C0};`,
    `const float C1  = ${_C1};`,
  ];
  if (degree >= 2) _C2.forEach((v, i) => constLines.push(`const float C2${i} = ${v};`));
  if (degree >= 3) _C3.forEach((v, i) => constLines.push(`const float C3${i} = ${v};`));

  const basisLines = ['float Y0 = C0;'];
  if (K > 1) {
    basisLines.push('float Y1 = -C1 * yr;');
    basisLines.push('float Y2 =  C1 * zr;');
    basisLines.push('float Y3 = -C1 * xr;');
  }
  if (K > 4) {
    basisLines.push('float Y4 = C20 * xr * yr;');
    basisLines.push('float Y5 = C21 * yr * zr;');
    basisLines.push('float Y6 = C22 * (2.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y7 = C23 * xr * zr;');
    basisLines.push('float Y8 = C24 * (xr*xr - yr*yr);');
  }
  if (K > 9) {
    basisLines.push('float Y9  = C30 * yr * (3.0*xr*xr - yr*yr);');
    basisLines.push('float Y10 = C31 * xr * yr * zr;');
    basisLines.push('float Y11 = C32 * yr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y12 = C33 * zr * (2.0*zr*zr - 3.0*xr*xr - 3.0*yr*yr);');
    basisLines.push('float Y13 = C34 * xr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y14 = C35 * zr * (xr*xr - yr*yr);');
    basisLines.push('float Y15 = C36 * xr * (xr*xr - 3.0*yr*yr);');
  }

  // 텍스처는 [0,1] 정규화 값(PNG 폴백이든 KTX2/UASTC 트랜스코딩이든 동일)만 담고 있으므로,
  // 실제 SH 계수 범위로의 환산(coeff_min ~ coeff_max)은 항상 셰이더에서 수행한다.
  const terms = Array.from({ length: dcOnly ? 1 : K }, (_, k) =>
    `    ${k === 0 ? '' : '+ '}Y${k} * (texture(u_k${k}, uv).rgb * u_coeff_range + u_coeff_min)`
  ).join('\n');

  // p_xy(=n_z·h, world 단위)를 u_uv_per_length(=1/u_extent, 1/v_extent)로 uv 변위로 환산.
  // 부호는 render.py의 resolve_uv와 동일하게 +1로 고정(실제 사진과 오버레이해 확정된 값).
  const parallaxDecl = useParallax ? `
uniform sampler2D u_parallax_map;
uniform vec2      u_uv_per_length;
uniform float     u_parallax_min;
uniform float     u_parallax_range;

vec2 resolve_uv(vec2 uv0, vec2 uv_est, vec2 view_xy) {
  float p_xy = texture(u_parallax_map, uv_est).r * u_parallax_range + u_parallax_min;
  return uv0 + p_xy * view_xy * u_uv_per_length;
}
` : '';

  const parallaxLoop = useParallax
    ? `for (int s = 0; s < ${numSteps}; s++) { uv = resolve_uv(v_uv, uv, d.xy); }`
    : '';

  return `precision highp float;
precision highp sampler2D;

${constLines.join('\n')}

${samplerDecls}
uniform vec3  u_cam_local;
uniform float u_aspect;
uniform float u_coeff_min;
uniform float u_coeff_range;
${parallaxDecl}
in  vec2 v_uv;
out vec4 fragColor;

void main() {
  vec3 pix_pos = vec3((v_uv - 0.5) * vec2(u_aspect, 1.0), 0.0);
  vec3 d = normalize(u_cam_local - pix_pos);

  vec2 uv = v_uv;
  ${parallaxLoop}
  uv = clamp(uv, 0.0, 1.0);

  float z0 = clamp(d.z, 0.0, 1.0);
  float xr  = 2.0 * d.x * z0;
  float yr  = 2.0 * d.y * z0;
  float zr  = 2.0 * z0 * z0 - 1.0;

  ${basisLines.join('\n  ')}

  vec3 color =
${terms};

  fragColor = vec4(clamp(color + 0.5, 0.0, 1.0), 1.0);
}
`;
}
