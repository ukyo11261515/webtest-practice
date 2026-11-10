"""build_local.py の問題セットの取り込みのテスト。実在の問題は使わず、形だけをまねた見本で確かめる。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))

import build_local as bl  # noqa: E402


def base():
    mk = lambda i, g=None: {"id": f"r{i}", "row": i, "type": "reading", "mode": "single", "passage": "甲",
                            "options": [], "accepted": [["A"]], "scored": True, "group": g, "sets": ["spi"]}
    return [mk(2, "g1"), mk(3, "g1"), mk(4, "g1"), mk(5)]


def write(tmp_path, items, name="問題セット_20990101_V0.json"):
    f = tmp_path / name
    f.write_text(json.dumps({"set": "20990101", "label": "1月1日", "items": items}, ensure_ascii=False))
    return f


def test_ref_marks_whole_group(tmp_path):
    qs, meta, problems = bl.merge_sets(base(), [write(tmp_path, [{"ref": "r3"}])])
    assert not problems
    assert [q["id"] for q in qs if "20990101" in q["sets"]] == ["r2", "r3", "r4"]
    assert meta[-1] == {"id": "20990101", "label": "1月1日"}


def test_new_item_number_is_normalized_and_validated(tmp_path):
    items = [
        {"id": "s-1", "type": "nv_calc", "mode": "number", "passage": "甲", "prompt": "何円か。", "accepted": ["１,２００"], "unit": "円"},
        {"id": "s-2", "type": "nv_table", "mode": "single", "options": [{"key": "A", "text": "1"}], "accepted": [["B"]]},
        {"id": "s-3", "type": "unknown", "mode": "single", "options": [], "accepted": [["A"]]},
    ]
    qs, _, problems = bl.merge_sets(base(), [write(tmp_path, items)])
    added = {q["id"]: q for q in qs if q["id"].startswith("s-")}
    assert added["s-1"]["accepted"] == ["1200"] and added["s-1"]["sets"] == ["20990101"]
    assert any("s-2" in p and "選択肢にない" in p for p in problems)
    assert any("s-3" in p and "タイプ" in p for p in problems)


def test_latest_version_is_used(tmp_path):
    write(tmp_path, [], "問題セット_20990101_V0.json")
    write(tmp_path, [], "問題セット_20990101_V2.json")
    write(tmp_path, [], "問題セット_20990101_V1.json")
    files = bl.latest_set_files(str(tmp_path / "問題セット_*.json"))
    assert [f.name for f in files] == ["問題セット_20990101_V2.json"]


def test_output_inside_repo_is_refused(tmp_path):
    root = Path(__file__).resolve().parent.parent
    try:
        bl.main(["dummy.xlsx", "--out", str(root / "site" / "x.html")])
    except SystemExit as e:
        assert "リポジトリの中" in str(e)
    else:
        raise AssertionError("リポジトリの中への出力が止まらなかった")
