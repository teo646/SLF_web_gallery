/**
 * SLF(SH 계수) 렌더링에 쓰이는 GLSL 셰이더 빌더.
 * gallery(viewer.js)와 단일 그림 뷰어(paintingViewer.js)가 공유한다.
 */

export const VERT = `
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// surface-light-fields-for-planar-paintings/src/render.py의 FS_BODY(eval_sh)와 동일한
// 순수 다항식 SH 기저. 실좌표 구면조화 정규화 상수(C0~C3, 부호 포함)는 곱하지 않는다 —
// 그 상수는 model.py의 _sh_basis와 짝을 이루도록 학습된 계수(u_k0/u_coeffs) 쪽에 이미
// 흡수돼 있으므로, 여기서 다시 곱하면 이중 적용된다.
//
// dcOnly(K=1 취급, DC 미리보기)일 때는 단일 2D 텍스처 u_k0을,
// 전체 SLF일 때는 render.py의 sampler2DArray u_coeffs와 동일하게 k00~k{K-1}을 한
// 텍스처 배열(coeffs.ktx2, K개 레이어)로 묶어 샘플링한다.
export function buildFragShader(K, dcOnly = false) {
  const degree = Math.round(Math.sqrt(K)) - 1;

  const samplerDecls = dcOnly
    ? 'uniform sampler2D u_k0;'
    : 'uniform sampler2DArray u_coeffs;';

  const basisLines = ['float Y0 = 1.0;'];
  if (K > 1) {
    basisLines.push('float Y1 = yr;');
    basisLines.push('float Y2 = zr;');
    basisLines.push('float Y3 = xr;');
  }
  if (K > 4) {
    basisLines.push('float Y4 = xr * yr;');
    basisLines.push('float Y5 = yr * zr;');
    basisLines.push('float Y6 = 2.0*zr*zr - xr*xr - yr*yr;');
    basisLines.push('float Y7 = xr * zr;');
    basisLines.push('float Y8 = xr*xr - yr*yr;');
  }
  if (K > 9) {
    basisLines.push('float Y9  = yr * (3.0*xr*xr - yr*yr);');
    basisLines.push('float Y10 = xr * yr * zr;');
    basisLines.push('float Y11 = yr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y12 = zr * (2.0*zr*zr - 3.0*xr*xr - 3.0*yr*yr);');
    basisLines.push('float Y13 = xr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y14 = zr * (xr*xr - yr*yr);');
    basisLines.push('float Y15 = xr * (xr*xr - 3.0*yr*yr);');
  }

  // 텍스처는 [0,1] 정규화 값(KTX2/UASTC 트랜스코딩 결과)만 담고 있으므로, 실제 SH 계수
  // 범위로의 환산(coeff_min ~ coeff_max)은 항상 셰이더에서 수행한다.
  const terms = dcOnly
    ? '    Y0 * (texture(u_k0, v_uv).rgb * u_coeff_range + u_coeff_min)'
    : Array.from({ length: K }, (_, k) =>
        `    ${k === 0 ? '' : '+ '}Y${k} * (texture(u_coeffs, vec3(v_uv, ${k}.0)).rgb * u_coeff_range + u_coeff_min)`
      ).join('\n');

  return `precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;

${samplerDecls}
uniform vec3  u_cam_local;
uniform float u_aspect;
uniform float u_coeff_min;
uniform float u_coeff_range;

in  vec2 v_uv;
out vec4 fragColor;

void main() {
  vec3 pix_pos = vec3((v_uv - 0.5) * vec2(u_aspect, 1.0), 0.0);
  vec3 d = normalize(u_cam_local - pix_pos);

  // render.py의 hsh_remap과 동일: 반구 방향을 전구로 재매핑
  float z0 = clamp(d.z, 0.0, 1.0);
  float xr = 2.0 * d.x * z0;
  float yr = 2.0 * d.y * z0;
  float zr = 2.0 * z0 * z0 - 1.0;

  ${basisLines.join('\n  ')}

  vec3 color =
${terms};

  fragColor = vec4(clamp(color + 0.5, 0.0, 1.0), 1.0);
}
`;
}
