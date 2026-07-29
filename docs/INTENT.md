# 一次資料の索引 — 手描き気候地図の系譜と Worldbuilding Pasta

ExoClim は「動画チュートリアルで紹介される**手描きの気候地図作成手順**を
模倣・自動化する」プロジェクトである。この手法には系譜がある:

1. **Geoff's Climate Cookbook**(テキスト、最古の体系化) — 海流 → 気圧・風 →
   気温・降水 → 気候帯、の順にレイヤーを重ねる原型。
2. **Artifexian**(YouTube) — Cookbook 系手順の動画化で最も普及した解説
   (単発チュートリアル群)。
3. **Madeline James Writes**(ブログ) — 気圧・降水の実践的な整理。
4. **Worldbuilding Pasta**(ブログ「An Apple Pie from Scratch」) — 最も精緻な
   テキスト。物理仕様の一次参照。
5. **Artifexian「Worldbuilder's Log」シリーズ**(YouTube) — 架空惑星 CRETÁK を
   題材に、Pasta + Madeline James の手法を**実際に描いて見せる**実演シリーズ。
   ExoClim が模倣・自動化する「手順」の直接の見本。

> **帰属の訂正(2026-07-29)**: 旧 ExoClim-2 の INTENT は Worldbuilder's Log を
> Worldbuilding Pasta 名義と誤記していた。実チャンネルは Artifexian。
> 旧文書・旧要約は参考にとどめ、疑わしい点は取得済みの書き起こしで裏を取ること。

ExoClim-3 の役割: 各ステップの中間地図(海流・気圧と風帯・気温・降水)を
自動生成して表示する = **手描き派にとっては「下絵と答え合わせ」、
自動化派にとっては完成図**、の両対応。UI のタブは作図手順の順序に並ぶ。

> **注意**: AI エージェントは動画の映像・音声を直接視聴できないが、
> **自動字幕(書き起こし)は yt-dlp で取得できる**(`scripts/fetch_transcripts.sh`)。
> 動画内容の裏取りは書き起こしで行い、ブログ(Pasta)を物理仕様の一次資料とする。
> 画面上の作図・図表など字幕に乗らない情報だけは、ユーザーの目視情報が頼り。

## ブログ: "An Apple Pie from Scratch"

- **Part VIb: Climate — Biomes and Climate Zones**
  <https://worldbuildingpasta.blogspot.com/2020/05/an-apple-pie-from-scratch-part-vib.html>
- **Part VIc: Climate — Climate Zones of Exotic Worlds**
  <https://worldbuildingpasta.blogspot.com/2020/10/an-apple-pie-from-scratch-part-vic.html>
- **Climate Explorations: Temperature** (2022-05)
  <https://worldbuildingpasta.blogspot.com/2022/05/climate-explorations-temperature.html>
- **Public Climate Data Re-Explorations with the Pasta Bioclimate System** (2025-09)
  <https://worldbuildingpasta.blogspot.com/2025/09/public-climate-data-re-explorations.html>

## YouTube: Artifexian「Worldbuilder's Log」気候関連回(番号は本人付与)

- **#28 Ocean Currents** — UgJ67AswrEs
- **#29 Winds & Pressure** — gWYzAFi0MZ4
- **#30 Upwelling & Coral Reefs** — vmoed42Zivg
- **#31 Precipitation** — lHV-jZUB5WU
- **#32 Precipitation & Pressure Redo** — 2RMyd9vo2Qk
- **#33 Temperature: Continentality** — 0yzTeuOZZ6o
- **#34 Temperature: Isotherms & Hot/Cold Spots** — Ihwv2EduEoM
- **#35 Temperature: Final Maps** — bTWF-xl_R0A
- **#36 Polar Climates** — uSMcnZV_Hh0
- **#37 Tropical Climates** — vi66amwP2g0
- **#38 Arid Climates** — e1EEKnliSK8
- **#39 Temperate Climates** — BvZ1rlCLg8U
- **#40 Continental Climates** — CYaHD9IKb2g(自動字幕が言語誤判定で取得不可。#33 も同様)

**書き起こし**: `scripts/fetch_transcripts.sh`(yt-dlp)で自動字幕を取得し、
`docs/動画書き起こし/` に保存する(第三者著作物のため git 追跡外)。
**動画内容の一次資料はこの書き起こし**とし、旧要約は補助にとどめる。

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
- **Artifexian**(YouTube チャンネル。書き起こしは fetch_transcripts.sh で取得)
  <https://www.youtube.com/@Artifexian>

## 定量物理の補助資料(Pasta が定量を示さない箇所の標準手法)

- エネルギー収支モデル: North & Coakley (1979) 型の季節 EBM。
- ケッペン=ガイガー閾値: Peel, Finlayson & McMahon (2007),
  "Updated world map of the Köppen-Geiger climate classification"。
- 軌道要素と日射: Berger (1978) の日平均日射公式。
