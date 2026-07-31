"""R5(地域降水 FB §9): 生の高解像度標高から 1° セル内の高分位標高を作る。

平均標高は気温・地表状態に、稜線標高は遮蔽・脱水に使い分ける。
入力: ETOPO 2022 v1 60 秒(1 分角)surface elevation の netCDF
出力: src/domain/data/earth_crest_1deg.json
  { widthCells, heightCells, quantile, crestMeters, maxMeters }

向きは ExoClim-3 の規約に合わせる(row 0 = 北端、col 0 = 西端 −180°)。
南米専用の判定は作らない — 全惑星で同じ演算(セル内分位)を使う。

実行: python scripts/build_crest_elevation.py <ETOPO.nc>
"""

import json
import sys
from pathlib import Path

import numpy as np
from netCDF4 import Dataset  # type: ignore

# セル内の高分位(最大値は単一ピクセルのノイズに弱いため p95 を主用途にする)
QUANTILE = 0.95
OUT_PATH = Path(__file__).resolve().parent.parent / "src" / "domain" / "data" / "earth_crest_1deg.json"


def main(nc_path: str) -> None:
    with Dataset(nc_path) as ds:
        var_name = next(
            (n for n in ("z", "elevation", "Band1") if n in ds.variables),
            None,
        )
        if var_name is None:
            raise SystemExit(f"標高変数が見つからない: {list(ds.variables)}")
        lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
        lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
        elev = np.asarray(ds.variables[var_name][:], dtype=np.float32)

    print(f"入力: {elev.shape} lat[{lat[0]:.2f}..{lat[-1]:.2f}] lon[{lon[0]:.2f}..{lon[-1]:.2f}]")

    # 1 セルあたりのピクセル数(60 秒 → 1° は 60×60)
    ny, nx = elev.shape
    py = ny // 180
    px = nx // 360
    if py * 180 != ny or px * 360 != nx:
        raise SystemExit(f"1° の整数倍でない: {ny}x{nx}")

    # 緯度が南→北なら反転して row 0 = 北端に合わせる
    if lat[0] < lat[-1]:
        elev = elev[::-1, :]
        print("緯度を反転(row 0 = 北端へ)")
    # 経度が 0..360 なら −180..180 へ回す
    if lon[0] >= 0:
        elev = np.roll(elev, nx // 2, axis=1)
        print("経度を回転(col 0 = −180° へ)")

    blocks = elev.reshape(180, py, 360, px).transpose(0, 2, 1, 3).reshape(180, 360, py * px)
    # 海面下は 0 に切り上げ(遮蔽に効くのは陸の高さ)
    positive = np.maximum(blocks, 0.0)
    crest = np.quantile(positive, QUANTILE, axis=2).astype(np.float32)
    peak = positive.max(axis=2).astype(np.float32)
    mean = positive.mean(axis=2).astype(np.float32)

    print(
        f"セル内 p{int(QUANTILE * 100)} 標高: 最大 {crest.max():.0f}m / "
        f"最大標高の最大 {peak.max():.0f}m / 平均標高の最大 {mean.max():.0f}m"
    )
    # 代表点の確認(南部アンデス ~46°S, 72°W と チベット ~32°N, 88°E)
    for name, la, lo in (("南部アンデス", -46.5, -72.5), ("チベット", 32.5, 88.5), ("アマゾン", -3.5, -62.5)):
        r = int((90 - la) // 1)
        c = int((lo + 180) // 1)
        print(f"  {name}: 平均 {mean[r, c]:.0f}m / p95 {crest[r, c]:.0f}m / 最大 {peak[r, c]:.0f}m")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "widthCells": 360,
                "heightCells": 180,
                "quantile": QUANTILE,
                "source": "ETOPO 2022 v1 60s surface elevation (NOAA, public domain)",
                "note": "row 0 = 北端、col 0 = −180°。海面下は 0 に切上げ。遮蔽・脱水にのみ使う",
                "crestMeters": [int(round(v)) for v in crest.ravel()],
                "maxMeters": [int(round(v)) for v in peak.ravel()],
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"出力: {OUT_PATH}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("使い方: python scripts/build_crest_elevation.py <ETOPO.nc>")
    main(sys.argv[1])
