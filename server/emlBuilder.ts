import crypto from "node:crypto";
import path from "node:path";
import { isActionableEmail } from "../src/lib/postDiscovery";

export interface EmlAttachment {
  filename: string;
  bytes: Buffer;
}

export interface EmlDraftInput {
  to: string;
  subject: string;
  body: string;
  attachment?: EmlAttachment | null;
}

export function mimeTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return 'text/plain; charset="utf-8"';
    default:
      return "application/octet-stream";
  }
}

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").replace(/\s+/g, " ").trim();
}

export function sanitizeAttachmentFilename(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\r\n\0"\\;]+/g, "")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return cleaned || "resume.pdf";
}

export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function wrapBase64(data: Buffer): string {
  const raw = data.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 76) {
    lines.push(raw.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

export function buildEmlFilename(subject: string, recipient: string): string {
  const seed = sanitizeHeaderValue(subject || recipient || "application-draft")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${seed || "application-draft"}.eml`;
}

export function buildEmlDraft(input: EmlDraftInput): Buffer {
  const cleanTo = sanitizeHeaderValue(input.to).toLowerCase();
  if (!isActionableEmail(cleanTo)) {
    throw new Error("Recipient email address is missing or invalid.");
  }

  const cleanSubject = encodeHeaderWord(input.subject.slice(0, 200));
  const normalizedBody = input.body.replace(/\r?\n/g, "\r\n").trim();
  const encodedBody = wrapBase64(Buffer.from(normalizedBody, "utf8"));
  const dateHeader = new Date().toUTCString();

  const headers = [
    `To: ${cleanTo}`,
    `Subject: ${cleanSubject}`,
    `Date: ${dateHeader}`,
    "X-Unsent: 1",
    "MIME-Version: 1.0",
  ];

  if (!input.attachment || input.attachment.bytes.byteLength === 0) {
    const simpleMessage = [
      ...headers,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodedBody,
      "",
    ].join("\r\n");
    return Buffer.from(simpleMessage, "utf8");
  }

  const boundary = `----HireMate_${crypto.randomBytes(12).toString("hex")}`;
  const safeFilename = sanitizeAttachmentFilename(input.attachment.filename);
  const contentType = mimeTypeForFilename(safeFilename);
  const encodedAttachment = wrapBase64(input.attachment.bytes);

  const multipartMessage = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
    "",
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${safeFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "",
    encodedAttachment,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return Buffer.from(multipartMessage, "utf8");
}
