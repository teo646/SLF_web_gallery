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
    <name_dir>/dataset/relief/height.npy, normal.npy    (선택 — 있으면 parallax mapping 활성화)

동작:
    1. meta.npz + plane.npz (+ relief) →  public/gallery/<name>/meta.json
    2. k00.png … k{K-1}.png            →  public/gallery/<name>/
    3. relief가 있으면 parallax map(n_z·h)을 16bit PNG로 인코딩 → parallax.png
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


def _encode_parallax_png(height: np.ndarray, normal: np.ndarray) -> tuple[np.ndarray, float, float]:
    """parallax map(n_z·h, world 단위)을 16bit 단일 채널 PNG용 배열로 정규화한다.

    render.py의 build_parallax_map_texture와 동일한 값(Pxy = n_z·h)을 [p_min, p_max] 선형
    구간으로 uint16에 매핑한다 — SH 계수 PNG 인코딩(model._coeff_to_u16)과 같은 방식이다.
    """
    parallax = (normal[..., 2] * height).astype(np.float32)
    p_min, p_max = float(parallax.min()), float(parallax.max())
    if p_max - p_min < 1e-12:
        p_max = p_min + 1e-6  # 평평한 그림(모든 값이 0) — 구간이 0이 되는 것을 방지
    scale = 65535.0 / (p_max - p_min)
    u16 = np.clip((parallax - p_min) * scale, 0, 65535).astype(np.uint16)
    return u16, p_min, p_max


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
    normal_path  = relief_dir / "normal.npy"
    if height_path.exists() and normal_path.exists():
        height = np.load(height_path)
        normal = np.load(normal_path)
        u16, p_min, p_max = _encode_parallax_png(height, normal)
        cv2.imwrite(str(dst / "parallax.png"), u16)
        meta["has_parallax"]  = True
        meta["parallax_min"]  = p_min
        meta["parallax_max"]  = p_max
        print(f"[parallax] {dst / 'parallax.png'}  (range [{p_min:.5f}, {p_max:.5f}])")
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
