import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEmlDraft,
  buildEmlFilename,
  mimeTypeForFilename,
  sanitizeAttachmentFilename,
} from "./emlBuilder";

test("buildEmlDraft generates multipart/mixed RFC 5322 draft with X-Unsent and exact PDF attachment", () => {
  const fakePdf = Buffer.from("%PDF-1.7\nHireMate sample resume bytes\n%%EOF", "utf8");
  const body =
    "Hello Lavanya,\n\nI am writing to apply for the GenAI Engineer role. My résumé is attached for your review.\n\nRegards,\nAayush Gupta";

  const emlBuffer = buildEmlDraft({
    to: "lavanya.s@prophecytechs.com",
    subject: "Application for GenAI Engineer\r\nBcc: evil@attacker.test",
    body,
    attachment: {
      filename: "../Aayush_Gupta_Resume.pdf",
      bytes: fakePdf,
    },
  });

  const text = emlBuffer.toString("utf8");
  assert.ok(text.includes("To: lavanya.s@prophecytechs.com\r\n"));
  assert.ok(text.includes("Subject: Application for GenAI Engineer Bcc: evil@attacker.test\r\n"));
  assert.ok(!text.includes("\r\nBcc:"));
  assert.ok(text.includes("X-Unsent: 1\r\n"));
  assert.ok(text.includes("MIME-Version: 1.0\r\n"));
  assert.ok(text.includes("Content-Type: multipart/mixed; boundary="));
  assert.ok(text.includes('Content-Type: application/pdf; name="Aayush_Gupta_Resume.pdf"'));
  assert.ok(text.includes('Content-Disposition: attachment; filename="Aayush_Gupta_Resume.pdf"'));

  // Extract boundary and verify both body and attachment decode cleanly.
  const boundaryMatch = text.match(/boundary="([^"]+)"/);
  assert.ok(boundaryMatch?.[1]);
  const parts = text.split(`--${boundaryMatch[1]}`);
  assert.equal(parts.length, 4); // preamble, text part, attachment part, closing "--"

  const decodedBody = Buffer.from(
    parts[1].split("\r\n\r\n")[1].replace(/\r\n/g, ""),
    "base64",
  ).toString("utf8");
  assert.ok(decodedBody.startsWith("Hello Lavanya,\r\n\r\n"));
  assert.ok(decodedBody.endsWith("\r\n\r\nRegards,\r\nAayush Gupta"));

  const decodedAttachment = Buffer.from(
    parts[2].split("\r\n\r\n")[1].replace(/\r\n/g, ""),
    "base64",
  );
  assert.deepEqual(decodedAttachment, fakePdf);
});

test("buildEmlDraft rejects invalid or no-reply recipient addresses and sanitizes filenames", () => {
  assert.throws(
    () =>
      buildEmlDraft({
        to: "no-reply@example.com",
        subject: "Test",
        body: "Hello Hiring Team,",
      }),
    /invalid/i,
  );
  assert.equal(sanitizeAttachmentFilename('..\\evil";name\r\n.pdf'), "evilname.pdf");
  assert.equal(mimeTypeForFilename("resume.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(buildEmlFilename("Application for GenAI Engineer", "a@b.com"), "application-for-genai-engineer.eml");
});
