"""抽出した国境ポリゴンを緯度経度へ変換し、国名ラベルと対応づける。

入力:
  out/derle/country_polygons.json      derle-map-visualizer から抽出した面(SVG 座標)
  data/external/config/map_labels_extracted.json  国名ラベル(緯度経度、出所 derle-climate)
出力:
  src/domain/data/derle_country_polygons.json
    { countries: [{ name|null, isStub, area, ring: [[lon,lat], ...] }] }

座標変換: ページ全体 = 360×180 度の等距円筒
  (map_labels_extracted.json の coordinate_note に従う)

名前の対応づけ: 国名ラベルの位置を内包するポリゴンにその名前を与える。
名前の付かないポリゴンは「スタブ(実在が怪しい)」として印を付け、
居住可能性ベンチでのペナルティを減衰させる。

実行: python scripts/build_derle_country_polygons.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLY_IN = ROOT / "out" / "derle" / "country_polygons.json"
LABELS = Path(__file__).resolve().parent.parent / "data" / "external" / "config" / "map_labels_extracted.json"
OUT = ROOT / "src" / "domain" / "data" / "derle_country_polygons.json"

COUNTRY_PATTERN = re.compile(r"国|共和|帝国|王国|連邦|公国|首領|領国|合議")
# 面積の下限(度²)。これ未満は湖・微小島の破片とみなす
MIN_AREA_DEG2 = 0.5


def ring_area_deg2(ring: list[list[float]]) -> float:
    """符号なし面積(度²)。緯度重みは掛けない粗い指標"""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def main() -> None:
    data = json.loads(POLY_IN.read_text(encoding="utf-8"))
    # 点の座標は viewBox 単位ではなく width/height 属性の単位(= AI のページ座標)。
    # 取り違えると 10 倍ずれるので、実際の点の範囲で自己検証する。
    w = float(data["pageSize"][0])
    h = float(data["pageSize"][1])

    labels = json.loads(LABELS.read_text(encoding="utf-8"))["labels"]
    names = [
        {"name": str(l["text"]).strip(), "lon": float(l["lon"]), "lat": float(l["lat"])}
        for l in labels
        if COUNTRY_PATTERN.search(str(l["text"]))
    ]
    print(f"ポリゴン {len(data['polygons'])} 個 / 国名ラベル {len(names)} 件")

    countries = []
    for poly in data["polygons"]:
        pts = poly["points"]
        if len(pts) < 4:
            continue
        # SVG 座標 → 経度緯度(ページ全体 = 360×180 度)
        ring = [[(x / w) * 360.0 - 180.0, 90.0 - (y / h) * 180.0] for x, y in pts]
        area = ring_area_deg2(ring)
        if area < MIN_AREA_DEG2:
            continue
        countries.append({"name": None, "isStub": True, "area": round(area, 3), "ring": ring})

    # 面積の大きい順に見て、内包するラベルの名前を与える(小さい面が優先)
    countries.sort(key=lambda c: c["area"])
    used: set[str] = set()
    for c in countries:
        for nm in names:
            if nm["name"] in used:
                continue
            if point_in_ring(nm["lon"], nm["lat"], c["ring"]):
                c["name"] = nm["name"].replace("（", "").replace("）", "")
                c["isStub"] = False
                used.add(nm["name"])
                break

    named = [c for c in countries if not c["isStub"]]
    stubs = [c for c in countries if c["isStub"]]
    print(f"面積 {MIN_AREA_DEG2}度² 以上の面 {len(countries)} 個")
    print(f"  名前つき {len(named)} 個 / 無名(スタブ扱い) {len(stubs)} 個")
    print(f"  未対応の国名ラベル {len(names) - len(used)} 件: {[n['name'] for n in names if n['name'] not in used][:8]}")
    for c in sorted(named, key=lambda x: -x["area"])[:8]:
        print(f"    {c['name']}: 面積 {c['area']:.1f} 度²")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": "derle-map-visualizer の国境線から復元(Playwright ヘッドレス)",
                "note": "ring は [経度, 緯度]。isStub = 国名ラベルが内包されない面。"
                "スタブは実在が怪しいため居住可能性ベンチのペナルティを減衰させる",
                "minAreaDeg2": MIN_AREA_DEG2,
                "countries": countries,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"出力: {OUT}")


if __name__ == "__main__":
    main()
