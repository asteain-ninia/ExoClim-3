"""デーレの地図ラベルから国名アンカーを抽出する。

出力: src/domain/data/derle_countries.json
  [{ name, lon, lat }]

用途: 「全土アネクメーネ(居住不能)の国が無い」ベンチマーク。
各国のラベル位置を中心に一定半径の陸セルを国土の代理とみなす
(正確な国境は未取得のため、位置アンカー + 半径の近似)。

実行: python scripts/build_derle_countries.py
"""

import json
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "data" / "external" / "config" / "map_labels_extracted.json"
OUT = Path(__file__).resolve().parent.parent / "src" / "domain" / "data" / "derle_countries.json"

# 国・領邦を示す語(都市国家も国として扱う)
COUNTRY_PATTERN = re.compile(r"国|共和|帝国|王国|連邦|公国|首領|領国|合議")


def main() -> None:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    seen: set[str] = set()
    countries = []
    for label in data["labels"]:
        text = str(label["text"]).strip()
        if not COUNTRY_PATTERN.search(text):
            continue
        # 括弧つきの仮称(（太陽国）など)は残すが、記号は落とす
        name = text.replace("（", "").replace("）", "").replace("(", "").replace(")", "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        countries.append(
            {"name": name, "lon": round(float(label["lon"]), 3), "lat": round(float(label["lat"]), 3)}
        )
    countries.sort(key=lambda c: c["name"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "source": "derle-climate config/map_labels_extracted.json",
                "note": "国名ラベルの位置アンカー。正確な国境は未取得のため、"
                "居住可能性の判定では各アンカー周辺の陸セルを国土の代理とする",
                "countries": countries,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"{len(countries)} 国を抽出 → {OUT}")
    for c in countries[:8]:
        print(f"  {c['name']} ({c['lon']}, {c['lat']})")


if __name__ == "__main__":
    main()
