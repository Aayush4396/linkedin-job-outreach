import re
from typing import Literal
from urllib.parse import urlencode

from pydantic import BaseModel, Field

from . import settings as cfg
from .storage import read


class Search(BaseModel):
    roles: str = Field(default="", max_length=240)
    locations: str = Field(default="", max_length=240)
    workplace: Literal["Any", "Remote", "Hybrid", "Onsite"] = "Any"
    employment: Literal["Any", "Contract", "Full-time"] = "Any"

    def query(self):
        roles = terms(self.roles)
        if not roles:
            return cfg.LINKEDIN_QUERY
        return "hiring (" + " OR ".join('"' + role.replace('"', '') + '"' for role in roles) + ")"

    def matches(self, post):
        text = post["title"] + " " + post["text"]
        for values in (terms(self.roles), terms(self.locations)):
            if values and not any(re.search(r"(?<!\w)" + re.escape(v) + r"(?!\w)", text, re.I) for v in values):
                return False
        patterns = {"Remote": r"\bremote\b|work from home", "Hybrid": r"\bhybrid\b", "Onsite": r"\bon[ -]?site\b",
                    "Contract": r"\b(contract|freelanc\w*)\b", "Full-time": r"\bfull[ -]?time\b"}
        for choice in (self.workplace, self.employment):
            if choice != "Any" and not re.search(patterns[choice], text, re.I):
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
