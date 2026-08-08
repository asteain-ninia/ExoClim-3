"""1° セルごとの真の陸率を ETOPO 60 秒から求め、陸判定の閾値を検討する。

動機(利用者の指摘 2026-08-01): 観測(Beck)のケッペン図がモデル地形より
膨らんで見える。実測したところ観測の陸面積はモデルの 1.21 倍で、
観測陸の 18.0% が採点対象外。しかもその除外分は熱帯に大きく偏っている
(A 熱帯が採点対象 20.6% に対し除外分 46.8%、Af だけで 25.2%)。
除外セルの 13.4% はモデル陸から 7 セル以上離れており、これは島嶼である。

ここでは 1° セルごとに「標高 > 0 の 60 秒画素の割合」= 真の陸率を出し、
現在の陸マスク(sum=22090)がどの閾値に相当するか、閾値を下げると
どれだけ島が拾えるかを調べる。

実行: python scripts/diag_land_fraction.py
"""

import json
import os

import numpy as np
from netCDF4 import Dataset

BASE = os.path.join(os.path.dirname(__file__), "..", "data", "external")
NC = os.path.join(BASE, "raw", "ETOPO_2022_v1_60s_surface.nc")
NPZ = os.path.join(BASE, "processed", "etopo2022_surface_1deg.npz")
KOPPEN = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "earth_koppen_1deg.json")


def main() -> None:
    z = np.load(NPZ)
    land1 = z["land"]  # (180, 360) bool 現在の陸マスク

    with Dataset(NC) as ds:
        var = "z" if "z" in ds.variables else list(ds.variables)[-1]
        lat = np.asarray(ds.variables["lat"][:])
        elev = ds.variables[var]
        ny, nx = elev.shape
        print(f"ETOPO 60s: {ny}×{nx} / lat {lat[0]:.2f}..{lat[-1]:.2f}")
        fy, fx = ny // 180, nx // 360
        assert fy * 180 == ny and fx * 360 == nx, f"整数倍でない: {fy},{fx}"

        frac = np.zeros((180, 360), dtype=np.float64)
        # 行ブロックごとに読む(全部載せるとメモリを食う)
        for r in range(180):
            block = np.asarray(elev[r * fy : (r + 1) * fy, :], dtype=np.float32)
            isLand = block > 0
            frac[r] = isLand.reshape(fy, 360, fx).sum(axis=(0, 2)) / (fy * fx)
        # 緯度が南から並ぶ netCDF なら南北を反転(npz は北から)
        if lat[0] < lat[-1]:
            frac = frac[::-1]

    kop = np.array(json.load(open(KOPPEN, encoding="utf-8"))["classRaster"], dtype=np.int32).reshape(180, 360)
    hasObs = kop > 0

    w = np.cos(np.deg2rad(np.linspace(89.5, -89.5, 180)))[:, None] * np.ones((1, 360))

    print(f"\n現在の陸マスク: {int(land1.sum())} セル")
    print(f"陸率 > 0 のセル: {int((frac > 0).sum())} / 陸率 >= 0.5 のセル: {int((frac >= 0.5).sum())}")

    # 現在のマスクがどの閾値に相当するか
    for t in [0.0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5]:
        n = int((frac > t).sum())
        agree = int(((frac > t) == land1).sum())
        print(f"  閾値 {t:>4}: {n:>6} セル / 現マスクとの一致 {agree / (180 * 360) * 100:.2f}%")

    # 除外セル(観測は陸、モデルは海)の真の陸率
    excluded = hasObs & ~land1
    ef = frac[excluded]
    ew = w[excluded]
    print(f"\n除外セル {int(excluded.sum())} 個の真の陸率:")
    for lo, hi in [(0, 0.001), (0.001, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.5), (0.5, 1.01)]:
        m = (ef >= lo) & (ef < hi)
        print(
            f"  {lo:>5} 〜 {hi:<5}: {int(m.sum()):>5} セル "
            f"(面積重み {ew[m].sum() / ew.sum() * 100:>5.1f}%)"
        )
    print(f"  除外セルの陸率 中央値 {np.median(ef):.3f} / 平均 {ef.mean():.3f}")

    # 閾値を下げたときに拾える観測陸の割合
    print("\n陸判定の閾値を下げたとき、観測陸のうち採点できる割合(面積重み):")
    obsW = w[hasObs].sum()
    for t in [0.5, 0.3, 0.2, 0.1, 0.05, 0.01, 0.0]:
        newLand = frac > t
        both = hasObs & newLand
        print(
            f"  閾値 {t:>4}: 陸 {int(newLand.sum()):>6} セル / "
            f"採点できる観測陸 {w[both].sum() / obsW * 100:>5.1f}% / "
            f"陸なのに観測が無いセル {int((newLand & ~hasObs).sum()):>5}"
        )

    np.save(os.path.join(os.path.dirname(__file__), "..", "out", "land_fraction_1deg.npy"), frac)
    print("\n陸率を out/land_fraction_1deg.npy に保存")


if __name__ == "__main__":
    main()
