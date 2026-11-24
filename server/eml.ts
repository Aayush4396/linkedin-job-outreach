import crypto from "node:crypto";
import path from "node:path";
import { isActionableEmail } from "../src/lib/postDiscovery";

export interface EmlAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface EmlDraftOptions {
  recipient: string;
  subject: string;
  body: string;
  attachment?: EmlAttachment | null;
}

export function resumeMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "text/plain; charset=utf-8";
}

export function sanitizeHeaderFilename(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, "/"));
  const cleaned = base.replace(/[\r\n"\\;]+/g, "_").replace(/[^\x20-\x7E]/g, "_").trim();
  return cleaned || "resume.pdf";
}

function encodeHeaderValue(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7E]*$/.test(singleLine)) {
    return singleLine;
  }
  return `=?UTF-8?B?${Buffer.from(singleLine, "utf8").toString("base64")}?=`;
}

function wrapBase64(raw: Buffer): string {
  const b64 = raw.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

export function buildEmlDraft(options: EmlDraftOptions): Buffer {
  const cleanRecipient = options.recipient.replace(/[\r\n]+/g, "").trim();
  if (!isActionableEmail(cleanRecipient)) {
    throw new Error("Invalid recipient email address.");
  }

  const subject = encodeHeaderValue(options.subject.slice(0, 200));
  const body = normalizeCrlf(options.body.trim().slice(0, 6000));
  const boundary = `----=_HireMate_${crypto.randomBytes(12).toString("hex")}`;

  const headers = [
    `To: ${cleanRecipient}`,
    `Subject: ${subject}`,
    "X-Unsent: 1",
    "MIME-Version: 1.0",
  ];

  if (!options.attachment || options.attachment.bytes.byteLength === 0) {
    const simple = [
      ...headers,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      "",
    ].join("\r\n");
    return Buffer.from(simple, "utf8");
  }

  const safeFilename = sanitizeHeaderFilename(options.attachment.filename);
  const contentType = options.attachment.contentType.replace(/[\r\n;]+/g, "").trim() || "application/octet-stream";

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${safeFilename}"`,
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(options.attachment.bytes),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return Buffer.from(parts, "utf8");
}
