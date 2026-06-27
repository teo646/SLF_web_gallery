import './style.css';
import { SLFViewer } from './viewer.js';
import { loadSLFPainting } from './slfLoader.js';

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

  showStatus('갤러리 로딩 중…');

  const galleryData = await Promise.all(
    paintings.map(name =>
      loadSLFPainting(`${import.meta.env.BASE_URL}gallery/${name}`)
        .then(data => ({ ...data, name }))
    )
  );

  viewer.setGallery(galleryData);
  overlayEl.style.display = 'none';
}

function showStatus(msg) {
  overlayEl.style.display = 'flex';
  statusEl.textContent = msg;
}

init();
