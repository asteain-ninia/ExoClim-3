"""Beck の 30 秒角の元データから 1° のケッペン観測フィクスチャを作り直す。

## なぜ作り直すか(2026-08-01 の実測)

既存の `earth_koppen_1deg.json` は配布元の 1° 版(koppen_geiger_1p0.tif)を
そのまま使っていた。しかしこれは陸域を過大に塗っている:

- 観測の陸面積はモデル地形の **1.21 倍**
- モデルが海と判定するセルのうち 3,844 個を観測は陸としている
- その真の陸率(ETOPO 60 秒で標高 > 0 の画素割合)は**中央値 0.087**、
  面積重みの **46.4% が陸率 5% 未満**、うち 305 セルは陸が実質ゼロ

1° グリッドに写る島はほとんど無いはずで、配布元の 1° 版は
「少しでも陸があれば陸」に寄せた集約になっていると考えられる。

## 作り直しの方針

30 秒角(0.00833333°)の元データを 1° へ**多数決**で集約する。
1 セル = 120×120 画素。**画素の過半が同じ気候区分でなければ採用しない**、
ではなく「陸画素(値 > 0)が閾値以上を占めるセルだけを陸とし、
その中の最頻値を採る」。閾値はモデルの陸判定(陸率 0.5)と揃える。
ただし Beck 元ラスターはカスピ海などの内水面にも気候クラスを持つため、
最後にモデルと同じ ETOPO 1° 陸マスクで水域を 0 にする。

これで観測とモデルが同じ陸を指すようになり、採点対象の食い違いが消える。

## 実行

    python scripts/rebuild_koppen_fixture.py

出力:
- tests/fixtures/earth_koppen_1deg.json(検証用)
- src/domain/data/earth_koppen_1deg.json(UI 表示用)

両方を同じ内容で更新し、検証結果と画面表示の食い違いを防ぐ。
上書き前のファイルはそれぞれ .bak に退避する。
"""

import json
import os
import shutil
import zipfile

import numpy as np

BASE = os.path.join(os.path.dirname(__file__), "..", "..", "derle-climate", "data")
ZIP = os.path.join(BASE, "raw", "koppen_geiger_tif_v2.zip")
MEMBER = "1991_2020/koppen_geiger_0p00833333.tif"
NPZ = os.path.join(BASE, "processed", "etopo2022_surface_1deg.npz")
VALIDATION_OUT = os.path.join(
    os.path.dirname(__file__), "..", "tests", "fixtures", "earth_koppen_1deg.json"
)
DISPLAY_OUT = os.path.join(
    os.path.dirname(__file__), "..", "src", "domain", "data", "earth_koppen_1deg.json"
)
OUTPUTS = [VALIDATION_OUT, DISPLAY_OUT]

# 陸とみなす画素割合の下限。モデルの陸判定(1° セルの陸率 0.5)と揃える
LAND_FRACTION_MIN = 0.5

KOPPEN_CLASSES = [
    "",
    "Af", "Am", "Aw",
    "BWh", "BWk", "BSh", "BSk",
    "Csa", "Csb", "Csc",
    "Cwa", "Cwb", "Cwc",
    "Cfa", "Cfb", "Cfc",
    "Dsa", "Dsb", "Dsc", "Dsd",
    "Dwa", "Dwb", "Dwc", "Dwd",
    "Dfa", "Dfb", "Dfc", "Dfd",
    "ET", "EF",
]


def load_high_res() -> np.ndarray:
    """30 秒角のラスタを (10800, 21600) uint8 で返す(row 0 = 北端)"""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    with zipfile.ZipFile(ZIP) as z:
        with z.open(MEMBER) as fh:
            import io

            data = fh.read()
    im = Image.open(io.BytesIO(data))
    a = np.array(im)
    print(f"元データ: {a.shape} {a.dtype} / 値域 {a.min()}..{a.max()}")
    return a


def main() -> None:
    a = load_high_res()
    ny, nx = a.shape
    fy, fx = ny // 180, nx // 360
    assert fy * 180 == ny and fx * 360 == nx, f"1° の整数倍でない: {fy},{fx}"
    print(f"集約: 1 セル = {fy}×{fx} 画素")

    out = np.zeros((180, 360), dtype=np.int32)
    landFrac = np.zeros((180, 360), dtype=np.float64)
    per = fy * fx
    for r in range(180):
        block = a[r * fy : (r + 1) * fy, :].reshape(fy, 360, fx)
        # 各 1° セルについて、区分ごとの画素数を数える
        for c in range(360):
            cell = block[:, c, :].ravel()
            land = cell[cell > 0]
            landFrac[r, c] = land.size / per
            if land.size / per < LAND_FRACTION_MIN:
                continue
            counts = np.bincount(land, minlength=31)
            out[r, c] = int(counts.argmax())

    z = np.load(NPZ)
    modelLand = z["land"]
    # Beck はカスピ海などの内水面にもクラスを持つ。表示と採点で
    # 水域の定義を揃えるため、ETOPO で海のセルは欠測とする。
    maskedWaterCells = int(((out > 0) & ~modelLand).sum())
    out[~modelLand] = 0
    print(f"ETOPO 水域の Beck クラスを除外: {maskedWaterCells} セル")
    w = np.cos(np.deg2rad(np.linspace(89.5, -89.5, 180)))[:, None] * np.ones((1, 360))

    hasObs = out > 0
    both = hasObs & modelLand
    print(f"\n作り直し後: 観測陸 {int(hasObs.sum())} セル / モデル陸 {int(modelLand.sum())} セル")
    print(f"  共通 {int(both.sum())} セル")
    print(
        f"  観測のみ陸 {int((hasObs & ~modelLand).sum())} セル "
        f"(面積重み {w[hasObs & ~modelLand].sum() / w[hasObs].sum() * 100:.1f}%)"
    )
    print(
        f"  モデルのみ陸 {int((modelLand & ~hasObs).sum())} セル "
        f"(面積重み {w[modelLand & ~hasObs].sum() / w[modelLand].sum() * 100:.1f}%)"
    )
    print(f"  観測 / モデルの陸面積比: {w[hasObs].sum() / w[modelLand].sum():.4f}")

    # 参考: 旧フィクスチャとの比較
    if os.path.exists(VALIDATION_OUT):
        old = np.array(
            json.load(open(VALIDATION_OUT, encoding="utf-8"))["classRaster"],
            dtype=np.int32,
        ).reshape(180, 360)
        oldHas = old > 0
        print(f"\n旧フィクスチャ: 観測陸 {int(oldHas.sum())} セル")
        agree = (old == out) & both
        print(
            f"  共通陸セルでの区分一致: {w[agree].sum() / w[both].sum() * 100:.2f}%"
        )
    payload = {
        "source": "Beck et al. 2023 Koppen-Geiger 1991-2020 (0.00833333 deg) を "
        f"1 度へ多数決集約。陸画素が {LAND_FRACTION_MIN} 以上を占め、"
        "ETOPO 1° 陸マスクで陸のセルのみ採用",
        "note": "配布元の 1 度版は陸域を過大に塗っており(モデル地形の 1.21 倍、"
        "除外セルの真の陸率は中央値 0.087)、採点対象が食い違っていた。"
        "Beck が気候クラスを持つ内水面(カスピ海など)も ETOPO 水域として除外",
        "landFractionMin": LAND_FRACTION_MIN,
        "widthCells": 360,
        "heightCells": 180,
        "classes": KOPPEN_CLASSES,
        "classRaster": [int(v) for v in out.flatten()],
    }
    for output in OUTPUTS:
        if os.path.exists(output):
            shutil.copy(output, output + ".bak")
        with open(output, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        print(f"出力: {output}")


if __name__ == "__main__":
    main()
