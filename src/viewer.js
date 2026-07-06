/**
 * SLF 갤러리 뷰어.
 * Three.js + 커스텀 GLSL 셰이더 + FPS 카메라.
 * LOD: 가장 바라보는 그림만 SH 전체로 렌더링, 나머지는 DC(Y0)만 사용한 플랫 이미지.
 */

import * as THREE from 'three';
import { VERT, buildFragShader } from './slfShader.js';
import { HUD_CW, HUD_CH, createHUDMesh, drawHUD } from './hud.js';

// ── 방 치수 ──────────────────────────────────────────────────────────────────

const ROOM      = { W: 8, H: 3, D: 8 };
const PAINTING_H = 2.0;
const PAINTING_Y = 1.5;

// HUD 3D 크기
const HUD_3D_W = 0.85;
const HUD_3D_H = HUD_3D_W * HUD_CH / HUD_CW;

// 4면 벽 배치, 그림이 걸리는 순서: 정면 · 좌측 · 우측 · 뒷면
const WALLS = [
  { pos: new THREE.Vector3(0,                PAINTING_Y, -ROOM.D / 2 + 0.015), rot: new THREE.Euler(0,             0, 0) }, // 정면 (북)
  { pos: new THREE.Vector3(-ROOM.W / 2 + 0.015, PAINTING_Y, 0),                rot: new THREE.Euler(0,  Math.PI / 2, 0) }, // 좌측 (서)
  { pos: new THREE.Vector3( ROOM.W / 2 - 0.015, PAINTING_Y, 0),                rot: new THREE.Euler(0, -Math.PI / 2, 0) }, // 우측 (동)
  { pos: new THREE.Vector3(0,                PAINTING_Y,  ROOM.D / 2 - 0.015), rot: new THREE.Euler(0,      Math.PI, 0) }, // 뒷면 (남)
];

// ── SLFViewer ────────────────────────────────────────────────────────────────

export class SLFViewer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this._canvas = canvas;

    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);

    // 갤러리 상태
    this._paintings  = [];  // { mesh, K }
    this._primaryIdx = -1;

    // FPS 상태
    this._yaw         = 0;
    this._pitch       = 0;
    this._targetYaw   = 0;
    this._targetPitch = 0;
    this._pos      = new THREE.Vector3(0, 1.6, ROOM.D / 2 - 0.5);
    this._keys     = new Set();
    this._moveVec  = new THREE.Vector2(0, 0); // 모바일 가상 조이스틱 입력 (x: 좌우, y: 전후)
    this._lastTime = performance.now();

    // 매 프레임 재사용 벡터
    this._fwd           = new THREE.Vector3();
    this._rgt           = new THREE.Vector3();
    this._lookDir       = new THREE.Vector3();
    this._dirToPainting = new THREE.Vector3();

    this._hudItems = [];

    this._buildRoom();
    this._setupFPS();
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

  // ── 방 구성 ───────────────────────────────────────────────────────────────

  _buildRoom() {
    const { W, H, D } = ROOM;

    const wallMat  = new THREE.MeshStandardMaterial({ color: 0xf2ede6, roughness: 1.0 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.85 });
    const ceilMat  = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0 });

    const panels = [
      [new THREE.PlaneGeometry(W, D), [0, 0,    0],    [-Math.PI/2, 0,          0], floorMat],
      [new THREE.PlaneGeometry(W, D), [0, H,    0],    [ Math.PI/2, 0,          0], ceilMat ],
      [new THREE.PlaneGeometry(W, H), [0, H/2, -D/2],  [0,          0,          0], wallMat ],
      [new THREE.PlaneGeometry(W, H), [0, H/2,  D/2],  [0,          Math.PI,    0], wallMat ],
      [new THREE.PlaneGeometry(D, H), [ W/2, H/2, 0],  [0,         -Math.PI/2,  0], wallMat ],
      [new THREE.PlaneGeometry(D, H), [-W/2, H/2, 0],  [0,          Math.PI/2,  0], wallMat ],
    ];

    for (const [geom, pos, rot, mat] of panels) {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      this._scene.add(mesh);
    }

    this._scene.add(new THREE.AmbientLight(0xfff8f0, 0.55));

    const ceiling1 = new THREE.PointLight(0xfff5e0, 0.9, 20);
    ceiling1.position.set(-2, H - 0.2, 0);
    this._scene.add(ceiling1);

    const ceiling2 = new THREE.PointLight(0xfff5e0, 0.9, 20);
    ceiling2.position.set(2, H - 0.2, 0);
    this._scene.add(ceiling2);

    const ceiling3 = new THREE.PointLight(0xfff5e0, 0.9, 20);
    ceiling3.position.set(0, H - 0.2, -2);
    this._scene.add(ceiling3);

    const ceiling4 = new THREE.PointLight(0xfff5e0, 0.9, 20);
    ceiling4.position.set(0, H - 0.2, 2);
    this._scene.add(ceiling4);
  }

  // ── FPS 컨트롤 ────────────────────────────────────────────────────────────

  _setupFPS() {
    const canvas = this._canvas;
    const MOUSE_SENS  = 0.0025;
    const TOUCH_SENS  = 0.006;
    const PITCH_LIMIT = Math.PI / 2.2;

    let touchLook = null; // { id, x, y } — 터치 드래그로 시점을 돌리는 중인 포인터

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') {
        // 클릭하면 포인터를 잠가 이후 마우스 이동만으로 시점을 돌릴 수 있게 한다.
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
      } else if (e.pointerType === 'touch' && !touchLook) {
        touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    });

    canvas.addEventListener('pointermove', e => {
      if (touchLook && e.pointerId === touchLook.id) {
        const dx = e.clientX - touchLook.x;
        const dy = e.clientY - touchLook.y;
        touchLook.x = e.clientX;
        touchLook.y = e.clientY;

        this._targetYaw  += dx * TOUCH_SENS;
        this._targetPitch = Math.max(-PITCH_LIMIT,
          Math.min(PITCH_LIMIT, this._targetPitch - dy * TOUCH_SENS));
        this._yaw   = this._targetYaw;
        this._pitch = this._targetPitch;
        return;
      }

      if (document.pointerLockElement !== canvas) return;

      this._targetYaw  += e.movementX * MOUSE_SENS;
      this._targetPitch = Math.max(-PITCH_LIMIT,
        Math.min(PITCH_LIMIT, this._targetPitch - e.movementY * MOUSE_SENS));

      // 다음 프레임까지 기다리지 않고 바로 반영해 마우스 추적이 지연 없이 느껴지게 한다.
      this._yaw   = this._targetYaw;
      this._pitch = this._targetPitch;
    });

    const releaseTouchLook = e => {
      if (touchLook && e.pointerId === touchLook.id) touchLook = null;
    };
    canvas.addEventListener('pointerup', releaseTouchLook);
    canvas.addEventListener('pointercancel', releaseTouchLook);

    document.addEventListener('keydown', e => {
      this._keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))
        e.preventDefault();
    });
    document.addEventListener('keyup', e => this._keys.delete(e.code));
  }

  /** 모바일 가상 조이스틱에서 호출: x(좌 -1 ~ 우 +1), y(위 -1 ~ 아래 +1). */
  setMoveVector(x, y) {
    this._moveVec.set(x, y);
  }

  // ── 공개 API ─────────────────────────────────────────────────────────────

  /**
   * @param {{ textures: THREE.DataTexture[], meta: object, name: string }[]} galleryData
   */
  setGallery(galleryData) {
    this._disposeGallery();

    for (let i = 0; i < galleryData.length && i < WALLS.length; i++) {
      const { textures, meta, K } = galleryData[i]; // K는 메타에서 (DC 로드 시 textures.length=1)
      const wall   = WALLS[i];
      const aspect = meta.W / meta.H;

      const geometry = new THREE.PlaneGeometry(aspect * PAINTING_H, PAINTING_H);

      const hasParallax = !!meta.has_parallax;

      const uniforms = {};
      for (let k = 0; k < textures.length; k++) uniforms[`u_k${k}`] = { value: textures[k] };
      uniforms.u_cam_local   = { value: new THREE.Vector3() };
      uniforms.u_aspect      = { value: aspect };
      uniforms.u_coeff_min   = { value: meta.coeff_min ?? -8.0 };
      uniforms.u_coeff_range = { value: (meta.coeff_max ?? 8.0) - (meta.coeff_min ?? -8.0) };
      if (hasParallax) {
        uniforms.u_uv_per_length = {
          value: new THREE.Vector2(1 / meta.u_extent, 1 / meta.v_extent),
        };
        uniforms.u_parallax_min   = { value: meta.parallax_min ?? -1.0 };
        uniforms.u_parallax_range = { value: (meta.parallax_max ?? 1.0) - (meta.parallax_min ?? -1.0) };
      }

      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: buildFragShader(K, true, 0), // 초기엔 DC-only (플랫, parallax 없음)
        glslVersion:    THREE.GLSL3,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(wall.pos);
      mesh.rotation.copy(wall.rot);
      this._scene.add(mesh);

      // numSteps: 전체 SLF(parallaxTex 포함)가 로드되기 전까지는 0(parallax 비활성) —
      // upgradePainting에서 parallaxTex가 도착하면 meta.num_steps로 올라간다.
      this._paintings.push({
        mesh, K, ready: false,
        numSteps: hasParallax ? (meta.num_steps ?? 4) : 0,
      });

      // 3D HUD: 벽면 위에 캔버스 텍스처 평면을 부착
      const { mesh: hudMesh, ctx: hudCtx, canvas: hudCanvas, tex: hudTex } = createHUDMesh(HUD_3D_W, HUD_3D_H);

      // 벽 법선 방향으로 살짝 앞에 배치해 z-fighting 방지
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(wall.rot);
      hudMesh.position.copy(wall.pos)
        .add(new THREE.Vector3(0, -PAINTING_H * 0.28, 0))
        .addScaledVector(normal, 0.012);
      hudMesh.rotation.copy(wall.rot);
      this._scene.add(hudMesh);

      drawHUD(hudCtx, hudCanvas, hudTex, 0);

      this._hudItems.push({ hudMesh, hudCtx, hudCanvas, hudTex, done: false, fadeStartTime: 0 });
    }

    // 정적 오브젝트이므로 matrixWorld를 한 번만 계산
    this._scene.updateMatrixWorld();
    this._primaryIdx = -1;
  }

  /**
   * @param {number} index
   * @param {number} loaded  현재까지 완료된 텍스처 수
   * @param {number} total   전체 텍스처 수 (K)
   */
  setProgress(index, loaded, total) {
    const item = this._hudItems[index];
    if (!item || item.done) return;
    const pct = total > 0 ? Math.min(1, loaded / total) : 0;
    drawHUD(item.hudCtx, item.hudCanvas, item.hudTex, pct);
    if (pct >= 1) {
      item.done          = true;
      item.fadeStartTime = performance.now();
    }
  }

  /**
   * 백그라운드에서 전체 SLF 텍스처가 준비됐을 때 호출.
   * @param {number} index
   * @param {THREE.DataTexture[]} allTextures  k00 ~ k{K-1}
   * @param {THREE.DataTexture | null} [parallaxTex]  u_parallax_map (has_parallax일 때만)
   */
  upgradePainting(index, allTextures, parallaxTex = null) {
    const p = this._paintings[index];
    if (!p || p.ready) return;

    // 기존 임시 k0 텍스처 해제 후 전체 uniform 교체
    p.mesh.material.uniforms.u_k0.value.dispose();
    for (let k = 0; k < allTextures.length; k++) {
      p.mesh.material.uniforms[`u_k${k}`] = { value: allTextures[k] };
    }
    if (parallaxTex) {
      p.mesh.material.uniforms.u_parallax_map = { value: parallaxTex };
    } else {
      p.numSteps = 0; // relief 데이터가 없었음 — parallax 비활성 유지
    }
    p.K     = allTextures.length;
    p.ready = true;

    // 현재 바라보는 그림이면 즉시 SLF(+parallax)로 전환
    if (index === this._primaryIdx) this._applyLOD();
  }

  dispose() {
    this._disposeGallery();
    this._renderer.dispose();
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  _disposeGallery() {
    for (const p of this._paintings) {
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      this._scene.remove(p.mesh);
    }
    this._paintings  = [];
    this._primaryIdx = -1;

    for (const item of this._hudItems) {
      this._scene.remove(item.hudMesh);
      item.hudMesh.geometry.dispose();
      item.hudMesh.material.dispose();
      item.hudTex.dispose();
    }
    this._hudItems = [];
  }

  _updateCamera(dt) {
    const t = Math.min(1.0, dt * 8);
    let dyaw = this._targetYaw - this._yaw;
    if (dyaw >  Math.PI) dyaw -= 2 * Math.PI;
    if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    this._yaw   += dyaw * t;
    this._pitch += (this._targetPitch - this._pitch) * t;

    const speed = 1.5 * dt;
    const { _keys: keys, _yaw: yaw } = this;

    this._fwd.set( Math.sin(yaw), 0, -Math.cos(yaw));
    this._rgt.set( Math.cos(yaw), 0,  Math.sin(yaw));

    if (keys.has('KeyW') || keys.has('ArrowUp'))    this._pos.addScaledVector(this._fwd,  speed);
    if (keys.has('KeyS') || keys.has('ArrowDown'))  this._pos.addScaledVector(this._fwd, -speed);
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  this._pos.addScaledVector(this._rgt, -speed);
    if (keys.has('KeyD') || keys.has('ArrowRight')) this._pos.addScaledVector(this._rgt,  speed);

    // 모바일 가상 조이스틱 (위로 밀면 y<0 → 전진)
    if (this._moveVec.lengthSq() > 0.0001) {
      this._pos.addScaledVector(this._fwd, -this._moveVec.y * speed);
      this._pos.addScaledVector(this._rgt,  this._moveVec.x * speed);
    }

    const { W, D } = ROOM;
    const m = 0.35;
    this._pos.x = Math.max(-W/2 + m, Math.min(W/2 - m, this._pos.x));
    this._pos.z = Math.max(-D/2 + m, Math.min(D/2 - m, this._pos.z));

    this._camera.position.copy(this._pos);

    const cy = Math.cos(this._yaw), sy = Math.sin(this._yaw);
    const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
    this._lookDir.set(sy * cp, sp, -cy * cp);
    this._camera.lookAt(
      this._pos.x + this._lookDir.x,
      this._pos.y + this._lookDir.y,
      this._pos.z + this._lookDir.z,
    );
  }

  // 카메라 시선과 가장 정렬된 그림을 SLF로 전환
  _updateLOD() {
    if (this._paintings.length === 0) return;

    let bestScore = -Infinity;
    let bestIdx   = 0;

    for (let i = 0; i < this._paintings.length; i++) {
      this._dirToPainting
        .subVectors(this._paintings[i].mesh.position, this._pos)
        .normalize();
      const score = this._dirToPainting.dot(this._lookDir);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx !== this._primaryIdx) {
      this._primaryIdx = bestIdx;
      this._applyLOD();
    }
  }

  // primary 변경 또는 upgrade 완료 시 셰이더 전환
  _applyLOD() {
    for (let i = 0; i < this._paintings.length; i++) {
      const p       = this._paintings[i];
      const useFull = i === this._primaryIdx && p.ready;
      p.mesh.material.fragmentShader = buildFragShader(p.K, !useFull, useFull ? p.numSteps : 0);
      p.mesh.material.needsUpdate    = true;
    }
  }

  // 각 그림의 로컬 좌표계에서 카메라 위치 갱신 (SH 셰이더 입력)
  _updatePaintingUniforms() {
    for (const p of this._paintings) {
      const localCam = p.mesh.worldToLocal(this._pos.clone());
      p.mesh.material.uniforms.u_cam_local.value.set(
        localCam.x / PAINTING_H,
        localCam.y / PAINTING_H,
        localCam.z / PAINTING_H,
      );
    }
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const now = performance.now();
    const dt  = Math.min((now - this._lastTime) / 1000, 0.05);
    this._lastTime = now;

    this._updateCamera(dt);
    this._updateLOD();
    this._updatePaintingUniforms();

    // 완료된 HUD 페이드 아웃
    for (const item of this._hudItems) {
      if (item.done && item.hudMesh.visible) {
        const t = (now - item.fadeStartTime) / 800;
        item.hudMesh.material.opacity = Math.max(0, 1 - t);
        if (item.hudMesh.material.opacity <= 0) item.hudMesh.visible = false;
      }
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
    this._camera.updateProjectionMatrix();
  }
}
