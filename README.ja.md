<div align="center">

![Anime Subtitle Extension Banner](docs/images/banner.svg)

# Anime Subtitle Extension（アニメ字幕アシスタント）

**dアニメストア・Amazon Prime Video でのアニメ視聴時に日本語字幕（`.ass` / `.srt` / `.ssa` / `.vtt`）を重ねて表示できる Chrome 拡張機能。Jimaku.cc + AniList の自動検索と、台詞クリックによる 1 クリック同期に対応しています。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)
[![Languages](https://img.shields.io/badge/i18n-EN%20%7C%20日本語%20%7C%20简体中文-eb5528)](extension/i18n.js)
[![Supported Sites](https://img.shields.io/badge/Players-d--anime%20Store%20%7C%20Prime%20Video-00a8e1)](extension/manifest.json)

[English](README.md) | **日本語** | [简体中文](README.zh-CN.md)

</div>

---

## ビジュアル紹介

![Feature Overview](docs/images/demo-showcase.svg)

---

## 主な特徴

- **dアニメストア・Amazon Prime Video に対応**
  - **dアニメストア** では再生中の作品名・話数・サブタイトルを自動検出し、最適な日本語字幕を自動で検索・適用します。
  - **Amazon Prime Video** でもアニメ・ドラマ作品に対応し、話数切り替え時の字幕リセットを自動で行います。
- **2 期・分割クール対応の自動検索 (`AniList` + `Jimaku.cc`)**
  - AniList の続編チェーンから通算話数／期別話数を自動解決し、作品ごとに選択した Jimaku 候補も記憶します。
- **クリックでタイミング同期（字幕ドロワー）**
  - 画面上の字幕をクリックすると台詞一覧が開き、今聞こえた台詞をクリックするだけで全体タイミングを即座に合わせられます（シーク移動モード切替可）。
- **開閉＆ドラッグ対応「ソース優先順 & 標準オフセット」辞書**
  - `ABEMA` / `DMMTV` / `Netflix`（標準 `-1.0s`）などをドラッグで並び替え、ソース別の標準オフセットを 1 対 1 で設定可能（`Other` は `0.0s` 固定・削除不可）。
  - 手動調整したズレ補正も「作品ごと」「作品 × ソースごと」に自動保存されます。
- **ローカル字幕読込 & SRT 書き出し**
  - `.ass` / `.srt` / `.ssa` / `.vtt` を画面のどこにでもドラッグ＆ドロップして適用でき、タイミング調整済み `.srt` のエクスポートも可能です。
- **邪魔にならない初期設定 & 3 言語 UI**
  - 初期値：`文字サイズ比率 4.5%`、`下からの位置 5%`、`背景不透明度 0%（透明）`。UI は **日本語 / English / 简体中文** をいつでも切り替えられます。

---

## かんたんセットアップ

1. リポジトリを取得します：
   ```bash
   git clone https://github.com/kysing02/video-subtitle.git
   ```
2. Chrome で `chrome://extensions/` を開き、右上の **「デベロッパーモード」** をオンにします。
3. **「パッケージ化されていない拡張機能を読み込む」** から [`extension/`](extension/) フォルダを選択します。
4. *(自動検索を使う場合)* [jimaku.cc/account](https://jimaku.cc/account) で無料 API キーを取得し、拡張ポップアップまたはプレイヤー右上の「💬 字幕 → ⚙ 設定」に貼り付けて保存します。

---

## ショートカット・操作方法

| 操作 | ショートカット / 操作方法 |
| :--- | :--- |
| 字幕の表示 ON / OFF | `Alt + S` |
| タイミング微調整 (`-0.5s` / `+0.5s`) | `[` / `]` |
| 台詞一覧を開いてクリック同期 / シーク | 表示中の字幕をクリック |
| 字幕の上下位置を移動 | 表示中の字幕を上下にドラッグ |
| 細かいタイミング調整 (`-5s` 〜 `+5s`) | 「💬 字幕」パネル下部のボタン |

---

## 開発・コントリビュート & ライセンス

新しい配信サイトへの対応方法やテスト手順については **[Contributor Guide (英語)](docs/CONTRIBUTING.md)** をご覧ください。

[MIT License](LICENSE)
