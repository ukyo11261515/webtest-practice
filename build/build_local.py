"""パスワードなしで手元で開ける、1ファイルの HTML（手元版）を作る。

使い方:
    python3 build/build_local.py <問題集.xlsx> [--sets "../SPI/問題セット_*.json"] [--out ../SPI/SPI練習_ローカル版.html]

site/ の index.html・style.css・app.js と、Excel から作った問題（SPI問題集）と、
日付ごとの問題セット（docs/SET_SCHEMA.md の形の JSON）を1つのファイルにまとめる。
ブラウザで直接開いたファイルは別のファイルを読み込めないため、すべてを埋め込む。
問題が平文で入るので、出力先は公開リポジトリの外にする（既定は Excel と同じ SPI フォルダ）。
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_data as b  # noqa: E402

ALL_TYPES = {**b.TYPES, **b.EXTRA_TYPES}


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


def latest_set_files(pattern: str) -> list[Path]:
    """同じセットの版が複数あれば（_V0, _V1 …）、いちばん新しい版だけを使う。"""
    best: dict[str, tuple[int, Path]] = {}
    for f in sorted(glob.glob(pattern)):
        p = Path(f)
        m = re.search(r"_V(\d+)\.json$", p.name)
        ver = int(m.group(1)) if m else 0
        key = re.sub(r"_V\d+\.json$", "", p.name)
        if key not in best or ver > best[key][0]:
            best[key] = (ver, p)
    return [p for _, p in sorted(best.values(), key=lambda x: x[1].name)]


def num_norm(text: str) -> str:
    t = unicodedata.normalize("NFKC", str(text)).replace(",", "").replace(" ", "")
    return t


def merge_sets(questions: list[dict], set_files: list[Path]) -> tuple[list[dict], list[dict], list[str]]:
    """問題セットを SPI問題集の問題に足す。参照（ref）は既存の問題にセットの印を付けるだけ。"""
    by_id = {q["id"]: q for q in questions}
    sets_meta = [{"id": "spi", "label": "SPI問題集"}]
    problems: list[str] = []
    seq = 100000
    for f in set_files:
        data = json.loads(f.read_text())
        sid, label = str(data["set"]), data.get("label") or str(data["set"])
        if sid not in [s["id"] for s in sets_meta]:
            sets_meta.append({"id": sid, "label": label})
        for item in data["items"]:
            if "ref" in item:
                q = by_id.get(item["ref"])
                if not q:
                    problems.append(f"{f.name}: 参照先 {item['ref']} がない")
                    continue
                # 組問題の1問だけを参照していても、組のすべての問題をセットに入れる（組の残りが欠けないように）。
                members = [x for x in questions if q.get("group") and x.get("group") == q["group"]] or [q]
                for m in members:
                    if sid not in m["sets"]:
                        m["sets"].append(sid)
                continue
            seq += 1
            q = {
                "id": item["id"], "row": seq, "type": item["type"], "mode": item["mode"],
                "passage": item.get("passage", ""), "prompt": item.get("prompt", ""),
                "tables": item.get("tables") or [], "afterTable": item.get("after_table", ""),
                "optionKind": item.get("optionKind", "letter"), "options": item.get("options", []),
                "accepted": item.get("accepted", []), "unit": item.get("unit"),
                "scored": bool(item.get("scored", True)) and bool(item.get("accepted")),
                "sourceAnswer": item.get("ai_majority", ""), "aiAnswer": "",
                "notes": item.get("notes", []), "explanation": item.get("explanation", ""),
                "group": item.get("group"), "underline": item.get("underline"), "sets": [sid],
            }
            if q["id"] in by_id:
                problems.append(f"{f.name}: id {q['id']} が重複")
                continue
            if q["type"] not in ALL_TYPES:
                problems.append(f"{f.name}: {q['id']} のタイプ {q['type']} が定義にない")
                continue
            if q["mode"] == "text":
                q["accepted"] = [b.norm(a) for a in q["accepted"]]
            if q["mode"] == "number":
                q["accepted"] = [num_norm(a) for a in q["accepted"]]
            if q["mode"] in ("single", "multi"):
                keys = {o["key"] for o in q["options"]}
                for a in q["accepted"]:
                    if not set(a) <= keys:
                        problems.append(f"{f.name}: {q['id']} の正解 {a} が選択肢にない")
            questions.append(q)
            by_id[q["id"]] = q
    return questions, sets_meta, problems


def main(argv=None):
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", type=Path)
    ap.add_argument("--sets", default=str(root.parent / "SPI" / "問題セット_*.json"))
    ap.add_argument("--out", type=Path, default=root.parent / "SPI" / "SPI練習_ローカル版.html")
    args = ap.parse_args(argv)

    out = args.out.resolve()
    if root.resolve() in out.parents:
        raise SystemExit("出力先が公開リポジトリの中です。問題が平文で入るので、リポジトリの外を指定してください")

    questions, issues = b.build_questions(b.read_rows(args.xlsx))
    set_files = latest_set_files(args.sets)
    questions, sets_meta, problems = merge_sets(questions, set_files)
    if problems:
        print("問題セットの不備:", *problems, sep="\n  ", file=sys.stderr)
        raise SystemExit(1)
    used = {q["type"] for q in questions}
    payload = {
        "title": "SPI",
        "source": args.xlsx.name,
        "types": {k: v for k, v in b.types_payload(ALL_TYPES).items() if k in used},
        "sets": sets_meta,
        "questions": questions,
    }
    out.write_text(build_html(root / "site", payload))
    print(f"問題 {len(questions)} 問（採点する {sum(q['scored'] for q in questions)} 問）")
    for s in sets_meta:
        n = sum(1 for q in questions if s["id"] in q["sets"])
        print(f"  {s['label']}: {n} 問")
    for f in set_files:
        print(f"  読み込んだ問題セット: {f.name}")
    if issues:
        print(f"答えを対応づけられなかった行 {len(issues)} 件", file=sys.stderr)
    print(f"手元版: {out}（{out.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
