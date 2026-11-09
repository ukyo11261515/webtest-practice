"""build_data.py の変換規則のテスト。実在の問題は使わず、形だけをまねた見本で確かめる。"""

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))

import build_data as b  # noqa: E402


def one(passage, choices, answer, ai="○", logic="", row=2):
    qs, issues = b.build_questions([(row, passage, choices, answer, ai, logic)])
    assert not issues, issues
    return qs[0]


def test_letter_options_and_reading_marks():
    q = one("意味の説明", "A 甲乙\nB 丙丁(テイ)\nC 戊己", "B 丙丁")
    assert q["mode"] == "single"
    assert q["accepted"] == [["B"]]
    assert q["type"] == "meaning"


def test_plain_options_matched_by_text():
    q = one("意味の説明", "甲乙\n丙丁《テイ》\n戊己", "丙丁《テイ》")
    assert [o["key"] for o in q["options"]] == ["A", "B", "C"]
    assert q["accepted"] == [["B"]]


def test_multi_select_by_letters_and_by_slash():
    long = "あ" * 90
    q1 = one(long, "合致するものをすべて選びなさい。\n\nA 一\nB 二\nC 三\nD 四", "A, C")
    assert q1["mode"] == "multi" and q1["accepted"] == [["A", "C"]]
    q2 = one(long, "すべて選びなさい。\n\nA 一つ目\nB 二つ目\nC 三つ目", "A 一つ目 / C 三つ目")
    assert q2["accepted"] == [["A", "C"]]


def test_kana_combo_including_none():
    q = one("甲；乙", "ア 丙；丁\nイ 戊；己\nウ 庚；辛", "アとウ")
    assert q["type"] == "pair_combo" and q["mode"] == "multi"
    assert q["accepted"] == [["ア", "ウ"]]
    q2 = one("甲；乙", "ア 丙；丁\nイ 戊；己\nウ 庚；辛", "該当なし")
    assert q2["accepted"] == [[]]


def test_ai_disagreement_accepts_both_and_notes_it():
    q = one("意味の説明", "A 甲乙\nB 丙丁\nC 戊己", "A 甲乙", ai="C 戊己")
    assert q["accepted"] == [["A"], ["C"]]
    assert any("分かれています" in n for n in q["notes"])


def test_missing_answer_falls_back_to_ai():
    q = one("意味の説明", "甲乙\n丙丁", "", ai="丙丁")
    assert q["scored"] and q["accepted"] == [["B"]]
    assert any("AI の答え" in n for n in q["notes"])


def test_or_alternatives():
    q = one("できる（下線は「できる」）", "A 一\nB 二\nC 三\nD 四", "B or D（原本で未確定）")
    assert q["accepted"] == [["B"], ["D"]]


def test_order_question_and_incomplete_fragments():
    q = one("前の文 12345 後の文", "1〜5の断片を並べ替えて文を完成させる\n\n1 あ\n2 い\n3 う\n4 え\n5 お", "31254")
    assert q["mode"] == "order" and q["type"] == "order" and q["accepted"] == ["31254"]
    broken = one("前の文 12345 後の文", "1〜5の断片を並べ替えて文を完成させる\n\n1 あ\n2 い", "")
    assert not broken["scored"]


def test_slot_question_is_order_type():
    q = one("文の頭 [ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ] 文の終わり", "[ 2 ] にあてはまるものはつぎのうちどれか。\n\nA 一\nB 二\nC 三\nD 四\nE 五", "B 二")
    assert q["type"] == "order" and q["mode"] == "single"


def test_pair_with_full_width_slash_is_not_split_into_prompt():
    q = one("甲乙：丙丁 ／ 戊己：（　　）", "A 甲\nB 乙\nC 丙", "B 乙")
    assert q["type"] == "pair"
    assert q["passage"] == "甲乙：丙丁 ／ 戊己：（　　）" and q["prompt"] == ""


def test_question_after_slash_moves_to_prompt():
    q = one("文の頭［ 1 ］［ 2 ］［ 3 ］［ 4 ］［ 5 ］終わり ／ ［ 1 ］にあてはまるものはつぎのうちどれか。", "A 一\nB 二\nC 三\nD 四\nE 五", "B 二")
    assert q["prompt"].startswith("［ 1 ］にあてはまる")


def test_text_answer_question():
    long = "い" * 80 + "更新" + "い" * 10
    q = one(long, "文中の空所に入れるべきことばを、文中から2文字で抜き出しなさい。", "更新")
    assert q["mode"] == "text" and q["accepted"] == ["更新"]


def test_only_consecutive_same_passages_form_a_group():
    long = "う" * 90
    rows = [
        (2, long, "すべて選びなさい。\n\nA 一\nB 二", "A", "○", ""),
        (3, long, "すべて選びなさい。\n\nA 一\nB 二", "B", "○", ""),
        (4, "意味の説明", "A 甲\nB 乙", "A", "○", ""),
        (5, long, "[　]に入る語句\n\nA 一\nB 二", "A", "○", ""),
    ]
    qs, _ = b.build_questions(rows)
    assert qs[0]["group"] and qs[0]["group"] == qs[1]["group"]
    assert qs[3]["group"] is None


def test_encrypt_roundtrip():
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    blob = b.encrypt({"x": "問題"}, "1234")
    assert "問題" not in json.dumps(blob, ensure_ascii=False)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(blob["salt"]), iterations=blob["iter"])
    key = kdf.derive(b"1234")
    plain = AESGCM(key).decrypt(base64.b64decode(blob["iv"]), base64.b64decode(blob["ct"]), None)
    assert json.loads(plain) == {"x": "問題"}


def test_missing_options_are_not_scored():
    single = one("意味の説明", "甲乙", "甲乙")
    assert not single["scored"]
    text = one("意味の《》が大きい", "", "丙丁")
    assert text["mode"] == "text" and not text["scored"]
