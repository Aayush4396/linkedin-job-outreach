import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import JSZip from "jszip";
import { z } from "zod";
import {
  applicationLink,
  buildSearchUrl,
  extractEmails,
  isLinkedInSearch,
  linkedinId,
  linkedinTimestampFromUrl,
  matchesSearch,
  normalizeSearchSettings,
  validateIncomingPosts,
} from "./src/lib/postDiscovery";
import type { DashboardPayload, PostRecord, ResumeRecord, ScanRecord } from "./src/lib/types";
import { loadConfig } from "./server/config";
import {
  buildEmlDraft,
  buildEmlFilename,
  mimeTypeForFilename,
  sanitizeAttachmentFilename,
} from "./server/emlBuilder";
import { parseAndSaveResume } from "./server/resumeParser";
import { HireMateStore } from "./server/storage";
import {
  assessPost,
  capturePost,
  claimManualScan,
  collectFromConfiguredSource,
  collectResults,
  dispatchQueue,
  draftEmailForPost,
  fitIsCurrent,
  getSavedSearch,
  localIsoDate,
  normalizeExistingEmailDrafts,
  prepareMatches,
  reconcileEmailLeads,
  reviewDraft,
  updateDeliveryStatus,
  updateManualOutreach,
} from "./server/workflow";

const config = loadConfig();
const store = new HireMateStore(config.dataDir);

const browserProgress = new Map<
  string,
  { completed: number; total: number; retryDeadline: number }
>();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkPinAuth(req: Request): boolean {
  if (!config.dashboardPin) return true;
  const auth = req.headers.authorization ?? "";
  const expectedBasic =
    "Basic " + Buffer.from(`hiremate:${config.dashboardPin}`, "utf8").toString("base64");
  const expectedBearer = `Bearer ${config.dashboardPin}`;
  return safeCompareSecret(auth, expectedBasic) || safeCompareSecret(auth, expectedBearer);
}

const editDraftSchema = z.object({
  subject: z
    .string()
    .min(1, "Subject cannot be empty.")
    .max(200, "Subject is too long.")
    .refine((v) => !/[\r\n]/.test(v), "Subject must be a single line."),
  message: z.string().min(1, "Email body cannot be empty.").max(6000, "Email body is too long."),
  action: z.enum(["save", "approve", "skip"]),
});

const emlDraftSchema = z.object({
  subject: z
    .string()
    .max(200, "Subject is too long.")
    .refine((v) => !/[\r\n]/.test(v), "Subject must be a single line.")
    .optional(),
  message: z.string().max(6000, "Email body is too long.").optional(),
});

const approvalSchema = z.object({
  required: z.boolean(),
});

const searchSchema = z.object({
  roles: z.string().max(240).optional().default(""),
  locations: z.string().max(240).optional().default(""),
  workplace: z.enum(["Any", "Remote", "Hybrid", "Onsite"]).optional().default("Any"),
  employment: z.enum(["Any", "Contract", "Full-time"]).optional().default("Any"),
});

const manualPostSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Enter a valid HTTPS post URL.")
    .refine((u) => u.startsWith("https://"), "Post URL must start with https://"),
  title: z.string().trim().min(2, "Enter a role title or headline.").max(300),
  published: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format for the publication date."),
  text: z.string().trim().min(15, "Paste the full hiring post text.").max(30000),
});

const deliveryActionSchema = z.object({
  action: z.enum(["mark_sent", "requeue"]),
});

const manualOutreachSchema = z.object({
  action: z.enum(["save", "mark_applied", "skip", "reopen"]),
  dm: z.string().max(2000).optional(),
  connect_note: z.string().max(300, "LinkedIn connection notes must be 300 characters or fewer.").optional(),
  comment: z.string().max(1000).optional(),
});

const browserPostSchema = z.object({
  url: z.string().max(2048),
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(30000),
  published: z.string().max(40),
  date_kind: z.enum(["published", "relative", "observed", "unknown"]),
  content_kind: z.enum(["full", "snippet"]),
  verification_note: z.string().max(240).optional().default(""),
  preview_text: z.string().max(30000).optional().default(""),
});

async function createApp() {
  const app = express();
  app.set("trust proxy", true);

  // Top-level payload parsing middleware MUST mount before route definitions.
  app.use((req, res, next) => {
    if (req.path === "/api/resume") {
      return next();
    }
    return express.json({ limit: "2mb" })(req, res, next);
  });

  // Security headers & CSRF/auth middleware for API routes.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (config.workerOnly) {
      if (
        (req.path !== "/scheduled-scan" && req.path !== "/dispatch") ||
        req.method !== "POST"
      ) {
        res.status(404).json({ detail: "Not found." });
        return;
      }
      next();
      return;
    }

    if (req.path === "/scheduled-scan" || req.path === "/dispatch") {
      res.status(404).json({ detail: "Not found." });
      return;
    }

    if (!checkPinAuth(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="HireMate"');
      res.status(401).json({ detail: "Dashboard PIN required." });
      return;
    }

    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (isMutation) {
      if (req.headers["x-hiremate"] !== "1") {
        res.status(403).json({ detail: "Missing X-HireMate request header." });
        return;
      }
      const originHeader = req.headers.origin;
      if (typeof originHeader === "string" && originHeader.trim()) {
        const expectedHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
          .split(",")[0]
          .trim()
          .toLowerCase();
        try {
          const originHost = new URL(originHeader).host.toLowerCase();
          if (expectedHost && originHost !== expectedHost) {
            res.status(403).json({ detail: "Cross-origin requests are not allowed." });
            return;
          }
        } catch {
          res.status(403).json({ detail: "Invalid Origin header." });
          return;
        }
      }
    }

    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, dry: config.dryRun, ai_configured: Boolean(config.geminiApiKey) });
  });

  app.get("/api/posts", (_req, res) => {
    const rows = store
      .all<PostRecord>("posts")
      .map((row) => {
        const enriched: PostRecord = { ...row };
        if (!enriched.published_at) {
          const decoded = linkedinTimestampFromUrl(enriched.url);
          if (decoded) {
            enriched.published_at = decoded;
          }
        }
        if (enriched.status === "Unverified lead") {
          enriched.apply_link = applicationLink(enriched.text);
          enriched.preview_has_email = extractEmails(enriched.text).length > 0;
        }
        return enriched;
      })
      .sort((a, b) =>
        (b.published_at || b.published || b.created_at || "").localeCompare(
          a.published_at || a.published || a.created_at || "",
        ),
      );

    const today = localIsoDate(config.timezone);
    const sentToday = rows.filter((p) => p.sent_day === today).length;
    const latestSetting = store.read<{ id: string }>("settings", "latest_scan");
    const latestScan = latestSetting ? store.read<ScanRecord>("scans", latestSetting.id) : null;
    const approvalPref = store.read<{ required: boolean }>("settings", "approval");
    const resume = store.read<ResumeRecord>("settings", "resume");
    const savedSearch = getSavedSearch(store);

    const source = config.feedUrl
      ? "Connected feed"
      : rows.some((p) => !p.sample)
        ? "LinkedIn & manual posts"
        : "Sample posts";

    const payload: DashboardPayload = {
      latest_scan: latestScan,
      search: savedSearch,
      search_url: buildSearchUrl(savedSearch, config.linkedinQuery),
      sent_today: sentToday,
      daily_cap: config.dailyCap,
      rotate: false,
      connection: "Chrome extension",
      source,
      ai_configured: Boolean(config.geminiApiKey),
      posts: rows,
      resume,
      dry: config.dryRun,
      approval: approvalPref ? approvalPref.required : config.approvalMode,
      auth_required: Boolean(config.dashboardPin),
    };

    res.json(payload);
  });

  app.get("/api/extension/download", async (_req, res) => {
    try {
      const browserDir = path.resolve(process.cwd(), "browser");
      const files = ["manifest.json", "dashboard.js", "worker.js"];
      const zip = new JSZip();
      const folder = zip.folder("hiremate-extension");
      for (const file of files) {
        const fullPath = path.resolve(browserDir, file);
        if (!fullPath.startsWith(browserDir + path.sep) || !fs.existsSync(fullPath)) {
          res.status(404).json({ detail: "Extension files are missing on the server." });
          return;
        }
        folder?.file(file, fs.readFileSync(fullPath));
      }
      const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="hiremate-chrome-extension.zip"');
      res.send(archive);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not package the Chrome extension.";
      res.status(500).json({ detail: message });
    }
  });

  app.post("/api/scan", async (_req, res) => {
    const retryAfter = claimManualScan(store, config);
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ detail: `Please try again in ${retryAfter} seconds.` });
      return;
    }
    try {
      const added = await collectFromConfiguredSource(store, config);
      res.json({ new: added });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not finish checking posts. Check your feed and search settings.";
      res.status(502).json({ detail: message });
    }
  });

  app.post("/api/posts/manual", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = manualPostSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid post details." });
      return;
    }

    try {
      const search = getSavedSearch(store);
      const post = {
        ...parsed.data,
        date_kind: "published" as const,
        content_kind: "full" as const,
      };
      const added = capturePost(store, post, false, undefined, localIsoDate(config.timezone));
      const matchedSearch = matchesSearch(search, post);
      await prepareMatches(store, config);
      res.status(201).json({
        ok: true,
        new: added,
        matched_search: matchedSearch,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save or assess this post.";
      res.status(502).json({ detail: message });
    }
  });

  app.post(
    "/api/resume",
    express.raw({ type: "*/*", limit: "8mb" }),
    async (req: Request, res: Response) => {
      const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (rawBuffer.byteLength === 0) {
        res.status(400).json({ detail: "Choose a résumé file before uploading." });
        return;
      }
      if (rawBuffer.byteLength > 8_000_000) {
        res.status(413).json({ detail: "Choose a file smaller than 8 MB." });
        return;
      }

      const rawHeader = String(req.headers["x-filename"] ?? "resume.txt");
      let decodedName = "resume.txt";
      try {
        decodedName = decodeURIComponent(rawHeader);
      } catch {
        decodedName = rawHeader;
      }

      let resume: ResumeRecord;
      try {
        resume = await parseAndSaveResume(store, decodedName, rawBuffer);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not read this résumé file.";
        res.status(422).json({ detail: message });
        return;
      }

      try {
        await prepareMatches(store, config);
      } catch (error) {
        const message =
          error instanceof Error
            ? `Résumé saved, but matching failed: ${error.message}`
            : "Résumé saved. Drafting failed. Retry the scan shortly.";
        res.status(502).json({ detail: message, name: resume.name });
        return;
      }

      res.json({ name: resume.name });
    },
  );

  app.get("/api/resume/download", (req, res) => {
    const activeResume = store.read<ResumeRecord>("settings", "resume");
    const requestedVersion =
      typeof req.query.version === "string" ? req.query.version.trim() : "";

    let versionToRead = activeResume?.version ?? "";
    let downloadName = activeResume?.name ?? "resume.pdf";

    if (requestedVersion) {
      if (!/^[a-f0-9]{64}\.(?:pdf|docx|txt)$/i.test(requestedVersion)) {
        res.status(400).json({ detail: "Invalid résumé identifier." });
        return;
      }
      if (activeResume && activeResume.version === requestedVersion) {
        versionToRead = activeResume.version;
        downloadName = activeResume.name;
      } else {
        const matchingPost = store
          .all<PostRecord>("posts")
          .find((p) => p.resume === requestedVersion);
        if (!matchingPost) {
          res.status(404).json({ detail: "Requested résumé file was not found." });
          return;
        }
        versionToRead = requestedVersion;
        downloadName = matchingPost.filename || activeResume?.name || "resume.pdf";
      }
    }

    if (!versionToRead) {
      res.status(404).json({ detail: "No résumé has been uploaded yet." });
      return;
    }

    const bytes = store.readResumeBytes(versionToRead);
    if (!bytes) {
      res.status(404).json({ detail: "Résumé file is no longer available on disk." });
      return;
    }

    const safeFilename = sanitizeAttachmentFilename(downloadName);
    res.setHeader("Content-Type", mimeTypeForFilename(safeFilename));
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.send(bytes);
  });

  app.post("/api/posts/:uid", (req, res) => {
    const uid = String(req.params.uid ?? "");
    if (!/^[a-f0-9]{64}$/i.test(uid)) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = editDraftSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid draft update." });
      return;
    }

    try {
      const updated = reviewDraft(
        store,
        uid,
        parsed.data.subject,
        parsed.data.message,
        parsed.data.action,
      );
      res.json({ ok: true, status: updated.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update draft.";
      res.status(409).json({ detail: message });
    }
  });

  app.post("/api/posts/:uid/delivery", (req, res) => {
    const uid = String(req.params.uid ?? "");
    if (!/^[a-f0-9]{64}$/i.test(uid)) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = deliveryActionSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: "Invalid delivery action." });
      return;
    }

    try {
      const updated = updateDeliveryStatus(store, config, uid, parsed.data.action);
      res.json({ ok: true, status: updated.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update delivery status.";
      res.status(409).json({ detail: message });
    }
  });

  app.post("/api/posts/:uid/outreach", (req, res) => {
    const uid = String(req.params.uid ?? "");
    if (!/^[a-f0-9]{64}$/i.test(uid)) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = manualOutreachSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid outreach update." });
      return;
    }

    try {
      const updated = updateManualOutreach(store, config, uid, parsed.data);
      res.json({ ok: true, status: updated.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update outreach status.";
      res.status(409).json({ detail: message });
    }
  });

  app.post("/api/posts/:uid/draft", async (req, res) => {
    const uid = String(req.params.uid ?? "");
    if (!/^[a-f0-9]{64}$/i.test(uid)) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    try {
      const updated = await draftEmailForPost(store, config, uid);
      res.json({
        ok: true,
        status: updated.status,
        recipient: updated.recipient,
        subject: updated.subject ?? "",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not draft email for this lead.";
      const isUserInput =
        /not found|upload your résumé|no actionable email/i.test(message);
      const isQuota = /\b429\b|RESOURCE_EXHAUSTED/i.test(message);
      res.status(isUserInput ? 422 : isQuota ? 429 : 502).json({ detail: message });
    }
  });

  app.post("/api/posts/:uid/eml", (req, res) => {
    const uid = String(req.params.uid ?? "");
    if (!/^[a-f0-9]{64}$/i.test(uid)) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = emlDraftSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid email draft." });
      return;
    }

    const post = store.read<PostRecord>("posts", uid);
    if (!post) {
      res.status(404).json({ detail: "Lead not found." });
      return;
    }

    const subject = (parsed.data.subject ?? post.subject ?? "").trim();
    const message = (parsed.data.message ?? post.message ?? "").trim();
    if (!message) {
      res.status(422).json({ detail: "Draft an email before downloading the .eml file." });
      return;
    }

    const recipient = (post.recipient || extractEmails(post.text)[0] || "").trim();
    const activeResume = store.read<ResumeRecord>("settings", "resume");

    let attachment: { filename: string; bytes: Buffer } | null = null;
    if (post.resume) {
      const postResumeBytes = store.readResumeBytes(post.resume);
      if (postResumeBytes) {
        attachment = {
          filename: post.filename || activeResume?.name || "resume.pdf",
          bytes: postResumeBytes,
        };
      }
    }
    if (!attachment && activeResume) {
      const activeBytes = store.readResumeBytes(activeResume.version);
      if (activeBytes) {
        attachment = {
          filename: activeResume.name,
          bytes: activeBytes,
        };
      }
    }

    try {
      const emlBytes = buildEmlDraft({
        to: recipient,
        subject: subject || `Application for ${post.title}`,
        body: message,
        attachment,
      });
      const emlFilename = buildEmlFilename(subject || post.title, recipient);
      res.setHeader("Content-Type", "message/rfc822");
      res.setHeader("Content-Disposition", `attachment; filename="${emlFilename}"`);
      res.send(emlBytes);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Could not generate .eml draft file.";
      res.status(422).json({ detail });
    }
  });

  app.post("/api/dispatch-now", (_req, res) => {
    const processed = dispatchQueue(store, config, true);
    res.json({ processed });
  });

  app.post("/api/preferences/approval", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = approvalSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: "Expected boolean approval preference." });
      return;
    }
    store.transact((_get, put) => {
      put("settings", "approval", { required: parsed.data.required });
    });
    res.json({ required: parsed.data.required });
  });

  app.post("/api/preferences/search", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ detail: parsed.error.issues[0]?.message ?? "Invalid search fields." });
      return;
    }
    const normalized = normalizeSearchSettings(parsed.data);
    store.transact((_get, put) => {
      put("settings", "search", normalized as unknown as Record<string, unknown>);
    });
    res.json({ url: buildSearchUrl(normalized, config.linkedinQuery) });
  });

  // Chrome extension progress polling endpoint (exact contract preserved).
  app.get("/api/browser-progress/:scanId", (req, res) => {
    const scanId = String(req.params.scanId ?? "");
    if (!UUID_REGEX.test(scanId)) {
      res.status(400).json({ detail: "Invalid scan ID." });
      return;
    }
    const state = browserProgress.get(scanId);
    if (!state) {
      res.json({});
      return;
    }
    const status: { completed: number; total: number; retry_in?: number } = {
      completed: state.completed,
      total: state.total,
    };
    if (state.retryDeadline > 0) {
      status.retry_in = Math.max(0, Math.ceil((state.retryDeadline - Date.now()) / 1000));
    }
    res.json(status);
  });

  // Chrome extension results import endpoint (exact contract preserved + hosted HTTPS support).
  app.post("/api/browser-results", async (req, res) => {
    if (!config.dryRun && !config.dashboardPin) {
      res
        .status(403)
        .json({ detail: "Browser import requires practice mode or a configured dashboard PIN." });
      return;
    }

    const rawList = Array.isArray(req.body) ? req.body : null;
    if (!rawList) {
      res.status(422).json({ detail: "Expected a list of LinkedIn posts or search previews." });
      return;
    }

    const parsedList = z.array(browserPostSchema).max(30).safeParse(rawList);
    if (!parsedList.success) {
      res.status(422).json({ detail: "Expected up to 30 valid LinkedIn posts or search previews." });
      return;
    }

    const posts = parsedList.data;
    const invalidPost = posts.some(
      (p) => !linkedinId(p.url) && !(p.content_kind === "snippet" && isLinkedInSearch(p.url)),
    );
    if (invalidPost) {
      res.status(422).json({ detail: "Expected LinkedIn posts or search previews." });
      return;
    }

    const scanToken = String(req.headers["x-hiremate-scan"] ?? "").trim();
    const scanId = scanToken ? (UUID_REGEX.test(scanToken) ? scanToken : null) : undefined;
    if (scanToken && !scanId) {
      res.status(422).json({ detail: "Invalid scan header." });
      return;
    }

    let rows;
    try {
      rows = validateIncomingPosts(posts);
    } catch {
      res
        .status(422)
        .json({ detail: "Some post details could not be read. Run the search again." });
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      if (posts[i].verification_note) {
        rows[i].verification_note = posts[i].verification_note;
      }
      if (posts[i].preview_text && linkedinId(posts[i].url)) {
        rows[i].preview_text = posts[i].preview_text;
      }
    }

    const reportProgress = (completed: number, total: number, delay = 0) => {
      if (scanId) {
        browserProgress.set(scanId, {
          completed,
          total,
          retryDeadline: delay > 0 ? Date.now() + delay * 1000 : 0,
        });
      }
    };

    try {
      const recheckTarget = String(req.headers["x-hiremate-recheck"] ?? "").trim();
      if (recheckTarget) {
        const saved = store.read<PostRecord>("posts", recheckTarget);
        if (rows.length !== 1 || !saved || saved.status !== "Unverified lead") {
          res.status(409).json({ detail: "This lead has changed. Refresh the dashboard." });
          return;
        }
        let row = rows[0];
        if (isLinkedInSearch(saved.url)) {
          if (
            (row.url !== saved.url || row.text !== saved.text) &&
            row.preview_text !== saved.text
          ) {
            res
              .status(422)
              .json({ detail: "The result could not be tied to the saved preview." });
            return;
          }
        } else if (linkedinId(saved.url) !== linkedinId(row.url)) {
          res.status(422).json({ detail: "LinkedIn returned a different post." });
          return;
        }
        if (!matchesSearch(getSavedSearch(store), row)) {
          row = {
            ...saved,
            verification_note: "The original no longer matches your saved search.",
          };
        }
        capturePost(store, row, false, undefined, localIsoDate(config.timezone));
        const current = store.read<PostRecord>("posts", recheckTarget);
        const resume = store.read<ResumeRecord>("settings", "resume");
        if (
          current &&
          resume &&
          [
            "Needs draft",
            "Unverified lead",
            "Apply via link",
            "Check application instructions",
            "No email listed",
            "Contact on LinkedIn",
            "Check recipients",
          ].includes(current.status) &&
          (current.status === "Needs draft" || !fitIsCurrent(current, resume))
        ) {
          reportProgress(0, 1, 0);
          await assessPost(store, config, current, resume, (delay) => reportProgress(0, 1, delay));
          reportProgress(1, 1, 0);
        }
        const finalRecord = store.read<PostRecord>("posts", recheckTarget);
        res.json({
          checked: 1,
          new: 0,
          status: finalRecord?.status ?? saved.status,
        });
        return;
      }

      const added = await collectResults(
        store,
        config,
        rows,
        getSavedSearch(store),
        false,
        reportProgress,
        scanId ?? undefined,
      );
      res.json({ new: added, checked: rows.length });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "HireMate could not finish saving or matching these posts.";
      const isQuota = /\b429\b|RESOURCE_EXHAUSTED/i.test(message);
      res.status(isQuota ? 429 : 502).json({
        detail: isQuota
          ? "Résumé matching paused because the AI service is busy or its quota was reached. Saved posts are available below. Try again later to resume matching."
          : message,
      });
    } finally {
      if (scanId) {
        browserProgress.delete(scanId);
      }
    }
  });

  // Seed initial sample scan once on fresh startup (mirrors original lifespan).
  if (store.all<PostRecord>("posts").length === 0) {
    try {
      await collectFromConfiguredSource(store, config);
    } catch (error) {
      console.warn("Initial scan skipped:", error instanceof Error ? error.message : error);
    }
  }

  // Background queue dispatcher when not using external Cloud Scheduler.
  if (!config.externalScheduler) {
    const dispatchInterval = setInterval(() => {
      try {
        dispatchQueue(store, config, false);
      } catch (error) {
        console.error("Background dispatch failed:", error);
      }
    }, 30_000);
    dispatchInterval.unref();
  }

  // Serve Vite dev middleware in development or static dist/ in production.
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  // Upgrade any already-saved posts containing an actionable email into Needs draft,
  // and ensure unedited Ready for review drafts include Hello <Name> and Regards, <User>.
  const upgradedEmailLeads = reconcileEmailLeads(store, config);
  normalizeExistingEmailDrafts(store);

  app.listen(config.port, config.host, () => {
    console.log(`HireMate server listening on http://${config.host}:${config.port}`);
    const hasResume = Boolean(store.read<ResumeRecord>("settings", "resume"));
    const hasPendingEmailDrafts = store
      .all<PostRecord>("posts")
      .some((p) => p.status === "Needs draft" && Boolean(p.recipient));
    if (hasResume && (upgradedEmailLeads > 0 || hasPendingEmailDrafts)) {
      prepareMatches(store, config).catch((error) => {
        console.warn(
          "Startup email drafting skipped:",
          error instanceof Error ? error.message : error,
        );
      });
    }
  });
}

createApp().catch((error) => {
  console.error("Failed to start HireMate server:", error);
  process.exit(1);
});
