#!/usr/bin/env python3
"""
SH PNG 데이터를 웹 갤러리 형식으로 변환.

Usage:
    python scripts/convert_to_web.py <model_dir> [--name <painting_name>]

    예:
        python scripts/convert_to_web.py \\
            ../surface-light-fields-for-planar-paintings/outputs/models/Merry_Company_on_a_Terrace

        python scripts/convert_to_web.py /path/to/MyPainting --name MyPainting

동작:
    1. <model_dir>/sh_pngs/meta.npz  →  public/gallery/<name>/meta.json
    2. <model_dir>/sh_pngs/k00.png … k{K-1}.png  →  public/gallery/<name>/
    3. public/gallery/index.json  에 name 추가 (중복 제외)
"""

import argparse
import json
import shutil
from pathlib import Path

import numpy as np

GALLERY_DIR = Path(__file__).resolve().parent.parent / "public" / "gallery"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="모델 폴더 안의 sh_pngs를 SLF 웹 갤러리용으로 변환"
    )
    parser.add_argument("model_dir", type=Path,
                        help="모델 폴더 경로 (sh_pngs/ 하위 폴더를 포함해야 함)")
    parser.add_argument("--name", type=str, default=None,
                        help="갤러리 슬러그 (기본: model_dir 폴더명)")
    args = parser.parse_args()

    model_dir = args.model_dir.resolve()
    if not model_dir.is_dir():
        raise SystemExit(f"Error: 폴더가 없습니다 — {model_dir}")

    src = model_dir / "sh_pngs"
    if not src.is_dir():
        raise SystemExit(f"Error: sh_pngs 폴더가 없습니다 — {src}")

    # 갤러리 슬러그: 지정 없으면 모델 폴더명
    name = args.name or model_dir.name

    # ── meta.npz → meta.json ────────────────────────────────────────────────
    meta_npz = src / "meta.npz"
    if not meta_npz.exists():
        raise SystemExit(f"Error: meta.npz 없음 — {meta_npz}")

    data = np.load(meta_npz)
    meta = {
        "H":         int(data["H"]),
        "W":         int(data["W"]),
        "degree":    int(data["degree"]),
        "coeff_min": float(data.get("coeff_min", np.float32(-8.0))),
        "coeff_max": float(data.get("coeff_max", np.float32( 8.0))),
    }
    K = (meta["degree"] + 1) ** 2

    # ── 출력 디렉토리 ────────────────────────────────────────────────────────
    dst = GALLERY_DIR / name
    dst.mkdir(parents=True, exist_ok=True)

    # meta.json 저장
    (dst / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[meta]  {dst / 'meta.json'}")

    # ── PNG 복사 ─────────────────────────────────────────────────────────────
    for k in range(K):
        fname = f"k{k:02d}.png"
        src_png = src / fname
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
