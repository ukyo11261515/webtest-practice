"""パスワードなしで手元で開ける、1ファイルの HTML（手元版）を作る。

使い方:
    python3 build/build_local.py <問題集.xlsx> [--out ../SPI/SPI練習_ローカル版.html]

site/ の index.html・style.css・app.js と、Excel から作った問題を1つのファイルにまとめる。
ブラウザで直接開いたファイルは別のファイルを読み込めないため、すべてを埋め込む。
問題が平文で入るので、出力先は公開リポジトリの外にする（既定は Excel と同じ SPI フォルダ）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_data as b  # noqa: E402


def build_html(site: Path, payload: dict) -> str:
    html = (site / "index.html").read_text()
    css = (site / "style.css").read_text()
    js = (site / "app.js").read_text()
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    link = '<link rel="stylesheet" href="style.css">'
    script = '<script src="app.js"></script>'
    if link not in html or script not in html:
        raise SystemExit("index.html に style.css か app.js の読み込みが見つかりません")
    html = html.replace(link, f"<style>\n{css}\n</style>")
    html = html.replace("<title>Webテスト練習</title>", "<title>Webテスト練習（手元版）</title>")
    # 置き換え文字列の中の \\ や \\1 が解釈されないよう、関数ではなく分割してつなぐ。
    head, tail = html.split(script, 1)
    return head + f"<script>window.LOCAL_DATA = {data};</script>\n<script>\n{js}\n</script>" + tail


def main(argv=None):
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", type=Path)
    ap.add_argument("--out", type=Path, default=root.parent / "SPI" / "SPI練習_ローカル版.html")
    args = ap.parse_args(argv)

    out = args.out.resolve()
    if root.resolve() in out.parents:
        raise SystemExit("出力先が公開リポジトリの中です。問題が平文で入るので、リポジトリの外を指定してください")

    questions, issues = b.build_questions(b.read_rows(args.xlsx))
    payload = {
        "title": "SPI 言語",
        "source": args.xlsx.name,
        "types": {k: {"label": v[0], "seconds": v[1]} for k, v in b.TYPES.items()},
        "questions": questions,
    }
    out.write_text(build_html(root / "site", payload))
    print(f"問題 {len(questions)} 問（採点する {sum(q['scored'] for q in questions)} 問）")
    if issues:
        print(f"答えを対応づけられなかった行 {len(issues)} 件", file=sys.stderr)
    print(f"手元版: {out}（{out.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
