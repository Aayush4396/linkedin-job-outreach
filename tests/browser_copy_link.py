"""Browser regression for button-only post links and signed-in original verification."""
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    worker = (Path(__file__).resolve().parents[1] / "browser/worker.js").read_text(encoding="utf8")
    original = "https://www.linkedin.com/feed/update/urn:li:activity:7527956605288652801/"
    search = "https://www.linkedin.com/search/results/content/?keywords=payroll"
    html = """<main><article><h2>Feed post</h2>
        <button aria-label="More options for post" aria-controls="actions"
          onclick="actions.hidden=!actions.hidden">Menu</button>
        <div id="actions" role="menu" hidden><button id="copy" role="menuitem">Copy link to post</button></div>
        <p>Hiring an accountant to work with our payroll team and support month-end reconciliations.</p>
        </article></main>"""
    with sync_playwright() as pw:
        page = pw.chromium.launch(channel="chrome").new_page()
        page.route("**/*", lambda route: route.fulfill(body=html, content_type="text/html"))
        page.goto(search)
        page.add_script_tag(content=worker[worker.index("function publicationRecord"):])
        page.evaluate("""url => {
            window.priorWrite = navigator.clipboard.writeText;
            document.querySelector('#copy').onclick = () => Promise.resolve().then(() => navigator.clipboard.writeText(url));
        }""", original)
        result = page.evaluate("readPosts()")
        assert result["posts"][0]["url"] == original, result
        assert page.evaluate("navigator.clipboard.writeText === window.priorWrite")
        page.goto(original)
        page.set_content("""<main><article data-urn="urn:li:activity:7527956605288652801">
          <time datetime="2026-11-18"></time>
          <div class="update-components-text">Hiring an accountant. Send your CV to payroll@example.org</div>
          </article></main>""")
        page.add_script_tag(content=worker[worker.index("function publicationRecord"):])
        checked = page.evaluate("url => publicationRecord(url)", original)
        assert checked["evidence"]["content_kind"] == "full"
        assert checked["evidence"]["published"] == "2026-11-18"
        assert "payroll@example.org" in checked["evidence"]["text"]
        assert "stop" in page.evaluate("url => publicationRecord(url)", original.replace("801/", "802/"))
        page.goto("https://www.linkedin.com/login")
        page.add_script_tag(content=worker[worker.index("function publicationRecord"):])
        assert "sign-in" in page.evaluate("url => publicationRecord(url)", original)["stop"]
    print("Copy command, cleanup, rendered post, wrong ID and sign-in checks passed.")


if __name__ == "__main__":
    main()
