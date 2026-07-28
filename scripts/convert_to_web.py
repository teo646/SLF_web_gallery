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

k00.png ~ k{K-1}.png(16bit RGB)를 옮겨 담은 뒤, 곧바로 `node scripts/build-ktx2.mjs
<name>`을 실행해 KTX2(k00.ktx2, coeffs.ktx2)까지 만들고 원본 PNG를 지운다(PNG 폴백
미지원) — 이 스크립트 하나로 끝난다. 여러 그림을 한꺼번에 변환할 때처럼 매번 압축을
기다리고 싶지 않으면 --skip-ktx2로 건너뛰고 나중에 한 번에 `npm run build:ktx2`를
돌리면 된다.

동작:
    1. meta.npz + plane.npz             →  public/gallery/<name>/meta.json
    2. k00.png … k{K-1}.png             →  public/gallery/<name>/
    3. public/gallery/index.json  에 name 추가 (중복 제외)
    4. node scripts/build-ktx2.mjs <name>  (--skip-ktx2 없을 때)
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

WEB_ROOT    = Path(__file__).resolve().parent.parent
GALLERY_DIR = WEB_ROOT / "public" / "gallery"


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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="outputs/<name>/ 폴더를 SLF 웹 갤러리용으로 변환"
    )
    parser.add_argument("name_dir", type=Path,
                        help="파이프라인 출력 폴더 경로 (outputs/<name>/)")
    parser.add_argument("--name", type=str, default=None,
                        help="갤러리 슬러그 (기본: name_dir 폴더명)")
    parser.add_argument("--skip-ktx2", action="store_true",
                        help="KTX2 압축(node scripts/build-ktx2.mjs)을 바로 실행하지 않고 PNG만 남겨둔다")
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

    coeff_min = float(sh_meta.get("coeff_min", np.float32(-8.0)))
    coeff_max = float(sh_meta.get("coeff_max", np.float32( 8.0)))
    meta = {
        "H":            int(sh_meta["H"]),
        "W":            int(sh_meta["W"]),
        "degree":       int(sh_meta["degree"]),
        "coeff_min":    coeff_min,
        "coeff_max":    coeff_max,
        # k01+(고차항/AC) 전용 범위 — k00보다 훨씬 좁게 잡아 8bit 인코딩 정밀도를 높인다
        # (model.py의 save_sh_pngs 참고). 구버전 sh_pngs/meta.npz에는 없을 수 있으니
        # 그런 경우엔 k00과 같은 범위로 폴백한다.
        "ac_coeff_min": float(sh_meta.get("ac_coeff_min", np.float32(coeff_min))),
        "ac_coeff_max": float(sh_meta.get("ac_coeff_max", np.float32(coeff_max))),
        "u_extent":     u_extent,
        "v_extent":     v_extent,
    }
    K = (meta["degree"] + 1) ** 2

    # ── 출력 디렉토리 ────────────────────────────────────────────────────────
    dst = GALLERY_DIR / name
    dst.mkdir(parents=True, exist_ok=True)

    # 이전 변환 방식(parallax mapping)의 잔여 파일이 있으면 정리한다 — 더는 어떤 코드도
    # 참조하지 않는다. k00.ktx2/coeffs.ktx2도 지운다 — 재변환이면 build:ktx2를 다시
    # 돌려야 새 PNG와 짝이 맞는 KTX2가 나오므로, 옛 것이 남아 혼동을 주지 않게 한다.
    (dst / "parallax.png").unlink(missing_ok=True)
    (dst / "parallax.ktx2").unlink(missing_ok=True)
    (dst / "k00.ktx2").unlink(missing_ok=True)
    (dst / "coeffs.ktx2").unlink(missing_ok=True)

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

    if args.skip_ktx2:
        print(f"\nPNG까지 완료 (--skip-ktx2). 나중에 `npm run build:ktx2 -- {name}`로 압축하세요.")
        return

    print(f"\n[ktx2] node scripts/build-ktx2.mjs {name}")
    try:
        subprocess.run(["node", "scripts/build-ktx2.mjs", name], cwd=WEB_ROOT, check=True)
    except FileNotFoundError:
        raise SystemExit(
            "Error: node를 찾을 수 없습니다 — KTX2 압축을 건너뛰려면 --skip-ktx2를 쓰거나, "
            f"Node.js 설치 후 `npm run build:ktx2 -- {name}`을 수동으로 실행하세요."
        )
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"Error: build-ktx2.mjs 실패 (exit {e.returncode})")

    print(f"\n완료. 브라우저에서 /gallery/{name}/ 로 접근 가능.")


if __name__ == "__main__":
    main()
