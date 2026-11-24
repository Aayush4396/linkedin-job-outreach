import crypto from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import type { ResumeRecord } from "../src/lib/types";
import type { HireMateStore } from "./storage";

const ALLOWED_EXTENSIONS = new Set([".txt", ".docx", ".pdf"]);
const MAX_XML_UNCOMPRESSED_BYTES = 8_000_000;
const MAX_PDF_PAGES = 25;
const MAX_RESUME_CHARS = 100_000;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

async function extractDocxText(raw: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(raw);
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    throw new Error("Could not find document contents in this Word file.");
  }
  const xmlBytes = await docEntry.async("uint8array");
  if (xmlBytes.byteLength > MAX_XML_UNCOMPRESSED_BYTES) {
    throw new Error("Word document is too large.");
  }
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  const paragraphs = xml.split(/<\/w:p>/i);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const runs = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map((m) =>
      decodeXmlEntities(m[1]),
    );
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

async function extractPdfText(raw: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(raw));
  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new Error("Choose a résumé under 26 pages.");
  }
  const result = await extractText(pdf, { mergePages: true });
  return typeof result.text === "string" ? result.text : "";
}

function extractTxtText(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString("utf16le");
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(raw.length - 2);
    for (let i = 2; i + 1 < raw.length; i += 2) {
      swapped[i - 2] = raw[i + 1];
      swapped[i - 1] = raw[i];
    }
    return swapped.toString("utf16le");
  }
  return raw.toString("utf8").replace(/^\uFEFF/, "");
}

export async function parseAndSaveResume(
  store: HireMateStore,
  rawFilename: string,
  rawBytes: Buffer,
): Promise<ResumeRecord> {
  const safeName = path.basename(rawFilename.replace(/\\/g, "/")).trim();
  const suffix = path.extname(safeName).toLowerCase();

  if (suffix === ".doc") {
    throw new Error(
      "Legacy .doc files are not supported in the web runtime. Please save your résumé as .docx, .pdf, or .txt.",
    );
  }
  if (!ALLOWED_EXTENSIONS.has(suffix)) {
    throw new Error("Choose a .docx, .txt, or .pdf résumé file.");
  }

  let extracted = "";
  if (suffix === ".txt") {
    extracted = extractTxtText(rawBytes);
  } else if (suffix === ".docx") {
    extracted = await extractDocxText(rawBytes);
  } else if (suffix === ".pdf") {
    extracted = await extractPdfText(rawBytes);
  }

  const text = extracted.trim();
  if (!text || text.includes("\0") || text.length > MAX_RESUME_CHARS) {
    throw new Error("Could not extract readable text from this résumé file.");
  }

  const version = `${crypto.createHash("sha256").update(rawBytes).digest("hex")}${suffix}`;
  store.saveResumeBytes(version, rawBytes);

  const resume: ResumeRecord = {
    name: safeName,
    version,
    text,
    uploadedAt: new Date().toISOString(),
  };

  store.transact((_get, put) => {
    put("settings", "resume", resume as unknown as Record<string, unknown>);
  });

  return resume;
}
