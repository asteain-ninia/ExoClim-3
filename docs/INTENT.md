# 一次資料の索引 — Worldbuilding Pasta

ExoClim-3 の段階構成・用語・可視化は Worldbuilding Pasta の手法を踏襲する。
物理モデルや判定ロジックの実装・修正時は、まず該当パートを確認すること。
動画は AI から視聴できないため、ブログ記事(テキスト)と手元要約を優先する。

## ブログ: "An Apple Pie from Scratch"

- **Part VIb: Climate — Biomes and Climate Zones**
  <https://worldbuildingpasta.blogspot.com/2020/05/an-apple-pie-from-scratch-part-vib.html>
- **Part VIc: Climate — Climate Zones of Exotic Worlds**
  <https://worldbuildingpasta.blogspot.com/2020/10/an-apple-pie-from-scratch-part-vic.html>
- **Climate Explorations: Temperature** (2022-05)
  <https://worldbuildingpasta.blogspot.com/2022/05/climate-explorations-temperature.html>
- **Public Climate Data Re-Explorations with the Pasta Bioclimate System** (2025-09)
  <https://worldbuildingpasta.blogspot.com/2025/09/public-climate-data-re-explorations.html>

## YouTube: Worldbuilder's Log(番号は本人付与)

- **#28 Ocean Currents** — <https://www.youtube.com/watch?v=UgJ67AswrEs>
- **#31 Precipitation** — <https://www.youtube.com/watch?v=lHV-jZUB5WU>
- **#32 Precipitation & Pressure Redo** — <https://www.youtube.com/watch?v=2RMyd9vo2Qk>
- **#37 Tropical Climates** — <https://www.youtube.com/watch?v=vi66amwP2g0>
- **#40 Continental Climates** — <https://www.youtube.com/watch?v=CYaHD9IKb2g>

## 手元資料(ExoClim-2 から複写、[参考-ExoClim2/](参考-ExoClim2/))

- 動画 #28/#31/#32/#37/#40 のユーザー作成要約
- Part VIb Step 7 Climate Zones の本文転記
- ExoClim-2 版の物理仕様書(spec 7 本) — **前世代の実装判断を含むため
  参照時は注意**。一次資料と食い違う場合は一次資料を優先する。

## 定量物理の補助資料(Pasta が定量を示さない箇所の標準手法)

- エネルギー収支モデル: North & Coakley (1979) 型の季節 EBM。
- ケッペン=ガイガー閾値: Peel, Finlayson & McMahon (2007),
  "Updated world map of the Köppen-Geiger climate classification"。
- 軌道要素と日射: Berger (1978) の日平均日射公式。
