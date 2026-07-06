import './style.css';
import { SLFViewer } from './viewer.js';
import { loadSLFPaintingDC, loadSLFPainting } from './slfLoader.js';
import { createJoystick } from './joystick.js';
import { IS_TOUCH } from './device.js';

const canvas       = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const overlayEl    = document.getElementById('overlay');
const statusEl     = document.getElementById('status');
const joystickBase = document.getElementById('joystickBase');
const joystickNub  = document.getElementById('joystickNub');

const viewer = new SLFViewer(canvas);
createJoystick(joystickBase, joystickNub, (x, y) => viewer.setMoveVector(x, y));

async function init() {
  let index;
  try {
    index = await fetch(`${import.meta.env.BASE_URL}gallery/index.json`).then(r => r.json());
  } catch {
    showStatus('Could not find gallery/index.json.\nRun scripts/convert_to_web.py first.');
    return;
  }

  const paintings = index.paintings ?? [];
  if (paintings.length === 0) {
    showStatus('No paintings registered.\nRun scripts/convert_to_web.py.');
    return;
  }

  statusEl.innerHTML = IS_TOUCH ? `
    <div class="loading-text">Loading gallery…</div>
    <div class="controls-grid">
      <span class="ctrl-key">Drag</span><span class="ctrl-desc">Look around</span>
      <span class="ctrl-key">Joystick</span><span class="ctrl-desc">Move</span>
    </div>
  ` : `
    <div class="loading-text">Loading gallery…</div>
    <div class="controls-grid">
      <span class="ctrl-key">Click</span><span class="ctrl-desc">Enable mouse look</span>
      <span class="ctrl-key">Mouse</span><span class="ctrl-desc">Look around</span>
      <span class="ctrl-key">W A S D</span><span class="ctrl-desc">Move forward / left / back / right</span>
    </div>
  `;

  // Phase 1: meta + k00만 로드 → 즉시 표시
  const dcData = await Promise.all(
    paintings.map(name =>
      loadSLFPaintingDC(`${import.meta.env.BASE_URL}gallery/${name}`, viewer.renderer)
        .then(data => ({ ...data, name }))
    )
  );

  viewer.setGallery(dcData);

  // 로딩 완료 → 닫기 버튼 표시, 오버레이는 클릭 통과(pointer-events: none)
  const loadingTextEl = statusEl.querySelector('.loading-text');
  if (loadingTextEl) loadingTextEl.remove();

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '✕ Close';
  closeBtn.addEventListener('click', () => overlayEl.style.display = 'none');
  statusEl.appendChild(closeBtn);

  // 오버레이 배경은 클릭 통과 → 뒤 캔버스 조작 가능
  overlayEl.style.pointerEvents = 'none';
  statusEl.style.pointerEvents = 'auto';

  // Phase 2: 백그라운드에서 전체 SLF 로드 → 진행 표시 후 각 그림 업그레이드
  paintings.forEach((name, i) => {
    loadSLFPainting(
      `${import.meta.env.BASE_URL}gallery/${name}`,
      (loaded, total) => viewer.setProgress(i, loaded, total),
      viewer.renderer,
    ).then(({ textures, parallaxTex }) => viewer.upgradePainting(i, textures, parallaxTex));
  });
}

function showStatus(msg) {
  overlayEl.style.display = 'flex';
  statusEl.textContent = msg;
}

init();
