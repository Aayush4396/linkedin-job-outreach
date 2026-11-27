import {
  isLinkedInUrl,
  isPrivateOrMetadataHost,
  linkedinId,
  linkedinTimestampFromUrl,
  todayIsoDate,
} from "../src/lib/postDiscovery";

export interface PublicLinkedInPostResult {
  url: string;
  published: string;
  published_at?: string;
  title: string;
  text: string;
  author_name?: string;
  truncated: boolean;
  blocked: boolean;
  reason?: string;
}

const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 2;

export function isSafeLinkedInPublicUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (isPrivateOrMetadataHost(parsed.hostname)) return false;
    return isLinkedInUrl(rawUrl);
  } catch {
    return false;
  }
}

export function extractLinkedInUrlFromShare(input: {
  url?: string;
  text?: string;
  title?: string;
}): string | null {
  const candidates = [input.url ?? "", input.text ?? "", input.title ?? ""];
  const urlRegex = /https:\/\/[^\s<>()]+/gi;
  for (const field of candidates) {
    const trimmed = field.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(urlRegex) ?? [];
    for (const raw of matches) {
      const cleaned = raw.replace(/[.,;:!?)'"]+$/, "");
      if (isSafeLinkedInPublicUrl(cleaned)) {
        return cleaned;
      }
    }
  }
  return null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const cp = Number(dec);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    });
}

function extractMetaContent(html: string, attrName: "property" | "name", value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+${attrName}=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+${attrName}=["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]).trim();
    }
  }
  return "";
}

function extractFromJsonLd(html: string): {
  title: string;
  text: string;
  authorName: string;
  datePublished: string;
} {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let title = "";
  let text = "";
  let authorName = "";
  let datePublished = "";

  for (const match of html.matchAll(scriptRegex)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const body =
          typeof obj.articleBody === "string"
            ? obj.articleBody.trim()
            : typeof obj.text === "string"
              ? obj.text.trim()
              : typeof obj.description === "string"
                ? obj.description.trim()
                : "";
        if (body.length > text.length) {
          text = decodeHtmlEntities(body);
        }
        if (!title && typeof obj.headline === "string" && obj.headline.trim()) {
          title = decodeHtmlEntities(obj.headline.trim());
        }
        if (!authorName && obj.author && typeof obj.author === "object") {
          const authorObj = obj.author as Record<string, unknown>;
          if (typeof authorObj.name === "string" && authorObj.name.trim()) {
            authorName = decodeHtmlEntities(authorObj.name.trim());
          }
        }
        if (!datePublished && typeof obj.datePublished === "string" && obj.datePublished.trim()) {
          datePublished = obj.datePublished.trim();
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return { title, text, authorName, datePublished };
}

function cleanLinkedInTitle(rawTitle: string, fallbackText: string): string {
  const cleaned = rawTitle
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .replace(/\s+on LinkedIn:\s*/i, " — ")
    .replace(/^["“]+|["”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 4 && !/^(?:sign in|join linkedin|linkedin)$/i.test(cleaned)) {
    return cleaned.slice(0, 220);
  }
  const firstLine = fallbackText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4);
  return (firstLine ?? "LinkedIn hiring post").slice(0, 220);
}

export function parseLinkedInPublicHtml(
  html: string,
  postUrl: string,
  fallbackTodayIso: string = todayIsoDate(),
): PublicLinkedInPostResult {
  const exactIso = linkedinTimestampFromUrl(postUrl) ?? undefined;
  const ld = extractFromJsonLd(html);
  const ogTitle = extractMetaContent(html, "property", "og:title");
  const ogDesc = extractMetaContent(html, "property", "og:description");
  const metaDesc = extractMetaContent(html, "name", "description");

  const bestText = [ld.text, ogDesc, metaDesc]
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length)[0] ?? "";

  const isAuthWall =
    /(?:authwall|uas\/login|sign in to view|join linkedin to see)/i.test(ogTitle) ||
    (/(?:sign in|log in)\s+to\s+linkedin/i.test(bestText) && bestText.length < 180);

  let publishedIso = exactIso ? exactIso.slice(0, 10) : "";
  if (!publishedIso && ld.datePublished) {
    const parsedDate = new Date(ld.datePublished);
    if (!Number.isNaN(parsedDate.getTime())) {
      publishedIso = parsedDate.toISOString().slice(0, 10);
    }
  }
  if (!publishedIso) {
    publishedIso = fallbackTodayIso;
  }

  if (isAuthWall || bestText.length < 20) {
    return {
      url: postUrl,
      published: publishedIso,
      ...(exactIso ? { published_at: exactIso } : {}),
      title: "",
      text: "",
      ...(ld.authorName ? { author_name: ld.authorName } : {}),
      truncated: false,
      blocked: true,
      reason:
        "LinkedIn requires sign-in to view this post. Upload a screenshot of the post or paste its text below.",
    };
  }

  const title = cleanLinkedInTitle(ld.title || ogTitle, bestText);
  const truncated = /(?:\.\.\.|…)\s*$/.test(bestText);

  return {
    url: postUrl,
    published: publishedIso,
    ...(exactIso ? { published_at: exactIso } : {}),
    title,
    text: bestText.slice(0, 30000),
    ...(ld.authorName ? { author_name: ld.authorName } : {}),
    truncated,
    blocked: false,
  };
}

export async function fetchPublicLinkedInPost(
  rawUrl: string,
  fallbackTodayIso: string = todayIsoDate(),
): Promise<PublicLinkedInPostResult> {
  if (!isSafeLinkedInPublicUrl(rawUrl)) {
    throw new Error("Enter a valid public https://www.linkedin.com post link.");
  }

  let currentUrl = rawUrl.trim();
  const exactIso = linkedinTimestampFromUrl(currentUrl) ?? undefined;
  const fallbackDate = exactIso ? exactIso.slice(0, 10) : fallbackTodayIso;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch {
      return {
        url: currentUrl,
        published: fallbackDate,
        ...(exactIso ? { published_at: exactIso } : {}),
        title: "",
        text: "",
        truncated: false,
        blocked: true,
        reason:
          "Could not reach LinkedIn from the server. Take a screenshot of the post and upload it below.",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      let resolved: string;
      try {
        resolved = new URL(location, currentUrl).toString();
      } catch {
        break;
      }
      if (!isSafeLinkedInPublicUrl(resolved) || /\/(?:authwall|login|uas\/login)/i.test(resolved)) {
        return {
          url: rawUrl.trim(),
          published: fallbackDate,
          ...(exactIso ? { published_at: exactIso } : {}),
          title: "",
          text: "",
          truncated: false,
          blocked: true,
          reason:
            "LinkedIn redirected this link to a sign-in wall. Drop a screenshot of the post below to draft immediately.",
        };
      }
      currentUrl = resolved;
      continue;
    }

    if (!response.ok) {
      return {
        url: currentUrl,
        published: fallbackDate,
        ...(exactIso ? { published_at: exactIso } : {}),
        title: "",
        text: "",
        truncated: false,
        blocked: true,
        reason:
          response.status === 999 || response.status === 403 || response.status === 429
            ? "LinkedIn blocked automatic reading for this post. Upload a screenshot below to extract and draft instantly."
            : `LinkedIn returned HTTP ${response.status}. Upload a screenshot or paste the post text below.`,
      };
    }

    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
      return parseLinkedInPublicHtml(html.slice(0, MAX_HTML_BYTES), currentUrl, fallbackDate);
    }
    const parsed = parseLinkedInPublicHtml(html, currentUrl, fallbackDate);
    if (!linkedinId(parsed.url) && linkedinId(rawUrl)) {
      parsed.url = rawUrl.trim();
    }
    return parsed;
  }

  return {
    url: rawUrl.trim(),
    published: fallbackDate,
    ...(exactIso ? { published_at: exactIso } : {}),
    title: "",
    text: "",
    truncated: false,
    blocked: true,
    reason:
      "LinkedIn did not return the public post body. Upload a screenshot of the post below to extract and draft.",
  };
}
