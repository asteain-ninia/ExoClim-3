# Step 1: ITCZ（熱帯収束帯）

## 1. 目的

ITCZ（Intertropical Convergence Zone, 熱帯収束帯）の中心緯度線と影響帯（zone of influence）を、月単位で導出する。後続ステップ（風帯・降水）が ITCZ 位置を起点とするため、本ステップはパイプラインの先頭に配置する。

## 2. 一次参照

- **Worldbuilding Pasta — "An Apple Pie from Scratch, Part VIb"**
  <https://worldbuildingpasta.blogspot.com/2020/05/an-apple-pie-from-scratch-part-vib.html>
    - Step 6 Precipitation > **ITCZ** サブセクション（中心線と影響帯の定義）
    - 引用: *"a 'zone of influence' centered on the ITCZ extending north and south by about 15° latitude"*
    - 引用: *"It should roughly follow the thermal equator, but a little more smoothed out so it isn't zigzagging through mountain ranges."*
    - 引用: *"perhaps a bit wider on the western shores of large oceans, and a bit thinner near the subtropical highs"*

- 補助: 補助動画 *Worldbuilding: How To Design Realistic Climates* シリーズ（[docs/INTENT.md](../INTENT.md) 参照）

## 3. 入力

- 惑星パラメータ: 地軸傾斜・自転周期・公転周期・軌道離心率・近日点引数
- 地形: 陸海分布・標高（後段の海岸・山岳との相互作用に備える）
- 季節位相: 月単位の年内位相（最低でも代表四季 + 年平均）

ITCZ は Pasta では「熱赤道（thermal equator）」を平滑化したものとして定義されるが、ExoClim パイプラインでは温度ステップ（Step 5）より前に ITCZ を決定するため、本ステップでは温度シミュレーションの結果ではなく、軌道幾何と陸海分布から推定される「期待される熱赤道」を用いる。詳細は §4 アルゴリズム概要を参照。

## 4. アルゴリズム概要

ITCZ の中心緯度線 \\(\\phi_\\text{ITCZ}(\\lambda, t)\\) は、経度 \\(\\lambda\\) と季節位相 \\(t\\) の関数として、以下の手順で導出する。

### 4.1 熱赤道の幾何的近似

地軸傾斜 \\(\\varepsilon\\) と季節位相に基づき、太陽直下点緯度の年内軌跡を求める。地球の場合、夏至・冬至で南北緯約 \\(\\pm \\varepsilon\\) の範囲を移動する。離心率および近日点引数による南北非対称はこの段階で取り込む。

### 4.2 陸海分布による補正

陸地は海洋より熱容量が小さいため、夏半球側の陸地上では熱赤道がより極側に振れる傾向（モンスーン的挙動）が知られている。この補正は経験的な係数で行う。本ステップではあくまで「予測される熱赤道」を扱い、温度ステップ完了後の再計算経路（フィードバック）は §7 未確定論点を参照。

### 4.3 平滑化

Pasta の指示に従い、地形による細かい振動（山脈による zigzag）を抑える平滑化を施す。

> *"a little more smoothed out so it isn't zigzagging through mountain ranges"*

平滑化の窓幅は経度方向に数十度のオーダーを既定とし、利用者が UI で調整可能とする（§6 パラメータ）。

### 4.4 影響帯の付与

中心線の南北に「影響帯（zone of influence）」を付与する。Pasta は南北 ±15° を初期値とし、海洋西岸でやや広く、亜熱帯高気圧帯近傍でやや狭くする調整を推奨している。

> *"a bit wider on the western shores of large oceans, and a bit thinner near the subtropical highs"*

亜熱帯高気圧帯の位置は Step 2 風帯から得られるため、影響帯の最終形状は Step 2 完了後に確定する余地を持たせる（パイプライン上は本ステップで初期値を出し、Step 2 で調整する）。

### 4.5 山岳横断の扱い

Pasta の指示「don't cross mountains」に従い、影響帯は標高がしきい値を超える領域では境界を切り取る。しきい値の既定値は §6 で定める。

## 5. 出力

- 月別の ITCZ 中心緯度線: 各経度 \\(\\lambda\\) と各月 \\(m\\) について、中心緯度 \\(\\phi_\\text{ITCZ}(\\lambda, m)\\)。
- 月別の影響帯: 各 \\((\\lambda, m)\\) における南北方向の幅（または上下端緯度）。山岳・亜熱帯高気圧による切取後の形状を含む。
- 年平均 ITCZ: 月別を平均した参照値（補助表示・検証用途）。

## 6. パラメータ

利用者が UI から触れるパラメータと、内部派生値の境界を以下のように区別する。

### 6.1 利用者が触れるパラメータ

- 影響帯の基準幅（南北、Pasta 既定 15°）
- 平滑化の窓幅（経度方向）
- 陸海熱容量差による熱赤道引き寄せの強度（モンスーン強度）
- 山岳しきい値（影響帯を切り取る標高）

### 6.2 内部派生値（§2.1 入力から計算される）

- 太陽直下点緯度の月別軌跡（軌道幾何から）
- 海洋西岸／東岸判定（陸海分布から）
- 亜熱帯高気圧帯の位置（Step 2 出力に依存。本ステップでは初期化のみ）

## 7. 未確定論点

### 7.1 ITCZ と温度ステップの順序

Pasta では ITCZ は降水（Step 6）の中で扱われ、温度シミュレーションが先行する。ExoClim パイプラインは ITCZ を先頭に置くため、温度シミュレーションの結果を ITCZ に反映できない。対応案:

- 案 A: 軌道幾何＋陸海分布の経験的近似で完結させる（現方針）
- 案 B: 温度ステップ完了後に ITCZ を再計算するフィードバック経路を追加する
- 案 C: ExoClim パイプラインを Pasta の順序（温度先行）に再構成する

採用案は技術方針（[技術方針.md](../../技術方針.md) §2.2 ステップ間の値渡し）と合わせて Phase 3 で確定する。

### 7.2 大陸質量による ITCZ の振れ幅

モンスーン的な ITCZ 移動の振幅は、Pasta では定量的に与えられていない。地球の南アジア・西アフリカでの観測値を参考にした既定値を §6 に載せるか、利用者調整に委ねるかは Phase 3 で確定する。

### 7.3 影響帯の海洋西岸補正

「a bit wider on the western shores of large oceans」の定量化は Pasta では示されていない。海岸距離・大陸サイズに連動した係数を導入するか、シンプルな一律値で済ませるかは Phase 3 で確定する。

## 8. 旧 ExoClim での扱い（参考）

旧版では `docs/itcz_spec.md` に独自の数式（C_SATURATION_DIST / K_SEA / K_LAND 等）で実装していたが、Pasta との対応関係が明示されていなかった。本仕様では Pasta 該当節からの直接の写像として書き直した。旧版定数を踏襲する場合は §6 パラメータの「陸海熱容量差による熱赤道引き寄せの強度」相当として位置付けるが、Pasta 引用との整合性を最優先とする。
