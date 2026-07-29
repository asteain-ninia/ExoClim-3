# 一次資料の索引 — 手描き気候地図の系譜と Worldbuilding Pasta

ExoClim は「動画チュートリアルで紹介される**手描きの気候地図作成手順**を
模倣・自動化する」プロジェクトである。この手法には系譜がある:

1. **Geoff's Climate Cookbook**(テキスト、最古の体系化) — 海流 → 気圧・風 →
   気温・降水 → 気候帯、の順にレイヤーを重ねる原型。
2. **Artifexian**(YouTube) — Cookbook 系手順の動画化で最も普及した解説。
   海流(環流テンプレート)→ 1 月/7 月の気圧配置 → 風 → ケッペン当てはめ。
3. **Madeline James Writes**(ブログ) — 気圧・降水の実践的な整理。
4. **Worldbuilding Pasta**(ブログ + Worldbuilder's Log) — 最も精緻。
   ExoClim の段階構成・用語・可視化はこれを一次参照とする。

ExoClim-3 の役割: 各ステップの中間地図(海流・気圧と風帯・気温・降水)を
自動生成して表示する = **手描き派にとっては「下絵と答え合わせ」、
自動化派にとっては完成図**、の両対応。UI のタブは作図手順の順序に並ぶ。

> **注意**: AI エージェントは動画を視聴できない。ブログ記事(テキスト)と
> 手元要約を優先する。Artifexian の動画固有の細部(数値・例外則)を仕様へ
> 取り込みたい場合は、Pasta のときと同様にユーザーによる要約・転記を
> `docs/参考-ExoClim2/動画要約/` 方式で追加してほしい。

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

## 手描き手順の系譜資料(テキスト)

- **Geoff's Climate Cookbook の解説**(Worldbuilding Workshop)
  <https://worldbuildingworkshop.com/2015/11/27/climate/>
- **Madeline James Writes: Temperature and Precipitation**
  <https://www.madelinejameswrites.com/blog/temperature-and-precipitation>
- **Artifexian**(YouTube チャンネル。動画のため直接参照不可、要約歓迎)
  <https://www.youtube.com/@Artifexian>

## 定量物理の補助資料(Pasta が定量を示さない箇所の標準手法)

- エネルギー収支モデル: North & Coakley (1979) 型の季節 EBM。
- ケッペン=ガイガー閾値: Peel, Finlayson & McMahon (2007),
  "Updated world map of the Köppen-Geiger climate classification"。
- 軌道要素と日射: Berger (1978) の日平均日射公式。
