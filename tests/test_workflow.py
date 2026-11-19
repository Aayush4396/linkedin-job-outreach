import ast
import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import settings as cfg, workflow
from app.main import app
from app.resumes import attachment, save
from app.storage import all_posts, read, transact


class OutreachTests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        previous = os.getcwd()
        os.chdir(workspace.name)
        self.addCleanup(os.chdir, previous)
        options = patch.multiple(cfg, DB="test.sqlite3", BUCKET="", FEED="", LINKEDIN_COOKIE="", PIN="",
                                 DRY=True, APPROVAL=True, WORKER=False, EXTERNAL=True, MODEL="", CAP=20)
        options.start()
        self.addCleanup(options.stop)

    def test_review_and_delivery(self):
        with TestClient(app) as client:
            headers = {"x-hiremate":"1"}
            self.assertEqual(client.post("/api/scan").status_code, 403)
            self.assertEqual(client.post("/api/scan", headers=headers).json(), {"new":3})
            upload = client.post("/api/resume", headers=dict(headers, **{"x-filename":"Resume.txt"}),
                                 content=b"Built language model evaluations.")
            self.assertEqual(upload.status_code, 200, upload.text)
            post = next(p for p in client.get("/api/posts").json()["posts"] if p["status"]=="Ready for review")
            self.assertEqual(attachment(post["resume"]), b"Built language model evaluations.")
            save("updated.txt", b"Different resume")
            self.assertEqual(attachment(post["resume"]), b"Built language model evaluations.")
            url = "/api/posts/" + post["id"]
            edit = {"action":"approve", "subject":"Interested in model evaluation", "message":"My edited pitch."}
            self.assertEqual(client.post(url, headers=headers, json=edit).status_code, 200)
            self.assertEqual(client.post(url, headers=headers, json=edit).status_code, 409)
            with patch("smtplib.SMTP_SSL", side_effect=AssertionError("Unexpected email")):
                self.assertEqual(workflow.dispatch(), 1)
                self.assertEqual(workflow.dispatch(), 0)
            self.assertEqual(read("posts", post["id"])["status"], "Simulated")
            self.assertEqual(client.post("/api/scan", headers=headers).json()["new"], 0)
            self.assertEqual(len(all_posts()), 3)

    def test_saved_search_browser_to_draft(self):
        from datetime import date
        prefs = dict(roles="GenAI", locations="India", workplace="Remote", employment="Contract")
        recruiter = dict(url="https://www.linkedin.com/feed/update/urn:li:activity:7527956605288652801/",
                         title="Hiring GenAI Engineer", text="Remote contract in India. Send your resume to: jobs@example.org",
                         date_kind="published", published=date.today().isoformat(), content_kind="full")
        seeker = dict(recruiter, url=recruiter["url"].replace("801/", "802/"),
                      text="Seeking remote GenAI contract roles in India. My email: me@example.org")
        onsite = dict(recruiter, url=recruiter["url"].replace("801/", "803/"), text="Onsite only. Contract in Irvine.")
        headers = {"x-hiremate":"1"}
        with TestClient(app) as client:
            response = client.post("/api/preferences/search", headers=headers, json=prefs)
            self.assertIn("GenAI", response.json()["url"])
            self.assertEqual(client.get("/api/posts").json()["search"], prefs)
            client.post("/api/resume",headers=dict(headers, **{"x-filename":"resume.txt"}),content=b"GenAI engineer building RAG pipelines.")
            for expected in (2, 0):
                result = client.post("/api/browser-results",headers=headers,json=[recruiter,seeker,onsite])
                self.assertEqual(result.json(), {"new":expected, "checked":3})
            rows = client.get("/api/posts").json()["posts"]
            drafts = [p for p in rows if p["status"] == "Ready for review"]
            self.assertEqual(len(drafts), 1)
            self.assertEqual((drafts[0]["recipient"], drafts[0]["filename"]), ("jobs@example.org","resume.txt"))
            with patch.object(cfg,"DRY",False):
                self.assertEqual(client.post("/api/browser-results",headers=headers,json=[recruiter]).status_code,403)

    def test_scheduled_worker_scan(self):
        with patch.object(cfg, "WORKER", True), TestClient(app) as worker:
            self.assertEqual(worker.get("/").status_code, 404)
            self.assertEqual(worker.post("/api/scheduled-scan").status_code, 200)
            self.assertEqual(worker.post("/api/dispatch").status_code, 200)
            self.assertFalse(all_posts())
            transact(lambda get, put: put("settings", "scan_timer", {"due": 1}))
            self.assertEqual(worker.post("/api/dispatch").status_code, 200)
            self.assertEqual(len(all_posts()), 3)
            self.assertFalse(read("settings", "scan_timer"))

    def test_cap_and_spacing(self):
        for i in range(21):
            uid = str(i)
            post = dict(id=uid,published="2026-11-18",status="Queued",sample=True)
            transact(lambda get, put: put("posts", uid, post))
        with patch("app.workflow.time.time") as clock:
            for i in range(20):
                clock.return_value = 1_800_000_000 + i*361
                self.assertEqual(workflow.dispatch(), 1)
                self.assertEqual(workflow.dispatch(), 0)
            clock.return_value += 361
            self.assertEqual(workflow.dispatch(), 0)
        self.assertEqual(sum(p["status"]=="Simulated" for p in all_posts()),20)

    def test_dispatch_throughput_multiple_when_spacing_allows(self):
        # When time elapses during a dispatch run (e.g. SMTP operations or multiple slots),
        # dispatch() should process all eligible posts in a single run instead of stopping at 1.
        for i in range(3):
            uid = f"tp-{i}"
            post = dict(id=uid, published=f"2026-11-{10+i}", status="Queued", sample=True)
            transact(lambda get, put: put("posts", uid, post))
        # Provide clock values: 0s for post 0, 400s for post 1, 800s for post 2
        times = iter([1_800_000_000, 1_800_000_400, 1_800_000_800, 1_800_000_800])
        with patch("app.workflow.time.time", side_effect=lambda: next(times)):
            processed = workflow.dispatch()
            self.assertEqual(processed, 3)
        self.assertEqual(sum(p["status"] == "Simulated" for p in all_posts() if p["id"].startswith("tp-")), 3)

    def test_word_text(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output,"w") as doc:
            doc.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Machine learning</w:t></w:r></w:p></w:document>')
        self.assertEqual(save("cv.docx",output.getvalue())["text"], "Machine learning")

    def test_live_delivery_with_mock_mailbox(self):
        save("cv.txt", b"Language model evaluation")
        source = dict(url="https://example.org/live", published="2026-11-18",
                      title="Model evaluation engineer", text="Apply by email to hiring@example.org")
        workflow.capture(source, False)
        workflow.prepare()
        uid = workflow.key(source["url"])
        workflow.review(uid, "Application", "Reviewed pitch", "approve")
        # Use a live draft in a controlled mailbox test.
        transact(lambda get, put: put("posts", uid, dict(get("posts", uid), preview=False)))
        with patch.multiple(cfg, DRY=False, ADDRESS="sender@example.org", PASSWORD="test"), patch("smtplib.SMTP_SSL") as smtp:
            workflow.dispatch()
            message = smtp.return_value.__enter__.return_value.send_message.call_args.args[0]
            self.assertEqual(message["To"], "hiring@example.org")
            self.assertEqual(next(message.iter_attachments()).get_payload(decode=True), b"Language model evaluation")
            self.assertEqual(read("posts",uid)["status"], "Sent")
            self.assertEqual(workflow.dispatch(), 0)

    def test_live_delivery_transient_error_retries_and_succeeds(self):
        import smtplib
        save("cv.txt", b"Language model evaluation")
        source = dict(url="https://example.org/retry-live", published="2026-11-18",
                      title="Model evaluation engineer", text="Apply by email to retry@example.org")
        workflow.capture(source, False)
        workflow.prepare()
        uid = workflow.key(source["url"])
        workflow.review(uid, "Application", "Reviewed pitch", "approve")
        transact(lambda get, put: put("posts", uid, dict(get("posts", uid), preview=False)))

        # First connection attempt fails with SMTPServerDisconnected, second succeeds
        mock_smtp = patch("smtplib.SMTP_SSL")
        mock_sleep = patch("app.workflow.time.sleep")
        with patch.multiple(cfg, DRY=False, ADDRESS="sender@example.org", PASSWORD="test"), \
             mock_smtp as smtp_cls, mock_sleep as sleep_mock:
            good_smtp = unittest.mock.MagicMock()
            smtp_cls.side_effect = [smtplib.SMTPServerDisconnected("Temporary glitch"), good_smtp]
            processed = workflow.dispatch()
            self.assertEqual(processed, 1)
            self.assertEqual(read("posts", uid)["status"], "Sent")
            self.assertEqual(smtp_cls.call_count, 2)
            sleep_mock.assert_called_once_with(2)

    def test_live_delivery_exhausted_retries_remains_check_delivery(self):
        import smtplib
        save("cv.txt", b"Language model evaluation")
        source = dict(url="https://example.org/fail-live", published="2026-11-18",
                      title="Model evaluation engineer", text="Apply by email to fail@example.org")
        workflow.capture(source, False)
        workflow.prepare()
        uid = workflow.key(source["url"])
        workflow.review(uid, "Application", "Reviewed pitch", "approve")
        transact(lambda get, put: put("posts", uid, dict(get("posts", uid), preview=False)))

        mock_smtp = patch("smtplib.SMTP_SSL")
        mock_sleep = patch("app.workflow.time.sleep")
        with patch.multiple(cfg, DRY=False, ADDRESS="sender@example.org", PASSWORD="test"), \
             mock_smtp as smtp_cls, mock_sleep as sleep_mock:
            smtp_cls.side_effect = smtplib.SMTPConnectError(421, b"Service unavailable")
            processed = workflow.dispatch()
            self.assertEqual(processed, 0)
            self.assertEqual(read("posts", uid)["status"], "Check delivery")
            self.assertEqual(smtp_cls.call_count, 3)
            self.assertEqual(sleep_mock.call_count, 2)

    def test_pdf_text(self):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        font = DictionaryObject({NameObject("/Type"):NameObject("/Font"), NameObject("/Subtype"):NameObject("/Type1"),
                                 NameObject("/BaseFont"):NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):font})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 10 100 Td (Language model research) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        output = io.BytesIO()
        writer.write(output)
        self.assertIn("Language model research", save("resume.pdf",output.getvalue())["text"])

    def test_any_role_filtered_by_resume_before_drafting(self):
        from app.search import Search
        search = Search(roles="Accountant, Payroll")
        transact(lambda get, put: put("settings", "search", search.model_dump()))
        save("cv.txt", b"Accountant handling reconciliations.")
        def opening(title):
            return dict(title=title, text="Send your resume to office@example.org", published="2026-11-17",
                        url="https://example.org/" + title)
        workflow.collect_results([opening("Payroll"), opening("Accountant"), opening("Engineer")], search)
        posts = {p["title"]: p for p in all_posts()}
        self.assertEqual(set(posts), {"Payroll", "Accountant"})
        self.assertEqual(posts["Payroll"]["status"], "Low résumé match")
        self.assertNotIn("message", posts["Payroll"])
        self.assertEqual(posts["Accountant"]["status"], "Ready for review")
        self.assertIn("accountant", posts["Accountant"]["fit_reason"])

    def test_recipient_duplicate(self):
        save("cv.txt", b"Language model evaluation")
        workflow.collect()
        workflow.capture(dict(title="AI Engineer",text="Email HIRING@example.org.",url="https://example.org/other",
                              published="2026-11-18"), False)
        self.assertEqual(read("posts",workflow.key("https://example.org/other"))["status"], "Recipient already seen")

    def test_iter_posts_and_filtering(self):
        from app.storage import iter_posts
        # Insert posts with different statuses
        posts_data = [
            dict(id="s1", status="Needs draft", title="Job 1"),
            dict(id="s2", status="Sent", title="Job 2"),
            dict(id="s3", status="Apply via link", title="Job 3"),
            dict(id="s4", status="Simulated", title="Job 4"),
        ]
        for p in posts_data:
            transact(lambda get, put, item=p: put("posts", item["id"], item))

        # Test streaming generator behavior
        stream = iter_posts()
        import types
        self.assertIsInstance(stream, types.GeneratorType)
        all_streamed = list(stream)
        self.assertEqual(len(all_streamed), 4)

        # Single string filter
        sent_posts = list(iter_posts("Sent"))
        self.assertEqual(len(sent_posts), 1)
        self.assertEqual(sent_posts[0]["title"], "Job 2")

        # Set / collection filter
        eligible_posts = list(iter_posts({"Needs draft", "Apply via link"}))
        self.assertEqual(len(eligible_posts), 2)
        self.assertEqual({p["title"] for p in eligible_posts}, {"Job 1", "Job 3"})

        # all_posts backward compatibility
        self.assertEqual(len(all_posts({"Sent", "Simulated"})), 2)


class ConfigurationTests(unittest.TestCase):
    def test_environment_wiring(self):
        root = Path(__file__).resolve().parents[1]
        for path in (root/"app").glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf8"))):
                if isinstance(node, ast.Call) and getattr(node.func,"attr",None)=="getenv":
                    key = node.args[0].value
                    self.assertIn(key+"=", (root/".env.example").read_text())
                    self.assertIn(key, (root/"deploy.sh").read_text())
