# data/external — 外部データの取り込み

**この配下は ExoClim-3 が読む外部データの実体です。他のリポジトリを参照しません。**

## なぜコピーなのか

2026-08-08 まで、ExoClim-3 は地球検証データを隣の `derle-climate` リポジトリから
**直接読んでいました**(`../derle-climate/data/processed/` など、一部は絶対パス直書き)。

`derle-climate` は試作品で、アーカイブや移動の対象になり得ます。参照のままだと
**あちらのパスが変われば ExoClim-3 のフィクスチャ再生成が動かなくなる**ので、
利用者の判断(2026-08-08)により実体をこちらへ複製しました。

複製はサイズとハッシュ(sha256)で照合済みです。

## 中身と出所

### processed/ — 前処理済み(常用)

| ファイル | 出所 | 使う場所 |
|---|---|---|
| `etopo2022_surface_1deg.npz` | ETOPO 2022(NOAA)を 1° へ集約 | `build_earth_fixtures.py` / `rebuild_koppen_fixture.py` |
| `koppen_geiger_1991_2020_1deg.tif` | Beck et al. 2023 | `build_earth_fixtures.py` |
| `koppen_climate_1991_2020_1deg.nc` | Beck et al. 2023 付随の月別気候値 | `build_earth_fixtures.py` |
| `koppen_geiger_legend.txt` | 同上の凡例 | 参照用 |
| `earth_geography_1deg.npz` | 地球の陸海・標高(derle-climate 生成) | 参照用 |
| `shukkai_geography_1deg_inferred.npz` | デーレ(出界)の地形 1° | `build_derle_terrain.py` |
| `shukkai_geography_05deg_ai.npz` | 同 0.5° | `build_derle_terrain.py` |

### raw/ — 元データ(再生成のときだけ要る。**git 管理外**)

| ファイル | 大きさ | 出所 | 使う場所 |
|---|---:|---|---|
| `ETOPO_2022_v1_60s_surface.nc` | 478 MB | NOAA ETOPO 2022, 60 秒角, surface | `diag_land_fraction.py` |
| `koppen_geiger_tif_v2.zip` | 125 MB | Beck et al. 2023 の配布 zip | `rebuild_koppen_fixture.py` |
| `ne_50m_antarctic_ice_shelves_polys.geojson` | 128 KB | Natural Earth 50m 南極棚氷 | `apply_ice_shelf_mask.ts` |

**大きい 2 つは `.gitignore` で除外しています。** git に 600 MB を入れると履歴が
永久に重くなるためで、**再生成の手順(このファイル)と実体(ディスク上)の両方が
残っていれば目的は達せられる**という判断です。
消してしまった場合は上表の出所から取り直してください。

### config/ — デーレ(出界)の設定(derle-climate 由来)

| ファイル | 使う場所 |
|---|---|
| `map_labels_extracted.json` | `build_derle_countries.py` / `build_derle_country_polygons.py` |
| `v11_shukkai.json` | 正典の期待値の**出所**(値は `scripts/derle_common.ts` に転記済み) |
| `earth_analog_regions.json` | 参照用 |

## ライセンスと出典の扱い

`processed/` と `raw/` の地球のデータは、下の原典を 1° などへ集約・加工したもの。
ライセンスと引用の求めは原典に従う(2026-11-05 の公開にあたり確認)。

- **ETOPO 2022**: NOAA National Centers for Environmental Information (2022).
  *ETOPO 2022 15 Arc-Second Global Relief Model.* doi:10.25921/fd45-gt74
  (米国政府の作成物。引用を求めている)
- **Köppen-Geiger 1991–2020**: Beck, H.E., McVicar, T.R., Vergopolan, N. et al. (2023).
  *High-resolution (1 km) Köppen-Geiger maps for 1901–2099 based on constrained CMIP6 projections.*
  Scientific Data 10, 724. doi:10.1038/s41597-023-02549-6
  (データは CC BY 4.0。配布元 https://www.gloh2o.org/koppen/)
- **Natural Earth**: public domain(https://www.naturalearthdata.com/)

`shukkai_*` と `config/` は出界(作者の架空世界)の値で、上の原典とは関係ない。

## 変更したスクリプト(2026-08-08)

参照先を `../derle-climate/...` から `data/external/...` へ切り替えました。

```
scripts/build_earth_fixtures.py
scripts/rebuild_koppen_fixture.py
scripts/diag_land_fraction.py
scripts/build_derle_terrain.py
scripts/build_derle_countries.py
scripts/build_derle_country_polygons.py
scripts/apply_ice_shelf_mask.ts
```

コード中に残る `derle-climate` の語は**出所の記述**(コメント)だけで、
ファイルの読み込みには使っていません。
