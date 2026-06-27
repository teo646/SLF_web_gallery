/**
 * SLF 갤러리 뷰어.
 * Three.js + 커스텀 GLSL 셰이더 + FPS 카메라 (PointerLock).
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

// ── 방 치수 & 그림 배치 ──────────────────────────────────────────────────────

const ROOM = { W: 8, H: 3, D: 8 };
const PAINTING_H = 2.0;          // 그림 세로 크기 (월드 단위)
const PAINTING_Y = 1.5;          // 그림 중심 높이
const PAINTING_Z = -ROOM.D / 2 + 0.015; // 북쪽 벽 바로 앞

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

  const samplerDecls = Array.from({ length: K }, (_, k) =>
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

    this._scene = new THREE.Scene();

    this._camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);

    // 그림 상태
    this._paintingMesh = null;
    this._K            = 0;
    this._dcOnly       = false;

    // FPS 상태
    this._yaw         = 0;
    this._pitch        = 0;
    this._targetYaw   = 0;
    this._targetPitch = 0;
    this._pos      = new THREE.Vector3(0, 1.6, ROOM.D / 2 - 0.5);
    this._keys     = new Set();
    this._lastTime = performance.now();

    // 매 프레임 재사용 벡터
    this._fwd     = new THREE.Vector3();
    this._rgt     = new THREE.Vector3();
    this._lookDir = new THREE.Vector3();

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

    // [geometry, position, euler rotation, material]
    const panels = [
      [new THREE.PlaneGeometry(W, D), [0, 0,    0],    [-Math.PI/2, 0,          0], floorMat],
      [new THREE.PlaneGeometry(W, D), [0, H,    0],    [ Math.PI/2, 0,          0], ceilMat ],
      [new THREE.PlaneGeometry(W, H), [0, H/2, -D/2],  [0,          0,          0], wallMat ], // 북 (그림 벽)
      [new THREE.PlaneGeometry(W, H), [0, H/2,  D/2],  [0,          Math.PI,    0], wallMat ], // 남
      [new THREE.PlaneGeometry(D, H), [ W/2, H/2, 0],  [0,         -Math.PI/2,  0], wallMat ], // 동
      [new THREE.PlaneGeometry(D, H), [-W/2, H/2, 0],  [0,          Math.PI/2,  0], wallMat ], // 서
    ];

    for (const [geom, pos, rot, mat] of panels) {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      this._scene.add(mesh);
    }

    // 조명
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

    // 클릭한 화면 위치 → 시선 방향으로 전환
    canvas.addEventListener('click', e => {
      const rect  = canvas.getBoundingClientRect();
      const ndcX  = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
      const ndcY  = ((e.clientY - rect.top)  / rect.height) * -2 + 1;

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

  setPainting(textures, meta) {
    this._disposePainting();

    const K      = textures.length;
    this._K      = K;
    const aspect = meta.W / meta.H;
    const paintW = aspect * PAINTING_H;

    const geometry = new THREE.PlaneGeometry(paintW, PAINTING_H);

    const uniforms = {};
    for (let k = 0; k < K; k++) uniforms[`u_k${k}`] = { value: textures[k] };
    uniforms.u_cam_local = { value: new THREE.Vector3() };
    uniforms.u_aspect    = { value: aspect };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   VERT,
      fragmentShader: buildFragShader(K, this._dcOnly),
      glslVersion:    THREE.GLSL3,
    });

    this._paintingMesh = new THREE.Mesh(geometry, material);
    this._paintingMesh.position.set(0, PAINTING_Y, PAINTING_Z);
    this._scene.add(this._paintingMesh);

    console.log(`[SLF] ${meta.W}×${meta.H}  degree=${meta.degree}  K=${K}`);
  }

  setDCOnly(enabled) {
    this._dcOnly = enabled;
    if (!this._paintingMesh) return;
    this._paintingMesh.material.fragmentShader = buildFragShader(this._K, enabled);
    this._paintingMesh.material.needsUpdate = true;
  }

  dispose() {
    this._disposePainting();
    this._renderer.dispose();
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  _updateCamera(dt) {
    // 클릭 목표 방향으로 부드럽게 회전
    const t = Math.min(1.0, dt * 8);
    let dyaw = this._targetYaw - this._yaw;
    if (dyaw >  Math.PI) dyaw -= 2 * Math.PI;
    if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    this._yaw   += dyaw * t;
    this._pitch += (this._targetPitch - this._pitch) * t;

    const speed = 3.0 * dt;
    const { _keys: keys, _yaw: yaw } = this;

    this._fwd.set( Math.sin(yaw), 0, -Math.cos(yaw));
    this._rgt.set( Math.cos(yaw), 0,  Math.sin(yaw));

    if (keys.has('KeyW') || keys.has('ArrowUp'))    this._pos.addScaledVector(this._fwd,  speed);
    if (keys.has('KeyS') || keys.has('ArrowDown'))  this._pos.addScaledVector(this._fwd, -speed);
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  this._pos.addScaledVector(this._rgt, -speed);
    if (keys.has('KeyD') || keys.has('ArrowRight')) this._pos.addScaledVector(this._rgt,  speed);

    // 방 경계 충돌
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

  _animate() {
    requestAnimationFrame(() => this._animate());

    const now = performance.now();
    const dt  = Math.min((now - this._lastTime) / 1000, 0.05);
    this._lastTime = now;

    this._updateCamera(dt);

    // 그림 셰이더 u_cam_local 갱신 (그림 로컬 좌표계, 높이=1 기준)
    if (this._paintingMesh) {
      const pp = this._paintingMesh.position;
      const cl = this._paintingMesh.material.uniforms.u_cam_local.value;
      cl.set(
        (this._pos.x - pp.x) / PAINTING_H,
        (this._pos.y - pp.y) / PAINTING_H,
        (this._pos.z - pp.z) / PAINTING_H,
      );
    }

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

  _disposePainting() {
    if (!this._paintingMesh) return;
    this._paintingMesh.geometry.dispose();
    this._paintingMesh.material.dispose();
    this._scene.remove(this._paintingMesh);
    this._paintingMesh = null;
  }
}
