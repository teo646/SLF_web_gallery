import './style.css';
import { SLFViewer } from './viewer.js';
import { loadSLFPainting } from './slfLoader.js';

const canvas    = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
const overlayEl = document.getElementById('overlay');
const statusEl  = document.getElementById('status');

const viewer = new SLFViewer(canvas);
let currentTextures = [];

// ── 갤러리 초기화 ─────────────────────────────────────────────────────────

async function init() {
  let index;
  try {
    index = await fetch('/gallery/index.json').then(r => r.json());
  } catch {
    showStatus('gallery/index.json를 찾을 수 없습니다.\nscripts/convert_to_web.py를 먼저 실행하세요.');
    return;
  }

  const paintings = index.paintings ?? [];
  if (paintings.length === 0) {
    showStatus('등록된 페인팅이 없습니다.\nscripts/convert_to_web.py를 실행하세요.');
    return;
  }

  await loadPainting(paintings[0]);
}

async function loadPainting(name) {
  currentTextures.forEach(t => t.dispose());
  currentTextures = [];

  showStatus(`Loading "${name.replace(/_/g, ' ')}"…`, false);

  try {
    const { textures, meta } = await loadSLFPainting(
      `/gallery/${name}`,
      (n, total) => showStatus(
        `Loading "${name.replace(/_/g, ' ')}"…  ${n}/${total}`,
        true,
        n / total,
      ),
    );

    currentTextures = textures;
    viewer.setPainting(textures, meta);
    overlayEl.style.display = 'none';
  } catch (err) {
    showStatus(`오류: ${err.message}`);
    console.error(err);
  }
}

// ── 오버레이 ─────────────────────────────────────────────────────────────

function showStatus(msg, withBar = false, progress = 0) {
  overlayEl.style.display = 'flex';
  if (withBar) {
    statusEl.innerHTML = `
      <div>${msg}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${Math.round(progress * 100)}%"></div>
      </div>`;
  } else {
    statusEl.textContent = msg;
  }
}

init();
