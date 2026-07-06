/**
 * 렌더링 진행률을 보여주는 3D HUD(캔버스 텍스처 평면) 공용 유틸.
 * gallery(viewer.js)와 단일 그림 뷰어(paintingViewer.js)가 공유한다.
 */

import * as THREE from 'three';

export const HUD_CW = 600;
export const HUD_CH = 150;

/** HUD 캔버스 텍스처가 부착된 평면 메시를 만든다. */
export function createHUDMesh(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = HUD_CW;
  canvas.height = HUD_CH;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);

  return { mesh, ctx, canvas, tex };
}

/** 진행률(pct, 0~1)에 맞춰 HUD 캔버스를 다시 그린다. */
export function drawHUD(ctx, canvas, tex, pct) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // 배경
  ctx.fillStyle = 'rgba(12, 8, 4, 0.82)';
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 12);
  ctx.fill();

  // 테두리
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(5, 5, w - 10, h - 10, 11);
  ctx.stroke();

  // 상태 텍스트
  const pctInt = Math.round(pct * 100);
  ctx.fillStyle = 'rgba(255, 248, 235, 0.9)';
  ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`◐ Preparing realistic rendering (${pctInt}%)`, w / 2, h * 0.30);

  // 진행바 트랙
  const tx = 24, ty = h * 0.54, tw = w - 48, th = 14;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, th, 7);
  ctx.fill();

  // 진행바 채우기
  if (pct > 0) {
    const grad = ctx.createLinearGradient(tx, 0, tx + tw, 0);
    grad.addColorStop(0, '#b8860b');
    grad.addColorStop(1, '#f0c040');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw * pct, th, 7);
    ctx.fill();
  }

  // 힌트 텍스트
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.font = '20px system-ui, -apple-system, sans-serif';
  ctx.fillText('Switches to realistic lighting once the bar fills', w / 2, h * 0.82);

  tex.needsUpdate = true;
}
