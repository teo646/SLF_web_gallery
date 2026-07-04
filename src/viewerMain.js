import './style.css';
import { SLFPaintingViewer } from './paintingViewer.js';
import { loadSLFPaintingDC, loadSLFPainting } from './slfLoader.js';

const canvas        = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const overlayEl      = document.getElementById('overlay');
const statusEl       = document.getElementById('status');
const viewerNavEl    = document.getElementById('viewerNav');
const prevBtn        = document.getElementById('prevBtn');
const nextBtn        = document.getElementById('nextBtn');
const paintingLabelEl = document.getElementById('paintingLabel');

const viewer = new SLFPaintingViewer(canvas);

let paintings  = [];
let currentIdx = 0;
let loadToken  = 0; // 그림 전환 중 지난 로딩 결과가 덮어쓰지 않도록 막는 토큰

async function init() {
  let index;
  try {
    index = await fetch(`${import.meta.env.BASE_URL}gallery/index.json`).then(r => r.json());
  } catch {
    showStatus('gallery/index.json를 찾을 수 없습니다.\nscripts/convert_to_web.py를 먼저 실행하세요.');
    return;
  }

  paintings = index.paintings ?? [];
  if (paintings.length === 0) {
    showStatus('등록된 페인팅이 없습니다.\nscripts/convert_to_web.py를 실행하세요.');
    return;
  }

  statusEl.innerHTML = `
    <div class="loading-text">그림 로딩 중…</div>
    <div class="controls-grid">
      <span class="ctrl-key">Drag</span><span class="ctrl-desc">시점 회전</span>
      <span class="ctrl-key">Wheel</span><span class="ctrl-desc">확대 · 축소</span>
      <span class="ctrl-key">‹ ›</span><span class="ctrl-desc">이전 · 다음 그림</span>
    </div>
  `;

  viewerNavEl.style.display = 'flex';
  prevBtn.addEventListener('click', () => goTo(currentIdx - 1));
  nextBtn.addEventListener('click', () => goTo(currentIdx + 1));
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft')  goTo(currentIdx - 1);
    if (e.key === 'ArrowRight') goTo(currentIdx + 1);
  });

  await loadCurrent();

  // 첫 로딩 완료 → 닫기 버튼 표시, 오버레이는 클릭 통과(pointer-events: none)
  const loadingTextEl = statusEl.querySelector('.loading-text');
  if (loadingTextEl) loadingTextEl.remove();

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '✕ 닫기';
  closeBtn.addEventListener('click', () => overlayEl.style.display = 'none');
  statusEl.appendChild(closeBtn);

  overlayEl.style.pointerEvents = 'none';
  statusEl.style.pointerEvents = 'auto';
}

function goTo(idx) {
  currentIdx = (idx + paintings.length) % paintings.length;
  loadCurrent();
}

async function loadCurrent() {
  const token = ++loadToken;
  const name  = paintings[currentIdx];
  updateLabel(name);

  const basePath = `${import.meta.env.BASE_URL}gallery/${name}`;

  // Phase 1: meta + k00만 로드 → 즉시 표시
  const dc = await loadSLFPaintingDC(basePath, viewer.renderer);
  if (token !== loadToken) return; // 그 사이 다른 그림으로 넘어감
  viewer.setPainting(dc);

  // Phase 2: 백그라운드에서 전체 SLF 로드 → 완료되면 업그레이드
  const full = await loadSLFPainting(basePath, undefined, viewer.renderer);
  if (token !== loadToken) return;
  viewer.upgradePainting(full.textures, full.parallaxTex);
}

function updateLabel(name) {
  const displayName = name.replace(/_/g, ' ');
  paintingLabelEl.textContent = `${currentIdx + 1} / ${paintings.length} · ${displayName}`;
}

function showStatus(msg) {
  overlayEl.style.display = 'flex';
  statusEl.textContent = msg;
}

init();
