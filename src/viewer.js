/**
 * SLF 갤러리 뷰어.
 * Three.js + 커스텀 GLSL 셰이더 + FPS 카메라.
 * LOD: 가장 바라보는 그림만 SH 전체로 렌더링, 나머지는 DC(Y0)만 사용한 플랫 이미지.
 */

import * as THREE from 'three';

// ── SH 상수 ─────────────────────────────────────────────────────────────────

const _C0 = 0.28209479177387814;
const _C1 = 0.4886025119029199;
const _C2 = [ 1.0925484305920792, -1.0925484305920792,  0.31539156525252005,
             -1.0925484305920792,  0.5462742152960396];
const _C3 = [-0.5900435899266435,  2.890611442640554,  -0.4570457994644658,
              0.3731763325901154, -0.4570457994644658,   1.445305721320277,
             -0.5900435899266435];

// ── 방 치수 ──────────────────────────────────────────────────────────────────

const ROOM      = { W: 8, H: 3, D: 8 };
const PAINTING_H = 2.0;
const PAINTING_Y = 1.5;

// 4면 벽 배치 (북·남·동·서)
const WALLS = [
  { pos: new THREE.Vector3(0,                PAINTING_Y, -ROOM.D / 2 + 0.015), rot: new THREE.Euler(0,             0, 0) },
  { pos: new THREE.Vector3(0,                PAINTING_Y,  ROOM.D / 2 - 0.015), rot: new THREE.Euler(0,      Math.PI, 0) },
  { pos: new THREE.Vector3( ROOM.W / 2 - 0.015, PAINTING_Y, 0),                rot: new THREE.Euler(0, -Math.PI / 2, 0) },
  { pos: new THREE.Vector3(-ROOM.W / 2 + 0.015, PAINTING_Y, 0),                rot: new THREE.Euler(0,  Math.PI / 2, 0) },
];

// ── GLSL 셰이더 ──────────────────────────────────────────────────────────────

const VERT = `
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function buildFragShader(K, dcOnly = false) {
  const degree = Math.round(Math.sqrt(K)) - 1;

  // dcOnly 모드에서는 u_k0만 선언 (나머지는 미로드 상태일 수 있음)
  const samplerDecls = Array.from({ length: dcOnly ? 1 : K }, (_, k) =>
    `uniform sampler2D u_k${k};`
  ).join('\n');

  const constLines = [
    `const float C0  = ${_C0};`,
    `const float C1  = ${_C1};`,
  ];
  if (degree >= 2) _C2.forEach((v, i) => constLines.push(`const float C2${i} = ${v};`));
  if (degree >= 3) _C3.forEach((v, i) => constLines.push(`const float C3${i} = ${v};`));

  const basisLines = ['float Y0 = C0;'];
  if (K > 1) {
    basisLines.push('float Y1 = -C1 * yr;');
    basisLines.push('float Y2 =  C1 * zr;');
    basisLines.push('float Y3 = -C1 * xr;');
  }
  if (K > 4) {
    basisLines.push('float Y4 = C20 * xr * yr;');
    basisLines.push('float Y5 = C21 * yr * zr;');
    basisLines.push('float Y6 = C22 * (2.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y7 = C23 * xr * zr;');
    basisLines.push('float Y8 = C24 * (xr*xr - yr*yr);');
  }
  if (K > 9) {
    basisLines.push('float Y9  = C30 * yr * (3.0*xr*xr - yr*yr);');
    basisLines.push('float Y10 = C31 * xr * yr * zr;');
    basisLines.push('float Y11 = C32 * yr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y12 = C33 * zr * (2.0*zr*zr - 3.0*xr*xr - 3.0*yr*yr);');
    basisLines.push('float Y13 = C34 * xr * (4.0*zr*zr - xr*xr - yr*yr);');
    basisLines.push('float Y14 = C35 * zr * (xr*xr - yr*yr);');
    basisLines.push('float Y15 = C36 * xr * (xr*xr - 3.0*yr*yr);');
  }

  const terms = Array.from({ length: dcOnly ? 1 : K }, (_, k) =>
    `    ${k === 0 ? '' : '+ '}Y${k} * texture(u_k${k}, v_uv).rgb`
  ).join('\n');

  return `precision highp float;
precision highp sampler2D;

${constLines.join('\n')}

${samplerDecls}
uniform vec3  u_cam_local;
uniform float u_aspect;

in  vec2 v_uv;
out vec4 fragColor;

void main() {
  vec3 pix_pos = vec3((v_uv - 0.5) * vec2(u_aspect, 1.0), 0.0);
  vec3 d = normalize(u_cam_local - pix_pos);

  float z0 = clamp(d.z, 0.0, 1.0);
  float xr  = 2.0 * d.x * z0;
  float yr  = 2.0 * d.y * z0;
  float zr  = 2.0 * z0 * z0 - 1.0;

  ${basisLines.join('\n  ')}

  vec3 color =
${terms};

  fragColor = vec4(clamp(color + 0.5, 0.0, 1.0), 1.0);
}
`;
}

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
    this._lastTime = performance.now();

    // 매 프레임 재사용 벡터
    this._fwd           = new THREE.Vector3();
    this._rgt           = new THREE.Vector3();
    this._lookDir       = new THREE.Vector3();
    this._dirToPainting = new THREE.Vector3();

    this._buildRoom();
    this._setupFPS();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._animate();
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
  }

  // ── FPS 컨트롤 ────────────────────────────────────────────────────────────

  _setupFPS() {
    const canvas = this._canvas;

    canvas.addEventListener('click', e => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
      const ndcY = ((e.clientY - rect.top)  / rect.height) * -2 + 1;

      const dir = new THREE.Vector3(ndcX, ndcY, 0.5)
        .unproject(this._camera)
        .sub(this._camera.position)
        .normalize();

      this._targetPitch = Math.max(-Math.PI / 2.2,
        Math.min(Math.PI / 2.2, Math.asin(Math.max(-1, Math.min(1, dir.y)))));
      this._targetYaw = Math.atan2(dir.x, -dir.z);
    });

    document.addEventListener('keydown', e => {
      this._keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))
        e.preventDefault();
    });
    document.addEventListener('keyup', e => this._keys.delete(e.code));
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

      const uniforms = {};
      for (let k = 0; k < K; k++) uniforms[`u_k${k}`] = { value: textures[k] };
      uniforms.u_cam_local = { value: new THREE.Vector3() };
      uniforms.u_aspect    = { value: aspect };

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
    }

    // 정적 오브젝트이므로 matrixWorld를 한 번만 계산
    this._scene.updateMatrixWorld();
    this._primaryIdx = -1;
  }

  /**
   * 백그라운드에서 전체 SLF 텍스처가 준비됐을 때 호출.
   * @param {number} index
   * @param {THREE.DataTexture[]} allTextures  k00 ~ k{K-1}
   */
  upgradePainting(index, allTextures) {
    const p = this._paintings[index];
    if (!p || p.ready) return;

    // 기존 임시 k0 텍스처 해제 후 전체 uniform 교체
    p.mesh.material.uniforms.u_k0.value.dispose();
    for (let k = 0; k < allTextures.length; k++) {
      p.mesh.material.uniforms[`u_k${k}`] = { value: allTextures[k] };
    }
    p.K     = allTextures.length;
    p.ready = true;

    // 현재 바라보는 그림이면 즉시 SLF로 전환
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

    this._renderer.render(this._scene, this._camera);
  }

  _resize() {
    const el = this._canvas.parentElement;
    const w  = el.clientWidth;
    const h  = el.clientHeight;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }
}
