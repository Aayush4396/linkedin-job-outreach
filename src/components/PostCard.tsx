import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Mail,
  Paperclip,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { resumeDownloadUrl } from "../lib/api";
import {
  buildMailtoHref,
  extractEmails,
  formatPostTimestamp,
  isActionableEmail,
  isDraftFromOlderResume,
  isSafeHttpUrl,
  missingDetails,
} from "../lib/postDiscovery";
import type { LinkedInActionType, PostRecord, PostStatus, ResumeRecord } from "../lib/types";

export interface OutreachActionPayload {
  action: "save" | "mark_applied" | "skip" | "reopen";
  dm?: string;
  connect_note?: string;
  comment?: string;
}

interface PostCardProps {
  post: PostRecord;
  activeResume: ResumeRecord | null;
  hideSharedMissingNote: boolean;
  onDraftAction: (
    postId: string,
    subject: string,
    message: string,
    action: "save" | "approve" | "skip",
  ) => Promise<void>;
  onDeliveryAction: (postId: string, action: "mark_sent" | "requeue") => Promise<void>;
  onOutreachAction: (postId: string, payload: OutreachActionPayload) => Promise<void>;
  onGenerateEmailDraft: (postId: string) => Promise<void>;
  onDownloadEml: (postId: string, subject: string, message: string) => Promise<void>;
}

const DEFAULT_DM_NOTE =
  "Hi, I saw your hiring post and I’m very interested in the role. My background aligns well with what you’re looking for—would you be open to connecting so I can share my résumé?";

const DEFAULT_CONNECT_NOTE =
  "Hi, I saw your hiring post and would love to connect regarding the opening. Happy to share my résumé if it looks like a fit.";

function defaultCommentNote(keyword?: string): string {
  const prefix = keyword?.trim() ? `${keyword.trim()} — ` : "";
  return `${prefix}Interested in this role! My experience aligns well with the opening and I’d love to connect.`;
}

function actionLabel(action?: LinkedInActionType, keyword?: string): string {
  if (action === "comment") {
    return keyword ? `Comment on post (keyword: "${keyword}")` : "Comment on post";
  }
  if (action === "connect") {
    return "Connect with a note";
  }
  return "Send LinkedIn DM";
}

function statusTone(status: PostStatus): string {
  switch (status) {
    case "Ready for review":
      return "text-[#423499] font-semibold";
    case "Sent":
    case "Applied":
    case "Simulated":
    case "Queued":
      return "text-emerald-700 font-semibold";
    case "Check delivery":
    case "Unverified lead":
    case "Check application instructions":
    case "Check recipients":
      return "text-amber-700 font-semibold";
    default:
      return "text-slate-600 font-medium";
  }
}

function statusExplanation(status: PostStatus, hasResume: boolean): string | null {
  switch (status) {
    case "Outside target roles":
      return "Skipped under your saved search criteria.";
    case "Outside discovery window":
      return "Publication date falls outside the 14-day discovery window.";
    case "No email listed":
      return "No email address, application link, or LinkedIn DM/comment instruction was found in this post.";
    case "Recipient already seen":
      return "HireMate already prepared outreach for this email address.";
    case "Check application instructions":
      return "An email appears in the post, but the exact application instruction is ambiguous.";
    case "Check recipients":
      return "Multiple email addresses appear in the post; verify the intended recipient.";
    case "Needs draft":
      return hasResume
        ? "Waiting for résumé matching and draft generation."
        : "Upload your résumé to evaluate fit and prepare an email draft.";
    case "Check delivery":
      return "Delivery was claimed but not confirmed. Check your Sent folder before marking sent or re-queuing.";
    default:
      return null;
  }
}

export function PostCard({
  post,
  activeResume,
  hideSharedMissingNote,
  onDraftAction,
  onDeliveryAction,
  onOutreachAction,
  onGenerateEmailDraft,
  onDownloadEml,
}: PostCardProps) {
  const hasResume = Boolean(activeResume);
  const [subject, setSubject] = useState(post.subject ?? "");
  const [message, setMessage] = useState(post.message ?? "");

  const [channel, setChannel] = useState<LinkedInActionType>(post.linkedin_action ?? "dm");
  const [dmDraft, setDmDraft] = useState(post.linkedin_dm_draft || DEFAULT_DM_NOTE);
  const [connectDraft, setConnectDraft] = useState(
    post.linkedin_connect_draft || DEFAULT_CONNECT_NOTE,
  );
  const [commentDraft, setCommentDraft] = useState(
    post.linkedin_comment_draft || defaultCommentNote(post.comment_keyword),
  );

  const [copied, setCopied] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setSubject(post.subject ?? "");
    setMessage(post.message ?? "");
  }, [post.subject, post.message]);

  useEffect(() => {
    setChannel(post.linkedin_action ?? "dm");
    setDmDraft(post.linkedin_dm_draft || DEFAULT_DM_NOTE);
    setConnectDraft(post.linkedin_connect_draft || DEFAULT_CONNECT_NOTE);
    setCommentDraft(post.linkedin_comment_draft || defaultCommentNote(post.comment_keyword));
  }, [
    post.id,
    post.linkedin_action,
    post.comment_keyword,
    post.linkedin_dm_draft,
    post.linkedin_connect_draft,
    post.linkedin_comment_draft,
  ]);

  const timestamp = formatPostTimestamp(post);

  const explanation = statusExplanation(post.status, hasResume);
  const missing = post.status === "Unverified lead" ? missingDetails(post) : "";
  const isLongPost = post.text.length > 420;
  const visibleText = isLongPost && !expanded ? `${post.text.slice(0, 420).trimEnd()}…` : post.text;
  const safePostUrl = !post.sample && isSafeHttpUrl(post.url) ? post.url : null;
  const safeApplyUrl = post.apply_link && isSafeHttpUrl(post.apply_link) ? post.apply_link : null;
  const asksForLinkedIn =
    post.status === "Ready for review" && /\blinkedin\s+(?:profile|url)\b/i.test(post.text);

  const activeLinkedInText =
    channel === "dm" ? dmDraft : channel === "connect" ? connectDraft : commentDraft;
  const connectOverLimit = channel === "connect" && connectDraft.length > 300;
  const canReopen =
    post.status === "Applied" ||
    (post.status === "Skipped" &&
      (post.route === "Contact on LinkedIn" || post.route === "Apply via link"));
  const detectedEmail =
    (post.recipient && isActionableEmail(post.recipient) ? post.recipient : "") ||
    extractEmails(post.text).find(isActionableEmail) ||
    "";
  const activeEmailSubject = post.status === "Ready for review" ? subject : (post.subject ?? "");
  const activeEmailBody = post.status === "Ready for review" ? message : (post.message ?? "");
  const mailtoHref =
    post.message && detectedEmail
      ? buildMailtoHref(detectedEmail, activeEmailSubject, activeEmailBody)
      : null;
  const draftFromOlderResume = isDraftFromOlderResume(post, activeResume);
  const attachedFilename = post.filename || activeResume?.name || "";
  const attachedVersion = post.resume || activeResume?.version || "";
  const attachmentDownloadHref = attachedVersion ? resumeDownloadUrl(attachedVersion) : null;

  function updateActiveLinkedInText(nextValue: string) {
    if (channel === "dm") setDmDraft(nextValue);
    else if (channel === "connect") setConnectDraft(nextValue);
    else setCommentDraft(nextValue);
  }

  async function handleDraftSubmit(action: "save" | "approve" | "skip") {
    setBusyAction(action);
    try {
      await onDraftAction(post.id, subject, message, action);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDelivery(action: "mark_sent" | "requeue") {
    setBusyAction(action);
    try {
      await onDeliveryAction(post.id, action);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleOutreach(action: OutreachActionPayload["action"]) {
    setBusyAction(action);
    try {
      await onOutreachAction(post.id, {
        action,
        ...(post.status === "Contact on LinkedIn"
          ? {
              dm: dmDraft,
              connect_note: connectDraft.slice(0, 300),
              comment: commentDraft,
            }
          : {}),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function copyActiveDraft() {
    try {
      await navigator.clipboard.writeText(activeLinkedInText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  async function copyEmailDraft() {
    try {
      const formatted = `To: ${detectedEmail}\nSubject: ${activeEmailSubject}\n\n${activeEmailBody}`;
      await navigator.clipboard.writeText(formatted);
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 1800);
    } catch {
      setEmailCopied(false);
    }
  }

  async function handleGenerateEmail() {
    setBusyAction("draft_email");
    try {
      await onGenerateEmailDraft(post.id);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDownloadEml() {
    setBusyAction("download_eml");
    try {
      await onDownloadEml(post.id, activeEmailSubject, activeEmailBody);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <article className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
      {/* Unboxed metadata line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className={statusTone(post.status)}>{post.status}</span>
        <span aria-hidden="true">·</span>
        <time
          dateTime={timestamp.title}
          title={timestamp.title}
          className="font-mono-tabular text-slate-600"
        >
          {timestamp.label}
        </time>
        {timestamp.relative && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular text-slate-500">{timestamp.relative}</span>
          </>
        )}
        {post.sample && (
          <>
            <span aria-hidden="true">·</span>
            <span>Sample lead</span>
          </>
        )}
        {post.status === "Contact on LinkedIn" && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-slate-700 font-medium">
              {actionLabel(post.linkedin_action, post.comment_keyword)}
            </span>
          </>
        )}
        {post.recipient && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular text-slate-700">{post.recipient}</span>
          </>
        )}
      </div>

      {/* Primary title */}
      <h2 className="font-display text-base font-semibold text-slate-900 leading-snug">
        {post.title}
      </h2>

      {/* Post body */}
      <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
        {visibleText}
        {isLongPost && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="ml-2 text-xs font-medium text-[#423499] hover:underline cursor-pointer"
          >
            {expanded ? "Show less" : "Show full post"}
          </button>
        )}
      </div>

      {/* Fit reason / verification / routing notes */}
      {(post.fit_reason || post.verification_note || explanation) && (
        <div className="pt-2 border-t border-slate-100 space-y-1 text-xs text-slate-600">
          {post.fit_reason && (
            <p>
              <span className="font-medium text-slate-800">Fit assessment:</span> {post.fit_reason}
            </p>
          )}
          {post.verification_note && (
            <p>
              <span className="font-medium text-slate-800">Verification:</span>{" "}
              {post.verification_note}
            </p>
          )}
          {explanation && <p>{explanation}</p>}
          {post.status === "Unverified lead" && post.preview_has_email === false && !safeApplyUrl && (
            <p>No email address is visible in this preview.</p>
          )}
          {post.status === "Unverified lead" && post.preview_has_email && (
            <p>
              An email address is visible. HireMate needs the original post to confirm application
              instructions.
            </p>
          )}
          {missing && !hideSharedMissingNote && (
            <p>To verify the original post, HireMate still needs {missing}.</p>
          )}
        </div>
      )}

      {/* External links */}
      {(safePostUrl || safeApplyUrl) && (
        <div className="flex flex-wrap items-center gap-4 pt-1 text-xs font-medium">
          {safePostUrl && (
            <a
              href={safePostUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#423499] hover:underline"
            >
              <span>
                {safePostUrl.startsWith("https://www.linkedin.com/search/results/content/")
                  ? "View LinkedIn search"
                  : "Original post"}
              </span>
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
          {safeApplyUrl && (
            <a
              href={safeApplyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#423499] hover:underline"
            >
              <span>
                {post.status === "Unverified lead"
                  ? "Open application link from preview"
                  : "Open application"}
              </span>
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      {/* Assisted Apply: Connect / Comment / DM on LinkedIn */}
      {post.status === "Contact on LinkedIn" && (
        <div className="pt-3 border-t border-slate-100 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label="LinkedIn outreach channel"
              className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              {(
                [
                  ["dm", "DM"],
                  ["connect", "Connect note"],
                  ["comment", "Comment"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={channel === id}
                  onClick={() => setChannel(id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    channel === id
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {label}
                  {post.linkedin_action === id ? " · Requested" : ""}
                </button>
              ))}
            </div>

            {channel === "connect" && (
              <span
                className={`text-xs font-mono-tabular ${
                  connectOverLimit ? "text-red-700 font-semibold" : "text-slate-500"
                }`}
              >
                {connectDraft.length} / 300 chars
              </span>
            )}
          </div>

          <label className="block text-xs font-medium text-slate-700">
            <span>
              {channel === "dm"
                ? "Tailored LinkedIn DM"
                : channel === "connect"
                  ? "Tailored connection request note (300-char LinkedIn limit)"
                  : "Tailored public comment"}
            </span>
            <textarea
              value={activeLinkedInText}
              onChange={(e) => updateActiveLinkedInText(e.target.value)}
              maxLength={channel === "connect" ? 300 : channel === "comment" ? 1000 : 2000}
              rows={channel === "dm" ? 4 : 3}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 leading-relaxed"
            />
          </label>

          {channel === "comment" && (
            <p className="text-xs text-slate-500">
              Public comment — keep personal email addresses and phone numbers out of public
              replies.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {safePostUrl ? (
              <a
                href={safePostUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => void copyActiveDraft()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{copied ? "Copied — opening post" : "Copy & open post"}</span>
              </a>
            ) : (
              <button
                type="button"
                onClick={copyActiveDraft}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors cursor-pointer whitespace-nowrap"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy message</span>
                  </>
                )}
              </button>
            )}

            {safePostUrl && (
              <button
                type="button"
                onClick={copyActiveDraft}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy only</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              disabled={busyAction !== null || connectOverLimit}
              onClick={() => handleOutreach("save")}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {busyAction === "save" ? "Saving…" : "Save draft"}
            </button>

            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => handleOutreach("mark_applied")}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{busyAction === "mark_applied" ? "Saving…" : "Mark as applied"}</span>
            </button>

            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => handleOutreach("skip")}
              className="px-3 py-2 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {busyAction === "skip" ? "Skipping…" : "Skip"}
            </button>
          </div>
        </div>
      )}

      {/* Apply via link completion controls */}
      {post.status === "Apply via link" && (
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          {safeApplyUrl && (
            <a
              href={safeApplyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors whitespace-nowrap"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Open application</span>
            </a>
          )}
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleOutreach("mark_applied")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{busyAction === "mark_applied" ? "Saving…" : "Mark as applied"}</span>
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleOutreach("skip")}
            className="px-3 py-2 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {busyAction === "skip" ? "Skipping…" : "Skip"}
          </button>
        </div>
      )}

      {/* Reopen applied/skipped LinkedIn or link lead */}
      {canReopen && (
        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {post.status === "Applied"
              ? `Marked applied${post.sent_day ? ` on ${post.sent_day}` : ""}.`
              : "Lead skipped."}
          </span>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleOutreach("reopen")}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#423499] hover:underline disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            <span>{busyAction === "reopen" ? "Reopening…" : "Reopen lead"}</span>
          </button>
        </div>
      )}

      {/* Check delivery recovery controls */}
      {post.status === "Check delivery" && (
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleDelivery("mark_sent")}
            className="px-3.5 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {busyAction === "mark_sent" ? "Updating…" : "Mark as sent"}
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleDelivery("requeue")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{busyAction === "requeue" ? "Re-queuing…" : "Re-queue draft"}</span>
          </button>
        </div>
      )}

      {/* On-demand email drafting when an email address is found in the post without a draft yet */}
      {!post.message && detectedEmail && (
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            Email found:{" "}
            <strong className="font-mono-tabular text-slate-900">{detectedEmail}</strong>
            {!hasResume && (
              <span className="ml-1.5 text-slate-500">· Upload your résumé to draft an email.</span>
            )}
          </div>
          {hasResume && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleGenerateEmail}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{busyAction === "draft_email" ? "Drafting email…" : "Draft email"}</span>
            </button>
          )}
        </div>
      )}

      {/* Draft review / read-only summary */}
      {post.message && (
        <div className="pt-3 border-t border-slate-100 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>
              To:{" "}
              <strong className="font-mono-tabular text-slate-900">
                {detectedEmail || post.recipient}
              </strong>
            </span>
            {attachedFilename && attachmentDownloadHref ? (
              <a
                href={attachmentDownloadHref}
                download={attachedFilename}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 transition-colors"
                title="Download attached résumé file"
              >
                <Paperclip className="w-3.5 h-3.5 text-[#423499] shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[240px]">{attachedFilename}</span>
                <Download className="w-3 h-3 text-slate-500 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <span className="text-amber-700">No résumé attached — upload one in My résumé</span>
            )}
          </div>

          {draftFromOlderResume && activeResume && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Drafted from an earlier résumé ({post.filename ?? "previous file"}). Your manual edits
              were preserved—click <strong>Redraft</strong> to regenerate using {activeResume.name}.
            </p>
          )}

          {asksForLinkedIn && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Check that your email includes your LinkedIn profile URL and any other details
              requested in the post.
            </p>
          )}

          {post.status === "Ready for review" ? (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-700">
                Subject
                <input
                  type="text"
                  value={subject}
                  maxLength={200}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Email draft
                <textarea
                  value={message}
                  maxLength={6000}
                  rows={8}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 leading-relaxed"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => handleDraftSubmit("approve")}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {busyAction === "approve" ? "Approving…" : "Approve and queue"}
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null || !detectedEmail}
                  onClick={handleDownloadEml}
                  title="Download a ready-to-send .eml draft with your résumé attached"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Paperclip className="w-3.5 h-3.5 text-[#423499]" aria-hidden="true" />
                  <span>
                    {busyAction === "download_eml"
                      ? "Preparing .eml…"
                      : attachedFilename
                        ? "Download .eml (with résumé)"
                        : "Download .eml"}
                  </span>
                </button>
                {mailtoHref && (
                  <a
                    href={mailtoHref}
                    title="Opens your default email app with subject and body (attach résumé manually, or use Download .eml for automatic attachment)"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open in email app</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={copyEmailDraft}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {emailCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                      <span>Copied email</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Copy email</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => handleDraftSubmit("save")}
                  className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {busyAction === "save" ? "Saving…" : "Save edits"}
                </button>
                {hasResume && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleGenerateEmail}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    <span>{busyAction === "draft_email" ? "Redrafting…" : "Redraft"}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => handleDraftSubmit("skip")}
                  className="px-3 py-2 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {busyAction === "skip" ? "Skipping…" : "Skip"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-xs text-slate-600">
              <div className="space-y-1">
                <p className="font-medium text-slate-900">{post.subject}</p>
                <p className="whitespace-pre-wrap text-slate-600">{post.message}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {detectedEmail && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleDownloadEml}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    <Paperclip className="w-3.5 h-3.5 text-[#423499]" aria-hidden="true" />
                    <span>
                      {busyAction === "download_eml"
                        ? "Preparing .eml…"
                        : attachedFilename
                          ? "Download .eml (with résumé)"
                          : "Download .eml"}
                    </span>
                  </button>
                )}
                {mailtoHref && (
                  <a
                    href={mailtoHref}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open in email app</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={copyEmailDraft}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                >
                  {emailCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                      <span>Copied email</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Copy email</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
