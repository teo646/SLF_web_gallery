/**
 * 단일 그림 SLF 뷰어.
 * 그림 한 장을 화면 중앙에 두고, 마우스 드래그(오빗) + 휠(줌)으로
 * surface-light-fields-for-planar-paintings/src/render.py의 OrbitCamera와
 * 동일한 방식으로 시점을 바꿔가며 감상한다.
 */

import * as THREE from 'three';
import { VERT, buildFragShader } from './slfShader.js';

// 학습된 SLF는 정면 근처 시야에서만 신뢰할 수 있으므로 오빗 각도를 제한한다.
const YAW_LIMIT   = Math.PI / 3;   // ±60°
const PITCH_LIMIT = Math.PI / 3.5; // ±~51°
const ZOOM_MIN    = 0.6;
const ZOOM_MAX    = 3.0;

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

    this._dragging   = false;
    this._lastPointer = { x: 0, y: 0 };

    this._setupControls();
    this._resize();
    window.addEventListener('resize', () => this._resize());
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
    const hasParallax = !!parallaxTex && !!meta.has_parallax;

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
      uniforms.u_parallax_map   = { value: parallaxTex };
      uniforms.u_parallax_min   = { value: meta.parallax_min ?? -1.0 };
      uniforms.u_parallax_range = { value: (meta.parallax_max ?? 1.0) - (meta.parallax_min ?? -1.0) };
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
  }

  _setupControls() {
    const canvas = this._canvas;

    canvas.addEventListener('pointerdown', e => {
      this._dragging = true;
      this._lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', e => {
      if (!this._dragging) return;
      const dx = e.clientX - this._lastPointer.x;
      const dy = e.clientY - this._lastPointer.y;
      this._lastPointer = { x: e.clientX, y: e.clientY };

      this._targetYaw   = clamp(this._targetYaw   - dx * 0.005, -YAW_LIMIT, YAW_LIMIT);
      this._targetPitch = clamp(this._targetPitch - dy * 0.005, -PITCH_LIMIT, PITCH_LIMIT);
    });

    const stopDrag = () => { this._dragging = false; };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);
    canvas.addEventListener('pointerleave', stopDrag);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.001);
      this._targetZoom = clamp(this._targetZoom * factor, ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });
  }

  _updateCamera(dt) {
    const t = Math.min(1.0, dt * 8);
    this._yaw   += (this._targetYaw   - this._yaw)   * t;
    this._pitch += (this._targetPitch - this._pitch) * t;
    this._zoom  += (this._targetZoom  - this._zoom)  * t;

    const dist = this._baseDist * this._zoom;
    const cy = Math.cos(this._yaw),   sy = Math.sin(this._yaw);
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);

    this._camera.position.set(dist * sy * cp, dist * sp, dist * cy * cp);
    this._camera.lookAt(0, 0, 0);
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

    this._renderer.render(this._scene, this._camera);
  }

  _resize() {
    const el = this._canvas.parentElement;
    const w  = el.clientWidth;
    const h  = el.clientHeight;
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
