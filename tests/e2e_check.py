"""ブラウザでの通しの確認（Playwright）。site/ を手元のサーバーで開いて操作する。

使い方: python3 tests/e2e_check.py [URL]   既定は http://127.0.0.1:8799/
パスワードは .env の WEBTEST_PASSWORD を使う。スクリーンショットは out/shots/ に保存する。
"""

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799/"
PW = next(l.split("=", 1)[1].strip() for l in (ROOT / ".env").read_text().splitlines() if l.startswith("WEBTEST_PASSWORD="))
SHOTS = ROOT / "out" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)


def elapsed(page):
    return float(re.match(r"([\d.]+) 秒", page.inner_text("#timer-sec")).group(1))


def setup(page, types, mode="exam", order="source", count="0", seconds=None):
    page.click("#types-none")
    for t in types:
        page.click(f'#type-chips [data-type="{t}"]')
        if seconds:
            if not page.locator(".sub-settings").get_attribute("open") is not None:
                page.click(".sub-settings summary")
            box = page.locator(f'#type-times input[data-type="{t}"]')
            box.fill(str(seconds))
            box.dispatch_event("change")
    page.click(f'#mode-seg [data-mode="{mode}"]')
    page.click(f'#order-seg [data-order="{order}"]')
    page.click(f'#count-seg [data-count="{count}"]')
    page.click('#filter-seg [data-filter="all"]')
    page.check("#opt-auto")
    page.click("#start")
    expect(page.locator("#quiz")).to_be_visible()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 860})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. ロック
        page.goto(URL)
        page.fill("#lock-pw", "0000")
        page.click("#lock-form button")
        expect(page.locator("#lock-error")).to_have_text("パスワードが違います。", timeout=20000)
        assert not page.is_checked("#lock-remember")
        page.check("#lock-remember")
        page.fill("#lock-pw", PW)
        page.click("#lock-form button")
        expect(page.locator("#home")).to_be_visible(timeout=20000)
        print("OK 違うパスワードでは開かず、正しいパスワードで開いた。", page.inner_text("#start-info"))
        assert "on" in page.locator('#order-seg [data-order="random"]').get_attribute("class"), "タイプの中の選び方の既定はランダム"
        page.fill("#count-input", "20")
        page.dispatch_event("#count-input", "change")
        info = page.inner_text("#start-info")
        assert info.startswith("20 問") and "熟語の意味 3・語句の用法 3・二語の関係 3・二語の関係（組み合わせ） 2・空欄補充（短文） 2・空欄補充（文章） 2・文の並べ替え 2・長文読解 3" in info, info
        print("OK タイプの中はランダムが既定。20問を8タイプに均等に配分:", info.replace("\n", " "))

        # タイプの順は本番どおりに固定され、タイプの中はランダムに選ばれる
        order_ok = page.evaluate("""() => {
          const keys = Object.keys(DATA.types);
          const idx = lastPreview.map((q) => keys.indexOf(q.type));
          return idx.every((v, i) => i === 0 || idx[i - 1] <= v);
        }""")
        assert order_ok, "タイプの順が本番どおりでない"
        rows = [page.evaluate("buildSet(pool()).questions.filter(q => q.type === 'meaning').map(q => q.row).join(',')") for _ in range(3)]
        first3 = page.evaluate("DATA.questions.filter(q => q.type === 'meaning' && q.scored).slice(0, 3).map(q => q.row).join(',')")
        assert len(set(rows)) > 1 and rows[0] != first3, (rows, first3)
        print(f"OK タイプの順は固定、熟語の意味の3問は毎回ランダムに選ばれる（例: 行 {rows[0]} / {rows[1]}）")

        # 2. 熟語の意味、10問、本番、制限3秒
        setup(page, ["meaning"], count="10", seconds=3)
        expect(page.locator("#q-progress")).to_contain_text("1 / 10")
        assert "下線部" in page.inner_text("#q-instr")
        assert page.locator("#q-passage .ul").count() == 1, "熟語の意味は本文に下線"
        time.sleep(0.3)
        e1 = elapsed(page)
        w1 = page.evaluate("document.querySelector('#timer-cells .cell b').style.width")
        time.sleep(0.8)
        e2 = elapsed(page)
        w3 = page.evaluate("[...document.querySelectorAll('#timer-cells .cell b')].map(b => parseFloat(b.style.width) || 0)")
        assert e2 > e1, (e1, e2)
        assert w3[0] == 100 and w3[2] > 0 and w3[9] == 0, w3
        print(f"OK 回答時間のマスが左から塗られ、経過秒数が増える（{e1}→{e2} 秒、1マス目 {w1}→100%）")
        page.screenshot(path=str(SHOTS / "1_meaning.png"))

        page.locator("#q-body .opt").first.click()
        assert page.locator("#q-body .opt.selected").count() == 1
        page.click("#q-submit")
        expect(page.locator("#q-progress")).to_contain_text("2 / 10")
        print("OK 選んで次へで進んだ")

        time.sleep(1.2)
        last = page.evaluate("parseFloat(document.querySelectorAll('#timer-cells .cell b')[9].style.width) || 0")
        expect(page.locator("#q-progress")).to_contain_text("3 / 10", timeout=5000)
        print(f"OK 赤のマスまで進むと自動で次へ進んだ（赤の直前の塗り {last:.0f}%）")

        page.keyboard.press("b")
        page.keyboard.down("Enter")
        page.dispatch_event("body", "keydown", {"key": "Enter", "repeat": True})
        page.keyboard.up("Enter")
        expect(page.locator("#q-progress")).to_contain_text("4 / 10")
        print("OK キーボードで回答でき、Enter の押しっぱなしでは飛ばない")

        page.click("#quit")
        expect(page.locator("#result")).to_be_visible()
        assert "時間切れ 1 問" in page.inner_text("#r-score"), page.inner_text("#r-score")
        cards = page.locator("#r-list .rv")
        assert cards.count() == 3, cards.count()
        assert cards.first.locator(".rv-explain").is_visible(), "解説は最初から見える"
        assert cards.first.locator(".rv-choices li.correct").count() >= 1
        page.click('#r-filter [data-f="timeout"]')
        assert page.locator("#r-list .rv").count() == 1
        print("OK 結果:", page.inner_text("#r-score").replace("\n", " "), "／ 1問ずつ解説が開いた状態で並び、時間切れだけに絞れる")
        page.screenshot(path=str(SHOTS / "1b_result.png"), full_page=True)
        page.click("#r-home")
        page.click('#order-seg [data-order="source"]')
        nxt = page.evaluate("lastPreview[0].row")
        fourth = page.evaluate("DATA.questions.filter(q => q.type === 'meaning' && q.scored)[3].row")
        assert nxt == fourth, (nxt, fourth)
        assert "熟語の意味" in page.inner_text("#resume-info")
        print(f"OK 問題集の順では、タイプごとに前回の続きから（3問解いたので4問目、行 {nxt} から）")
        page.click("#resume-reset")
        first = page.evaluate("DATA.questions.filter(q => q.type === 'meaning' && q.scored)[0].row")
        assert page.evaluate("lastPreview[0].row") == first
        print("OK 最初からに戻すで、1問目から出る")

        # 3. 長文（3問組）: タブで切り替え、練習モードで解説
        setup(page, ["reading"], mode="practice")
        expect(page.locator("#q-tabs")).to_be_visible()
        assert page.locator("#q-tabs .tab").count() == 3
        assert "3問組" in page.inner_text("#q-group-badge")
        page.screenshot(path=str(SHOTS / "2_reading_tab1.png"))
        prompt1 = page.inner_text("#q-prompt")
        page.locator("#q-tabs .tab").nth(2).click()
        assert page.inner_text("#q-prompt") != prompt1
        assert "current" in page.locator("#q-tabs .tab").nth(2).get_attribute("class")
        page.locator("#q-tabs .tab").nth(0).click()
        answer1 = page.evaluate("session.cur.unit.qs[0].accepted[0]")
        page.fill(".text-answer", answer1)
        page.click("#q-submit")
        assert "current" in page.locator("#q-tabs .tab").nth(1).get_attribute("class")
        assert "done" in page.locator("#q-tabs .tab").nth(0).get_attribute("class")
        page.locator("#q-body .opt").first.click()
        page.screenshot(path=str(SHOTS / "3_reading_tab2.png"))
        page.click("#q-submit")
        page.click("#q-submit")
        expect(page.locator("#q-feedback")).to_be_visible()
        assert page.locator("#q-feedback .rv").count() == 3
        assert page.locator("#q-feedback .badge").first.inner_text() == "正解"
        print(f"OK 3問組をタブで切り替え、問1（{answer1}）は正解、3問分の解説が出た")
        page.screenshot(path=str(SHOTS / "4_reading_feedback.png"), full_page=True)
        page.click("#quit")
        page.click("#r-home")

        # 4. ア・イ・ウ: 本番と同じ6択、左にア・イ・ウ
        setup(page, ["pair_combo"])
        texts = page.locator("#q-body .opt .txt").all_inner_texts()
        assert texts == ["アだけ", "イだけ", "ウだけ", "アとイ", "アとウ", "イとウ"], texts
        assert page.inner_text("#q-sub").startswith("ア")
        page.screenshot(path=str(SHOTS / "5_pair_combo.png"))
        print("OK ア・イ・ウは6択（アだけ〜イとウ）で、左にア・イ・ウの対を表示")
        page.click("#quit")
        page.click("#r-home")

        # 5. 用法: 下線
        setup(page, ["usage"])
        ul = page.inner_text("#q-passage .ul")
        assert ul == "あずかる", ul
        print(f"OK 用法の問題の下線: {page.inner_text('#q-passage')} → 下線は {ul}")
        page.screenshot(path=str(SHOTS / "6_usage.png"))
        page.click("#quit")
        page.click("#r-home")

        # 6. 並べ替え（断片の順番）
        setup(page, ["order"], mode="practice")
        for _ in range(60):
            if page.locator(".order-slots").count():
                break
            page.locator("#q-body .opt").first.click()
            page.click("#q-submit")
            page.click("#q-submit")
        assert page.locator(".order-slots").count() == 1
        answer = page.evaluate("session.cur.unit.qs[session.cur.tab].accepted[0]")
        for d in answer:
            page.keyboard.press(d)
        page.screenshot(path=str(SHOTS / "7_order.png"))
        page.click("#q-submit")
        expect(page.locator("#q-feedback .badge").first).to_have_text("正解")
        print(f"OK 並べ替え {answer} を入力して正解")
        page.click("#quit")

        # 7. 再読み込みで自動的に開く
        page.reload()
        expect(page.locator("#home")).to_be_visible(timeout=20000)
        print("OK 再読み込みで記憶したパスワードで開いた")

        # 8. スマートフォンの幅
        m = browser.new_page(viewport={"width": 390, "height": 844})
        m.goto(URL)
        m.fill("#lock-pw", PW)
        m.click("#lock-form button")
        expect(m.locator("#home")).to_be_visible(timeout=20000)
        setup(m, ["reading"])
        sw = m.evaluate("document.documentElement.scrollWidth")
        assert sw <= 390, sw
        assert m.locator(".spi-next").is_visible() and m.locator(".spi-timer").is_visible()
        m.screenshot(path=str(SHOTS / "8_mobile.png"))
        print(f"OK スマートフォンの幅で横にはみ出さず（幅 {sw}px）、回答時間と次へが下に固定")
        m.click("#quit")
        m.click("#r-home")

        # 9. スマートフォンの結果画面: URL を含む解説（用法の3問目）でも横にはみ出さない
        setup(m, ["usage"], count="10")
        for _ in range(3):
            m.locator("#q-body .opt").first.click()
            m.click("#q-submit")
        m.click("#quit")
        expect(m.locator("#result")).to_be_visible()
        assert m.locator("#r-list .rv-explain", has_text="http").count() >= 1, "URL を含む解説が対象に入っていない"
        sw = m.evaluate("document.documentElement.scrollWidth")
        assert sw <= 390, sw
        m.screenshot(path=str(SHOTS / "9_mobile_result.png"), full_page=True)
        print(f"OK スマートフォンの結果画面は、URL を含む解説でも横にはみ出さない（幅 {sw}px）")

        # 10. 解き直しでは続きの位置が巻き戻らない
        m.click("#r-home")
        row_usage = m.evaluate("resumeRow('usage')")
        assert row_usage > 0
        m.click("#start")
        m.locator("#q-body .opt").nth(5).click()
        m.click("#q-submit")
        m.click("#quit")
        before = m.evaluate("resumeRow('usage')")
        retried = m.locator("#r-retry-wrong").is_enabled()
        if retried:
            m.click("#r-retry-wrong")
            m.click("#quit")
            assert m.evaluate("resumeRow('usage')") == before, (before, m.evaluate("resumeRow('usage')"))
        print(f"OK 用法の続きの位置 {row_usage}→{before} 行目。解き直し（{'実施' if retried else '不正解なしで未実施'}）では巻き戻らない")

        # 11. 問題数の欄を空にしても1問にならない
        m.click("#r-home")
        m.click('#count-seg [data-count="20"]')
        m.fill("#count-input", "")
        m.dispatch_event("#count-input", "change")
        assert m.evaluate("settings.count") == 20
        print("OK 問題数の欄を空にしても設定は変わらない")

        assert not errors, errors
        print("OK ページのエラー 0 件")
        browser.close()


if __name__ == "__main__":
    main()
