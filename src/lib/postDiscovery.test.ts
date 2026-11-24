import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationLink,
  buildMailtoHref,
  buildSearchQuery,
  buildSearchUrl,
  extractCandidateName,
  extractRecipientName,
  formatEmailDraftBody,
  formatPostTimestamp,
  instructions,
  isDraftFromOlderResume,
  isSafeFeedUrl,
  linkedinId,
  linkedinTimestampFromUrl,
  matchesSearch,
  shouldRefreshDraftOnResumeChange,
  stripUndefined,
  validateIncomingPosts,
} from "./postDiscovery";

test("linkedinId parses activity, share, ugcPost, posts, and group URLs", () => {
  assert.equal(
    linkedinId("https://www.linkedin.com/feed/update/urn:li:activity:7234567890123456789/"),
    "7234567890123456789",
  );
  assert.equal(
    linkedinId("https://www.linkedin.com/posts/jane-doe_hiring-7234567890123456789-abcd"),
    "7234567890123456789",
  );
  assert.equal(
    linkedinId(
      "https://www.linkedin.com/groups/12345/?highlightedUpdateUrn=urn:li:activity:7234567890123456789",
    ),
    "7234567890123456789",
  );
  assert.equal(
    linkedinId("https://www.linkedin.com/search/results/content/?keywords=hiring"),
    null,
  );
});

test("instructions routes explicit email, apply link, DM, and unverified leads accurately", () => {
  const emailRoute = instructions(
    {
      text: "We are hiring a Data Analyst. Send your résumé to jobs@acme.io today!",
      published: "2026-11-20",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(emailRoute.route, "Needs draft");
  assert.equal(emailRoute.recipient, "jobs@acme.io");

  const linkRoute = instructions(
    {
      text: "We're hiring engineers! Apply here: https://careers.acme.io/role/123.",
      published: "2026-11-20",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(linkRoute.route, "Apply via link");
  assert.equal(linkRoute.applyLink, "https://careers.acme.io/role/123");

  const dmRoute = instructions(
    {
      text: "Hiring a Product Designer in London. DM me if interested!",
      published: "2026-11-20",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(dmRoute.route, "Contact on LinkedIn");

  const oldRoute = instructions(
    {
      text: "Send your resume to hiring@acme.io",
      published: "2026-10-01",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(oldRoute.route, "Outside discovery window");

  const snippetRoute = instructions(
    {
      text: "Send your resume to hiring@acme.io...",
      published: "2026-11-20",
      date_kind: "published",
      content_kind: "snippet",
    },
    "2026-11-23",
  );
  assert.equal(snippetRoute.route, "Unverified lead");
});

test("matchesSearch respects roles, locations, workplace, and remote negation", () => {
  const search = {
    roles: "ML Engineer, Software Engineer",
    locations: "London, Remote",
    workplace: "Remote" as const,
    employment: "Full-time" as const,
  };
  assert.equal(
    matchesSearch(search, {
      title: "Hiring Software Engineer",
      text: "Full-time remote role working with our distributed team.",
    }),
    true,
  );
  assert.equal(
    matchesSearch(search, {
      title: "Hiring Software Engineer",
      text: "Full-time role in London. This is not remote, on-site only.",
    }),
    false,
  );
  const query = buildSearchQuery(search);
  assert.ok(query.includes('"ML Engineer" OR "Software Engineer"'));
  assert.ok(query.includes('"London" OR "Remote"'));
  assert.ok(query.includes('"Remote"'));
  assert.ok(query.includes('"Full-time"'));
  assert.ok(buildSearchUrl(search).startsWith("https://www.linkedin.com/search/results/content/?"));
});

test("isSafeFeedUrl blocks non-HTTPS, localhost, private IPs, and cloud metadata endpoints", () => {
  assert.equal(isSafeFeedUrl("https://feeds.example.org/jobs.json"), true);
  assert.equal(isSafeFeedUrl("http://feeds.example.org/jobs.json"), false);
  assert.equal(isSafeFeedUrl("https://localhost/jobs.json"), false);
  assert.equal(isSafeFeedUrl("https://127.0.0.1/jobs.json"), false);
  assert.equal(isSafeFeedUrl("https://169.254.169.254/latest/meta-data"), false);
  assert.equal(isSafeFeedUrl("https://10.0.0.5/internal"), false);
  assert.equal(isSafeFeedUrl("https://192.168.1.20/feed"), false);
});

test("stripUndefined removes nested undefined properties cleanly", () => {
  const cleaned = stripUndefined({
    id: "abc",
    note: undefined,
    nested: { keep: 1, drop: undefined },
  });
  assert.deepEqual(cleaned, { id: "abc", nested: { keep: 1 } });
});

test("validateIncomingPosts and applicationLink normalize valid payloads", () => {
  const validated = validateIncomingPosts([
    {
      url: "https://example.org/jobs/1",
      published: "2026-11-20",
      title: "Backend Engineer",
      text: "Apply at https://example.org/apply/42.",
    },
  ]);
  assert.equal(validated.length, 1);
  assert.equal(applicationLink(validated[0].text), "https://example.org/apply/42");
});

test("instructions detects LinkedIn comment, connect, DM, and respects negations", () => {
  const commentRoute = instructions(
    {
      text: 'Hiring an AI Engineer! Comment "AI" below if you want to be considered.',
      published: "2026-11-21",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(commentRoute.route, "Contact on LinkedIn");
  assert.equal(commentRoute.linkedinAction, "comment");
  assert.equal(commentRoute.commentKeyword, "AI");

  const connectRoute = instructions(
    {
      text: "We are hiring Backend Engineers. Send me a connection request with a short note!",
      published: "2026-11-21",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(connectRoute.route, "Contact on LinkedIn");
  assert.equal(connectRoute.linkedinAction, "connect");

  const negatedDm = instructions(
    {
      text: "We are hiring a Designer. Please do not DM me and no comments please.",
      published: "2026-11-21",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(negatedDm.route, "No email listed");
});

test("linkedinTimestampFromUrl decodes exact Snowflake timestamp and formats relative age", () => {
  const sampleMs = Date.UTC(2026, 10, 24, 3, 36, 52, 171);
  const snowflake = (BigInt(sampleMs) << 22n) | 123456n;
  const url = `https://www.linkedin.com/feed/update/urn:li:activity:${snowflake.toString()}/`;
  const decoded = linkedinTimestampFromUrl(url, sampleMs + 60_000);
  assert.equal(decoded, new Date(sampleMs).toISOString());

  const formatted = formatPostTimestamp(
    { url, published: "2026-11-24", date_kind: "relative" },
    new Date(sampleMs + 25 * 60_000),
  );
  assert.equal(formatted.relative, "25m ago");
  assert.equal(formatted.title, new Date(sampleMs).toISOString());

  // Non-LinkedIn or invalid short ID returns null
  assert.equal(linkedinTimestampFromUrl("https://example.org/jobs/1"), null);
});

test("instructions drafts email whenever an actionable email is present in the post", () => {
  const emailAfterDm = instructions(
    {
      text: "📩 Interested candidates can share their updated resumes via DM.\nlavanya.s@prophecytechs.com",
      published: "2026-11-23",
      date_kind: "relative",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(emailAfterDm.route, "Needs draft");
  assert.equal(emailAfterDm.recipient, "lavanya.s@prophecytechs.com");

  const emojiEmail = instructions(
    {
      text: "📩 Interested candidates can share their updated resumes.\n📧 Email: glowhorizonconsulting@gmail.com",
      published: "2026-11-23",
      date_kind: "relative",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(emojiEmail.route, "Needs draft");
  assert.equal(emojiEmail.recipient, "glowhorizonconsulting@gmail.com");

  const linkAndEmail = instructions(
    {
      text: "Hiring GenAI Engineer. Apply at https://careers.example.org/ai or email talent@example.org",
      published: "2026-11-23",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(linkAndEmail.route, "Needs draft");
  assert.equal(linkAndEmail.recipient, "talent@example.org");
  assert.equal(linkAndEmail.applyLink, "https://careers.example.org/ai");

  const noreplyOnly = instructions(
    {
      text: "We are hiring! Notifications come from no-reply@example.org. DM me if interested.",
      published: "2026-11-23",
      date_kind: "published",
      content_kind: "full",
    },
    "2026-11-23",
  );
  assert.equal(noreplyOnly.route, "Contact on LinkedIn");
  assert.equal(noreplyOnly.recipient, "");
});

test("buildMailtoHref encodes subject and body safely and rejects invalid or noreply addresses", () => {
  const href = buildMailtoHref(
    "lavanya.s@prophecytechs.com",
    "GenAI Engineer\r\nApplication",
    "Hello,\nI am interested.",
  );
  assert.ok(href?.startsWith("mailto:lavanya.s%40prophecytechs.com?"));
  assert.ok(href?.includes("subject=GenAI%20Engineer%20Application"));
  assert.ok(!href?.includes("+"));
  assert.equal(buildMailtoHref("no-reply@example.org", "Hi", "Body"), null);
  assert.equal(buildMailtoHref("not-an-email", "Hi", "Body"), null);
});

test("resume re-upload refreshes unedited Ready for review drafts while preserving edited drafts", () => {
  const oldResume = { version: "old-hash.pdf" };
  const newResume = { version: "new-hash.pdf" };
  const policy = "role-and-skills-v1";

  const uneditedDraft = {
    status: "Ready for review" as const,
    resume: oldResume.version,
    message: "Original AI draft",
    fit_resume: oldResume.version,
    fit_policy: policy,
  };
  assert.equal(shouldRefreshDraftOnResumeChange(uneditedDraft, newResume, policy), true);
  assert.equal(shouldRefreshDraftOnResumeChange(uneditedDraft, oldResume, policy), false);
  assert.equal(isDraftFromOlderResume(uneditedDraft, newResume), true);
  assert.equal(isDraftFromOlderResume(uneditedDraft, oldResume), false);

  const editedDraft = {
    ...uneditedDraft,
    draft_edited: true,
  };
  assert.equal(shouldRefreshDraftOnResumeChange(editedDraft, newResume, policy), false);
  assert.equal(isDraftFromOlderResume(editedDraft, newResume), true);

  const sentLead = {
    status: "Sent" as const,
    resume: oldResume.version,
    message: "Sent email",
    fit_resume: oldResume.version,
    fit_policy: policy,
  };
  assert.equal(shouldRefreshDraftOnResumeChange(sentLead, newResume, policy), false);
  assert.equal(isDraftFromOlderResume(sentLead, newResume), false);
});

test("extractRecipientName, extractCandidateName, and formatEmailDraftBody produce Hello <Name> and Regards, <User>", () => {
  assert.equal(
    extractRecipientName({
      recipient: "lavanya.s@prophecytechs.com",
      url: "https://www.linkedin.com/posts/lavanya-s-4473b1298_hiring-7530529042857361408-EG7s/",
    }),
    "Lavanya",
  );
  assert.equal(
    extractRecipientName({
      recipient: "glowhorizonconsulting@gmail.com",
      url: "https://www.linkedin.com/posts/preeti-nagpal-910589411_hiring-7530512976001474560-uyNk/",
    }),
    "Preeti",
  );
  assert.equal(
    extractRecipientName({
      recipient: "hr.ananya@acme.io",
      url: "https://example.org/jobs/1",
    }),
    "Ananya",
  );
  assert.equal(
    extractRecipientName({
      recipient: "careers@acme.io",
      url: "https://www.linkedin.com/posts/hiring-genai-7530618133628338176-5JvO/",
    }),
    null,
  );

  assert.equal(
    extractCandidateName({
      name: "Aayush_Gupta_Resume.pdf",
      text: "AAYUSH GUPTA\nLead Data Scientist",
    }),
    "Aayush Gupta",
  );
  assert.equal(
    extractCandidateName({
      name: "resume_final.pdf",
      text: "PRIYA SHARMA\nMachine Learning Engineer",
    }),
    "Priya Sharma",
  );

  const formatted = formatEmailDraftBody(
    "I am writing to apply for the GenAI Engineer role.",
    "Lavanya",
    "Aayush Gupta",
  );
  assert.equal(
    formatted,
    "Hello Lavanya,\n\nI am writing to apply for the GenAI Engineer role.\n\nRegards,\nAayush Gupta",
  );

  // Normalizes existing greeting/sign-off without duplicating them
  const normalized = formatEmailDraftBody(
    "Hi there,\n\nMy background fits well.\n\nBest regards,\nAayush",
    null,
    "Aayush Gupta",
  );
  assert.equal(
    normalized,
    "Hello Hiring Team,\n\nMy background fits well.\n\nRegards,\nAayush Gupta",
  );
});





