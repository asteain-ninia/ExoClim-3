# Pasta 整合性ステータス（2026-05-04 P4-83 時点）

ユーザ FB「現状ってどこまで真似できていてどこが真似できていないんですか？」
への回答。Worldbuilding Pasta（"An Apple Pie from Scratch" + "Worldbuilder's
Log"）と当アプリの Step 1-7 を機能単位で対応付けた表。

凡例:
- ✅ **実装済**: Pasta の手法を意図通り再現
- 🟡 **近似**: コア機能は動くが、係数・分岐の校正未確定 or 簡略化
- 🔴 **未実装**: 仕様外として明示スキップ or Phase 4 後半で実装予定
- ⚠ **既知不一致**: Pasta では明確だが当アプリが意図的に変えている部分

---

## Step 1: ITCZ (赤道収束帯)

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| 季節 ITCZ migration（軸傾斜由来 ±δ）| ✅ | `solarDeclinationDeg` で月別中心線移動 |
| 大陸モンスーン引き寄せ | ✅ | `monsoonPullStrengthDeg` で夏半球大陸へ追加引き寄せ |
| 山岳切取（高地で帯がゼロに）| ✅ | `mountainCutoffMeters` (既定 4000m) |
| ITCZ 影響帯半幅 | ✅ | `baseInfluenceHalfWidthDeg` (既定 15°) |
| 平滑化窓幅 | ✅ | `smoothingWindowDeg` で経度方向 LPF |

## Step 2: 風帯 (Hadley/Ferrel/Polar)

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| Hadley/Ferrel/Polar 三セル構造 | ✅ | 緯度別卓越風 (NE/SE 貿易、偏西風、極東風) |
| 季節シフト（ITCZ に追従）| ✅ | `monthlyDominantWind` |
| 大陸内 monsoon 反転 | ✅ | `monthlyMonsoonMask` （大陸夏期 SW、冬期 NE 反転） |
| 沿岸湧昇マスク | ✅ | `monthlyCoastalUpwellingMask` で寒流側強化材料 |

## Step 3: 海流

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| §4.1 赤道反流 streamline | ✅ | `generateEquatorialCountercurrent` |
| §4.2 亜熱帯ジャイヤ (NH/SH) | ✅ | 1 盆あたり 4 streamline (warm/cold/neutral) |
| §4.3 暖寒流 per-cell 分類 | ✅ | `classifyOceanCell` west/east 距離比 |
| §4.5 衝突点 (赤道流 / 極流) | ✅ | 1 盆 4 点、P4-47 で陸セル避けスナップ |
| §4.5 中緯度衝突点 (lat ±30°) | ✅ (P4-80) | `mid_latitude_branching` 型追加、basin 東縁にスナップ、シアンマーカー |
| §4.6 極ジャイヤ (lat ≈80°) | ✅ | polar easterlies による西進反転を 3 streamline 追加 |
| §4.7 寒流沿い東岸海氷延長 | ✅ | NH/SH 冬季のみ extension |
| §4.8 海岸補正の影響保持距離 | 🟡 | 線形減衰 `coastalInfluenceRangeDeg` (既定 5°) |
| §4.9 逆行惑星 (retrograde) | ✅ | rotationSign 反転で basin 西/東縁 swap |
| §4.10 ENSO ダイポール候補マスク | 🟡 | 候補マスクのみ。動的振動 simulate は Pasta 方針外 |
| streamline 陸地分断 (split) | ✅ | `splitPathByLand` でサブ区間化 |
| **agent-tracing 多段階パス** | 🔴 | 旧 ExoClim crawl + collision-field 勾配追従の本格移植は未着手 |
| 月別 streamline 差 | 🔴 | 12 ヶ月で同一（季節依存は Step 5 feedback 後で導入予定） |

## Step 4: 気流 (地表風 + 気圧)

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| 卓越風 (Step 2) + 圧力勾配風 合成 | ✅ | `pressureGradientCoefficient` で重み |
| 山脈偏向 | ✅ | `mountainDeflectionThresholdMeters` 超で法線方向減衰 |
| 月別気圧中心 (H/L マーカー) | ✅ | anomaly 局所極値 抽出 |
| 季節モンスーン反転 | ✅ | `monsoonReversalStrength` |
| Lee cyclogenesis | 🔴 | Pasta も詳細なし、最小実装でスキップ |

## Step 5: 気温

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| §4.2 緯度別日射 + 軸傾斜 季節振幅 | ✅ | Berger 1978 公式、annual+seasonal 2 段階スケール |
| §4.3 標高 lapse rate | ✅ | `lapseRateCelsiusPerKm` (既定 4.46) |
| §4.4 高地高原キャップ (4km+ で 10°C 上限) | ✅ | `PLATEAU_TEMPERATURE_CAP_CELSIUS` |
| §4.5 大陸性 continentality (年振幅増幅) | ✅ | 内陸 `CONTINENTAL_INTERIOR_CELL_THRESHOLD` |
| §4.6 海岸補正 (暖流/寒流) | ✅ | per-cell + P4-50 inland propagation (reach 10) |
| §4.7 風移流 (Step 4 風で熱搬送) | ✅ | `windAdvectionStrength` (既定 0.3) |
| §4.8 雪氷アルベド feedback | ✅ | `snowIceFeedbackIterations` (既定 2 反復) |
| §4.9 蒸発散量 (Penman-Monteith) | 🟡 | `max(0, T) × coef` の暫定線形式。Penman-Monteith 簡略版置換は将来 |
| §4.12 等温線 (marching squares) | ✅ | `extractIsotherms` |
| Pasta 系数 (annual 350 / seasonal 80) | 🟡 | 経験スケール、Phase 4.1 検証で固定値に |
| **planetary albedo 公式** | ⚠ | P4-52 で 50/50 mix に修正（Pasta は明示せず）|

## Step 6: 降水

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| §4.1 暖流海岸 humid belt (warm trace) | ✅ | onshore 風 + 隣接暖流 → 内陸トレース |
| §4.2 ITCZ 圏内 + onshore = very_wet/wet | ✅ | |
| §4.3 季節低気圧 (Madeline James 手法) | 🔴 | 採用せず、`monthlyFrontPassageFrequency` 全 0 |
| §4.4 風上斜面湿潤 (orographic wet) | ✅ | `windwardWetMinReliefMeters` |
| §4.5 高地乾燥 (チベット高原 analog) | ✅ | `highElevationDryThresholdMeters` (既定 4000m) |
| §4.6 風下雨陰砂漠 (lee rainshadow) | ✅ | leeward + 起伏しきい値 |
| §4.7 極前線拡張 (winter only) | ✅ | `polarFrontExtensionMask` |
| §4.x **暖流海岸 fetch 距離 (Pasta「2000 km」)** | ⚠ | reach はセル数で指定 (`maxWetExtensionKm` あるが内部はセル単位)。**km-aware 化が課題** |
| §4.x 内海/湖の Fetch 計算 | 🔴 | 外洋扱い一律 2000 km 上限 |
| §4.x Lee cyclogenesis | 🔴 | Pasta も詳細なし、未実装 |
| **寒流隣接 dry rule (Sahara/Atacama)** | ✅ (P4-53) | Pasta 直接記述なしだが物理的 |
| **熱帯乾季 (ITCZ 圏外)** | ✅ (P4-54) | Pasta WL#37 趣旨で Aw 形成 |
| **Siberian winter dry / continental summer wet** | ✅ (P4-57) | NH 高緯度東半分に Dw |
| **地中海性 winter wet (storm track)** | ✅ (P4-70) | 西岸 30-42° |
| 月別 vs 年平均風 | 🟡 | 月別 monsoon 反転で乖離可能性 |

## Step 7: 気候帯 Köppen-Geiger

| Pasta 概念 | 状態 | 備考 |
|---|---|---|
| 系統 1 標準 Köppen | ✅ | A/B/C/D/E + 細分 |
| 系統 2 Pasta Bioclimate System | 🔴 | GDD/HDD/Ar/Evr 未計算、選択しても系統 1 で判定 |
| §4.1.2 B 群しきい値 (annualMean*20 + bonus) | ✅ | hot half precip 比率で bonus |
| §4.1.5 A 群細分 Af/Am/Aw/As | ✅ | `classifyTropical` |
| §4.1.6 第 3 文字 a/b/c/d | ✅ | `thirdLetterFromTemp` |
| §4.1.6 第 2 文字 f/s/w | ✅ | `precipitationPatternLetter` |
| §4.1.7 寒冷地 B → D 振り戻し (WL#40) | ✅ (P4-19) | `aridReclassToDEnabled` |
| §4.1.5 A 群拡張 (赤道帯救済 WL#40 風) | ✅ (P4-49) | `tropicalExtensionEnabled` |
| §4.1.x BS リング (砂漠は必ずステップに囲まれる WL#37) | ✅ (P4-55) | `bsRingAroundBwEnabled` |
| §4.1.8 ITCZ 移動帯 savanna 拡張 | ✅ (P4-81) | `applyItczMigrationSavannaExpansion` BWh/BSh@\|lat\|≤15° + winterMin≥18°C → Aw |
| §4.1.8 中緯度西岸 desert 海岸延長 | ✅ (P4-81) | `applyWestCoastDesertExtension` lat 18-25° 西岸 A/C → BSh |
| §4.1.4 Cs ベルト強制 (lat 30-42° 西岸) | ✅ (P4-82) | `applyMediterraneanWestCoastForce` C 群 + B 群 → Csa/Csb |
| §4.1.4 Cfb wedge 強制 (lat 45-60° 西岸) | ✅ (P4-83) | `applyCfbWestCoastForce` D 群 → Cfb |
| §4.1.5 赤道直上 Af 保護 | ✅ (P4-82) | `applyEquatorialAfProtection` \|lat\|<5° + winterMin≥18°C → Af |
| §4.1.9 Climate clash 検出 | ✅ (P4-79) | `computeClimateClash` 群レベル差≥3 を mask 化、UI 診断 overlay |
| §7.5 蒸発散量 厳密式 | 🟡 | Step 5 の暫定線形式に依存 |
| §7.6 降水ラベル → mm/月 変換 | 🟡 | `precipitationMmByLabel` 経験値 (10/60/120/240) |
| **D/C 境界 winterMin** | ⚠ | 標準 Köppen -3°C (P4-68 で採用)、Pasta WL#40 の 0°C 厳格版から外した |

---

## 大局のサマリ

### ✅ 高い再現度 (Pasta の core spec を意図通り)

- **Step 1 ITCZ**: 季節 migration / 大陸モンスーン引き寄せ / 山岳切取 / 影響帯
- **Step 2 風帯**: 三セル構造 / monsoon 反転 / 沿岸湧昇
- **Step 3 海流 (静的)**: 亜熱帯/赤道反流/極ジャイヤ / 暖寒流 per-cell 分類 / 衝突点 / 海氷延長 / 逆行惑星
- **Step 4 気流**: 卓越風 + 圧力勾配風合成 / 山脈偏向 / 季節モンスーン
- **Step 5 気温**: 緯度日射 / 標高 / 高地キャップ / 大陸性 / 海岸補正 + propagation / 風移流 / 雪氷 feedback / 等温線
- **Step 7 気候帯 (系統 1)**: A/B/C/D/E + 細分文字 / B→D 振り戻し / A 群拡張 / BS リング

### 🟡 近似実装 (動くが係数・式が暫定)

- 蒸発散量（Penman-Monteith ではなく `max(0,T) × coef`）
- 海岸補正の影響保持距離（線形減衰）
- ENSO（候補マスクのみ）
- Annual/Seasonal 温度スケール係数（経験値 350/80）
- 降水ラベル → mm/月 変換係数（経験値）

### 🔴 意図的未実装 / 大きな未着手項目

- **agent-tracing 多段階パス**: 旧 ExoClim の crawl + collision-field 勾配追従の本格移植。現状は矩形 gyre + split のみで、陸沿い這行が直線的（ECC のみ skeleton 完成）
- **Step 3 月別 streamline 差**: 12 ヶ月で同一（季節依存は Step 5 feedback 後）
- **Step 4 Lee cyclogenesis**: Pasta 詳細なし
- **Step 6 季節低気圧 (Madeline James 手法)**: 前線ベース未採用
- **Step 6 内海/湖 fetch 計算**: 外洋扱い
- **Step 7 系統 2 (Bioclimate System)**: GDD/HDD/Ar/Evr 未計算
- ~~**Step 7 §4.1.8 季節調整**~~: ✅ P4-81 で savanna 拡張 + 西岸 desert 延長
- ~~**Step 7 §4.1.9 Climate clash 検出**~~: ✅ P4-79 で実装
- ~~**中緯度衝突点 (lat ±30°)**~~: ✅ P4-80 で `mid_latitude_branching` 追加

### 🟢 P4-79..P4-83 で追加された後処理 (お手本準拠 forced classification)

ユーザ FB「お手本準拠を磨く」と subagent 客観評価への対応。Pasta が緯度・
海岸・ITCZ 移動帯ベースで暗黙に期待する気候帯配置を、計算層が取り逃すケースに
対する post-processing 補正:

- 赤道直上 Af 保護 (P4-82)
- Cs ベルト強制 lat 30-42° 西岸 (P4-82)
- Cfb wedge 強制 lat 45-60° 西岸 (P4-83)
- ITCZ 移動帯 savanna 拡張 (P4-81)
- 中緯度西岸 desert 海岸延長 (P4-81)
- BS リング (P4-55)
- A 群拡張 赤道帯救済 (P4-49)
- B → D 振り戻し (P4-19)

すべて `params.*Enabled` フラグで OFF 可能（Pasta 純粋計算結果を見るとき）。

### ⚠ 既知不一致 (Pasta と異なる選択を意図的に)

- **planetary albedo 公式** (P4-52): Pasta は明示しない計算式バグを修正 (`surface + cloud*0.5` → `0.5*cloud + 0.5*surface`)
- **D/C 境界 winterMin** (P4-68): WL#40 厳格 0°C → 標準 Köppen -3°C
- **Dw 配置**: お手本（清書版）は中央分布、当アプリは東半分偏重 (P4-58、ユーザ確認済み)

### 🆕 ユーザ FB ベースの追加実装 (Pasta に直接記述ないが物理的)

- **P4-53** 寒流隣接 dry rule (Sahara/Atacama)
- **P4-54** 熱帯乾季 (ITCZ 圏外で乾季)
- **P4-57** Siberian winter dry / continental summer wet (Dw 形成)
- **P4-58** Dw 東半分偏重
- **P4-70** 地中海性 winter wet (storm track)
- **P4-50** Step 5 海岸補正の内陸 propagation (Pasta WL#28 「数百 km 内陸まで」を 700-1100km に定量化)

---

## 「カックカク」改善のロードマップ

ユーザ指摘 (2026-05-04): per-cell 1° 解像度では zone 境界が緯度 step 関数で
直線的にカクつく。本質改善には:

### 短期 (P4-72 候補)

- 内部 grid 解像度 0.5° 化（180×360 → 360×720、cell 数 4 倍）
- perf チェック必要（Step 1-7 ピペ全体で 4 倍コスト）

### 中期 (P4-73+ 候補)

- **km-aware 距離化**: 現状 `coastalInfluenceRangeDeg` 等は度単位。Pasta の
  「2000 km from coast」を直接 km で書ける API へ。lat に応じて
  `degToKm(lat) = 111 × cos(lat × π/180)` で換算
- 境界の確率的 dithering（zone A/B 境界で確率 50% で振り分け）

### 長期

- **agent-tracing 多段階パス**: 海流 streamline が直線的にしか出ない問題の
  根本解決
- 系統 2 (Bioclimate System) 実装
- Climate clash 検出 + 季節調整自動修正
