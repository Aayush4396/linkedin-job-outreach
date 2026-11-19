import unittest
from datetime import date, timedelta
from unittest.mock import Mock

from app.discovery_pilot import pilot
from app.post_discovery import instructions
from app.search import Search
from urllib.parse import parse_qs, urlsplit


class DiscoveryTests(unittest.TestCase):
    def test_saved_filters_in_search_and_import(self):
        search = Search(roles="GenAI, Generative AI, LLM, data science", locations="india", employment="Full-time")
        query = parse_qs(urlsplit(search.url()).query)["keywords"][0]
        self.assertEqual(query, 'hiring ("GenAI" OR "Generative AI" OR "LLM" OR "data science")')
        self.assertFalse(search.matches(dict(title="Hiring ServiceNow Architect – TSM & Agentic AI", text="India full time")))
        for text in ("contract in India", "full-time in London"):
            self.assertFalse(search.matches(dict(title="Hiring Data Science Lead", text=text)))
        self.assertTrue(search.matches(dict(title="Hiring Data Science Lead", text="Full time in India")))
        remote = Search(workplace="Remote")
        self.assertEqual(remote.query(), Search().query())
        self.assertTrue(remote.matches(dict(title="Hiring", text="Work from home")))
        self.assertFalse(remote.matches(dict(title="Hiring", text="Onsite only")))

    def setUp(self):
        self.post = dict(title="Hiring AI Engineer", published=date.today().isoformat(),
                         text="Send your resume to: hiring@example.org",
                         url="https://www.linkedin.com/posts/recruiter_hiring-activity-7527956605288652800-abcd/")

    def test_qualified_repeat(self):
        second = dict(self.post, url="https://www.linkedin.com/feed/update/urn:li:activity:7527956605288652800/?trk=test")
        source = Mock(side_effect=[[self.post], [second]])
        self.assertTrue(pilot(source))
        self.assertEqual(source.call_count, 2)

    def test_signed_in_search_result_shapes(self):
        group = dict(self.post, url="https://www.linkedin.com/groups/123/?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7527956605288652800")
        source = Mock(side_effect=[[group], [self.post]])
        self.assertTrue(pilot(source))
        seeker = dict(group, text="I am looking for AI engineer roles. Email: me@example.org #hiring")
        self.assertFalse(pilot(lambda: [seeker]))

    def test_application_evidence(self):
        self.assertEqual(instructions(self.post)[:2], ("Needs draft", "hiring@example.org"))
        invitation = dict(self.post, text="Interested candidates can share their profiles at:\nhiring@example.org")
        self.assertEqual(instructions(invitation)[:2], ("Needs draft", "hiring@example.org"))
        self.assertEqual(instructions(dict(self.post,text="Register here: https://example.org/jobs/123"))[2],
                         "https://example.org/jobs/123")
        self.assertEqual(instructions(dict(self.post,text="For questions, email team@example.org"))[0],
                         "Check application instructions")
        for change in (dict(content_kind="snippet"),dict(date_kind="observed"),dict(published="")):
            self.assertEqual(instructions(dict(self.post,**change))[0],"Unverified lead")
        self.assertEqual(instructions(dict(self.post,published=(date.today()-timedelta(days=30)).isoformat()))[0],
                         "Outside discovery window")

    def test_multi_email_uses_action_target(self):
        # A post with a general contact email AND a clear apply-to email:
        # the action-pattern email should win; the footer email must not block it.
        multi = dict(self.post, text=(
            "We are hiring an AI Engineer.\n"
            "For general queries contact info@company.org.\n"
            "Send your resume to: hiring@example.org"
        ))
        self.assertEqual(instructions(multi)[:2], ("Needs draft", "hiring@example.org"))
        # The action regex captures only the first email after the verb — that is the apply-to address.
        # Both emails in the same instruction sentence: first one wins (regex stops at first match).
        both_action = dict(self.post, text=(
            "Send your resume to hiring@example.org or jobs@example.org"
        ))
        self.assertEqual(instructions(both_action)[:2], ("Needs draft", "hiring@example.org"))
        # Genuinely ambiguous: two separate action sentences pointing to different addresses.
        two_actions = dict(self.post, text=(
            "Send your CV to hr@example.org\nOr apply to jobs@example.org"
        ))
        self.assertEqual(instructions(two_actions)[0], "Check application instructions")

    def test_empty_or_unverified_runs_cannot_pass(self):
        self.assertFalse(pilot(lambda: []))
        self.assertFalse(pilot(lambda: [dict(self.post,content_kind="snippet")]))

    def test_linkedin_scraper_selector_resilience(self):
        from unittest.mock import MagicMock
        from app.linkedin import SELECTORS, extract_urn, extract_body, extract_published

        # Verify centralized selectors exist and have fallbacks
        self.assertIn("cards", SELECTORS)
        self.assertIn("body", SELECTORS)
        self.assertIn("time", SELECTORS)
        self.assertIn("empty", SELECTORS)
        self.assertGreater(len(SELECTORS["cards"]), 1)
        self.assertGreater(len(SELECTORS["body"]), 1)

        # URN extraction: primary data-urn
        card1 = MagicMock()
        card1.get_attribute.side_effect = lambda k: "urn:li:activity:7123456789012345678" if k == "data-urn" else ""
        self.assertEqual(extract_urn(card1), "urn:li:activity:7123456789012345678")

        # URN extraction: fallback data-activity-urn
        card2 = MagicMock()
        card2.get_attribute.side_effect = lambda k: "urn:li:ugcPost:7123456789012345679" if k == "data-activity-urn" else ""
        self.assertEqual(extract_urn(card2), "urn:li:ugcPost:7123456789012345679")

        # URN extraction: fallback permalink anchor
        card3 = MagicMock()
        card3.get_attribute.return_value = ""
        link = MagicMock()
        link.get_attribute.return_value = "https://www.linkedin.com/feed/update/urn:li:share:7123456789012345680/"
        card3.locator.return_value.all.return_value = [link]
        self.assertEqual(extract_urn(card3), "urn:li:share:7123456789012345680")

        # Body extraction: primary vs fallback selector
        card_body = MagicMock()
        primary_body = MagicMock()
        primary_body.first.count.return_value = 0
        fallback_body = MagicMock()
        fallback_body.first.count.return_value = 1
        fallback_body.first.inner_text.return_value = "We are hiring an AI Engineer to join our team."
        card_body.locator.side_effect = lambda sel: fallback_body if "expandable-text" in sel else primary_body
        self.assertEqual(extract_body(card_body), "We are hiring an AI Engineer to join our team.")

        # Published date extraction
        card_time = MagicMock()
        time_node = MagicMock()
        time_node.count.return_value = 1
        time_node.get_attribute.return_value = "2026-11-18T10:00:00Z"
        card_time.locator.return_value.first = time_node
        self.assertEqual(extract_published(card_time), "2026-11-18")
