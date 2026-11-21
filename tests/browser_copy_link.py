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
        # Copy can close its menu without exposing a URL. Reopen the same menu for Embed.
        for host, expected in [("www.linkedin.com", original), ("example.org", search)]:
            page.set_content(html)
            page.evaluate("""host => {
                const actions = document.querySelector('#actions');
                const copy = document.querySelector('#copy');
                window.copyCount = 0;
                copy.onclick = () => { window.copyCount++; actions.hidden = true; };
                const embed = document.createElement("button");
                embed.setAttribute("aria-label", "Embed this post");
                embed.onclick = () => {
                    actions.hidden = true;
                    const dialog = document.createElement("dialog");
                    dialog.textContent = "Embed this post";
                    const code = document.createElement("textarea");
                    code.value = '<iframe src="https://' + host + '/embed/feed/update/urn:li:activity:7527956605288652801/"></iframe>';
                    const close = document.createElement("button");
                    close.setAttribute("aria-label", "Close");
                    close.onclick = () => dialog.remove();
                    dialog.append(code, close);
                    document.body.append(dialog);
                    dialog.showModal();
                };
                actions.append(embed);
            }""", host)
            retry = page.evaluate("readPosts()")["posts"][0]
            assert retry["url"] == expected, retry
            assert page.evaluate("window.copyCount === 1 && !document.querySelector('dialog[open]')")
            if expected == original:
                assert retry["preview_text"] == retry["text"]
        page.set_content(html)
        page.evaluate("""url => document.querySelector('#copy').onclick =
            () => navigator.clipboard.writeText(url)""", original.replace("www.", "").replace("urn:li:activity:", "urn%3Ali%3Aactivity%3A"))
        assert page.evaluate("readPosts()")["posts"][0]["url"] == original
        page.set_content(html.replace('<button aria-label', '<span>23m • </span><button aria-label', 1))
        page.evaluate("""() => {
            document.querySelector('#copy').onclick = () => navigator.clipboard.write([
                new ClipboardItem({'text/plain':new Blob(['https://lnkd.in/p/sharedPost'],{type:'text/plain'})})]);
        }""")
        shared = page.evaluate("readPosts()")["posts"][0]
        assert shared["url"] == search and shared["short_post_link"] == "https://lnkd.in/p/sharedPost", shared
        assert shared["age_label"] == "23m", shared

        # The first scan can use a timestamp link and age without opening the menu or original.
        page.add_script_tag(content=worker[worker.index("const postAgeSelector"):worker.index("async function search(")])
        body = '<div class="update-components-text">Hiring an accountant for the finance team to support month-end reporting.</div>'
        encoded = original.replace("www.", "").replace("urn:li:activity:", "urn%3Ali%3Aactivity%3A")
        page.set_content(f"""<main><article><h2>Feed post</h2><a href="{encoded}">
            <span aria-label="Posted 2 weeks ago"><span>2w</span><span> •</span></span></a>
            <button aria-label="More options for post" onclick="window.openedMenu=true"></button>{body}</article>
            <article><h2>Feed post</h2><span title="Posted 3 days ago">Published</span>{body}</article>
            <article><h2>Feed post</h2><div class="update-components-text">
              Hiring an analyst for our finance team. The following link is a previous opening.
              <a href="{original.replace('801/', '802/')}"><time datetime="2023-01-01">1w</time></a>
            </div></article></main>""")
        capture = """async () => {
            const {posts} = await readPosts(true, postAgeSelector);
            posts.forEach(applyVisibleAge);
            return posts;
        }"""
        records = page.evaluate(capture)
        assert len(records) == 3, records
        direct, preview, unrelated = records
        assert direct["url"] == original and direct["content_kind"] == "full", direct
        assert direct["date_kind"] == "relative" and not page.evaluate("Boolean(window.openedMenu)")
        assert preview["url"] == search and preview["date_kind"] == "relative", preview
        def days_back(days):
            return page.evaluate("""days => {
              const d = new Date(); d.setDate(d.getDate()-days);
              return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
            }""", days)
        assert direct["published"] == days_back(14) and preview["published"] == days_back(3)
        assert unrelated["url"] == search and unrelated["date_kind"] == "unknown", unrelated
        page.set_content(f"""<main><article><h2>Feed post</h2><a href="{encoded}">Post</a>
            <span aria-label="Posted 6 hours ago"></span><time datetime="2026-11-18"></time>{body}</article></main>""")
        exact = page.evaluate(capture)[0]
        assert exact["date_kind"] == "published" and exact["published"] == "2026-11-18", exact
        page.goto(original)
        page.set_content("""<main><article data-urn="urn:li:activity:7527956605288652801">
          <time datetime="2026-11-18"></time>
          <div class="update-components-text">Hiring an accountant. Send your CV to payroll@example.org</div>
          </article></main>""")
        page.add_script_tag(content=worker[worker.index("function publicationRecord"):])
        checked = page.evaluate("url => publicationRecord(url)", original)
        resolved = page.evaluate("url=>publicationRecord(url,'time',true)", search)
        assert resolved["permalink"] == original
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
