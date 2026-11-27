import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinkedInUrlFromShare,
  isSafeLinkedInPublicUrl,
  parseLinkedInPublicHtml,
} from "./linkedinFetcher";

test("isSafeLinkedInPublicUrl allows only public HTTPS linkedin.com URLs", () => {
  assert.equal(
    isSafeLinkedInPublicUrl(
      "https://www.linkedin.com/posts/lavanya-s-4473b1298_hiring-genai-7530529042857361408-EG7s/",
    ),
    true,
  );
  assert.equal(isSafeLinkedInPublicUrl("https://lnkd.in/abc123"), false);
  assert.equal(isSafeLinkedInPublicUrl("http://www.linkedin.com/posts/test"), false);
  assert.equal(isSafeLinkedInPublicUrl("https://127.0.0.1/linkedin.com"), false);
  assert.equal(isSafeLinkedInPublicUrl("https://evil.example.com/linkedin.com"), false);
});

test("extractLinkedInUrlFromShare finds LinkedIn URLs inside Android share text or url fields", () => {
  assert.equal(
    extractLinkedInUrlFromShare({
      title: "Lavanya on LinkedIn",
      text: "Check out this post: https://www.linkedin.com/posts/lavanya-s_hiring-7530529042857361408-EG7s/.",
    }),
    "https://www.linkedin.com/posts/lavanya-s_hiring-7530529042857361408-EG7s/",
  );
  assert.equal(
    extractLinkedInUrlFromShare({
      url: "https://example.com/not-linkedin",
      text: "No LinkedIn url here",
    }),
    null,
  );
});

test("parseLinkedInPublicHtml extracts JSON-LD articleBody, author name, and Snowflake timestamp", () => {
  const sampleMs = Date.UTC(2026, 10, 23, 12, 30, 0, 0);
  const snowflake = (BigInt(sampleMs) << 22n) | 42n;
  const postUrl = `https://www.linkedin.com/posts/preeti-nagpal_hiring-genai-${snowflake.toString()}-abcd/`;
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Preeti Nagpal on LinkedIn: Hiring GenAI Engineer | LinkedIn" />
    <meta property="og:description" content="Short snippet..." />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "SocialMediaPosting",
        "headline": "Hiring GenAI Engineer in Bengaluru",
        "articleBody": "We are hiring a GenAI Engineer experienced in Python and LangGraph. Send your resume to glowhorizonconsulting@gmail.com today!",
        "author": { "@type": "Person", "name": "Preeti Nagpal" }
      }
    </script>
  </head><body></body></html>`;

  const result = parseLinkedInPublicHtml(html, postUrl, "2026-11-24");
  assert.equal(result.blocked, false);
  assert.equal(result.title, "Hiring GenAI Engineer in Bengaluru");
  assert.equal(result.author_name, "Preeti Nagpal");
  assert.ok(result.text.includes("glowhorizonconsulting@gmail.com"));
  assert.equal(result.published, "2026-11-23");
  assert.equal(result.published_at, new Date(sampleMs).toISOString());
});

test("parseLinkedInPublicHtml detects authwall cleanly", () => {
  const html = `<html><head><meta property="og:title" content="Sign In | LinkedIn" /><meta property="og:description" content="Sign in to LinkedIn to view this post." /></head></html>`;
  const result = parseLinkedInPublicHtml(
    html,
    "https://www.linkedin.com/feed/update/urn:li:activity:7530529042857361408/",
    "2026-11-24",
  );
  assert.equal(result.blocked, true);
  assert.ok(result.reason);
});
