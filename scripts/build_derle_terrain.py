"""デーレ(出界)の地形を ExoClim-3 形式へ変換する。

入力: data/external/processed/shukkai_geography_*.npz(1° と 0.5°、出所 derle-climate)
出力: src/domain/data/derle_terrain_1deg.json
  { widthCells, heightCells, elevationMeters, landMask, crestMeters }

向きの規約: ExoClim-3 は row 0 = 北端、col 0 = 西端(−180°)。
デーレ側は lat が南→北なので反転する。
crestMeters は 0.5° データを 1° セルへ最大値集約したもの(R5 の遮蔽用。
高解像度の元データがこれしかないため、セル内 4 点の最大 = 粗い稜線推定)。

実行: python scripts/build_derle_terrain.py
"""

import json
from pathlib import Path

import numpy as np

SRC_DIR = Path(__file__).resolve().parent.parent / "data" / "external" / "processed"
OUT_PATH = Path(__file__).resolve().parent.parent / "src" / "domain" / "data" / "derle_terrain_1deg.json"
OCEAN_FLOOR_M = -4000.0


def main() -> None:
    d1 = np.load(SRC_DIR / "shukkai_geography_1deg_inferred.npz")
    land = np.asarray(d1["land"], dtype=bool)
    elev = np.asarray(d1["elev"], dtype=np.float64)
    lat = np.asarray(d1["lat"], dtype=np.float64)
    lon = np.asarray(d1["lon"], dtype=np.float64)

    # row 0 = 北端 へ
    if lat[0] < lat[-1]:
        land = land[::-1, :]
        elev = elev[::-1, :]
        print("1° を反転(row 0 = 北端へ)")
    if lon[0] >= 0:
        land = np.roll(land, land.shape[1] // 2, axis=1)
        elev = np.roll(elev, elev.shape[1] // 2, axis=1)
        print("1° を回転(col 0 = −180° へ)")

    # 海セルは負の水深にする(ExoClim-3 の規約)。元データは陸のみ標高で海は 0
    elevation = np.where(land, np.maximum(elev, 1.0), OCEAN_FLOOR_M)

    # 0.5° から 1° セル内の最大標高(粗い稜線推定 — R5 の遮蔽用)
    d05 = np.load(SRC_DIR / "shukkai_geography_05deg_ai.npz")
    land05 = np.asarray(d05["land"], dtype=bool)
    elev05 = np.asarray(d05["elev"], dtype=np.float64)
    lat05 = np.asarray(d05["lat"], dtype=np.float64)
    lon05 = np.asarray(d05["lon"], dtype=np.float64)
    if lat05[0] < lat05[-1]:
        land05 = land05[::-1, :]
        elev05 = elev05[::-1, :]
    if lon05[0] >= 0:
        land05 = np.roll(land05, land05.shape[1] // 2, axis=1)
        elev05 = np.roll(elev05, elev05.shape[1] // 2, axis=1)
    pos05 = np.where(land05, np.maximum(elev05, 0.0), 0.0)
    crest = pos05.reshape(180, 2, 360, 2).transpose(0, 2, 1, 3).reshape(180, 360, 4).max(axis=2)
    crest = np.maximum(crest, np.where(land, np.maximum(elev, 0.0), 0.0))

    w = np.cos(np.radians(90.0 - (np.arange(180) + 0.5)))[:, None]
    land_frac = float((land * w).sum() / (w.sum() * 360))
    print(
        f"陸率(面積重み) {land_frac * 100:.1f}% / 最高標高 {elevation.max():.0f}m / "
        f"稜線最大 {crest.max():.0f}m / 陸平均標高 {elevation[land].mean():.0f}m"
    )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "widthCells": 360,
                "heightCells": 180,
                "source": "derle-climate shukkai_geography_1deg_inferred.npz + 05deg_ai.npz",
                "note": "row 0 = 北端、col 0 = −180°。海は水深 −4000m。crest は 0.5° の最大集約",
                "elevationMeters": [round(float(v), 1) for v in elevation.ravel()],
                "landMask": [int(v) for v in land.ravel()],
                "crestMeters": [round(float(v), 1) for v in crest.ravel()],
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"出力: {OUT_PATH}")


if __name__ == "__main__":
    main()
