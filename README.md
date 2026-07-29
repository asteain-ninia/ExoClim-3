# ExoClim-3

惑星のパラメータ(主星・軌道・自転・大気・海洋・地形)を与えると、
**ITCZ → 風帯 → 海流 → 気流 → 気温 → 降水 → 気候区分** の 7 段階を順に導出し、
ケッペン気候区分図を生成する、ワールドビルディング向けの対話型気候設計ツール。

一次参照は Worldbuilding Pasta(「An Apple Pie from Scratch」/ Worldbuilder's Log)。
段階構成は Pasta の手順を踏襲しつつ、数値の中核(気温・降水)は
**エネルギー収支モデルと水収支モデルによる定量計算**で置き換えている
(理由は [docs/方針.md](docs/方針.md) と [docs/教訓.md](docs/教訓.md) を参照)。

本プロジェクトは [ExoClim-2](../ExoClim-2/) の全面再構築(第 3 世代)。

## 使い方

```bash
npm install
npm run dev        # 開発サーバ起動
npm run build      # 本番ビルド(静的 SPA、完全オフライン動作)
npm test           # ユニットテスト(Vitest)
npm run validate   # ヘッドレス検証(PNG 出力 + 地球再現度の自動採点)
```

## 文書構成

| 文書 | 内容 |
| --- | --- |
| [docs/要件.md](docs/要件.md) | 何を作るか(機能・非機能・検証基準) |
| [docs/方針.md](docs/方針.md) | 技術と物理モデルの設計判断(ExoClim-2 からの変更点と根拠) |
| [docs/教訓.md](docs/教訓.md) | ExoClim-2 / 初代から掘り出した教訓集(失敗の構造と再発防止) |
| [docs/INTENT.md](docs/INTENT.md) | 一次資料(Worldbuilding Pasta)の索引 |
| [docs/spec/](docs/spec/) | 各ステップの物理仕様 |
| [docs/参考-ExoClim2/](docs/参考-ExoClim2/) | 前世代の仕様書・動画要約の複写(参照専用) |
