# 引き継ぎ

## 到達点（2026-11-09（月））
- Excel（../SPI/SPI言語_問題集_V0.xlsx、488行）を暗号化 JSON に変換し、練習サイト（site/）を作った。
- reviewer の指摘8件を直し、pytest 15件、Playwright の通し13項目が通った。
- https://ukyo11261515.github.io/webtest-practice/ に公開（リポジトリ ukyo11261515/webtest-practice、公開）。公開版でも通しの13項目が通った。

## 決めたこと
- 公開は GitHub の公開リポジトリ + GitHub Pages（Actions）。問題は AES-GCM で暗号化し、平文は commit しない。
- 原本と AI の答えが違う行は、どちらも正解にして注記を出す。
- 制限時間の既定は docs/SPEC.md の表。

## 次の一手
- 問題集を直したら、build_data.py で作り直して commit・push する（Actions が自動で公開）。
