"""手元版（1ファイルの HTML）をファイルとして直接開き、パスワードなしで一通り動くかを確かめる。

使い方: python3 tests/local_check.py [手元版のパス]   既定は ../SPI/SPI練習_ローカル版.html
"""

import sys
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FILE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "SPI" / "SPI練習_ローカル版.html"
URL = FILE.resolve().as_uri()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 860})
        page = ctx.new_page()
        errors, requests = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: requests.append(r.url))

        page.goto(URL)
        expect(page.locator("#home")).to_be_visible(timeout=10000)
        assert not page.locator("#lock").is_visible() and not page.locator("#logout").is_visible()
        print("OK ファイルを直接開くと、パスワードなしで最初の画面が出る。", page.inner_text("#start-info").replace("\n", " "))

        page.click("#types-none")
        page.click('#type-chips [data-type="meaning"]')
        page.click(".sub-settings summary")
        box = page.locator('#type-times input[data-type="meaning"]')
        box.fill("3")
        box.dispatch_event("change")
        page.click('#count-seg [data-count="10"]')
        page.click('#mode-seg [data-mode="exam"]')
        page.check("#opt-auto")
        page.click("#start")
        expect(page.locator("#quiz")).to_be_visible()
        assert page.locator(".share-bar").is_visible()
        page.locator("#q-body .opt").first.click()
        page.click("#q-submit")
        time.sleep(3.6)
        expect(page.locator("#q-progress")).to_contain_text("3 / 10")
        print("OK 出題、回答、時間切れでの自動の次へが動く（画面共有の帯も出る）")

        page.click("#quit")
        expect(page.locator("#result")).to_be_visible()
        assert page.locator("#r-list .rv").count() == 2
        assert page.locator("#r-list .rv-explain").first.is_visible()
        print("OK 結果画面で解説が見える:", page.inner_text("#r-score").replace("\n", " "))

        page.click("#r-home")
        page.click("#types-none")
        page.click('#type-chips [data-type="reading"]')
        page.click('#mode-seg [data-mode="practice"]')
        page.click("#start")
        assert page.locator("#q-tabs .tab").count() == 3
        page.locator("#q-tabs .tab").nth(2).click()
        print("OK 長文の3問組をタブで切り替えられる")
        page.click("#quit")

        page.reload()
        expect(page.locator("#home")).to_be_visible(timeout=10000)
        kept = page.evaluate("settings.seconds.meaning")
        hist = page.evaluate("Object.keys(history()).length")
        assert kept == 3 and hist >= 2, (kept, hist)
        print(f"OK 開き直しても設定（熟語の意味の制限 {kept} 秒）と履歴（{hist} 問分）が残る")

        external = [u for u in requests if not u.startswith("file:") and not u.startswith("data:")]
        assert not external, external
        print("OK ネットへの通信は 0 件（ファイルだけで動く）")
        assert not errors, errors
        print("OK ページのエラー 0 件")
        browser.close()


if __name__ == "__main__":
    main()
