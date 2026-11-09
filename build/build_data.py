"""SPI 言語の問題集（Excel）を、練習サイトが読む暗号化 JSON に変換する。

使い方:
    python3 build/build_data.py <問題集.xlsx> [--out site/data.enc.json] [--review out/review.csv]

パスワードは環境変数 WEBTEST_PASSWORD か、.env の WEBTEST_PASSWORD から読む。
平文の問題は out/（git に入れない）にだけ書き、site/ には暗号文だけを置く。
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import re
import secrets
import sys
import unicodedata
from pathlib import Path

PBKDF2_ITERATIONS = 600_000

# 種類ごとの制限時間（秒）の既定値。サイトの設定画面で変えられる。
TYPES = {
    "meaning": ("熟語の意味", 10),
    "usage": ("語句の用法", 15),
    "pair": ("二語の関係", 10),
    "pair_combo": ("二語の関係（組み合わせ）", 20),
    "blank_short": ("空欄補充（短文）", 10),
    "blank_passage": ("空欄補充（文章）", 30),
    "order": ("文の並べ替え", 60),
    "reading": ("長文読解", 60),
}

LETTER_LINE = re.compile(r"^([A-H])[\s　]+(.+)$")
LETTER_ONLY = re.compile(r"^([A-H])$")
KANA_LINE = re.compile(r"^([アイウ])[\s　]*(.+)$")
DIGIT_LINE = re.compile(r"^([1-9])[\s　]+(.+)$")
ORDER_SLOTS = re.compile(r"[\[［]\s*1\s*[\]］]\s*[\[［]\s*2\s*[\]］]|12345")
READING_PARENS = re.compile(r"[（(《][^）)》]*[）)》]")
TRAILING_NOTE = re.compile(r"（[^）]*）$")


def norm(text: str) -> str:
    """答えと選択肢を照らし合わせるための正規化（読み仮名・空白・記号の揺れを消す）。"""
    t = unicodedata.normalize("NFKC", text or "")
    t = READING_PARENS.sub("", t)
    t = re.sub(r"[\s　・、。,.]", "", t)
    return t


def kata_to_hira(text: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def parse_options(cell: str):
    """設問・選択肢の欄を、指示文と選択肢の並びに分ける。

    戻り値: (指示文, [(key, text)], 選択肢の種類 "letter"|"kana"|"digit"|"plain"|"none")
    """
    text = (cell or "").strip()
    if not text:
        return "", [], "none"
    blocks = re.split(r"\n\s*\n", text)
    if len(blocks) > 1:
        prompt = "\n\n".join(b.strip() for b in blocks[:-1])
        lines = [ln.strip() for ln in blocks[-1].split("\n") if ln.strip()]
    else:
        prompt = ""
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]

    for pattern, kind in ((LETTER_LINE, "letter"), (KANA_LINE, "kana"), (DIGIT_LINE, "digit")):
        matches = [pattern.match(ln) for ln in lines]
        if lines and all(matches):
            return prompt, [(m.group(1), m.group(2).strip()) for m in matches], kind

    # 1行だけで、指示文に見えるもの（抜き出し問題など）は選択肢なし。
    if len(lines) == 1 and not prompt and re.search(r"(なさい|どれか|選ぶ|入れる)", lines[0]):
        return lines[0], [], "none"
    if not prompt and len(lines) >= 1 and re.search(r"(なさい|どれか)", lines[0]) and len(lines) == 1:
        return lines[0], [], "none"
    keys = "ABCDEFGH"
    return prompt, [(keys[i], ln) for i, ln in enumerate(lines)], "plain"


def match_one(part: str, options):
    """答えの一部分（例: "D 反駁"・"反駁"・"D"）を選択肢のキーに対応づける。"""
    part = part.strip()
    if not part:
        return None
    keys = {k for k, _ in options}
    m = LETTER_LINE.match(part) or LETTER_ONLY.match(part)
    if m and m.group(1) in keys:
        return m.group(1)
    target = norm(part)
    exact = [k for k, t in options if norm(t) == target]
    if len(exact) == 1:
        return exact[0]
    near = [k for k, t in options if target and (target in norm(t) or norm(t) in target)]
    if len(near) == 1:
        return near[0]
    return None


def parse_choice_answer(raw: str, options, kind: str):
    """選択式の答えをキーの集合に変える。対応づけられなければ None。"""
    raw = TRAILING_NOTE.sub("", (raw or "").strip()).strip()
    if not raw:
        return None
    if kind == "kana":
        if "該当なし" in raw:
            return []
        found = [k for k in "アイウ" if k in raw]
        return found or None
    parts = re.split(r"\s*/\s*|\s*,\s*|、", raw)
    keys = []
    for p in parts:
        k = match_one(p, options)
        if k is None:
            # 区切りのない複数の答え（例: "A B"）は扱わない。
            return None
        if k not in keys:
            keys.append(k)
    return sorted(keys)


def split_alternatives(raw: str):
    """"B or D（原本で未確定）" のような、どちらも正解とする書き方を分ける。"""
    raw = TRAILING_NOTE.sub("", (raw or "").strip()).strip()
    if re.search(r"\s+or\s+", raw):
        return [p.strip() for p in re.split(r"\s+or\s+", raw) if p.strip()]
    return [raw] if raw else []


def classify(passage: str, prompt: str, options, kind: str, mode: str, in_group: bool) -> str:
    if mode == "order" or ORDER_SLOTS.search(passage):
        return "order"
    if kind == "kana":
        return "pair_combo"
    if len(passage) < 40 and len(re.findall(r"[：:；;]", passage)) >= 1 and (
        re.search(r"[/／=＝]", passage) or len(re.findall(r"[：:；;]", passage)) >= 2
    ):
        return "pair"
    if len(passage) >= 80:
        if in_group or re.search(r"(すべて選び|3問組|合致|抜き出し)", prompt):
            return "reading"
        return "blank_passage"
    if re.search(r"[\[［]|（\s*）|（　+）|＝＝|《》", passage):
        return "blank_passage" if len(passage) >= 40 else "blank_short"
    if "全体に下線" in passage:
        return "meaning"
    if "下線" in passage or re.search(r"[ァ-ヶ]", READING_PARENS.sub("", passage)):
        return "usage"
    # 選択肢の多くが設問の語を含む（設問の動詞が選択肢にも出てくる形）なら用法の問題。
    base = kata_to_hira(norm(passage))
    hits = sum(1 for _, t in options if shares_word(base, kata_to_hira(norm(t))))
    if options and len(options) >= 3 and hits / len(options) >= 0.6:
        return "usage"
    return "meaning"


def shares_word(a: str, b: str) -> bool:
    """漢字を含む2字以上か、かなが3字以上続く共通部分があるか（熟語の1字の重なりは数えない）。"""
    for i in range(len(a)):
        for j in range(i + 2, len(a) + 1):
            sub = a[i:j]
            if sub not in b:
                break
            if re.search(r"[一-龥々]", sub) or len(sub) >= 3:
                return True
    return False


# 機械の判定では分けにくい行を、問題を読んで決めた種類（2026-11-09 確認）。
TYPE_OVERRIDES = {
    12: "usage", 13: "usage", 93: "usage", 303: "usage", 327: "usage", 329: "usage",
    161: "meaning", 182: "meaning", 241: "meaning", 266: "meaning",
    309: "meaning", 314: "meaning", 334: "meaning", 335: "meaning",
}


def group_key(passage: str) -> str:
    return hashlib.sha1(norm(passage)[:40].encode()).hexdigest()[:10]


def build_questions(rows):
    """rows: [(行番号, 本文, 設問・選択肢, 答え, AIの答え, AIのロジック)]"""
    # 同じ本文が続けて並ぶ行（3問組など）だけを組にする。離れた場所の重複は別の問題として扱う。
    in_group_rows = set()
    for prev, cur in zip(rows, rows[1:]):
        if len(prev[1] or "") >= 80 and group_key(prev[1]) == group_key(cur[1]):
            in_group_rows.update({prev[0], cur[0]})

    questions = []
    issues = []
    for row, passage, choice_cell, answer, ai_answer, logic in rows:
        passage = (passage or "").strip()
        answer = (answer or "").strip()
        ai_answer = (ai_answer or "").strip()
        prompt, options, kind = parse_options(choice_cell)
        # 本文の後ろに " ／ 設問" が付いている行（並べ替えの設問が本文の欄に入っている形）。
        if " ／ " in passage and not prompt and re.search(r"(どれか|あてはまる)", passage.split(" ／ ", 1)[1]):
            passage, prompt = [s.strip() for s in passage.split(" ／ ", 1)]

        notes = []
        ai_differs = ai_answer not in ("", "○")
        source_answer = answer
        if not answer and ai_differs:
            answer = ai_answer
            notes.append("原本に正解がないため、AI の答えで採点します。")
        elif answer and ai_differs:
            notes.append(f"原本と AI で答えが分かれています（AI の答え: {ai_answer}）。どちらを選んでも正解にします。")
        if "未確定" in source_answer:
            notes.append("原本で答えが確定していません。")

        candidates = split_alternatives(answer)
        if answer and ai_differs and source_answer:
            candidates += split_alternatives(ai_answer)

        if kind == "digit" or re.fullmatch(r"\d{5}", answer or ""):
            mode = "order"
            accepted = [re.sub(r"\D", "", c) for c in candidates if re.sub(r"\D", "", c)]
            fragments = [(k, t) for k, t in options]
            if len(fragments) < 5:
                notes.append("原本で断片が欠けているため、採点しません。")
                accepted = []
        elif not options:
            mode = "text"
            accepted = [norm(c) for c in candidates if norm(c)]
            # 抜き出し問題なのに答えが本文にない行は、選択肢が欠けた問題とみなす。
            if accepted and not any(a in norm(passage) for a in accepted):
                notes.append("原本で選択肢が欠けているため、採点しません。")
                accepted = []
        else:
            parsed = []
            for c in candidates:
                keys = parse_choice_answer(c, options, kind)
                if keys is None:
                    issues.append((row, f"答え {c!r} を選択肢に対応づけられない"))
                    continue
                if keys not in parsed:
                    parsed.append(keys)
            accepted = parsed
            multi = kind == "kana" or "すべて選び" in prompt or any(len(a) > 1 for a in accepted)
            mode = "multi" if multi else "single"
            if len(options) < 2:
                notes.append("原本で選択肢が欠けているため、採点しません。")
                accepted = []

        if not accepted:
            if not any("採点しません" in n for n in notes):
                notes.append("正解が分からないため、採点しません。")

        in_group = row in in_group_rows
        qtype = TYPE_OVERRIDES.get(row) or classify(passage, prompt, options, kind, mode, in_group)
        questions.append(
            {
                "id": f"r{row}",
                "row": row,
                "type": qtype,
                "mode": mode,
                "passage": passage,
                "prompt": prompt,
                "optionKind": kind,
                "options": [{"key": k, "text": t} for k, t in options],
                "accepted": accepted,
                "scored": bool(accepted),
                "sourceAnswer": source_answer,
                "aiAnswer": ai_answer if ai_differs else "",
                "notes": notes,
                "explanation": (logic or "").strip(),
                "group": f"g{group_key(passage)}" if in_group else None,
            }
        )
    return questions, issues


def read_rows(xlsx: Path):
    import openpyxl

    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    header = [str(c or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
    expected = ["本文・問題", "設問・選択肢", "答え", "AIの答え", "AIのロジック"]
    if header[:5] != expected:
        raise SystemExit(f"見出しが想定と違います: {header[:5]}（想定: {expected}）")
    rows = []
    for i, r in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        vals = ["" if v is None else str(v) for v in list(r)[:5]]
        vals += [""] * (5 - len(vals))
        if not any(v.strip() for v in vals):
            continue
        rows.append((i, *vals))
    return rows


def encrypt(payload: dict, password: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt = secrets.token_bytes(16)
    iv = secrets.token_bytes(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS)
    key = kdf.derive(password.encode())
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def load_password(root: Path) -> str:
    pw = os.environ.get("WEBTEST_PASSWORD")
    env = root / ".env"
    if not pw and env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("WEBTEST_PASSWORD="):
                pw = line.split("=", 1)[1].strip()
    if not pw:
        raise SystemExit("WEBTEST_PASSWORD が設定されていません（.env か環境変数に書く）")
    return pw


def main(argv=None):
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", type=Path)
    ap.add_argument("--out", type=Path, default=root / "site" / "data.enc.json")
    ap.add_argument("--review", type=Path, default=root / "out" / "review.csv")
    ap.add_argument("--plain", type=Path, default=root / "out" / "questions.json")
    args = ap.parse_args(argv)

    rows = read_rows(args.xlsx)
    questions, issues = build_questions(rows)
    payload = {
        "title": "SPI 言語",
        "source": args.xlsx.name,
        "types": {k: {"label": v[0], "seconds": v[1]} for k, v in TYPES.items()},
        "questions": questions,
    }

    args.plain.parent.mkdir(parents=True, exist_ok=True)
    args.plain.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    with args.review.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["行", "種類", "回答の形", "選択肢の数", "正解", "採点", "注記", "本文の冒頭"])
        for q in questions:
            w.writerow(
                [q["row"], TYPES[q["type"]][0], q["mode"], len(q["options"]),
                 " | ".join(",".join(a) if isinstance(a, list) else a for a in q["accepted"]),
                 "する" if q["scored"] else "しない", " ".join(q["notes"]), q["passage"][:30]]
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(encrypt(payload, load_password(root))))

    counts = {}
    for q in questions:
        counts[q["type"]] = counts.get(q["type"], 0) + 1
    print(f"問題 {len(questions)} 問（採点する {sum(q['scored'] for q in questions)} 問）")
    for k, n in counts.items():
        print(f"  {TYPES[k][0]}: {n} 問")
    if issues:
        print(f"答えを対応づけられなかった行 {len(issues)} 件:", file=sys.stderr)
        for row, msg in issues:
            print(f"  行 {row}: {msg}", file=sys.stderr)
    print(f"暗号文: {args.out}")
    print(f"確認用（平文。git に入れない）: {args.plain}, {args.review}")


if __name__ == "__main__":
    main()
