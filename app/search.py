import re
from typing import Literal
from urllib.parse import urlencode

from pydantic import BaseModel, Field

from . import settings as cfg
from .storage import read


CHOICE_TERMS = {
    "Remote": ("remote", "work from home"),
    "Hybrid": ("hybrid",),
    "Onsite": ("onsite", "on-site", "on site"),
    "Contract": ("contract", "freelance", "freelancer", "freelancing", "contractor"),
    "Full-time": ("full-time", "full time", "fulltime"),
}


def keyword_group(values):
    phrases = ['"' + value.replace('"', '') + '"' for value in values]
    return phrases[0] if len(phrases) == 1 else "(" + " OR ".join(phrases) + ")"


class Search(BaseModel):
    roles: str = Field(default="", max_length=240)
    locations: str = Field(default="", max_length=240)
    workplace: Literal["Any", "Remote", "Hybrid", "Onsite"] = "Any"
    employment: Literal["Any", "Contract", "Full-time"] = "Any"

    def query(self):
        roles = terms(self.roles)
        return "hiring " + keyword_group(roles) if roles else cfg.LINKEDIN_QUERY

    def filter_groups(self):
        return (terms(self.locations), CHOICE_TERMS.get(self.workplace, ()),
                CHOICE_TERMS.get(self.employment, ()))

    def matches(self, post):
        text = post["title"] + " " + post["text"]
        for values in (terms(self.roles), *self.filter_groups()):
            if values and not any(re.search(r"(?<!\w)" + re.escape(v) + r"(?!\w)", text, re.I) for v in values):
                return False
        if self.workplace == "Remote" and re.search(r"\b(no remote|not remote|on[ -]?site only)\b", text, re.I):
            return False
        return True

    def url(self):
        return "https://www.linkedin.com/search/results/content/?" + urlencode({"keywords":self.query(),"sortBy":'"date_posted"'})


def terms(value):
    return [term.strip() for term in value.split(",") if term.strip()]


def saved_search():
    return Search.model_validate(read("settings", "search") or {})
