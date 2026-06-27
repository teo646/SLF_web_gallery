import './style.css';
import { SLFViewer } from './viewer.js';
import { loadSLFPaintingDC, loadSLFPainting } from './slfLoader.js';

const canvas    = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const overlayEl = document.getElementById('overlay');
const statusEl  = document.getElementById('status');

const viewer = new SLFViewer(canvas);

async function init() {
  let index;
  try {
    index = await fetch(`${import.meta.env.BASE_URL}gallery/index.json`).then(r => r.json());
  } catch {
    showStatus('gallery/index.json를 찾을 수 없습니다.\nscripts/convert_to_web.py를 먼저 실행하세요.');
    return;
  }

  const paintings = index.paintings ?? [];
  if (paintings.length === 0) {
    showStatus('등록된 페인팅이 없습니다.\nscripts/convert_to_web.py를 실행하세요.');
    return;
  }

  statusEl.innerHTML = `
    <div class="loading-text">갤러리 로딩 중…</div>
    <div class="controls-grid">
      <span class="ctrl-key">Click</span><span class="ctrl-desc">시점 변경</span>
      <span class="ctrl-key">W A S D</span><span class="ctrl-desc">앞 · 좌 · 뒤 · 우 이동</span>
    </div>
  `;

  // Phase 1: meta + k00만 로드 → 즉시 표시
  const dcData = await Promise.all(
    paintings.map(name =>
      loadSLFPaintingDC(`${import.meta.env.BASE_URL}gallery/${name}`)
        .then(data => ({ ...data, name }))
    )
  );

  viewer.setGallery(dcData);

  // 로딩 완료 → 닫기 버튼 표시, 오버레이는 클릭 통과(pointer-events: none)
  const loadingTextEl = statusEl.querySelector('.loading-text');
  if (loadingTextEl) loadingTextEl.remove();

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '✕ 닫기';
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
    ).then(({ textures }) => viewer.upgradePainting(i, textures));
  });
}

function showStatus(msg) {
  overlayEl.style.display = 'flex';
  statusEl.textContent = msg;
}

init();
