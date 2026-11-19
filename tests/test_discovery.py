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

    def test_empty_or_unverified_runs_cannot_pass(self):
        self.assertFalse(pilot(lambda: []))
        self.assertFalse(pilot(lambda: [dict(self.post,content_kind="snippet")]))
