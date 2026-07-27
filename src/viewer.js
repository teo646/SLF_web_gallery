/**
 * SLF 갤러리 뷰어.
 * Three.js + 커스텀 GLSL 셰이더 + FPS 카메라.
 * LOD: 가장 바라보는 그림만 SH 전체로 렌더링, 나머지는 DC(Y0)만 사용한 플랫 이미지.
 */

import * as THREE from 'three';
import { VERT, buildFragShader } from './slfShader.js';
import { HUD_CW, HUD_CH, createHUDMesh, drawHUD } from './hud.js';

// ── 방 치수 ──────────────────────────────────────────────────────────────────
// 그림 개수(n)에 따라 방/벽 배치를 동적으로 계산한다(setGallery에서 재계산).
// 4면 벽에 그림을 라운드로빈으로 고르게 분배하고, 각 벽 길이는 그 벽에 걸리는
// 그림 수 × 슬롯 간격만큼 자동으로 늘어난다.

const PAINTING_H  = 2.0;
const PAINTING_Y  = 1.5;
const SLOT_SPACING = 3.6;  // 인접 그림 중심 간 목표 간격(가장 넓은 그림 폭 + 여유)
const ROOM_MARGIN  = 3.0;  // 벽 양 끝 여유 공간
const ROOM_H       = 4.0;
const ROOM_MIN     = 8;    // 그림이 적어도 방이 너무 작아지지 않도록 하는 최소 크기

// HUD 3D 크기
const HUD_3D_W = 0.85;
const HUD_3D_H = HUD_3D_W * HUD_CH / HUD_CW;

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

    // 방 상태 (setGallery에서 그림 개수에 맞춰 재계산됨)
    this._room = { W: ROOM_MIN, H: ROOM_H, D: ROOM_MIN };
    this._roomObjects = [];

    // FPS 상태
    this._yaw         = 0;
    this._pitch       = 0;
    this._targetYaw   = 0;
    this._targetPitch = 0;
    this._pos      = new THREE.Vector3(0, 1.6, this._room.D / 2 - 0.5);
    this._keys     = new Set();
    this._moveVec  = new THREE.Vector2(0, 0); // 모바일 가상 조이스틱 입력 (x: 좌우, y: 전후)
    this._lastTime = performance.now();

    // 매 프레임 재사용 벡터
    this._fwd           = new THREE.Vector3();
    this._rgt           = new THREE.Vector3();
    this._lookDir       = new THREE.Vector3();
    this._dirToPainting = new THREE.Vector3();

    this._hudItems = [];

    this._buildRoom(this._room);
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

  /**
   * 그림 개수(n)에 맞춰 방 크기와 각 그림이 걸릴 벽면 슬롯(위치/회전)을 계산한다.
   * 4면 벽(정면·좌측·우측·뒷면)에 라운드로빈으로 고르게 분배하고, 각 벽 길이는
   * 그 벽에 걸리는 그림 수만큼 SLOT_SPACING 간격으로 늘어난다.
   */
  _computeLayout(n) {
    n = Math.max(n, 1);
    const perWall = [0, 0, 0, 0]; // 정면 · 좌측 · 우측 · 뒷면
    for (let i = 0; i < n; i++) perWall[i % 4]++;

    const W = Math.max(ROOM_MIN, Math.max(perWall[0], perWall[3]) * SLOT_SPACING + ROOM_MARGIN);
    const D = Math.max(ROOM_MIN, Math.max(perWall[1], perWall[2]) * SLOT_SPACING + ROOM_MARGIN);
    const H = ROOM_H;

    // 각 벽마다 그 벽 길이를 따라 그림 수만큼 균등 배치한 슬롯 목록을 만든다.
    const sidesDef = [
      { axis: 'x', coord:  -D / 2 + 0.015, length: W, rot: new THREE.Euler(0,             0, 0) }, // 정면 (북)
      { axis: 'z', coord:  -W / 2 + 0.015, length: D, rot: new THREE.Euler(0,  Math.PI / 2, 0) }, // 좌측 (서)
      { axis: 'z', coord:   W / 2 - 0.015, length: D, rot: new THREE.Euler(0, -Math.PI / 2, 0) }, // 우측 (동)
      { axis: 'x', coord:   D / 2 - 0.015, length: W, rot: new THREE.Euler(0,      Math.PI, 0) }, // 뒷면 (남)
    ];

    const wallSlots = sidesDef.map((side, s) => {
      const count = perWall[s];
      const slots = [];
      for (let i = 0; i < count; i++) {
        const offset = ((i + 0.5) / count - 0.5) * side.length;
        const pos = side.axis === 'x'
          ? new THREE.Vector3(offset, PAINTING_Y, side.coord)
          : new THREE.Vector3(side.coord, PAINTING_Y, offset);
        slots.push({ pos, rot: side.rot });
      }
      return slots;
    });

    // 라운드로빈 순서(i % 4)대로 다시 풀어, setGallery에서 그대로 꺼내 쓸 수 있게 한다.
    const cursor = [0, 0, 0, 0];
    const slots = [];
    for (let i = 0; i < n; i++) {
      const side = i % 4;
      slots.push(wallSlots[side][cursor[side]++]);
    }

    return { room: { W, H, D }, slots };
  }

  /** 방(바닥/천장/벽/조명)을 새 크기로 (재)구성한다. */
  _buildRoom(room) {
    this._disposeRoom();

    const { W, H, D } = room;

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
      this._roomObjects.push(mesh);
    }

    const ambient = new THREE.AmbientLight(0xfff8f0, 0.55);
    this._scene.add(ambient);
    this._roomObjects.push(ambient);

    // 방 크기에 맞춰 천장 조명을 격자로 배치(작은 방에서도 최소 1x1은 보장).
    // 조명 수는 MeshStandardMaterial 프래그먼트당 순회 비용에 그대로 더해지므로,
    // 방이 아무리 커져도 축당 개수를 상한선 안에서만 늘리고 대신 range로 커버한다.
    const LIGHT_SPACING     = 10;
    const MAX_LIGHTS_PER_AXIS = 5;
    const nx = Math.min(MAX_LIGHTS_PER_AXIS, Math.max(1, Math.round(W / LIGHT_SPACING)));
    const nz = Math.min(MAX_LIGHTS_PER_AXIS, Math.max(1, Math.round(D / LIGHT_SPACING)));
    const range = Math.max(W / nx, D / nz) * 2.2;

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = -W / 2 + (ix + 0.5) * (W / nx);
        const z = -D / 2 + (iz + 0.5) * (D / nz);
        const light = new THREE.PointLight(0xfff5e0, 0.9, range);
        light.position.set(x, H - 0.2, z);
        this._scene.add(light);
        this._roomObjects.push(light);
      }
    }
  }

  _disposeRoom() {
    for (const obj of this._roomObjects) {
      this._scene.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
    this._roomObjects = [];
  }

  // ── FPS 컨트롤 ────────────────────────────────────────────────────────────

  _setupFPS() {
    const canvas = this._canvas;
    const MOUSE_SENS  = 0.0025;
    const TOUCH_SENS  = 0.006;
    const PITCH_LIMIT = Math.PI / 2.2;

    let touchLook = null; // { id, x, y } — 터치 드래그로 시점을 돌리는 중인 포인터
    let lockRetryTimer = null;

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') {
        // 클릭할 때마다 잠금/해제를 토글: 잠그면 이후 마우스 이동만으로 시점을 돌리고,
        // 다시 클릭하면 풀어서 커서를 되찾는다(Esc와 동일하게 동작).
        if (document.pointerLockElement === canvas) {
          document.exitPointerLock();
        } else {
          canvas.requestPointerLock();
        }
      } else if (e.pointerType === 'touch' && !touchLook) {
        touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    });

    // 브라우저는 포인터 락을 해제한 직후 곧바로 재요청하면 클릭재킹 방지용
    // 쿨다운으로 이를 거부한다(pointerlockerror 발생). 배포 환경에서는 Esc나
    // 창 포커스 이탈로 락이 풀린 직후 다시 클릭하는 경우가 흔해 이 쿨다운에
    // 걸리기 쉬우므로, 토글이 먹통으로 보이지 않도록 잠시 후 한 번 재시도한다.
    document.addEventListener('pointerlockerror', () => {
      if (document.pointerLockElement === canvas) return;
      clearTimeout(lockRetryTimer);
      lockRetryTimer = setTimeout(() => {
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
      }, 400);
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
   * @param {{ textures: THREE.CompressedTexture[], meta: object, name: string }[]} galleryData
   */
  setGallery(galleryData) {
    this._disposeGallery();

    const { room, slots } = this._computeLayout(galleryData.length);
    this._room = room;
    this._buildRoom(room);

    // 새 방 크기에 맞춰 스폰 위치/시점 재설정
    this._pos.set(0, 1.6, room.D / 2 - 0.5);
    this._yaw = this._targetYaw = this._pitch = this._targetPitch = 0;

    for (let i = 0; i < galleryData.length; i++) {
      const { textures, meta, K } = galleryData[i]; // K는 메타에서 (DC 로드 시 textures.length=1)
      const wall   = slots[i];
      const aspect = meta.W / meta.H;

      const geometry = new THREE.PlaneGeometry(aspect * PAINTING_H, PAINTING_H);

      const uniforms = {};
      for (let k = 0; k < textures.length; k++) uniforms[`u_k${k}`] = { value: textures[k] };
      uniforms.u_cam_local   = { value: new THREE.Vector3() };
      uniforms.u_aspect      = { value: aspect };
      uniforms.u_coeff_min   = { value: meta.coeff_min ?? -8.0 };
      uniforms.u_coeff_range = { value: (meta.coeff_max ?? 8.0) - (meta.coeff_min ?? -8.0) };

      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: buildFragShader(K, true), // 초기엔 DC-only (플랫)
        glslVersion:    THREE.GLSL3,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(wall.pos);
      mesh.rotation.copy(wall.rot);
      this._scene.add(mesh);

      this._paintings.push({ mesh, K, ready: false });

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
   * @param {number} loaded  coeffs.ktx2 다운로드 진행 바이트 수
   * @param {number} total   coeffs.ktx2 전체 바이트 수
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
   * @param {THREE.CompressedArrayTexture} coeffsTex  coeffs.ktx2 (k00~k{K-1}, K개 레이어)
   */
  upgradePainting(index, coeffsTex) {
    const p = this._paintings[index];
    if (!p || p.ready) return;

    // u_k0는 primary가 아닐 때 계속 쓰는 flat(DC-only) 셰이더가 참조하므로 지우지 않고
    // 전체 계수 배열 텍스처(u_coeffs)를 추가로 얹는다.
    p.mesh.material.uniforms.u_coeffs = { value: coeffsTex };
    p.ready = true;

    // 현재 바라보는 그림이면 즉시 전체 SLF로 전환
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

    // 방이 커질수록(그림이 많을수록) 걸어서 가로지르는 데 걸리는 시간이 늘어나므로
    // 원래(8x8) 대비 커진 비율만큼 이동 속도를 비례해서 높인다.
    const roomScale = Math.max(1, Math.max(this._room.W, this._room.D) / ROOM_MIN);
    const speed = 1.5 * roomScale * dt;
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

    const { W, D } = this._room;
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
      p.mesh.material.fragmentShader = buildFragShader(p.K, !useFull);
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
