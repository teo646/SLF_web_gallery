/**
 * 단일 그림 SLF 뷰어.
 * 그림 한 장을 화면 중앙에 두고, 마우스 드래그(오빗) + 휠(줌)으로
 * surface-light-fields-for-planar-paintings/src/render.py의 OrbitCamera와
 * 동일한 방식으로 시점을 바꿔가며 감상한다.
 */

import * as THREE from 'three';
import { VERT, buildFragShader } from './slfShader.js';
import { HUD_CW, HUD_CH, createHUDMesh, drawHUD } from './hud.js';

// 학습된 SLF는 정면 근처 시야에서만 신뢰할 수 있으므로 오빗 각도를 제한한다.
const YAW_LIMIT   = Math.PI / 3;   // ±60°
const PITCH_LIMIT = Math.PI / 3.5; // ±~51°
const ZOOM_MIN    = 0.1;
const ZOOM_MAX    = 3.0;
const PAN_SLACK   = 0.5; // 그림 절반 크기 대비 추가로 허용할 여유 패닝 비율

// HUD 3D 크기 (그림 높이 1 기준)
const HUD_3D_W = 0.425;
const HUD_3D_H = HUD_3D_W * HUD_CH / HUD_CW;
const HUD_Y_OFFSET = -0.28; // 그림 하단부에 오버레이

export class SLFPaintingViewer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this._canvas = canvas;

    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._scene  = new THREE.Scene();
    this._scene.background = new THREE.Color(0x111111);
    this._camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);

    this._mesh     = null;
    this._aspect   = 1;
    this._baseDist = 1.6; // 그림이 화면에 꽉 차 보이는 기준 거리 (줌 배율 1일 때)

    // 오빗 상태
    this._yaw       = 0;
    this._pitch     = 0;
    this._targetYaw   = 0;
    this._targetPitch = 0;
    this._zoom        = 1;
    this._targetZoom  = 1;

    // 패닝 상태 (WASD / 방향키로 확대된 화면 안에서 시야를 이동)
    this._pan       = new THREE.Vector2(0, 0);
    this._targetPan = new THREE.Vector2(0, 0);
    this._keys      = new Set();

    this._dragging   = false;
    this._lastPointer = { x: 0, y: 0 };
    this._pinchStartDist = 0; // 핀치 줌 시작 시점의 두 손가락 간 거리
    this._pinchStartZoom = 1;

    // 렌더링 진행률 HUD
    const { mesh: hudMesh, ctx: hudCtx, canvas: hudCanvas, tex: hudTex } = createHUDMesh(HUD_3D_W, HUD_3D_H);
    hudMesh.position.set(0, HUD_Y_OFFSET, 0.01);
    hudMesh.visible = false;
    this._scene.add(hudMesh);
    this._hud = { mesh: hudMesh, ctx: hudCtx, canvas: hudCanvas, tex: hudTex, done: true, fadeStartTime: 0 };

    this._setupControls();
    this._resize();
    // window resize만 감지하면 창 크기는 그대로인데 캔버스 표시 영역만 바뀌는
    // 경우(포워딩된 브라우저 패널, 숨겨진 탭 복귀 등)를 놓쳐 카메라 종횡비가
    // 어긋난 채로 고정되므로, 실제 렌더 영역 크기 변화를 직접 관찰한다.
    new ResizeObserver(() => this._resize()).observe(this._canvas.parentElement);
    this._animate();
  }

  /** KTX2(압축 텍스처) 지원 감지용으로 slfLoader에 넘겨줄 렌더러. */
  get renderer() {
    return this._renderer;
  }

  // ── 공개 API ─────────────────────────────────────────────────────────────

  /** 새 그림으로 교체 (DC만 있는 미리보기 or 전체 SLF 둘 다 사용 가능) */
  setPainting({ textures, meta, K, parallaxTex = null }) {
    this._disposePainting();

    this._aspect = meta.W / meta.H;
    // meta.has_parallax만으로 판단한다(viewer.js와 동일) — parallaxTex는 항상 DC 미리보기
    // 다음 upgradePainting에서야 도착하므로, 여기서 parallaxTex 존재를 요구하면 numSteps가
    // 0으로 고정돼 이후 전체 SLF가 와도 parallax가 영영 켜지지 않는다.
    const hasParallax = !!meta.has_parallax;

    const geometry = new THREE.PlaneGeometry(this._aspect, 1);

    const uniforms = {};
    for (let k = 0; k < textures.length; k++) uniforms[`u_k${k}`] = { value: textures[k] };
    uniforms.u_cam_local   = { value: new THREE.Vector3() };
    uniforms.u_aspect      = { value: this._aspect };
    uniforms.u_coeff_min   = { value: meta.coeff_min ?? -8.0 };
    uniforms.u_coeff_range = { value: (meta.coeff_max ?? 8.0) - (meta.coeff_min ?? -8.0) };
    if (hasParallax) {
      uniforms.u_uv_per_length = {
        value: new THREE.Vector2(1 / meta.u_extent, 1 / meta.v_extent),
      };
      uniforms.u_parallax_min   = { value: meta.parallax_min ?? -1.0 };
      uniforms.u_parallax_range = { value: (meta.parallax_max ?? 1.0) - (meta.parallax_min ?? -1.0) };
      uniforms.u_height_range   = { value: meta.height_range ?? 0.0 };
      if (parallaxTex) uniforms.u_parallax_map = { value: parallaxTex };
    }

    const dcOnly    = textures.length === 1;
    const numSteps  = hasParallax ? (meta.num_steps ?? 4) : 0;

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   VERT,
      fragmentShader: buildFragShader(K, dcOnly, dcOnly ? 0 : numSteps),
      glslVersion:    THREE.GLSL3,
    });

    this._mesh = new THREE.Mesh(geometry, material);
    this._scene.add(this._mesh);

    this._K        = K;
    this._numSteps = numSteps;
    this._ready    = !dcOnly;

    this._resetView();
    this._resize(); // aspect가 바뀌었으니 기준 거리 재계산

    // HUD 리셋: DC-only 미리보기면 0%부터, 이미 전체 SLF가 도착해 있으면 즉시 숨김
    const hud = this._hud;
    hud.done = this._ready;
    hud.mesh.material.opacity = this._ready ? 0 : 1;
    hud.mesh.visible          = !this._ready;
    if (!this._ready) drawHUD(hud.ctx, hud.canvas, hud.tex, 0);
  }

  /** 백그라운드에서 전체 SLF 로드 중일 때 반복 호출해 진행률 HUD를 갱신 */
  setProgress(loaded, total) {
    const hud = this._hud;
    if (hud.done) return;
    const pct = total > 0 ? Math.min(1, loaded / total) : 0;
    drawHUD(hud.ctx, hud.canvas, hud.tex, pct);
    if (pct >= 1) {
      hud.done          = true;
      hud.fadeStartTime = performance.now();
    }
  }

  /** setPainting으로 DC 미리보기를 띄운 뒤, 전체 SLF 텍스처가 도착하면 호출 */
  upgradePainting(allTextures, parallaxTex = null) {
    if (!this._mesh || this._ready) return;

    this._mesh.material.uniforms.u_k0.value.dispose();
    for (let k = 0; k < allTextures.length; k++) {
      this._mesh.material.uniforms[`u_k${k}`] = { value: allTextures[k] };
    }
    if (parallaxTex) {
      this._mesh.material.uniforms.u_parallax_map = { value: parallaxTex };
    }

    this._K     = allTextures.length;
    this._ready = true;
    this._mesh.material.fragmentShader = buildFragShader(this._K, false, this._numSteps);
    this._mesh.material.needsUpdate    = true;
  }

  dispose() {
    this._disposePainting();
    this._hud.mesh.geometry.dispose();
    this._hud.mesh.material.dispose();
    this._hud.tex.dispose();
    this._renderer.dispose();
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  _disposePainting() {
    if (!this._mesh) return;
    this._mesh.geometry.dispose();
    for (const key in this._mesh.material.uniforms) {
      this._mesh.material.uniforms[key].value?.dispose?.();
    }
    this._mesh.material.dispose();
    this._scene.remove(this._mesh);
    this._mesh = null;
  }

  _resetView() {
    this._yaw = this._targetYaw = 0;
    this._pitch = this._targetPitch = 0;
    this._zoom  = this._targetZoom  = 1;
    this._pan.set(0, 0);
    this._targetPan.set(0, 0);
  }

  _setupControls() {
    const canvas = this._canvas;

    // 터치는 손가락 개수로 모드가 갈린다: 1개 = 오빗 드래그, 2개 = 핀치 줌.
    // (PC에서는 마우스 포인터 1개만 들어오므로 기존 드래그 동작과 동일하게 작동한다.)
    this._touches = new Map(); // pointerId -> { x, y }

    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._touches.size === 1) {
        this._dragging = true;
        this._lastPointer = { x: e.clientX, y: e.clientY };
      } else if (this._touches.size === 2) {
        this._dragging = false;
        const [a, b] = [...this._touches.values()];
        this._pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        this._pinchStartZoom = this._targetZoom;
      }
    });

    canvas.addEventListener('pointermove', e => {
      if (!this._touches.has(e.pointerId)) return;
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._touches.size === 2) {
        const [a, b] = [...this._touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinchStartDist > 0) {
          this._targetZoom = clamp(
            this._pinchStartZoom * (this._pinchStartDist / dist), ZOOM_MIN, ZOOM_MAX);
        }
        return;
      }

      if (!this._dragging || this._touches.size !== 1) return;
      const dx = e.clientX - this._lastPointer.x;
      const dy = e.clientY - this._lastPointer.y;
      this._lastPointer = { x: e.clientX, y: e.clientY };

      this._targetYaw   = clamp(this._targetYaw   - dx * 0.005, -YAW_LIMIT, YAW_LIMIT);
      this._targetPitch = clamp(this._targetPitch + dy * 0.005, -PITCH_LIMIT, PITCH_LIMIT);
    });

    const releasePointer = e => {
      this._touches.delete(e.pointerId);
      if (this._touches.size === 1) {
        // 손가락 하나가 남으면 그 지점을 새 기준점 삼아 오빗 드래그를 이어간다(점프 방지).
        const [remaining] = [...this._touches.values()];
        this._dragging   = true;
        this._lastPointer = { x: remaining.x, y: remaining.y };
      } else {
        this._dragging = false;
      }
    };
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('pointerleave', releasePointer);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.001);
      this._targetZoom = clamp(this._targetZoom * factor, ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });

    document.addEventListener('keydown', e => {
      this._keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) e.preventDefault();
    });
    document.addEventListener('keyup', e => this._keys.delete(e.code));
  }

  _updateCamera(dt) {
    const t = Math.min(1.0, dt * 8);
    this._yaw   += (this._targetYaw   - this._yaw)   * t;
    this._pitch += (this._targetPitch - this._pitch) * t;
    this._zoom  += (this._targetZoom  - this._zoom)  * t;

    const dist = this._baseDist * this._zoom;

    // WASD/방향키 패닝: 확대해서 화면에 보이는 영역이 그림보다 작아진 만큼만 이동을 허용한다
    // (기본 배율에서는 그림 전체가 이미 보이므로 이동 범위가 0으로 clamp됨).
    const visHalfH = dist * Math.tan(THREE.MathUtils.degToRad(this._camera.fov) / 2);
    const visHalfW = visHalfH * this._camera.aspect;
    const maxPanX  = Math.max(0, this._aspect / 2 - visHalfW) + (this._aspect / 2) * PAN_SLACK;
    const maxPanY  = Math.max(0, 0.5 - visHalfH) + 0.5 * PAN_SLACK;

    const panSpeed = 0.6 * dt;
    const keys = this._keys;
    if (keys.has('KeyW') || keys.has('ArrowUp'))    this._targetPan.y += panSpeed;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  this._targetPan.y -= panSpeed;
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  this._targetPan.x -= panSpeed;
    if (keys.has('KeyD') || keys.has('ArrowRight')) this._targetPan.x += panSpeed;
    this._targetPan.x = clamp(this._targetPan.x, -maxPanX, maxPanX);
    this._targetPan.y = clamp(this._targetPan.y, -maxPanY, maxPanY);

    this._pan.x += (this._targetPan.x - this._pan.x) * t;
    this._pan.y += (this._targetPan.y - this._pan.y) * t;

    const cy = Math.cos(this._yaw),   sy = Math.sin(this._yaw);
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);

    this._camera.position.set(
      this._pan.x + dist * sy * cp,
      this._pan.y + dist * sp,
      dist * cy * cp,
    );
    this._camera.lookAt(this._pan.x, this._pan.y, 0);
  }

  _updatePaintingUniform() {
    if (!this._mesh) return;
    const localCam = this._mesh.worldToLocal(this._camera.position.clone());
    this._mesh.material.uniforms.u_cam_local.value.copy(localCam);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const now = performance.now();
    const dt  = Math.min((now - (this._lastTime ?? now)) / 1000, 0.05);
    this._lastTime = now;

    this._updateCamera(dt);
    this._updatePaintingUniform();

    // 완료된 HUD 페이드 아웃
    const hud = this._hud;
    if (hud.done && hud.mesh.visible) {
      const t = (now - hud.fadeStartTime) / 800;
      hud.mesh.material.opacity = Math.max(0, 1 - t);
      if (hud.mesh.material.opacity <= 0) hud.mesh.visible = false;
    }

    this._renderer.render(this._scene, this._camera);
  }

  _resize() {
    const el = this._canvas.parentElement;
    const w  = el.clientWidth;
    const h  = el.clientHeight;
    if (w === 0 || h === 0) return; // 탭이 숨겨진 상태 등, 아직 레이아웃되지 않음
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;

    // 그림 전체가 항상 보이도록 화면비에 맞춰 기준 거리 계산 (여백 15%)
    const fitW = this._aspect / this._camera.aspect;
    const halfExtent = Math.max(1, fitW) / 2 * 1.15;
    this._baseDist = halfExtent / Math.tan(THREE.MathUtils.degToRad(this._camera.fov) / 2);

    this._camera.updateProjectionMatrix();
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
