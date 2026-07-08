#!/usr/bin/env python3
"""
학습 결과물(outputs/<name>/)을 웹 갤러리 형식으로 변환.

Usage:
    python scripts/convert_to_web.py <name_dir> [--name <painting_name>]

    예:
        python scripts/convert_to_web.py \\
            ../surface-light-fields-for-planar-paintings/outputs/Merry_Company_on_a_Terrace

        python scripts/convert_to_web.py /path/to/outputs/MyPainting --name MyPainting

<name_dir> 는 surface-light-fields-for-planar-paintings/main.py 가 만드는 출력 폴더
(outputs/<name>/) 다. 아래 레이아웃을 기대한다:

    <name_dir>/models/sh_pngs/meta.npz, k00.png, ...   (필수)
    <name_dir>/dataset/plane.npz                        (필수 — u_extent/v_extent)
    <name_dir>/dataset/relief/height.npy                (선택 — 있으면 parallax mapping 활성화)

동작:
    1. meta.npz + plane.npz (+ relief) →  public/gallery/<name>/meta.json
    2. k00.png … k{K-1}.png            →  public/gallery/<name>/
    3. relief가 있으면 height map을 16bit PNG로 인코딩 → parallax.png
       (+ POM 레이마칭용 height_range도 함께 계산해 meta.json에 저장)
    4. public/gallery/index.json  에 name 추가 (중복 제외)
"""

import argparse
import json
import shutil
from pathlib import Path

import cv2
import numpy as np

GALLERY_DIR = Path(__file__).resolve().parent.parent / "public" / "gallery"


def _find_sh_pngs_dir(name_dir: Path) -> Path:
    """models/sh_pngs (현재 레이아웃) 또는 sh_pngs (구버전 flat 레이아웃)를 찾는다."""
    candidates = [name_dir / "models" / "sh_pngs", name_dir / "sh_pngs"]
    for c in candidates:
        if (c / "meta.npz").exists():
            return c
    raise SystemExit(
        f"Error: sh_pngs/meta.npz 를 찾을 수 없습니다 — 확인한 경로: "
        + ", ".join(str(c) for c in candidates)
    )


def _encode_parallax_png(height: np.ndarray) -> tuple[np.ndarray, float, float]:
    """height map(world 단위, 평면 위 = 0)을 16bit 단일 채널 PNG용 배열로 정규화한다.

    render.py의 build_parallax_map_texture와 동일하게 raw height를 그대로 인코딩한다 —
    시선 방향에 따른 보정(POM 레이마칭, VZ_MIN 클램프)은 셰이더의 resolve_uv가 매 프레임
    수행하므로, 여기서 normal.z를 미리 곱해두지 않는다. [p_min, p_max] 선형 구간으로
    uint16에 매핑하는 방식은 SH 계수 PNG 인코딩(model._coeff_to_u16)과 동일하다.
    """
    height = height.astype(np.float32)
    p_min, p_max = float(height.min()), float(height.max())
    if p_max - p_min < 1e-12:
        p_max = p_min + 1e-6  # 평평한 그림(모든 값이 0) — 구간이 0이 되는 것을 방지
    scale = 65535.0 / (p_max - p_min)
    u16 = np.clip((height - p_min) * scale, 0, 65535).astype(np.uint16)
    return u16, p_min, p_max


def _compute_height_range(height: np.ndarray, margin: float = 1.15) -> float:
    """POM 레이마칭이 훑을 후보 높이 범위(world 단위, u_height_range)를 height map에서 계산한다.

    render.py의 compute_height_range와 동일 — 실제 표면 높이가 [-range, +range]를 벗어나지
    않도록 margin(기본 15%) 여유를 둔다. 학습(ID pass)과 렌더링(shading pass)이 같은
    height_map에서 이 값을 계산해 써야 두 pass의 UV 해석이 일치하므로, render.py 쪽과
    정확히 같은 공식을 써야 한다.
    """
    peak = float(np.abs(height).max()) if height.size else 0.0
    return max(peak * margin, 1e-6)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="outputs/<name>/ 폴더를 SLF 웹 갤러리용으로 변환"
    )
    parser.add_argument("name_dir", type=Path,
                        help="파이프라인 출력 폴더 경로 (outputs/<name>/)")
    parser.add_argument("--name", type=str, default=None,
                        help="갤러리 슬러그 (기본: name_dir 폴더명)")
    args = parser.parse_args()

    name_dir = args.name_dir.resolve()
    if not name_dir.is_dir():
        raise SystemExit(f"Error: 폴더가 없습니다 — {name_dir}")

    sh_pngs_dir = _find_sh_pngs_dir(name_dir)

    plane_npz = name_dir / "dataset" / "plane.npz"
    if not plane_npz.exists():
        raise SystemExit(f"Error: plane.npz 없음 — {plane_npz}")

    # 갤러리 슬러그: 지정 없으면 폴더명
    name = args.name or name_dir.name

    # ── meta.npz + plane.npz → meta.json ────────────────────────────────────
    sh_meta = np.load(sh_pngs_dir / "meta.npz")
    plane   = np.load(plane_npz)

    u_extent = float(plane["u_coords"][-1] - plane["u_coords"][0])
    v_extent = float(plane["v_coords"][-1] - plane["v_coords"][0])

    meta = {
        "H":         int(sh_meta["H"]),
        "W":         int(sh_meta["W"]),
        "degree":    int(sh_meta["degree"]),
        "coeff_min": float(sh_meta.get("coeff_min", np.float32(-8.0))),
        "coeff_max": float(sh_meta.get("coeff_max", np.float32( 8.0))),
        "num_steps": int(sh_meta["num_steps"]) if "num_steps" in sh_meta.files else 4,
        "u_extent":  u_extent,
        "v_extent":  v_extent,
        "has_parallax": False,
    }
    K = (meta["degree"] + 1) ** 2

    # ── 출력 디렉토리 ────────────────────────────────────────────────────────
    dst = GALLERY_DIR / name
    dst.mkdir(parents=True, exist_ok=True)

    # ── relief → parallax.png (parallax mapping) ────────────────────────────
    relief_dir   = name_dir / "dataset" / "relief"
    height_path  = relief_dir / "height.npy"
    if height_path.exists():
        height = np.load(height_path)
        u16, p_min, p_max = _encode_parallax_png(height)
        height_range = _compute_height_range(height)
        cv2.imwrite(str(dst / "parallax.png"), u16)
        meta["has_parallax"]  = True
        meta["parallax_min"]  = p_min
        meta["parallax_max"]  = p_max
        meta["height_range"]  = height_range
        print(f"[parallax] {dst / 'parallax.png'}  (range [{p_min:.5f}, {p_max:.5f}], "
              f"height_range={height_range:.5f})")
    else:
        # 기존에 parallax.png가 남아있으면(재변환 시) 지운다 — has_parallax=False와 어긋나지 않도록.
        (dst / "parallax.png").unlink(missing_ok=True)
        print(f"[parallax] relief 없음 ({relief_dir}) — 평면 기준으로 렌더링합니다.")

    # meta.json 저장
    (dst / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[meta]  {dst / 'meta.json'}")

    # ── PNG 복사 ─────────────────────────────────────────────────────────────
    for k in range(K):
        fname = f"k{k:02d}.png"
        src_png = sh_pngs_dir / fname
        if not src_png.exists():
            raise SystemExit(f"Error: PNG 없음 — {src_png}")
        shutil.copy2(src_png, dst / fname)
        print(f"[copy]  {fname}")

    # ── gallery/index.json 갱신 ──────────────────────────────────────────────
    index_path = GALLERY_DIR / "index.json"
    if index_path.exists():
        index = json.loads(index_path.read_text())
    else:
        index = {"paintings": []}

    if name not in index["paintings"]:
        index["paintings"].append(name)
        index_path.write_text(json.dumps(index, indent=2))
        print(f"[index] '{name}' 추가 → {index_path}")
    else:
        print(f"[index] '{name}' 이미 등록됨, 파일만 갱신.")

    print(f"\n완료. 브라우저에서 /gallery/{name}/ 로 접근 가능.")


if __name__ == "__main__":
    main()
