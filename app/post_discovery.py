"""Identify individual posts and route their published application instructions."""
import re
from datetime import date
from urllib.parse import parse_qs, urlsplit

from .store import EMAIL


def is_linkedin_url(url):
    host = urlsplit(url).hostname or ""
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def is_linkedin_search(url):
    page = urlsplit(url)
    return (page.scheme == "https" and page.netloc == "www.linkedin.com"
            and page.path == "/search/results/content/")


def linkedin_id(url):
    page = urlsplit(url)
    if page.scheme != "https" or not is_linkedin_url(url):
        return None
    if re.fullmatch(r"/groups/[0-9]+/?", page.path):
        urns = parse_qs(page.query).get("highlightedUpdateUrn", [])
        if len(urns) == 1:
            group_post = re.fullmatch(r"urn:li:activity:([0-9]{15,21})", urns[0])
            if group_post:
                return group_post[1]
        return None
    match = re.fullmatch(r"/(?:posts/[^/]*-(\d{15,21})(?:-[^/]*)?|feed/update/urn:li:(?:share|activity|ugcPost):(\d{15,21}))/?", page.path)
    return next((part for part in match.groups() if part), None) if match else None


def instructions(post, today=None):
    if post.get("content_kind", "full") != "full" or post.get("date_kind", "published") != "published":
        return "Unverified lead", "", ""
    try:
        age = ((today or date.today()) - date.fromisoformat(post["published"])).days
    except (KeyError, ValueError):
        return "Unverified lead", "", ""
    if not 0 <= age <= 14:
        return "Outside discovery window", "", ""
    text = post["text"]
    action = (r"(?:apply(?:\s+(?:by|via)\s+email)?\s+(?:at|to)|"
              r"(?:send|submit|share|email|e-mail|forward)\s+(?:(?:your|a|an|updated|latest)\s+)*"
              r"(?:résumés?|resumes?|cvs?|profiles?|applications?)\s*(?:(?:at|to|via email)\b)?|"
              r"(?:application|applications)\s+(?:email|to))")
    # Match the destination in the application instruction, including the next line.
    email = re.findall(r"\b" + action + r"[\s:–—-]*(" + EMAIL.pattern + ")", text, re.I)
    link = re.search(r"\b(?:apply|register|submit)\b[^.!?\n]{0,80}?\s*(https?://[^\s<>]+)", text, re.I)
    if link:
        return "Apply via link", "", link.group(1).rstrip(".,;:!?)")
    addresses = set(x.lower() for x in email)
    all_emails = set(x.lower() for x in EMAIL.findall(text))
    if len(addresses) == 1 and addresses == all_emails:
        return "Needs draft", addresses.pop(), ""
    return ("Check application instructions" if all_emails else "No email listed"), "", ""

