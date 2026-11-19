"""Collect visible hiring posts for operators with LinkedIn-authorized automation access."""
import logging
import re
from datetime import date
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import sync_playwright

SELECTORS = {
    "cards": [
        "[data-urn^='urn:li:activity:'], [data-urn^='urn:li:ugcPost:'], [data-urn^='urn:li:share:']",
        "[data-activity-urn^='urn:li:activity:'], [data-activity-urn^='urn:li:ugcPost:']",
        "div.feed-shared-update-v2, [data-view-name='search-entity-result-universal-template']",
    ],
    "body": [
        ".update-components-text, .feed-shared-update-v2__description",
        "[data-testid='expandable-text-box'], [data-testid='expandable-text']",
        "[data-view-name='feed-commentary']",
        ".feed-shared-inline-show-more-text",
    ],
    "time": [
        "time[datetime]",
        "time",
        ".update-components-actor__sub-description time",
    ],
    "empty": [
        ".search-reusable-search-no-results",
        "[data-view-name='search-empty-state']",
    ],
}


def find_cards(page):
    for selector in SELECTORS["cards"]:
        locator = page.locator(selector)
        if locator.count():
            return locator
    primary = page.locator(SELECTORS["cards"][0])
    try:
        primary.first.wait_for(state="attached", timeout=12000)
        return primary
    except Exception:
        pass
    for selector in SELECTORS["cards"][1:]:
        locator = page.locator(selector)
        if locator.count():
            return locator
    return primary


def extract_urn(card):
    for attr in ("data-urn", "data-activity-urn", "data-id"):
        val = card.get_attribute(attr) or ""
        match = re.search(r"urn:li:(?:activity|ugcPost|share):(\d+)", val)
        if match:
            return match.group(0)
    try:
        links = card.locator("a[href*='/feed/update/'], a[href*='/posts/']").all()[:3]
    except Exception:
        links = []
    for link in links:
        href = link.get_attribute("href") or ""
        match = re.search(r"urn:li:(?:activity|ugcPost|share):(\d+)", href)
        if match:
            return match.group(0)
        post_match = re.search(r"-(\d{15,21})(?:[/?]|$)", href)
        if post_match:
            return f"urn:li:activity:{post_match.group(1)}"
    return ""


def extract_body(card):
    for selector in SELECTORS["body"]:
        body = card.locator(selector).first
        if body.count():
            text = body.inner_text().strip()
            if text:
                return text
    return ""


def extract_published(card):
    for selector in SELECTORS["time"]:
        stamp = card.locator(selector).first
        if stamp.count():
            dt = stamp.get_attribute("datetime") or stamp.inner_text().strip()
            if dt:
                try:
                    return date.fromisoformat(dt[:10]).isoformat()
                except ValueError:
                    pass
    return None


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
            cards = find_cards(page)
            card_count = cards.count()
            if card_count == 0:
                is_empty = any(page.locator(sel).count() > 0 for sel in SELECTORS["empty"])
                if is_empty:
                    logging.info("LinkedIn search returned zero results for query: %s", query)
                else:
                    logging.warning(
                        "No LinkedIn post cards found for query %r. "
                        "The page layout or DOM selectors may have changed.",
                        query,
                    )
                return []
            posts = []
            for card in cards.all()[:30]:
                urn = extract_urn(card)
                if not urn:
                    continue
                content = extract_body(card)
                if not content or not re.search(r"\b(hiring|vacanc\w*|open role|opening|apply|join our team)\b", content, re.I):
                    continue
                post_date = extract_published(card)
                posts.append({"url": "https://www.linkedin.com/feed/update/" + urn + "/", "text": content,
                              "title": content.splitlines()[0][:180], "published": post_date or date.today().isoformat(),
                              "date_kind": "published" if post_date else "observed"})
            if card_count > 0 and len(posts) == 0:
                logging.info(
                    "Inspected %d cards for query %r, but none matched hiring criteria or body selectors.",
                    card_count,
                    query,
                )
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
