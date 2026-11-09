# Webテスト練習サイト（SPI 言語。Claude・Codex 共通。Claude は CLAUDE.md から読み込む）

段階: 開発中（自分だけが使う。2026-11-09 から https://ukyo11261515.github.io/webtest-practice/ に公開。問題はパスワードで暗号化している）

## 目的
- 何を作るか: 友人と作った SPI 言語の問題集（Excel）を、本番に近い制限時間で解く練習サイト。
- 誰が使うか: 本人だけ。
- いちばん大事なこと: 問題の平文を公開リポジトリに出さない（site/data.enc.json の暗号文だけを公開する）。問題が出てからの経過秒数を常に表示する。

## 構成
- 技術: 素の HTML・CSS・JavaScript（ビルドなし）。データの変換は Python（openpyxl・cryptography）。
- フォルダ: build/（Excel → 暗号化 JSON）、site/（公開するサイト）、tests/（pytest と Playwright）、docs/（仕様）、out/（平文の確認用。git 管理外）。
- 元の Excel: ../SPI/SPI言語_問題集_V0.xlsx（リポジトリに入れない）。

## コマンド（AI が自分で確かめるために使う）
- データの作り直し: `python3 build/build_data.py ../SPI/SPI言語_問題集_V0.xlsx`（パスワードは .env の WEBTEST_PASSWORD）
- 起動: `python3 -m http.server 8799 --bind 127.0.0.1 --directory site`（8765 は別のサービスが使っている）
- 手元版（パスワードなし、1ファイルの HTML）: `python3 build/build_local.py ../SPI/SPI言語_問題集_V0.xlsx` → ../SPI/SPI練習_ローカル版.html（問題が平文で入るので、リポジトリの外に出す）
- テスト: `python3 -m pytest -q tests/test_build.py`、`python3 tests/e2e_check.py`（サーバーを起動してから）、`python3 tests/local_check.py`（手元版）
- 公開: main に push すると GitHub Actions（.github/workflows/pages.yml）が site/ を GitHub Pages に出す。

## このプロジェクトだけの決まり
- Excel、out/、.env、手元版の HTML を commit しない。テストには実在の問題を書かず、形だけをまねた見本を使う。
- 問題集の版を上げたら（V1 など）、build_data.py の引数を新しい版にして作り直し、種類ごとの問題数の変化を確かめる。
- 種類の判定は build_data.py の classify と TYPE_OVERRIDES。機械で分けにくい行は TYPE_OVERRIDES に行番号で足す。

## 必要なときだけ読む
| こういうとき | 読むもの |
|---|---|
| 仕様を確かめる | docs/SPEC.md |
| 前回の続きから再開する | HANDOFF.md |
