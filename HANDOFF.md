# 引き継ぎ

## 到達点（2026-11-09（月））
- Excel（../SPI/SPI言語_問題集_V0.xlsx、488行）を暗号化 JSON に変換し、練習サイト（site/）を作った。
- pytest 14件、Playwright の通し11項目が通った。reviewer のレビュー待ち → 指摘を直してから GitHub Pages に公開する。

## 決めたこと
- 公開は GitHub の公開リポジトリ + GitHub Pages（Actions）。問題は AES-GCM で暗号化し、平文は commit しない。
- 原本と AI の答えが違う行は、どちらも正解にして注記を出す。
- 制限時間の既定は docs/SPEC.md の表。

## 次の一手
- レビューの指摘を直す → push → Pages の URL で開いて確かめる。
