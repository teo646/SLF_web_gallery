/**
 * 원형 베이스 위에서 드래그한 오프셋을 [-1, 1] 정규화 벡터로 알려주는 가상 조이스틱.
 * 모바일에서 갤러리 이동(전/후/좌/우, WASD 대응)에 사용한다.
 * @param {HTMLElement} baseEl
 * @param {HTMLElement} nubEl
 * @param {(x: number, y: number) => void} onChange  x: 좌(-1)/우(+1), y: 위(-1)/아래(+1)
 */
export function createJoystick(baseEl, nubEl, onChange) {
  let activeId = null;

  function update(clientX, clientY) {
    const rect   = baseEl.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = clientX - (rect.left + radius);
    let dy = clientY - (rect.top  + radius);

    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = dx / dist * radius;
      dy = dy / dist * radius;
    }

    nubEl.style.transform = `translate(${dx}px, ${dy}px)`;
    onChange(dx / radius, dy / radius);
  }

  function release() {
    activeId = null;
    nubEl.style.transform = 'translate(0, 0)';
    onChange(0, 0);
  }

  baseEl.addEventListener('pointerdown', e => {
    activeId = e.pointerId;
    baseEl.setPointerCapture(e.pointerId);
    update(e.clientX, e.clientY);
  });
  baseEl.addEventListener('pointermove', e => {
    if (e.pointerId !== activeId) return;
    update(e.clientX, e.clientY);
  });
  baseEl.addEventListener('pointerup',     e => { if (e.pointerId === activeId) release(); });
  baseEl.addEventListener('pointercancel', e => { if (e.pointerId === activeId) release(); });
}
