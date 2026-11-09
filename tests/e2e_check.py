"""ブラウザでの通しの確認（Playwright）。site/ を手元のサーバーで開いて操作する。

使い方: python3 tests/e2e_check.py [URL]   既定は http://127.0.0.1:8799/
パスワードは .env の WEBTEST_PASSWORD を使う。スクリーンショットは out/shots/ に保存する。
"""

import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799/"
PW = next(l.split("=", 1)[1].strip() for l in (ROOT / ".env").read_text().splitlines() if l.startswith("WEBTEST_PASSWORD="))
SHOTS = ROOT / "out" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)


def num(text):
    return float(text.replace("+", ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. ロック画面と、違うパスワード
        page.goto(URL)
        expect(page.locator("#lock")).to_be_visible()
        page.fill("#lock-pw", "0000")
        page.click("#lock-form button")
        expect(page.locator("#lock-error")).to_have_text("パスワードが違います。", timeout=20000)
        print("OK 違うパスワードは開かない")

        # 2. 正しいパスワード（記憶するに入れる）
        assert not page.is_checked("#lock-remember")
        page.check("#lock-remember")
        page.fill("#lock-pw", PW)
        page.click("#lock-form button")
        expect(page.locator("#home")).to_be_visible(timeout=20000)
        rows = page.locator("#type-rows tr").count()
        print(f"OK 開いた。種類の行 {rows} 行、{page.inner_text('#start-info')}")
        page.screenshot(path=str(SHOTS / "1_home.png"), full_page=True)

        # 3. 熟語の意味だけ、10問、本番、制限 3 秒
        page.click("#types-none")
        page.check('#type-rows input[data-type="meaning"]')
        page.fill('#type-rows input[type=number][data-type="meaning"]', "3")
        page.locator('#type-rows input[type=number][data-type="meaning"]').dispatch_event("change")
        page.select_option("#opt-count", "10")
        page.select_option("#opt-mode", "exam")
        page.check("#opt-auto")
        page.click("#start")
        expect(page.locator("#quiz")).to_be_visible()
        expect(page.locator("#q-progress")).to_have_text("1 / 10")

        # 4. 残りが減り、経過が増える
        assert num(page.inner_text("#bomb-digits")) > 2.0
        time.sleep(0.3)
        r1, e1 = num(page.inner_text("#bomb-digits")), num(page.inner_text("#bomb-elapsed"))
        time.sleep(1.0)
        r2, e2 = num(page.inner_text("#bomb-digits")), num(page.inner_text("#bomb-elapsed"))
        assert r2 < r1 and e2 > e1, (r1, r2, e1, e2)
        print(f"OK タイマー: 残り {r1}→{r2} 秒、経過 {e1}→{e2} 秒")
        page.screenshot(path=str(SHOTS / "2_quiz.png"))

        # 5. 選んで回答すると次へ
        page.locator("#q-body .opt").first.click()
        page.click("#q-submit")
        expect(page.locator("#q-progress")).to_have_text("2 / 10")
        print("OK 回答して次の問題へ進んだ")

        # 6. 何もしないと 3 秒で時間切れになり、次へ進む
        time.sleep(1.4)
        assert page.locator("#bomb").get_attribute("class").count("danger") == 1, page.locator("#bomb").get_attribute("class")
        expect(page.locator("#q-progress")).to_have_text("3 / 10", timeout=5000)
        print("OK 残り3秒で点滅し、時間切れで自動的に次へ進んだ")

        # 7. Enter の押しっぱなし（キーリピート）では1問しか進まない
        page.keyboard.press("b")
        page.keyboard.down("Enter")
        page.dispatch_event("body", "keydown", {"key": "Enter", "repeat": True})
        page.keyboard.up("Enter")
        expect(page.locator("#q-progress")).to_have_text("4 / 10")
        print("OK Enter のキーリピートでは次へ飛ばない")

        # キーボードで回答（B と Enter）
        page.keyboard.press("b")
        assert "selected" in page.locator("#q-body .opt").nth(1).get_attribute("class")
        page.keyboard.press("Enter")
        expect(page.locator("#q-progress")).to_have_text("5 / 10")
        print("OK キーボードで選んで回答できた")

        # 8. やめて結果を見る
        page.click("#quit")
        expect(page.locator("#result")).to_be_visible()
        print("OK 結果:", page.inner_text("#r-score"))
        timeouts = page.locator("#r-types tr td").nth(5).inner_text()
        assert timeouts == "1", timeouts
        print("OK 時間切れ 1 問が記録された")
        page.screenshot(path=str(SHOTS / "3_result.png"), full_page=True)

        # 9. 練習モードで並べ替え（正解の順に押す）
        page.click("#r-home")
        page.click("#types-none")
        page.check('#type-rows input[data-type="order"]')
        page.select_option("#opt-mode", "practice")
        page.select_option("#opt-order", "source")
        page.select_option("#opt-filter", "all")
        page.select_option("#opt-count", "0")
        page.click("#start")
        # 最初の問題（[ n ]にあてはまる、の単一選択）は飛ばし、断片を並べる問題まで進める
        for _ in range(60):
            if page.locator(".order-slots").count():
                break
            page.locator("#q-body .opt").first.click()
            page.click("#q-submit")
            page.click("#q-submit")
        assert page.locator(".order-slots").count() == 1
        answer = page.evaluate("session.current.q.accepted[0]")
        for d in answer:
            page.keyboard.press(d)
        page.screenshot(path=str(SHOTS / "4_order.png"))
        page.click("#q-submit")
        expect(page.locator("#q-feedback .verdict")).to_contain_text("正解")
        print(f"OK 並べ替え {answer} を入力して正解と判定、解説を表示")
        page.screenshot(path=str(SHOTS / "5_feedback.png"), full_page=True)

        # 10. 再読み込みすると、記憶したパスワードで開く
        page.reload()
        expect(page.locator("#home")).to_be_visible(timeout=20000)
        print("OK 再読み込みで自動的に開いた")

        # 11. スマートフォンの幅
        m = browser.new_page(viewport={"width": 390, "height": 844})
        m.goto(URL)
        m.fill("#lock-pw", PW)
        m.click("#lock-form button")
        expect(m.locator("#home")).to_be_visible(timeout=20000)
        m.click("#types-all")
        m.select_option("#opt-mode", "exam")
        m.select_option("#opt-order", "source")
        m.click("#start")
        m.screenshot(path=str(SHOTS / "6_mobile.png"))
        print("OK スマートフォンの幅で表示")

        assert not errors, errors
        print("OK ページのエラー 0 件")
        browser.close()


if __name__ == "__main__":
    main()
