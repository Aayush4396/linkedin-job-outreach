import crypto from "node:crypto";
import {
  extractEmails,
  instructions,
  isActionableEmail,
  isLinkedInSearch,
  isLinkedInUrl,
  isSafeFeedUrl,
  linkedinId,
  linkedinTimestampFromUrl,
  matchesSearch,
  normalizeSearchSettings,
  validateIncomingPosts,
} from "../src/lib/postDiscovery";
import type {
  PostRecord,
  PostStatus,
  RawPostInput,
  ResumeRecord,
  ScanRecord,
  SearchSettings,
} from "../src/lib/types";
import type { AppConfig } from "./config";
import { assessResumeFit, draftApplicationPitch, draftLinkedInOutreach } from "./gemini";
import { SAMPLE_POSTS } from "./samplePosts";
import type { HireMateStore } from "./storage";

const FIT_POLICY = "role-and-skills-v1";

export function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function localIsoDate(timezone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value ?? "2026";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${d}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function fitIsCurrent(post: PostRecord, resume: ResumeRecord): boolean {
  return post.fit_policy === FIT_POLICY && post.fit_resume === resume.version;
}

export function getSavedSearch(store: HireMateStore): SearchSettings {
  const saved = store.read<Partial<SearchSettings>>("settings", "search");
  return normalizeSearchSettings(saved);
}

export function capturePost(
  store: HireMateStore,
  rawPost: RawPostInput,
  sample: boolean,
  scanId?: string,
  todayIso?: string,
): number {
  const post = { ...rawPost };
  const previewText = post.preview_text ?? "";
  delete post.preview_text;

  const searchPreview = isLinkedInSearch(post.url);
  const identity = searchPreview
    ? `linkedin-preview:${post.text.split(/\s+/).join(" ").toLowerCase()}`
    : post.url;
  const uid = hashKey(identity);
  const addresses = extractEmails(post.text).filter(isActionableEmail);
  let recipient = addresses.length > 0 ? addresses[0] : "";
  const postId = linkedinId(post.url);
  let route: PostStatus | null = null;
  let applyLink = "";
  let linkedinAction: PostRecord["linkedin_action"];
  let commentKeyword: string | undefined;

  if (postId && !sample) {
    const routed = instructions(post, todayIso);
    route = routed.route;
    recipient = routed.recipient;
    applyLink = routed.applyLink;
    linkedinAction = routed.linkedinAction;
    commentKeyword = routed.commentKeyword;
  } else if (!sample && isLinkedInUrl(post.url)) {
    route = "Unverified lead";
    recipient = "";
  } else {
    const routed = instructions(post, todayIso);
    if (routed.route === "Needs draft" && routed.recipient) {
      route = "Needs draft";
      recipient = routed.recipient;
      applyLink = routed.applyLink;
    } else if (routed.applyLink) {
      route = "Apply via link";
      recipient = "";
      applyLink = routed.applyLink;
    } else if (routed.route === "Contact on LinkedIn") {
      route = "Contact on LinkedIn";
      recipient = "";
      linkedinAction = routed.linkedinAction;
      commentKeyword = routed.commentKeyword;
    }
  }

  return store.transact((get, put) => {
    const index = postId ? get<{ post: string }>("linkedin_ids", postId) : null;
    let recordId = index ? index.post : uid;
    let previous = get<PostRecord>("posts", recordId);

    if (postId && !previous && previewText) {
      const previewId = hashKey(
        `linkedin-preview:${previewText.split(/\s+/).join(" ").toLowerCase()}`,
      );
      const preview = get<PostRecord>("posts", previewId);
      if (preview && isLinkedInSearch(preview.url)) {
        recordId = previewId;
        previous = preview;
      }
    }

    const scan = scanId ? get<ScanRecord>("scans", scanId) : null;
    const saveMembership = () => {
      if (scan && !(recordId in scan.members)) {
        scan.members[recordId] = previous ? "seen" : "new";
        put("scans", scan.id, scan as unknown as Record<string, unknown>);
      }
    };

    const recoveredLink = Boolean(previous && postId && isLinkedInSearch(previous.url));
    if (
      previous &&
      !recoveredLink &&
      previous.status !== "Outside target roles" &&
      !((previous.route ?? previous.status) === "Unverified lead" && route && route !== "Unverified lead")
    ) {
      if ((previous.route ?? previous.status) === "Unverified lead") {
        const updated: PostRecord = { ...previous };
        if (post.verification_note) {
          updated.verification_note = post.verification_note;
        }
        if (
          post.date_kind === "published" ||
          (post.date_kind === "relative" && previous.date_kind !== "published")
        ) {
          updated.published = post.published;
          updated.date_kind = post.date_kind;
        }
        if (JSON.stringify(updated) !== JSON.stringify(previous)) {
          put("posts", recordId, updated as unknown as Record<string, unknown>);
        }
      }
      saveMembership();
      return 0;
    }

    let status: PostStatus = "Needs draft";
    if (route && route !== "Needs draft") {
      status = route;
    } else if (!recipient) {
      status = addresses.length > 0 ? "Check recipients" : "No email listed";
    } else {
      const seenOwner = get<{ post: string }>("recipients", hashKey(recipient));
      if (seenOwner && seenOwner.post !== recordId) {
        status = "Recipient already seen";
      }
    }

    if (postId) {
      put("linkedin_ids", postId, { post: recordId });
    }

    const exactPublishedAt = linkedinTimestampFromUrl(post.url);
    const record: PostRecord = {
      ...post,
      id: recordId,
      recipient,
      status,
      route: status,
      sample,
      apply_link: applyLink,
      created_at: previous?.created_at ?? new Date().toISOString(),
      ...(exactPublishedAt ? { published_at: exactPublishedAt } : {}),
      ...(linkedinAction ? { linkedin_action: linkedinAction } : {}),
      ...(commentKeyword ? { comment_keyword: commentKeyword } : {}),
    };

    const firstScan = previous?.scan_id ?? scanId;
    if (firstScan) {
      record.scan_id = firstScan;
    }

    if (
      previous &&
      previous.status === "Unverified lead" &&
      previous.fit_reason &&
      previous.text.split(/\s+/).join(" ") === post.text.split(/\s+/).join(" ")
    ) {
      record.fit_reason = previous.fit_reason;
      record.fit_resume = previous.fit_resume;
      record.fit_policy = previous.fit_policy;
    }

    put("posts", recordId, record as unknown as Record<string, unknown>);
    saveMembership();
    return previous ? 0 : 1;
  });
}

export async function assessPost(
  store: HireMateStore,
  config: AppConfig,
  post: PostRecord,
  resume: ResumeRecord,
  onRetry?: (delaySeconds: number) => void,
): Promise<void> {
  const route = post.route ?? post.status;
  let fit: { relevant: boolean; reason: string; model?: string };

  if (post.status === "Needs draft" && fitIsCurrent(post, resume) && post.fit_reason) {
    fit = { relevant: true, reason: post.fit_reason, model: post.fit_model };
  } else {
    fit = await assessResumeFit(config, post, resume, onRetry);
  }

  const pitch =
    fit.relevant && route === "Needs draft"
      ? await draftApplicationPitch(config, post, resume, onRetry)
      : null;

  const socialDrafts =
    fit.relevant && route === "Contact on LinkedIn"
      ? await draftLinkedInOutreach(config, post, resume, onRetry)
      : null;

  store.transact((get, put) => {
    const current = get<PostRecord>("posts", post.id);
    const activeResume = get<ResumeRecord>("settings", "resume");
    if (!current || !activeResume || activeResume.version !== resume.version) {
      return;
    }

    let status: PostStatus = fit.relevant ? route : "Low résumé match";
    if (pitch) {
      const recipientKey = hashKey(current.recipient);
      const owner = get<{ post: string }>("recipients", recipientKey);
      const pref = get<{ required: boolean }>("settings", "approval") ?? {
        required: config.approvalMode,
      };
      if (owner && owner.post !== current.id) {
        status = "Recipient already seen";
      } else {
        put("recipients", recipientKey, { post: current.id });
        status = pref.required ? "Ready for review" : "Queued";
        current.subject = pitch.subject;
        current.message = pitch.body;
        current.resume = resume.version;
        current.filename = resume.name;
        current.preview = config.dryRun;
      }
    }

    if (socialDrafts) {
      current.linkedin_dm_draft = socialDrafts.dm;
      current.linkedin_connect_draft = socialDrafts.connect_note;
      current.linkedin_comment_draft = socialDrafts.comment;
      current.resume = resume.version;
      current.filename = resume.name;
    }

    current.status = status;
    current.route = route;
    current.fit_reason = fit.reason;
    current.fit_resume = resume.version;
    current.fit_policy = FIT_POLICY;
    if (fit.model) {
      current.fit_model = fit.model;
    }
    put("posts", current.id, current as unknown as Record<string, unknown>);
  });
}

const ELIGIBLE_FOR_PREPARE = new Set<PostStatus>([
  "Needs draft",
  "Apply via link",
  "Contact on LinkedIn",
  "No email listed",
  "Check recipients",
  "Check application instructions",
  "Unverified lead",
  "Low résumé match",
]);

const RECONCILABLE_FOR_EMAIL = new Set<PostStatus>([
  "Check application instructions",
  "Check recipients",
  "No email listed",
  "Contact on LinkedIn",
  "Apply via link",
]);

export function reconcileEmailLeads(store: HireMateStore, config: AppConfig): number {
  const today = localIsoDate(config.timezone);
  const allPosts = store.all<PostRecord>("posts");
  let upgraded = 0;

  for (const post of allPosts) {
    if (post.message || !RECONCILABLE_FOR_EMAIL.has(post.status)) continue;
    const routed = instructions(post, today);
    if (routed.route !== "Needs draft" || !routed.recipient) continue;

    const didUpgrade = store.transact((get, put) => {
      const current = get<PostRecord>("posts", post.id);
      if (!current || current.message || !RECONCILABLE_FOR_EMAIL.has(current.status)) {
        return false;
      }
      const owner = get<{ post: string }>("recipients", hashKey(routed.recipient));
      const updated: PostRecord = {
        ...current,
        recipient: routed.recipient,
        route: "Needs draft",
        status: owner && owner.post !== current.id ? "Recipient already seen" : "Needs draft",
        apply_link: current.apply_link || routed.applyLink,
      };
      put("posts", current.id, updated as unknown as Record<string, unknown>);
      return updated.status === "Needs draft";
    });

    if (didUpgrade) upgraded += 1;
  }

  return upgraded;
}

export async function draftEmailForPost(
  store: HireMateStore,
  config: AppConfig,
  uid: string,
): Promise<PostRecord> {
  const post = store.read<PostRecord>("posts", uid);
  if (!post) {
    throw new Error("Lead not found.");
  }
  const resume = store.read<ResumeRecord>("settings", "resume");
  if (!resume) {
    throw new Error("Upload your résumé first so HireMate can draft a tailored email.");
  }

  const today = localIsoDate(config.timezone);
  const routed = instructions(post, today);
  const fallbackEmail = extractEmails(post.text).find(isActionableEmail) ?? "";
  const recipient = (
    (post.recipient && isActionableEmail(post.recipient) ? post.recipient : "") ||
    routed.recipient ||
    fallbackEmail
  ).toLowerCase();

  if (!recipient) {
    throw new Error("No actionable email address was found in this post.");
  }

  let fitReason = post.fit_reason;
  let fitModel = post.fit_model;
  if (!fitIsCurrent(post, resume) || !fitReason) {
    const fit = await assessResumeFit(config, post, resume);
    fitReason = fit.reason;
    fitModel = fit.model;
  }

  const pitch = await draftApplicationPitch(config, post, resume);

  return store.transact((get, put) => {
    const current = get<PostRecord>("posts", uid);
    if (!current) {
      throw new Error("Lead not found.");
    }
    const updated: PostRecord = {
      ...current,
      recipient,
      route: "Needs draft",
      status: "Ready for review",
      subject: pitch.subject,
      message: pitch.body,
      resume: resume.version,
      filename: resume.name,
      preview: config.dryRun,
      fit_reason: fitReason,
      fit_resume: resume.version,
      fit_policy: FIT_POLICY,
      ...(fitModel ? { fit_model: fitModel } : {}),
      apply_link: current.apply_link || routed.applyLink,
    };
    put("recipients", hashKey(recipient), { post: current.id });
    put("posts", current.id, updated as unknown as Record<string, unknown>);
    return updated;
  });
}

export async function prepareMatches(
  store: HireMateStore,
  config: AppConfig,
  onMatchProgress?: (completed: number, total: number, delaySeconds?: number) => void,
): Promise<void> {
  reconcileEmailLeads(store, config);

  const resume = store.read<ResumeRecord>("settings", "resume");
  if (!resume) return;

  const search = getSavedSearch(store);
  const allPosts = store.all<PostRecord>("posts");
  const candidates = allPosts.filter(
    (post) =>
      ELIGIBLE_FOR_PREPARE.has(post.status) &&
      (!fitIsCurrent(post, resume) ||
        post.status === "Needs draft" ||
        (post.status === "Contact on LinkedIn" && !post.linkedin_dm_draft)) &&
      ((post.status === "Needs draft" && Boolean(post.recipient)) || matchesSearch(search, post)),
  );

  if (onMatchProgress) {
    onMatchProgress(0, candidates.length, 0);
    for (let i = 0; i < candidates.length; i++) {
      const post = candidates[i];
      await assessPost(store, config, post, resume, (delay) => {
        onMatchProgress(i, candidates.length, delay);
      });
      onMatchProgress(i + 1, candidates.length, 0);
    }
    return;
  }

  if (candidates.length === 0) return;

  const workers = Math.min(candidates.length, config.geminiWorkers);
  let nextIdx = 0;
  const runWorker = async () => {
    while (nextIdx < candidates.length) {
      const post = candidates[nextIdx++];
      await assessPost(store, config, post, resume);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
}

export async function fetchFeedPosts(config: AppConfig): Promise<{
  posts: RawPostInput[];
  sample: boolean;
}> {
  if (!config.feedUrl) {
    return { posts: SAMPLE_POSTS, sample: true };
  }
  if (!isSafeFeedUrl(config.feedUrl)) {
    throw new Error("Feed URL must be a public HTTPS endpoint.");
  }

  const headers: Record<string, string> = {
    "User-Agent": "HireMate/1.0",
    Accept: "application/json",
  };
  if (config.feedAuthHeader) {
    headers.Authorization = config.feedAuthHeader;
  }

  const response = await fetch(config.feedUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Feed request failed with HTTP ${response.status}.`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2_000_000) {
    throw new Error("Feed response exceeds the 2 MB limit.");
  }

  const parsed = JSON.parse(text);
  return { posts: validateIncomingPosts(parsed), sample: false };
}

export async function collectResults(
  store: HireMateStore,
  config: AppConfig,
  posts: RawPostInput[],
  search: SearchSettings,
  sample: boolean,
  onMatchProgress?: (completed: number, total: number, delaySeconds?: number) => void,
  scanId?: string,
): Promise<number> {
  const id = scanId || crypto.randomUUID();
  store.transact((get, put) => {
    if (!get("scans", id)) {
      put("scans", id, {
        id,
        checked: posts.length,
        members: {},
        created_at: new Date().toISOString(),
      });
      put("settings", "latest_scan", { id });
    }
  });

  const today = localIsoDate(config.timezone);
  let added = 0;
  for (const post of posts) {
    if (matchesSearch(search, post)) {
      added += capturePost(store, post, sample, id, today);
    }
  }

  await prepareMatches(store, config, onMatchProgress);
  return added;
}

export async function collectFromConfiguredSource(
  store: HireMateStore,
  config: AppConfig,
): Promise<number> {
  const search = getSavedSearch(store);
  const { posts, sample } = await fetchFeedPosts(config);
  return collectResults(store, config, posts, search, sample);
}

export function claimManualScan(store: HireMateStore, config: AppConfig): number {
  return store.transact((get, put) => {
    const previous = get<{ started: number }>("settings", "manual_scan");
    const now = Date.now() / 1000;
    if (previous && !config.dryRun) {
      const remaining = Math.ceil(previous.started + config.scanCooldownMinutes * 60 - now);
      if (remaining > 0) return remaining;
    }
    put("settings", "manual_scan", { started: now });
    return 0;
  });
}

export function reviewDraft(
  store: HireMateStore,
  uid: string,
  subject: string,
  message: string,
  action: "save" | "approve" | "skip",
): PostRecord {
  const nextStatusMap: Record<"save" | "approve" | "skip", PostStatus> = {
    save: "Ready for review",
    approve: "Queued",
    skip: "Skipped",
  };
  return store.transact((get, put) => {
    const post = get<PostRecord>("posts", uid);
    if (!post || post.status !== "Ready for review") {
      throw new Error("This draft is no longer awaiting review.");
    }
    const updated: PostRecord = {
      ...post,
      subject: subject.replace(/[\r\n]+/g, " ").trim(),
      message: message.trim(),
      status: nextStatusMap[action],
    };
    put("posts", uid, updated as unknown as Record<string, unknown>);
    return updated;
  });
}

export function updateDeliveryStatus(
  store: HireMateStore,
  config: AppConfig,
  uid: string,
  action: "mark_sent" | "requeue",
): PostRecord {
  const today = localIsoDate(config.timezone);
  return store.transact((get, put) => {
    const post = get<PostRecord>("posts", uid);
    if (!post || post.status !== "Check delivery") {
      throw new Error("Only leads awaiting delivery verification can be updated here.");
    }
    const updated: PostRecord =
      action === "mark_sent"
        ? { ...post, status: "Sent", sent_day: today }
        : { ...post, status: "Queued" };
    put("posts", uid, updated as unknown as Record<string, unknown>);
    return updated;
  });
}

export function dispatchQueue(store: HireMateStore, config: AppConfig, immediate = false): number {
  const queued = store
    .all<PostRecord>("posts")
    .filter((p) => p.status === "Queued")
    .sort((a, b) => (a.published || "").localeCompare(b.published || ""));

  let processed = 0;
  for (const post of queued) {
    const simulated = config.dryRun || post.sample || (post.preview ?? true);
    const now = Date.now() / 1000;
    const day = localIsoDate(config.timezone);

    const claimResult = store.transact((get, put) => {
      const clock = get<{ used?: number; day?: string; next?: number }>("settings", "delivery") ?? {};
      const used = clock.day === day ? (clock.used ?? 0) : 0;
      if (used >= config.dailyCap || (!immediate && now < (clock.next ?? 0))) {
        return "blocked";
      }
      const item = get<PostRecord>("posts", post.id);
      if (!item || item.status !== "Queued") {
        return "skip";
      }
      const nextDelay = simulated ? 10 : Math.floor(120 + Math.random() * 240);
      put("settings", "delivery", {
        used: used + 1,
        day,
        next: now + nextDelay,
      });
      item.status = simulated ? "Simulated" : "Check delivery";
      item.sent_day = day;
      put("posts", item.id, item as unknown as Record<string, unknown>);
      return "claimed";
    });

    if (claimResult === "blocked") break;
    if (claimResult === "claimed") processed += 1;
  }

  return processed;
}

export function updateManualOutreach(
  store: HireMateStore,
  config: AppConfig,
  uid: string,
  payload: {
    action: "save" | "mark_applied" | "skip" | "reopen";
    dm?: string;
    connect_note?: string;
    comment?: string;
  },
): PostRecord {
  return store.transact((get, put) => {
    const post = get<PostRecord>("posts", uid);
    if (!post) {
      throw new Error("Lead not found.");
    }

    const updated: PostRecord = { ...post };
    if (typeof payload.dm === "string") {
      updated.linkedin_dm_draft = payload.dm.trim().slice(0, 2000);
    }
    if (typeof payload.connect_note === "string") {
      updated.linkedin_connect_draft = payload.connect_note.trim().slice(0, 300);
    }
    if (typeof payload.comment === "string") {
      updated.linkedin_comment_draft = payload.comment.trim().slice(0, 1000);
    }

    if (payload.action === "save") {
      if (post.status !== "Contact on LinkedIn") {
        throw new Error("Only Contact on LinkedIn leads support saving outreach drafts.");
      }
    } else if (payload.action === "mark_applied") {
      if (post.status !== "Contact on LinkedIn" && post.status !== "Apply via link") {
        throw new Error("This lead cannot be marked as applied from its current status.");
      }
      updated.status = "Applied";
      updated.sent_day = localIsoDate(config.timezone);
    } else if (payload.action === "skip") {
      if (post.status !== "Contact on LinkedIn" && post.status !== "Apply via link") {
        throw new Error("This lead cannot be skipped from its current status.");
      }
      updated.status = "Skipped";
    } else if (payload.action === "reopen") {
      if (post.status !== "Applied" && post.status !== "Skipped") {
        throw new Error("Only applied or skipped leads can be reopened.");
      }
      updated.status =
        post.route === "Contact on LinkedIn" || post.route === "Apply via link"
          ? post.route
          : post.apply_link
            ? "Apply via link"
            : "Contact on LinkedIn";
      delete updated.sent_day;
    }

    put("posts", uid, updated as unknown as Record<string, unknown>);
    return updated;
  });
}

