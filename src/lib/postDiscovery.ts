import type {
  EmploymentChoice,
  LinkedInActionType,
  PostRecord,
  PostStatus,
  RawPostInput,
  ResumeRecord,
  SearchSettings,
  WorkplaceChoice,
} from "./types";

export const EMAIL_REGEX = /[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;

export const CHOICE_TERMS: Record<string, readonly string[]> = {
  Remote: ["remote", "work from home"],
  Hybrid: ["hybrid"],
  Onsite: ["onsite", "on-site", "on site"],
  Contract: ["contract", "freelance", "freelancer", "freelancing", "contractor"],
  "Full-time": ["full-time", "full time", "fulltime"],
};

export const PRIORITY_STATUSES: readonly PostStatus[] = [
  "Ready for review",
  "Check delivery",
  "Queued",
  "Needs draft",
  "Contact on LinkedIn",
  "Apply via link",
  "Unverified lead",
  "Check application instructions",
  "Check recipients",
];

export function statusRank(status: PostStatus): number {
  const idx = PRIORITY_STATUSES.indexOf(status);
  return idx === -1 ? PRIORITY_STATUSES.length : idx;
}

const NON_REPLY_EMAIL_REGEX = /^(?:no-?reply|do-?not-?reply|mailer-daemon)@/i;

export function isActionableEmail(email: string): boolean {
  const cleaned = email.trim().toLowerCase();
  if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(cleaned)) return false;
  return !NON_REPLY_EMAIL_REGEX.test(cleaned);
}

export function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of matches) {
    const lower = item.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      ordered.push(lower);
    }
  }
  return ordered;
}

export function buildMailtoHref(recipient: string, subject: string, body: string): string | null {
  const cleanRecipient = recipient.replace(/[\r\n]+/g, "").trim();
  if (!isActionableEmail(cleanRecipient)) return null;
  const cleanSubject = subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const cleanBody = body.trim().slice(0, 6000);
  const params = new URLSearchParams();
  if (cleanSubject) params.set("subject", cleanSubject);
  if (cleanBody) params.set("body", cleanBody);
  // Use %20 instead of + because mail clients render + literally in mailto URLs.
  const query = params.toString().replace(/\+/g, "%20");
  return `mailto:${encodeURIComponent(cleanRecipient)}${query ? `?${query}` : ""}`;
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function isPrivateOrMetadataHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export function isSafeFeedUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return !isPrivateOrMetadataHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isLinkedInUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

export function isLinkedInSearch(url: string): boolean {
  try {
    const page = new URL(url);
    return (
      page.protocol === "https:" &&
      page.host === "www.linkedin.com" &&
      page.pathname === "/search/results/content/"
    );
  } catch {
    return false;
  }
}

export function linkedinId(url: string): string | null {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" || !isLinkedInUrl(url)) {
    return null;
  }
  if (/^\/groups\/[0-9]+\/?$/.test(page.pathname)) {
    const urns = page.searchParams.getAll("highlightedUpdateUrn");
    if (urns.length === 1) {
      const groupPost = urns[0].match(/^urn:li:activity:([0-9]{15,21})$/);
      if (groupPost) return groupPost[1];
    }
    return null;
  }
  const decodedPath = page.pathname.replace(/%3a/gi, ":");
  const match = decodedPath.match(
    /^\/(?:posts\/[^/]*-(\d{15,21})(?:-[^/]*)?|feed\/update\/urn:li:(?:share|activity|ugcPost):(\d{15,21}))\/?$/,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

const MIN_LINKEDIN_EPOCH_MS = Date.UTC(2015, 0, 1);

export function linkedinTimestampFromUrl(
  url: string,
  nowMs: number = Date.now(),
): string | null {
  const id = linkedinId(url);
  if (!id || !/^\d{18,20}$/.test(id)) return null;
  try {
    const ms = Number(BigInt(id) >> 22n);
    if (!Number.isFinite(ms)) return null;
    if (ms < MIN_LINKEDIN_EPOCH_MS || ms > nowMs + 86_400_000) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeAge(date: Date, now: Date): string | undefined {
  const diffMs = now.getTime() - date.getTime();
  if (!Number.isFinite(diffMs) || diffMs < -60_000) return undefined;
  const mins = Math.floor(Math.max(0, diffMs) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatPostTimestamp(
  post: Pick<PostRecord, "url" | "published" | "published_at" | "date_kind" | "created_at">,
  now: Date = new Date(),
): { label: string; title: string; relative?: string } {
  const exactIso = post.published_at || linkedinTimestampFromUrl(post.url, now.getTime());
  if (exactIso) {
    const date = new Date(exactIso);
    if (!Number.isNaN(date.getTime())) {
      return {
        label: formatDateTime(date),
        title: date.toISOString(),
        relative: formatRelativeAge(date, now),
      };
    }
  }

  if (post.published) {
    const prefix =
      post.date_kind === "observed"
        ? "Seen "
        : post.date_kind === "relative"
          ? "Approx. "
          : "";
    return {
      label: `${prefix}${post.published}`,
      title: post.published,
    };
  }

  if (post.created_at) {
    const captured = new Date(post.created_at);
    if (!Number.isNaN(captured.getTime())) {
      return {
        label: `Captured ${formatDateTime(captured)}`,
        title: captured.toISOString(),
      };
    }
  }

  return {
    label: "Date unconfirmed",
    title: "",
  };
}

export function applicationLink(text: string): string {
  const link = text.match(
    /\b(?:apply|register|submit)\b[^.!?\n]{0,80}?\s*(https?:\/\/[^\s<>]+)/i,
  );
  return link ? link[1].replace(/[.,;:!?)]+$/, "") : "";
}

function parseIsoDateUtc(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const ts = Date.UTC(y, m - 1, d);
  const check = new Date(ts);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return ts;
}

export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function detectLinkedInOutreach(
  text: string,
): { action: LinkedInActionType; commentKeyword: string } | null {
  const clauses = text.split(/[.!?;\n]+/);
  let foundDm = false;
  let foundConnect = false;
  let foundComment = false;
  let commentKeyword = "";

  const offPlatformRegex = /\b(?:WhatsApp|Telegram|Instagram)\b/i;

  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause || offPlatformRegex.test(clause)) continue;

    const negatesDm = /\b(?:do not|don't|don’t|please avoid|avoid|no)\s+(?:direct\s+)?(?:DMs?|messages?|inmails?)\b/i.test(
      clause,
    );
    const negatesConnect = /\b(?:do not|don't|don’t|please avoid|no)\s+(?:connection\s+requests?|connect)\b/i.test(
      clause,
    );
    const negatesComment = /\b(?:do not|don't|don’t|please avoid|no)\s+comments?\b/i.test(clause);

    if (
      !negatesDm &&
      /\b(?:DM me|DM\s+(?:your|for|if|to)|message me|drop me a (?:DM|message)|send me a (?:direct )?message|shoot me a (?:DM|message)|inbox me|ping me|via LinkedIn DM|reach out (?:to me )?(?:via|on) (?:LinkedIn|DM))\b/i.test(
        clause,
      )
    ) {
      foundDm = true;
    }

    if (
      !negatesConnect &&
      /\b(?:connect with me(?:\s+(?:on|via)\s+LinkedIn)?|send (?:me )?a connection (?:request|invite)|add me on LinkedIn|let['’]?s connect)\b/i.test(
        clause,
      )
    ) {
      foundConnect = true;
    }

    if (!negatesComment) {
      const quotedKeyword = clause.match(
        /\bcomment\s+(?:with\s+)?["'“”‘’]([^"'“”‘’]{1,32})["'“”‘’]/i,
      );
      if (quotedKeyword?.[1]) {
        foundComment = true;
        if (!commentKeyword) commentKeyword = quotedKeyword[1].trim();
      } else if (
        /\b(?:drop a comment|leave a comment|comment below|comment here|comment on this post|reply in (?:the )?comments?|comment (?:if )?interested|comment your (?:portfolio|github|resume|résumé|profile|interest))\b/i.test(
          clause,
        )
      ) {
        foundComment = true;
        if (!commentKeyword && /\bcomment\s+(?:if\s+)?interested\b/i.test(clause)) {
          commentKeyword = "Interested";
        }
      }
    }
  }

  if (foundDm) return { action: "dm", commentKeyword };
  if (foundConnect) return { action: "connect", commentKeyword };
  if (foundComment) return { action: "comment", commentKeyword };
  return null;
}

export function instructions(
  post: Pick<RawPostInput, "text" | "published" | "date_kind" | "content_kind">,
  todayIso: string = todayIsoDate(),
): {
  route: PostStatus;
  recipient: string;
  applyLink: string;
  linkedinAction?: LinkedInActionType;
  commentKeyword?: string;
} {
  const contentKind = post.content_kind ?? "full";
  const dateKind = post.date_kind ?? "published";
  if (contentKind !== "full" || (dateKind !== "published" && dateKind !== "relative")) {
    return { route: "Unverified lead", recipient: "", applyLink: "" };
  }

  const publishedTs = parseIsoDateUtc(post.published);
  const todayTs = parseIsoDateUtc(todayIso);
  if (publishedTs === null || todayTs === null) {
    return { route: "Unverified lead", recipient: "", applyLink: "" };
  }
  const ageDays = Math.floor((todayTs - publishedTs) / 86_400_000);
  if (ageDays < 0 || ageDays > 14) {
    return { route: "Outside discovery window", recipient: "", applyLink: "" };
  }

  const text = post.text;
  const action =
    "(?:apply(?:\\s+(?:by|via)\\s+email)?\\s+(?:at|to)|" +
    "(?:send|submit|share|email|e-mail|forward|drop)\\s+(?:(?:your|their|a|an|updated|latest)\\s+)*" +
    "(?:résumés?|resumes?|cvs?|profiles?|applications?)" +
    "(?:\\s*(?:and|&|along with)\\s+(?:your\\s+)?LinkedIn\\s+(?:profile(?:\\s+(?:link|URL))?|URL))?" +
    "\\s*(?:(?:at|to|via email|via dm|along with)\\b)?|" +
    "(?:application|applications|contact|reach\\s+out(?:\\s+(?:at|to))?|e-?mail(?:\\s+(?:at|to|id))?|mail(?:\\s+(?:at|to|id))?|along\\s+with))";

  const actionEmailRegex = new RegExp(
    "\\b" + action + "[\\s:–—-]*(" + EMAIL_REGEX.source + ")",
    "gi",
  );
  const actionEmails: string[] = [];
  for (const match of text.matchAll(actionEmailRegex)) {
    const email = match[1]?.toLowerCase();
    if (email && isActionableEmail(email) && !actionEmails.includes(email)) {
      actionEmails.push(email);
    }
  }

  const link = applicationLink(text);
  const allEmails = extractEmails(text).filter(isActionableEmail);
  const primaryEmail = actionEmails[0] ?? allEmails[0] ?? "";

  if (primaryEmail) {
    return {
      route: "Needs draft",
      recipient: primaryEmail,
      applyLink: link,
    };
  }

  if (link) {
    return { route: "Apply via link", recipient: "", applyLink: link };
  }

  const social = detectLinkedInOutreach(text);
  if (social) {
    return {
      route: "Contact on LinkedIn",
      recipient: "",
      applyLink: "",
      linkedinAction: social.action,
      commentKeyword: social.commentKeyword || undefined,
    };
  }

  return {
    route: "No email listed",
    recipient: "",
    applyLink: "",
  };
}

export function splitTerms(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBooleanGroup(values: string[]): string {
  const phrases = values.map((val) => `"${val.replace(/"/g, "")}"`);
  return phrases.length === 1 ? phrases[0] : `(${phrases.join(" OR ")})`;
}

export function buildSearchQuery(search: SearchSettings, fallbackQuery = "hiring"): string {
  const parts: string[] = [];
  const roles = splitTerms(search.roles);
  const locations = splitTerms(search.locations);

  if (roles.length > 0) {
    parts.push("hiring", formatBooleanGroup(roles));
  } else {
    parts.push(fallbackQuery);
  }

  if (locations.length > 0) {
    parts.push(formatBooleanGroup(locations));
  }
  const lowerLocations = new Set(locations.map((loc) => loc.toLowerCase()));
  if (search.workplace !== "Any" && !lowerLocations.has(search.workplace.toLowerCase())) {
    parts.push(`"${search.workplace}"`);
  }
  if (search.employment !== "Any") {
    parts.push(`"${search.employment}"`);
  }

  return parts.join(" ");
}

export function buildSearchUrl(search: SearchSettings, fallbackQuery = "hiring"): string {
  const params = new URLSearchParams({
    keywords: buildSearchQuery(search, fallbackQuery),
    sortBy: '"date_posted"',
  });
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

export function matchesSearch(
  search: SearchSettings,
  post: Pick<RawPostInput, "title" | "text">,
): boolean {
  const text = `${post.title} ${post.text}`;
  const groups: readonly (readonly string[])[] = [
    splitTerms(search.roles),
    splitTerms(search.locations),
    CHOICE_TERMS[search.workplace] ?? [],
    CHOICE_TERMS[search.employment] ?? [],
  ];
  for (const values of groups) {
    if (values.length > 0) {
      const matched = values.some((term) => {
        const pattern = new RegExp(`(?<!\\w)${escapeRegExp(term)}(?!\\w)`, "i");
        return pattern.test(text);
      });
      if (!matched) return false;
    }
  }
  if (
    search.workplace === "Remote" &&
    /\b(no remote|not remote|on[ -]?site only)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

export function normalizeSearchSettings(input: Partial<SearchSettings> | null | undefined): SearchSettings {
  const workplaces: readonly WorkplaceChoice[] = ["Any", "Remote", "Hybrid", "Onsite"];
  const employments: readonly EmploymentChoice[] = ["Any", "Contract", "Full-time"];
  const workplace = workplaces.includes(input?.workplace as WorkplaceChoice)
    ? (input?.workplace as WorkplaceChoice)
    : "Any";
  const employment = employments.includes(input?.employment as EmploymentChoice)
    ? (input?.employment as EmploymentChoice)
    : "Any";
  return {
    roles: typeof input?.roles === "string" ? input.roles.trim().slice(0, 240) : "",
    locations: typeof input?.locations === "string" ? input.locations.trim().slice(0, 240) : "",
    workplace,
    employment,
  };
}

export function validateIncomingPosts(posts: unknown): RawPostInput[] {
  if (!Array.isArray(posts)) {
    throw new Error("Expected a list of posts");
  }
  const result: RawPostInput[] = [];
  for (const raw of posts) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid post item");
    }
    const post = raw as Record<string, unknown>;
    for (const field of ["url", "title", "text"] as const) {
      if (typeof post[field] !== "string" || !post[field].trim()) {
        throw new Error(`Missing post field ${field}`);
      }
    }
    const url = (post.url as string).trim();
    try {
      if (new URL(url).protocol !== "https:") {
        throw new Error("Invalid post URL");
      }
    } catch {
      throw new Error("Invalid post URL");
    }

    let dateKind = (post.date_kind as RawPostInput["date_kind"]) ?? "published";
    let published = typeof post.published === "string" ? post.published.trim() : "";

    if (dateKind === "published" || dateKind === "relative") {
      if (parseIsoDateUtc(published) === null) {
        if (!linkedinId(url) && dateKind !== "relative") {
          throw new Error("Missing or invalid publication date");
        }
        dateKind = "unknown";
        published = "";
      }
    }

    const cleaned: RawPostInput = {
      url,
      title: (post.title as string).trim().slice(0, 300),
      text: (post.text as string).trim().slice(0, 30000),
      published,
      date_kind: dateKind,
      content_kind:
        post.content_kind === "snippet" || post.content_kind === "full"
          ? post.content_kind
          : "full",
    };
    if (typeof post.verification_note === "string" && post.verification_note.trim()) {
      cleaned.verification_note = post.verification_note.trim().slice(0, 240);
    }
    if (typeof post.preview_text === "string" && post.preview_text.trim()) {
      cleaned.preview_text = post.preview_text.trim().slice(0, 30000);
    }
    result.push(cleaned);
  }
  return result;
}

export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    }
    return out as T;
  }
  return value;
}

export function missingDetails(post: PostRecord): string {
  const missing: string[] = [];
  if (post.url.startsWith("https://www.linkedin.com/search/results/content/")) {
    missing.push("a direct post link");
  }
  if (
    !post.published ||
    (post.date_kind && !["published", "relative"].includes(post.date_kind))
  ) {
    missing.push("a confirmed publication date");
  }
  if (post.content_kind === "snippet") {
    missing.push("confirmation that the text is complete");
  }
  return missing.join(", ");
}

export function isDraftFromOlderResume(
  post: Pick<PostRecord, "status" | "resume" | "message">,
  activeResume: Pick<ResumeRecord, "version"> | null | undefined,
): boolean {
  if (post.status !== "Ready for review" || !post.message) return false;
  if (!activeResume?.version || !post.resume) return false;
  return post.resume !== activeResume.version;
}

export function shouldRefreshDraftOnResumeChange(
  post: Pick<PostRecord, "status" | "resume" | "draft_edited" | "fit_resume" | "fit_policy">,
  activeResume: Pick<ResumeRecord, "version">,
  fitPolicy: string,
): boolean {
  if (post.status !== "Ready for review") return false;
  if (post.draft_edited) return false;
  return (
    post.resume !== activeResume.version ||
    post.fit_resume !== activeResume.version ||
    post.fit_policy !== fitPolicy
  );
}

const GENERIC_RECIPIENT_TOKENS = new Set([
  "hr",
  "jobs",
  "job",
  "hiring",
  "career",
  "careers",
  "talent",
  "recruit",
  "recruiter",
  "recruiters",
  "recruiting",
  "recruitment",
  "apply",
  "application",
  "applications",
  "team",
  "info",
  "hello",
  "hi",
  "contact",
  "admin",
  "support",
  "sales",
  "office",
  "mail",
  "email",
  "resume",
  "resumes",
  "cv",
  "people",
  "work",
  "we",
  "our",
  "urgent",
  "open",
  "opening",
  "openings",
  "position",
  "positions",
  "role",
  "roles",
  "looking",
  "staffing",
  "consulting",
  "consultancy",
  "solutions",
  "services",
  "careersindia",
  "hrteam",
  "talentacquisition",
]);

const COMPANY_LOCALPART_HINT =
  /(?:consult|solution|staffing|recruit|career|hiring|talent|services|systems|digital|tech|labs|studio|agency|ventures|group|global|india|corp|inc|llc|ltd|hr$)/i;

const RESUME_NOISE_WORDS = new Set([
  "resume",
  "résumé",
  "cv",
  "curriculum",
  "vitae",
  "updated",
  "latest",
  "final",
  "new",
  "draft",
  "copy",
  "profile",
  "summary",
  "engineer",
  "developer",
  "scientist",
  "manager",
  "analyst",
  "architect",
  "consultant",
  "lead",
  "senior",
  "junior",
  "staff",
  "principal",
  "ai",
  "ml",
  "genai",
  "data",
  "software",
  "full",
  "stack",
  "backend",
  "frontend",
  "pdf",
  "docx",
  "txt",
]);

function toTitleCase(word: string): string {
  const lower = word.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function cleanNameToken(raw: string): string | null {
  const cleaned = raw.replace(/[^a-zA-Z]/g, "");
  if (cleaned.length < 2 || cleaned.length > 20) return null;
  if (GENERIC_RECIPIENT_TOKENS.has(cleaned.toLowerCase())) return null;
  return toTitleCase(cleaned);
}

export function extractRecipientName(
  post: Pick<PostRecord, "url" | "recipient" | "author_name">,
): string | null {
  // 1. Personal email address (e.g. lavanya.s@..., smita.rai@..., hatim.kagdi@...)
  const recipient = (post.recipient ?? "").trim().toLowerCase();
  if (recipient && recipient.includes("@")) {
    const localPart = recipient.split("@")[0];
    if (localPart && !COMPANY_LOCALPART_HINT.test(localPart)) {
      const segments = localPart.split(/[._-]+/).filter(Boolean);
      if (segments.length >= 2) {
        for (const segment of segments) {
          const candidate = cleanNameToken(segment);
          if (candidate) return candidate;
        }
      } else if (segments.length === 1 && segments[0].length <= 14) {
        const single = cleanNameToken(segments[0]);
        if (single) return single;
      }
    }
  }

  // 2. Explicit author name (extracted from LinkedIn JSON-LD or mobile screenshot)
  if (post.author_name) {
    const authorTokens = post.author_name.trim().split(/\s+/).filter(Boolean);
    if (authorTokens.length > 0) {
      const first = cleanNameToken(authorTokens[0]);
      if (first) return first;
    }
  }

  // 3. LinkedIn post author slug (e.g. /posts/preeti-nagpal-910589411_hiring-...)
  if (post.url) {
    try {
      const parsed = new URL(post.url);
      if (isLinkedInUrl(post.url)) {
        const slugMatch = parsed.pathname.match(/^\/posts\/([a-z0-9-]+)_/i);
        if (slugMatch?.[1]) {
          const tokens = slugMatch[1].split("-").filter(Boolean);
          const firstRaw = tokens[0]?.toLowerCase() ?? "";
          if (
            tokens.length >= 2 &&
            firstRaw &&
            !GENERIC_RECIPIENT_TOKENS.has(firstRaw) &&
            !COMPANY_LOCALPART_HINT.test(slugMatch[1])
          ) {
            const first = cleanNameToken(tokens[0]);
            if (first) return first;
          }
        }
      }
    } catch {
      // Ignore invalid URLs.
    }
  }

  return null;
}

export function extractCandidateName(
  resume: Pick<ResumeRecord, "name" | "text"> | null | undefined,
): string {
  if (!resume) return "";

  // 1. Filename (e.g. "Aayush_Gupta_Resume.pdf" -> "Aayush Gupta")
  const base = (resume.name ?? "").replace(/\.[^.]+$/, "");
  const fileTokens = base
    .split(/[\s._-]+/)
    .map((t) => t.replace(/[^a-zA-Z]/g, ""))
    .filter((t) => t.length >= 2 && !RESUME_NOISE_WORDS.has(t.toLowerCase()));
  if (fileTokens.length >= 2 && fileTokens.length <= 3) {
    return fileTokens.map(toTitleCase).join(" ");
  }

  // 2. Opening name header in résumé text (e.g. "AAYUSH GUPTA AI Engineer...")
  const firstLine = (resume.text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (firstLine) {
    const words = firstLine.split(/\s+/).slice(0, 6);
    const nameParts: string[] = [];
    for (const rawWord of words) {
      const cleaned = rawWord.replace(/[^a-zA-Z'-]/g, "");
      if (!cleaned || cleaned.length < 2 || cleaned.length > 20) break;
      if (RESUME_NOISE_WORDS.has(cleaned.toLowerCase())) break;
      if (!/^[A-Z]/.test(cleaned)) break;
      nameParts.push(toTitleCase(cleaned));
      if (nameParts.length === 3) break;
    }
    if (nameParts.length >= 2) {
      return nameParts.join(" ");
    }
  }

  if (fileTokens.length === 1) {
    return toTitleCase(fileTokens[0]);
  }

  return "";
}

export function formatEmailDraftBody(
  rawBody: string,
  recipientName: string | null,
  candidateName: string,
): string {
  let core = rawBody.replace(/\r\n/g, "\n").trim();

  // Remove any existing leading greeting line so we apply a consistent "Hello <Name>," greeting.
  core = core.replace(
    /^(?:hello|hi|hey|dear|greetings)\b[^\n]{0,60}[,!:–—-]?\s*(?:\n\s*)*/i,
    "",
  );

  // Remove any existing trailing sign-off block so we apply a consistent "Regards,\n<Name>" ending.
  core = core.replace(
    /(?:\n\s*)+(?:(?:best|warm|kind)\s+)?(?:regards|sincerely|thanks(?:\s+and\s+regards)?|thank\s+you|best(?:\s+wishes)?|cheers)[,!]?\s*(?:\n[^\n]{0,80}){0,2}\s*$/i,
    "",
  );

  core = core.trim();
  const greeting = `Hello ${recipientName || "Hiring Team"},`;
  const signOff = candidateName ? `Regards,\n${candidateName}` : "Regards,";

  return `${greeting}\n\n${core}\n\n${signOff}`;
}


