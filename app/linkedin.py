"""Collect visible hiring posts for operators with LinkedIn-authorized automation access."""
import re
from datetime import date
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright


def collect_posts(cookie, query):
    from .sources import validate
    url = "https://www.linkedin.com/search/results/content/?" + urlencode({"keywords": query, "sortBy": "date_posted"})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            context = browser.new_context()
            context.add_cookies([{"name": "li_at", "value": cookie, "domain": ".linkedin.com",
                                  "path": "/", "httpOnly": True, "secure": True}])
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            if any(part in urlsplit(page.url).path for part in ("/login","/checkpoint","/authwall")):
                raise PermissionError("LinkedIn session needs attention")
            cards = page.locator("[data-urn^='urn:li:activity:'], [data-urn^='urn:li:ugcPost:']")
            if not cards.count():
                cards.first.wait_for(state="attached", timeout=12000)
            posts = []
            for card in cards.all()[:30]:
                urn = card.get_attribute("data-urn") or ""
                if not re.fullmatch(r"urn:li:(?:activity|ugcPost):\d+", urn):
                    continue
                body = card.locator(".update-components-text, .feed-shared-update-v2__description").first
                if not body.count():
                    continue
                content = body.inner_text().strip()
                if not content or not re.search(r"\b(hiring|vacanc\w*|open role|opening|apply|join our team)\b", content, re.I):
                    continue
                stamp = card.locator("time[datetime]").first
                published = stamp.get_attribute("datetime") if stamp.count() else None
                try:
                    post_date = date.fromisoformat((published or "")[:10]).isoformat()
                except ValueError:
                    post_date = None
                posts.append({"url": "https://www.linkedin.com/feed/update/" + urn + "/", "text": content,
                              "title": content.splitlines()[0][:180], "published": post_date or date.today().isoformat(),
                              "date_kind": "published" if post_date else "observed"})
            return validate(posts)
        finally:
            browser.close()




def secret_path():
    from . import settings as cfg
    return f"projects/{cfg.PROJECT}/secrets/hiremate-linkedin_li_at_cookie"


def current_cookie():
    from . import settings as cfg
    if not cfg.BUCKET:
        return cfg.LINKEDIN_COOKIE
    from google.cloud import secretmanager
    response = secretmanager.SecretManagerServiceClient().access_secret_version(
        name=secret_path() + "/versions/latest")
    return response.payload.data.decode()


def rotate_cookie(value):
    from google.cloud import secretmanager
    secretmanager.SecretManagerServiceClient().add_secret_version(
        parent=secret_path(), payload={"data": value.encode()})
