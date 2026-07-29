# -*- coding: utf-8 -*-
"""地球フィクスチャ生成スクリプト。

../derle-climate/data/processed/ の処理済みデータ(出所・ライセンスは同リポジトリの
data/manifest.json 参照)から、ExoClim-3 用の JSON フィクスチャを生成する。

- ETOPO 2022 (NOAA, CC0): 1° 標高 + 陸海マスク → src/domain/data/earth_terrain_1deg.json
- Beck et al. 2023 Köppen-Geiger v2 1991-2020 (CC BY 4.0): 1° 観測気候区分
  → tests/fixtures/earth_koppen_1deg.json
- 同 underpinning 月別気候平年値: 2° に間引いた月別気温・降水
  → tests/fixtures/earth_climate_2deg.json

固定の向き: row 0 = 北端 (lat +89.5°)、col 0 = 西端 (lon -179.5°)。
実行: python scripts/build_earth_fixtures.py
"""

import json
import os
import sys

import numpy as np

BASE = os.path.join(os.path.dirname(__file__), "..", "..", "derle-climate", "data", "processed")
OUT_ROOT = os.path.join(os.path.dirname(__file__), "..")


def load_etopo():
    z = np.load(os.path.join(BASE, "etopo2022_surface_1deg.npz"))
    lat = z["lat"]  # 89.5 .. -89.5 (北から)
    elev = z["elev"].astype(np.float64)  # (180, 360) row 0 = lat +89.5
    land = z["land"]
    assert lat[0] > 0 > lat[-1], "lat は北から降順のはず"
    return elev, land


def load_koppen_tif():
    from PIL import Image

    im = Image.open(os.path.join(BASE, "koppen_geiger_1991_2020_1deg.tif"))
    a = np.array(im)  # (180, 360) uint8, GeoTIFF は row 0 = 北端
    assert a.shape == (180, 360)
    return a


def load_monthly_climate():
    import netCDF4 as nc

    ds = nc.Dataset(os.path.join(BASE, "koppen_climate_1991_2020_1deg.nc"))
    print("nc variables:", {k: v.shape for k, v in ds.variables.items()})
    return ds


KOPPEN_CLASSES = [
    "Af", "Am", "Aw", "BWh", "BWk", "BSh", "BSk",
    "Csa", "Csb", "Csc", "Cwa", "Cwb", "Cwc",
    "Cfa", "Cfb", "Cfc",
    "Dsa", "Dsb", "Dsc", "Dsd", "Dwa", "Dwb", "Dwc", "Dwd",
    "Dfa", "Dfb", "Dfc", "Dfd", "ET", "EF",
]


def cell_index(lat_deg, lon_deg):
    """緯度経度 → (row, col)。row 0 = 89.5N、col 0 = 179.5W。"""
    row = int(round(89.5 - lat_deg + 0.0))
    col = int(round(lon_deg + 179.5))
    return row, col


def sanity_checks(elev, land, koppen):
    # ヒマラヤ (28.0N, 87.0E) は高標高の陸
    r, c = cell_index(28.5, 86.5)
    assert land[r, c] and elev[r, c] > 3000, f"Himalaya check failed: {elev[r, c]}"
    # 太平洋中央 (0N, 160W) は海
    r, c = cell_index(0.5, -159.5)
    assert not land[r, c] and elev[r, c] < -3000, f"Pacific check failed: {elev[r, c]}"
    # サハラ中央 (23N, 10E) は BWh (=4)
    r, c = cell_index(23.5, 9.5)
    assert koppen[r, c] == 4, f"Sahara check failed: {koppen[r, c]}"
    # シンガポール付近 (1.5N, 103.5E) は Af (=1) か海
    r, c = cell_index(1.5, 103.5)
    assert koppen[r, c] in (0, 1, 2), f"Singapore check failed: {koppen[r, c]}"
    # 南極中央 (85S, 0E) は EF (=30)
    r, c = cell_index(-84.5, 0.5)
    assert koppen[r, c] == 30, f"Antarctica check failed: {koppen[r, c]}"
    # 陸面積率が実地球 (約29.2%) に近いこと(cos(lat) の面積重みつき)
    lats = 89.5 - np.arange(180)
    w = np.cos(np.deg2rad(lats))[:, None] * np.ones((1, 360))
    frac = (w * land).sum() / w.sum()
    print(f"area-weighted land fraction: {frac * 100:.1f}%")
    assert 0.27 < frac < 0.31
    print("sanity checks OK")


def main():
    elev, land = load_etopo()
    koppen = load_koppen_tif()
    # モデル用の陸海マスクは ETOPO 中心サンプル(面積重み 29.1% で実地球と一致)。
    # Beck ラスターとの採点は「両者が陸のセル」に限定する(検証ハーネス側の責務)。
    both = land & (koppen > 0)
    print(f"scoring cells (model-land & beck-land): {both.sum()}")
    sanity_checks(elev, land, koppen)

    os.makedirs(os.path.join(OUT_ROOT, "src", "domain", "data"), exist_ok=True)
    os.makedirs(os.path.join(OUT_ROOT, "tests", "fixtures"), exist_ok=True)

    terrain = {
        "description": "実在地球 1° 地形。ETOPO 2022 (NOAA, CC0) を 1° に間引いたもの。row 0 = 89.5N, col 0 = 179.5W。",
        "widthCells": 360,
        "heightCells": 180,
        "elevationMeters": [int(round(v)) for v in elev.flatten()],
        "landMask": [int(v) for v in land.flatten()],
    }
    with open(os.path.join(OUT_ROOT, "src", "domain", "data", "earth_terrain_1deg.json"), "w") as f:
        json.dump(terrain, f, separators=(",", ":"))

    kop = {
        "description": "Beck et al. 2023 Köppen-Geiger v2 (1991-2020, 1°, CC BY 4.0)。0=海/欠測、1-30=下記 classes。row 0 = 89.5N。",
        "citation": "Beck, H. E., et al. High-resolution (1 km) Köppen-Geiger maps for 1901-2099 based on constrained CMIP6 projections, Scientific Data 10, 724 (2023).",
        "widthCells": 360,
        "heightCells": 180,
        "classes": KOPPEN_CLASSES,
        "classRaster": [int(v) for v in koppen.flatten()],
    }
    with open(os.path.join(OUT_ROOT, "tests", "fixtures", "earth_koppen_1deg.json"), "w") as f:
        json.dump(kop, f, separators=(",", ":"))

    # 月別気候平年値 (2° 間引き)
    ds = load_monthly_climate()
    names = list(ds.variables.keys())
    print("choosing from:", names)
    # 変数名を柔軟に解決
    tair = None
    prec = None
    for cand in ["tas", "air_temperature", "temperature", "tavg", "t2m"]:
        if cand in names:
            tair = ds.variables[cand]
            break
    for cand in ["pr", "precipitation", "precip", "prec", "ppt"]:
        if cand in names:
            prec = ds.variables[cand]
            break
    if tair is None or prec is None:
        print("!! 月別変数を特定できず。names を確認して修正すること:", names)
        sys.exit(1)

    t = np.array(tair[:])  # 期待 (12, 180, 360)
    p = np.array(prec[:])
    print("t/p shapes:", t.shape, p.shape, "t range", np.nanmin(t), np.nanmax(t))

    lat_var = ds.variables.get("lat") or ds.variables.get("latitude")
    lat0 = float(np.array(lat_var[:])[0]) if lat_var is not None else 89.5
    flip = lat0 < 0  # 南から始まるなら反転して北 row 0 に
    if flip:
        t = t[:, ::-1, :]
        p = p[:, ::-1, :]

    # 単位: 気温は K なら °C に。降水は kg/m2/s なら mm/月 に。
    if np.nanmax(t) > 200:
        t = t - 273.15
    if np.nanmax(p) < 1e-2:
        p = p * 86400 * 30.4375  # kg/m2/s -> mm/月

    # 2° 間引き(セル中心サンプル)
    t2 = t[:, ::2, ::2]
    p2 = p[:, ::2, ::2]

    clim = {
        "description": "Beck et al. 2023 underpinning 月別気候平年値 (1991-2020) を 2° に間引き。気温 0.1°C 単位整数、降水 mm/月 整数。row 0 = 89N 側。欠測は -9999。",
        "widthCells": 180,
        "heightCells": 90,
        "monthlyTemperatureDeciC": [
            [-9999 if not np.isfinite(v) else int(round(v * 10)) for v in t2[m].flatten()]
            for m in range(12)
        ],
        "monthlyPrecipitationMm": [
            [-9999 if not np.isfinite(v) else int(round(v)) for v in p2[m].flatten()]
            for m in range(12)
        ],
    }
    with open(os.path.join(OUT_ROOT, "tests", "fixtures", "earth_climate_2deg.json"), "w") as f:
        json.dump(clim, f, separators=(",", ":"))

    print("done. sizes:")
    for rel in [
        ("src", "domain", "data", "earth_terrain_1deg.json"),
        ("tests", "fixtures", "earth_koppen_1deg.json"),
        ("tests", "fixtures", "earth_climate_2deg.json"),
    ]:
        path = os.path.join(OUT_ROOT, *rel)
        print(" ", os.path.join(*rel), f"{os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
