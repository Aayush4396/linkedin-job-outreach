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
            self.assertEqual(client.post("/api/scan", headers=headers).status_code, 429)
            self.assertEqual(len(all_posts()), 3)

    def test_assess_discards_result_if_resume_changed_during_generation(self):
        post = dict(id="p", title="Payroll", text="Hiring", status="Needs draft", recipient="jobs@example.org")
        resume = dict(version="old", name="cv.txt", text="Payroll")
        def transaction(operation):
            from unittest.mock import Mock
            put = Mock()
            records = {("posts", "p"): post, ("settings", "resume"): {"version": "replacement"}}
            operation(lambda group, key: records[(group, key)], put)
            put.assert_not_called()
        fit = workflow.ResumeFit(relevant=True, reason="Payroll experience")
        pitch = workflow.Pitch(subject="Application", body="My experience matches.")
        with patch.object(cfg, "MODEL", "test-model"), patch.object(workflow, "generate", side_effect=[fit, pitch]) as model, \
             patch.object(workflow, "transact", side_effect=transaction) as storage:
            workflow.assess(post, resume)
            self.assertEqual(model.call_count, 2)
            storage.assert_called_once()

    def test_manual_scan_cooldown_after_failure_and_at_expiry(self):
        with TestClient(app) as client, patch.object(cfg, "SCAN_COOLDOWN", 2), \
             patch("app.main.collect", side_effect=[ValueError("feed unavailable"), 3]) as collect, \
             patch("app.workflow.time.time") as clock:
            headers = {"x-hiremate": "1"}
            clock.return_value = 1000
            self.assertEqual(client.post("/api/scan", headers=headers).status_code, 502)
            clock.return_value = 1119.5
            response = client.post("/api/scan", headers=headers)
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "1")
            clock.return_value = 1120
            self.assertEqual(client.post("/api/scan", headers=headers).json(), {"new": 3})
            self.assertEqual(collect.call_count, 2)

    def test_simultaneous_manual_scans_share_one_reservation(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        start = Barrier(4)
        def claim(_):
            start.wait(timeout=10)
            return workflow.claim_manual_scan()
        with ThreadPoolExecutor(max_workers=4) as pool:
            delays = list(pool.map(claim, range(4)))
        self.assertEqual(delays.count(0), 1)
        self.assertTrue(all(delay >= 0 for delay in delays))

    def test_vertex_draft_retry_preserves_successful_match(self):
        from google.genai.errors import ClientError
        from types import SimpleNamespace
        from unittest.mock import Mock, call
        error = ClientError(429, {}, SimpleNamespace(headers={"Retry-After": "7"}))
        resume = save("cv.txt", b"Payroll experience.")
        workflow.capture(dict(url="https://example.org/payroll", title="Accountant",
                              text="Send resume to jobs@example.org", published="2026-11-18"), False)
        post = all_posts()[0]
        progress = Mock()
        with patch.object(cfg, "MODEL", "test"), patch("google.genai.Client") as client, \
             patch.object(workflow, "_pace_vertex"), patch("app.workflow.time.sleep") as sleep:
            model = client.return_value.__enter__.return_value.models.generate_content
            model.side_effect = [SimpleNamespace(text='{"relevant":true,"reason":"Payroll"}'), error,
                                 SimpleNamespace(text='{"subject":"Application","body":"My payroll experience."}')]
            workflow.assess(post, resume, progress)
            schemas = [c.kwargs["config"]["response_schema"] for c in model.call_args_list]
            self.assertEqual(schemas, [workflow.ResumeFit, workflow.Pitch, workflow.Pitch])
            sleep.assert_called_once_with(7)
            self.assertEqual(progress.call_args_list, [call(7), call(0)])
            self.assertEqual(read("posts", post["id"])["status"], "Ready for review")

    def test_vertex_retry_budget_and_non_retryable_errors(self):
        from google.genai.errors import ClientError
        from types import SimpleNamespace
        with patch("google.genai.Client") as client, patch.object(workflow, "_pace_vertex"), \
             patch("app.workflow.random.uniform", side_effect=lambda lo, hi: lo), \
             patch("app.workflow.time.sleep") as sleep:
            model = client.return_value.__enter__.return_value.models.generate_content
            for code, hint, waits in [(403, "5", []), (429, "120", []), (429, "invalid", [5, 10, 20])]:
                model.side_effect = ClientError(code, {}, SimpleNamespace(headers={"Retry-After": hint}))
                with self.assertRaises(ClientError):
                    workflow.generate({"title":"Job","text":"Opening"},{"text":"Résumé"},"test",workflow.Pitch)
                self.assertEqual([c.args[0] for c in sleep.call_args_list], waits)
                self.assertEqual(model.call_count, len(waits) + 1)
                sleep.reset_mock()
                model.reset_mock()

    def test_browser_quota_error_preserves_saved_post_for_retry(self):
        from uuid import uuid4
        class QuotaError(Exception):
            code = 429
        scan_id = str(uuid4())
        headers = {"x-hiremate": "1", "x-hiremate-scan": scan_id}
        post = dict(url="https://www.linkedin.com/search/results/content/?keywords=accountant",
                    title="Hiring an accountant", text="Accountant wanted to manage payroll.",
                    date_kind="unknown", published="", content_kind="snippet")
        save("cv.txt", b"Accountant in payroll")
        with TestClient(app) as client:
            def fail_match(*args):
                status = client.get("/api/browser-progress/" + scan_id).json()
                self.assertEqual(status, {"completed": 0, "total": 1})
                raise QuotaError()
            with patch.object(workflow, "assess", side_effect=fail_match):
                response = client.post("/api/browser-results", headers=headers, json=[post])
            self.assertEqual(response.status_code, 429)
            self.assertIn("quota", response.json()["detail"])
            self.assertEqual(len(all_posts()), 1)
            self.assertEqual(client.get("/api/browser-progress/" + scan_id).json(), {})
            retry = client.post("/api/browser-results", headers=headers, json=[post])
            self.assertEqual(retry.json(), {"new": 0, "checked": 1})
            self.assertIn("fit_resume", all_posts()[0])

    def test_copy_link_recovery_promotes_saved_preview(self):
        from datetime import date
        headers = {"x-hiremate": "1"}
        snippet = dict(url="https://www.linkedin.com/search/results/content/?keywords=accountant",
                       title="Hiring an accountant", text="Hiring an accountant for our payroll team.",
                       date_kind="unknown", published="", content_kind="snippet")
        original = dict(snippet, url="https://www.linkedin.com/feed/update/urn:li:activity:7527956605288652801/",
                        text=snippet["text"] + " Send your CV to payroll@example.org",
                        preview_text=snippet["text"], date_kind="published",
                        published=date.today().isoformat(), content_kind="full")
        save("cv.txt", b"Accountant with payroll experience.")
        with TestClient(app) as client:
            for item, expected in [(snippet, 1), (original, 0), (original, 0)]:
                result = client.post("/api/browser-results", headers=headers, json=[item])
                self.assertEqual(result.json(), {"new": expected, "checked": 1})
            rows = client.get("/api/posts").json()["posts"]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["status"], "Ready for review")
            self.assertEqual(rows[0]["recipient"], "payroll@example.org")
            self.assertEqual(rows[0]["url"], original["url"])

    def test_targeted_recheck_reuses_fit_and_promotes_only_saved_lead(self):
        from datetime import date
        headers = {"x-hiremate": "1"}
        post = dict(url="https://www.linkedin.com/search/results/content/?keywords=payroll",
                    title="Hiring an accountant", text="Hiring an accountant. Send your CV to payroll@example.org",
                    published="", content_kind="snippet", date_kind="unknown")
        save("cv.txt", b"Payroll accountant")
        with TestClient(app) as client:
            client.post("/api/browser-results", headers=headers, json=[post]).raise_for_status()
            saved = all_posts()[0]
            headers["x-hiremate-recheck"] = saved["id"]
            original = dict(post, url="https://www.linkedin.com/feed/update/urn:li:activity:7527956605288652801/",
                            published=date.today().isoformat(), date_kind="published", content_kind="full")
            self.assertEqual(client.post("/api/browser-results", headers=headers, json=[original]).status_code, 422)
            with patch.object(workflow, "resume_fit", side_effect=AssertionError("Redundant match")):
                result = client.post("/api/browser-results", headers=headers, json=[dict(original, preview_text=post["text"])])
            self.assertEqual(result.json()["status"], "Ready for review")
            self.assertEqual(all_posts()[0]["fit_reason"], saved["fit_reason"])
            self.assertEqual(len(all_posts()), 1)

    def test_scan_history_survives_repeat_and_old_fit_is_refreshed(self):
        from uuid import uuid4
        first, second = str(uuid4()), str(uuid4())
        post = dict(url="https://www.linkedin.com/search/results/content/?keywords=payroll",
                    title="Senior payroll accountant", text="Hiring for payroll. Requires 9 years.",
                    published="", date_kind="unknown", content_kind="snippet")
        save("cv.txt", b"Junior accountant, payroll, 1 year")
        with TestClient(app) as client:
            headers = {"x-hiremate": "1", "x-hiremate-scan": first}
            client.post("/api/browser-results", headers=headers, json=[post, post]).raise_for_status()
            row, = all_posts()
            self.assertEqual(row["scan_id"], first)
            self.assertEqual(read("scans", first)["members"], {row["id"]: "new"})
            self.assertEqual(row["status"], "Unverified lead")
            row.pop("fit_policy")
            row.update(status="Low résumé match", fit_reason="Previously penalized for tenure")
            transact(lambda get, put: put("posts", row["id"], row))
            headers["x-hiremate-scan"] = second
            client.post("/api/browser-results", headers=headers, json=[post]).raise_for_status()
            data = client.get("/api/posts").json()
            self.assertEqual(data["latest_scan"]["members"], {row["id"]: "seen"})
            self.assertEqual(data["latest_scan"]["id"], second)
            saved, = data["posts"]
            self.assertEqual(saved["scan_id"], first)
            self.assertEqual(saved["status"], "Unverified lead")
            self.assertNotEqual(saved["fit_reason"], row["fit_reason"])

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

    def test_parallel_prepare(self):
        save("cv.txt", b"Machine learning engineer")
        for i in range(4):
            uid = f"par-{i}"
            post = dict(id=uid, title=f"ML Engineer {i}", text=f"Hiring machine learning. Send resume to ml{i}@example.org",
                        published="2026-11-18", status="Needs draft", recipient=f"ml{i}@example.org", sample=False)
            transact(lambda get, put, item=post: put("posts", item["id"], item))

        with patch.object(cfg, "GEMINI_WORKERS", 4):
            workflow.prepare()

        assessed = [read("posts", f"par-{i}") for i in range(4)]
        for p in assessed:
            self.assertEqual(p["status"], "Ready for review")
            self.assertIn("learning", p["fit_reason"])

    def test_repeat_logs_exception_traceback(self):
        import asyncio
        from app.main import repeat

        def failing():
            raise RuntimeError("Database connection lost")

        async def run_one():
            with patch("logging.exception") as log_mock, patch("asyncio.sleep", side_effect=asyncio.CancelledError):
                try:
                    await repeat(failing, 1)
                except asyncio.CancelledError:
                    pass
                log_mock.assert_called_once_with("Background %s failed", "failing")

        asyncio.run(run_one())

    def test_structured_json_logging_cloud_format(self):
        import json
        import logging
        from app.main import CloudJsonFormatter, setup_logging

        formatter = CloudJsonFormatter()
        record = logging.LogRecord("hiremate.worker", logging.WARNING, "worker.py", 42,
                                   "Rate limit spacing: wait %d seconds", (180,), None)
        out = formatter.format(record)
        data = json.loads(out)
        self.assertEqual(data["severity"], "WARNING")
        self.assertEqual(data["message"], "Rate limit spacing: wait 180 seconds")
        self.assertEqual(data["logger"], "hiremate.worker")
        self.assertIn("T", data["time"])

        # Test exception formatting in JSON
        try:
            raise ValueError("Test error for traceback")
        except ValueError:
            import sys
            exc_record = logging.LogRecord("hiremate.worker", logging.ERROR, "worker.py", 50,
                                           "Task failed", (), sys.exc_info())
            exc_out = formatter.format(exc_record)
            exc_data = json.loads(exc_out)
            self.assertEqual(exc_data["severity"], "ERROR")
            self.assertIn("ValueError: Test error for traceback", exc_data["exception"])
            self.assertIn("ValueError: Test error for traceback", exc_data["message"])

        # Test setup_logging applies formatter when BUCKET is set
        with patch.object(cfg, "BUCKET", "my-test-bucket"):
            setup_logging()
            root = logging.getLogger()
            self.assertTrue(any(isinstance(h.formatter, CloudJsonFormatter) for h in root.handlers))

    def test_feed_authorization_header(self):
        from unittest.mock import MagicMock
        from app.sources import read_posts

        mock_response = MagicMock()
        mock_response.read.return_value = b'[{"url":"https://example.org/p1","title":"Dev","text":"Hiring dev","published":"2026-11-18"}]'
        mock_response.__enter__.return_value = mock_response

        # With auth header
        with patch.object(cfg, "FEED_AUTH_HEADER", "Bearer secret-token-123"), \
             patch("app.sources.urlopen", return_value=mock_response) as mock_urlopen:
            posts = read_posts("https://feed.example.org/jobs")
            self.assertEqual(len(posts), 1)
            req = mock_urlopen.call_args[0][0]
            self.assertEqual(req.get_header("Authorization"), "Bearer secret-token-123")

        # Without auth header
        with patch.object(cfg, "FEED_AUTH_HEADER", ""), \
             patch("app.sources.urlopen", return_value=mock_response) as mock_urlopen:
            read_posts("https://feed.example.org/jobs")
            req = mock_urlopen.call_args[0][0]
            self.assertFalse(req.has_header("Authorization"))


class ConfigurationTests(unittest.TestCase):
    def test_environment_wiring(self):
        root = Path(__file__).resolve().parents[1]
        for path in (root/"app").glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf8"))):
                if isinstance(node, ast.Call) and getattr(node.func,"attr",None)=="getenv":
                    key = node.args[0].value
                    self.assertIn(key+"=", (root/".env.example").read_text())
                    self.assertIn(key, (root/"deploy.sh").read_text())
