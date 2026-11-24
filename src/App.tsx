import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Globe,
  Menu,
  RefreshCw,
  Search as SearchIcon,
  Send,
} from "lucide-react";
import {
  dispatchQueuedNow,
  fetchDashboard,
  generateEmailDraft,
  runServerScan,
  saveApprovalPreference,
  saveSearchPreferences,
  submitManualPost,
  updateDelivery,
  updateDraft,
  updateOutreach,
  uploadResumeFile,
} from "./lib/api";
import { missingDetails, PRIORITY_STATUSES, statusRank } from "./lib/postDiscovery";
import type {
  DashboardPayload,
  EmploymentChoice,
  PostRecord,
  SearchSettings,
  WorkplaceChoice,
} from "./lib/types";
import { ExtensionPanel } from "./components/ExtensionPanel";
import { ManualPostPanel } from "./components/ManualPostPanel";
import { PostCard, type OutreachActionPayload } from "./components/PostCard";
import { ResumePanel } from "./components/ResumePanel";
import { Sidebar, type WorkspaceSection } from "./components/Sidebar";
import { SearchPanel } from "./components/SearchPanel";

type QueueFilter = "priority" | "review" | "apply" | "sent" | "other" | "all";

interface FailedAction {
  message: string;
  retry?: () => Promise<void>;
}

const SECTION_LABELS: Record<WorkspaceSection, string> = {
  queue: "Outreach queue",
  search: "Saved search",
  paste: "Paste hiring post",
  resume: "My résumé",
  extension: "Chrome extension",
};

export default function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<WorkspaceSection>("queue");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("priority");
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [notice, setNotice] = useState("");
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);

  const [extensionReady, setExtensionReady] = useState(
    () => document.documentElement.dataset.hiremateBrowser === "ready",
  );
  const [browserBusy, setBrowserBusy] = useState(false);
  const [quickSearch, setQuickSearch] = useState<SearchSettings>({
    roles: "",
    locations: "",
    workplace: "Any",
    employment: "Any",
  });
  const retryingRef = useRef(false);
  const extensionStartTimerRef = useRef<number | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const payload = await fetchDashboard();
      setData(payload);
      setQuickSearch(payload.search);
      setFailedAction(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load outreach dashboard.";
      setFailedAction({ message, retry: loadDashboard });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // Chrome extension DOM event bridge (exact contract with browser/dashboard.js).
  useEffect(() => {
    const syncExtensionAttr = () => {
      if (document.documentElement.dataset.hiremateBrowser === "ready") {
        setExtensionReady(true);
      }
    };
    syncExtensionAttr();

    const observer = new MutationObserver(syncExtensionAttr);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-hiremate-browser"],
    });

    const onResults = () => {
      loadDashboard().catch((error) => {
        setNotice(error instanceof Error ? error.message : "Could not refresh results.");
      });
    };
    const onStarted = () => {
      if (extensionStartTimerRef.current !== null) {
        window.clearTimeout(extensionStartTimerRef.current);
        extensionStartTimerRef.current = null;
      }
      setBrowserBusy(true);
    };
    const onFinished = () => {
      if (extensionStartTimerRef.current !== null) {
        window.clearTimeout(extensionStartTimerRef.current);
        extensionStartTimerRef.current = null;
      }
      setBrowserBusy(retryingRef.current);
    };

    document.addEventListener("hiremate-results", onResults);
    document.addEventListener("hiremate-started", onStarted);
    document.addEventListener("hiremate-finished", onFinished);

    return () => {
      observer.disconnect();
      document.removeEventListener("hiremate-results", onResults);
      document.removeEventListener("hiremate-started", onStarted);
      document.removeEventListener("hiremate-finished", onFinished);
    };
  }, [loadDashboard]);

  const handleServerScan = useCallback(async () => {
    setScanning(true);
    setFailedAction(null);
    try {
      const result = await runServerScan();
      await loadDashboard();
      setNotice(
        result.new === 1 ? "Scan complete · 1 new post found." : `Scan complete · ${result.new} new posts found.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check for posts.";
      setFailedAction({ message, retry: handleServerScan });
    } finally {
      setScanning(false);
    }
  }, [loadDashboard]);

  const handleSaveSearch = useCallback(
    async (next: SearchSettings) => {
      setFailedAction(null);
      try {
        await saveSearchPreferences(next);
        await loadDashboard();
        setNotice("Search settings saved.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save search settings.";
        setFailedAction({ message, retry: () => handleSaveSearch(next) });
      }
    },
    [loadDashboard],
  );

  const handleBrowserSearch = useCallback(
    async (overrideSearch?: SearchSettings) => {
      setFailedAction(null);
      if (document.documentElement.dataset.hiremateBrowser !== "ready") {
        setNotice(
          `This tab cannot see the HireMate extension. Open ${window.location.origin}/ in the desktop Chrome profile with HireMate installed.`,
        );
        return;
      }
      if (document.documentElement.dataset.hiremateProgress !== "1") {
        setNotice("Reload the HireMate extension in Chrome, then refresh this page.");
        return;
      }

      setBrowserBusy(true);
      setNotice("Saving your search…");
      try {
        const targetSearch = overrideSearch ?? data?.search ?? {
          roles: "",
          locations: "",
          workplace: "Any",
          employment: "Any",
        };
        const saved = await saveSearchPreferences(targetSearch);
        setNotice("Connecting to the browser…");
        extensionStartTimerRef.current = window.setTimeout(() => {
          setNotice("The extension did not respond. Refresh HireMate and try again.");
          setBrowserBusy(false);
        }, 3000);
        document.dispatchEvent(new CustomEvent("hiremate-search", { detail: saved.url }));
      } catch (error) {
        setBrowserBusy(false);
        const message =
          error instanceof Error ? error.message : "Could not start browser search.";
        setFailedAction({ message, retry: () => handleBrowserSearch(overrideSearch) });
      }
    },
    [data?.search],
  );

  const unverifiedPosts = useMemo(
    () => (data?.posts ?? []).filter((p) => p.status === "Unverified lead"),
    [data?.posts],
  );

  const handleRecheckUnverified = useCallback(async () => {
    setFailedAction(null);
    if (document.documentElement.dataset.hiremateRecheck !== "5") {
      setNotice("Reload the HireMate extension in Chrome, then refresh this page.");
      return;
    }
    if (unverifiedPosts.length === 0) return;

    retryingRef.current = true;
    setBrowserBusy(true);
    const started = Date.now();
    const previewIds = new Set(
      unverifiedPosts
        .filter((p) => p.url.startsWith("https://www.linkedin.com/search/"))
        .map((p) => p.id),
    );
    let checked = 0;
    let interrupted = 0;
    let timedOut = 0;
    let nextIdx = 0;
    let pauseReason = "";

    try {
      const checkNext = async () => {
        while (!pauseReason && nextIdx < unverifiedPosts.length) {
          const index = nextIdx++;
          const post = unverifiedPosts[index];
          const finished = new Promise<{
            id?: string;
            success?: boolean;
            timedOut?: boolean;
            pause?: string;
          }>((resolve) => {
            const onFinished = (event: Event) => {
              const detail = (event as CustomEvent).detail;
              if (detail?.id !== post.id) return;
              document.removeEventListener("hiremate-finished", onFinished);
              resolve(detail);
            };
            document.addEventListener("hiremate-finished", onFinished);
          });

          const { id, url, title, text, published, date_kind, content_kind } = post;
          document.dispatchEvent(
            new CustomEvent("hiremate-search", {
              detail: {
                target: { id, url, title, text, published, date_kind, content_kind },
                position: `Lead ${index + 1} of ${unverifiedPosts.length}`,
              },
            }),
          );
          const result = await finished;
          if (result?.timedOut) timedOut++;
          if (result?.pause) pauseReason = result.pause;
          if (result?.success) checked++;
          else interrupted++;
        }
      };

      await Promise.all([checkNext(), checkNext()]);
      const latest = await fetchDashboard();
      setData(latest);

      const attempted = new Set(unverifiedPosts.map((p) => p.id));
      const stillUnverified = latest.posts.filter(
        (p) => attempted.has(p.id) && p.status === "Unverified lead",
      ).length;
      const recovered = latest.posts.filter(
        (p) => previewIds.has(p.id) && !p.url.startsWith("https://www.linkedin.com/search/"),
      ).length;
      const elapsedSec = Math.round((Date.now() - started) / 1000);

      setNotice(
        `${checked} of ${unverifiedPosts.length} retry results saved in ${elapsedSec}s. ` +
          `${recovered} original links found. ${stillUnverified} leads still unverified.` +
          (timedOut ? ` ${timedOut} browser lookup(s) timed out.` : "") +
          (interrupted ? ` ${interrupted} retry result(s) could not be saved.` : "") +
          (pauseReason ? ` ${pauseReason}` : ""),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recheck failed.";
      setFailedAction({ message, retry: handleRecheckUnverified });
    } finally {
      retryingRef.current = false;
      setBrowserBusy(false);
    }
  }, [unverifiedPosts]);

  const handleToggleApproval = useCallback(
    async (required: boolean) => {
      setApprovalSaving(true);
      setFailedAction(null);
      try {
        await saveApprovalPreference(required);
        await loadDashboard();
        setNotice(
          required
            ? "New drafts will wait for your approval."
            : "New matching drafts will queue automatically.",
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not update approval preference.";
        setFailedAction({ message, retry: () => handleToggleApproval(required) });
      } finally {
        setApprovalSaving(false);
      }
    },
    [loadDashboard],
  );

  const handleUploadResume = useCallback(
    async (file: File) => {
      setFailedAction(null);
      try {
        const result = await uploadResumeFile(file);
        await loadDashboard();
        setNotice(`Résumé saved (${result.name}) and matched against your posts.`);
        setActiveSection("queue");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not upload or match résumé.";
        await loadDashboard();
        setFailedAction({ message, retry: () => handleUploadResume(file) });
      }
    },
    [loadDashboard],
  );

  const handleDraftAction = useCallback(
    async (
      postId: string,
      subject: string,
      message: string,
      action: "save" | "approve" | "skip",
    ) => {
      setFailedAction(null);
      try {
        await updateDraft(postId, { subject, message, action });
        await loadDashboard();
        setNotice(
          action === "approve"
            ? "Draft approved and queued."
            : action === "skip"
              ? "Draft skipped."
              : "Draft edits saved.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not save draft changes.";
        setFailedAction({
          message: msg,
          retry: () => handleDraftAction(postId, subject, message, action),
        });
      }
    },
    [loadDashboard],
  );

  const handleDeliveryAction = useCallback(
    async (postId: string, action: "mark_sent" | "requeue") => {
      setFailedAction(null);
      try {
        await updateDelivery(postId, action);
        await loadDashboard();
        setNotice(action === "mark_sent" ? "Lead marked as sent." : "Lead returned to queue.");
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not update delivery status.";
        setFailedAction({
          message: msg,
          retry: () => handleDeliveryAction(postId, action),
        });
      }
    },
    [loadDashboard],
  );

  const handleOutreachAction = useCallback(
    async (postId: string, payload: OutreachActionPayload) => {
      setFailedAction(null);
      try {
        await updateOutreach(postId, payload);
        await loadDashboard();
        setNotice(
          payload.action === "mark_applied"
            ? "Lead marked as applied."
            : payload.action === "skip"
              ? "Lead skipped."
              : payload.action === "reopen"
                ? "Lead reopened in your outreach queue."
                : "LinkedIn outreach draft saved.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not update outreach lead.";
        setFailedAction({
          message: msg,
          retry: () => handleOutreachAction(postId, payload),
        });
      }
    },
    [loadDashboard],
  );

  const handleGenerateEmailDraft = useCallback(
    async (postId: string) => {
      setFailedAction(null);
      try {
        const result = await generateEmailDraft(postId);
        await loadDashboard();
        setNotice(`Email draft ready for ${result.recipient}.`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not draft email for this lead.";
        setFailedAction({
          message: msg,
          retry: () => handleGenerateEmailDraft(postId),
        });
      }
    },
    [loadDashboard],
  );

  const handleDispatchNow = useCallback(async () => {
    setDispatching(true);
    setFailedAction(null);
    try {
      const result = await dispatchQueuedNow();
      await loadDashboard();
      setNotice(
        result.processed === 1
          ? "Processed 1 queued draft."
          : `Processed ${result.processed} queued drafts.`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Could not process queued drafts.";
      setFailedAction({ message: msg, retry: handleDispatchNow });
    } finally {
      setDispatching(false);
    }
  }, [loadDashboard]);

  const handleFetchWithFilters = useCallback(
    async (filters: SearchSettings) => {
      setFailedAction(null);
      const cleaned: SearchSettings = {
        roles: filters.roles.trim(),
        locations: filters.locations.trim(),
        workplace: filters.workplace,
        employment: filters.employment,
      };
      if (extensionReady) {
        await handleBrowserSearch(cleaned);
        return;
      }
      // Save filters first so they are ready as soon as the Chrome extension is connected.
      try {
        await saveSearchPreferences(cleaned);
        await loadDashboard();
        setActiveSection("extension");
        setNotice("Search filters saved. Connect the Chrome extension in a top-level Chrome tab to fetch live LinkedIn posts.");
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not save search filters.";
        setFailedAction({ message: msg, retry: () => handleFetchWithFilters(cleaned) });
      }
    },
    [extensionReady, handleBrowserSearch, loadDashboard],
  );

  const handleManualPost = useCallback(
    async (payload: { url: string; title: string; published: string; text: string }) => {
      setFailedAction(null);
      try {
        const result = await submitManualPost(payload);
        await loadDashboard();
        setNotice(
          result.new > 0
            ? "Hiring post imported and assessed."
            : "Existing post updated and assessed.",
        );
        setActiveSection("queue");
        setQueueFilter("all");
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Could not import hiring post.";
        setFailedAction({
          message: msg,
          retry: async () => {
            await handleManualPost(payload);
          },
        });
        return false;
      }
    },
    [loadDashboard],
  );

  const posts = useMemo(() => data?.posts ?? [], [data?.posts]);

  const counts = useMemo(() => {
    const priority = posts.filter((p) => PRIORITY_STATUSES.includes(p.status)).length;
    const review = posts.filter((p) => p.status === "Ready for review").length;
    const apply = posts.filter(
      (p) => p.status === "Apply via link" || p.status === "Contact on LinkedIn",
    ).length;
    const sent = posts.filter(
      (p) =>
        p.status === "Sent" ||
        p.status === "Applied" ||
        p.status === "Simulated" ||
        p.status === "Queued",
    ).length;
    const other = posts.filter((p) => !PRIORITY_STATUSES.includes(p.status)).length;
    const queued = posts.filter((p) => p.status === "Queued").length;
    return { priority, review, apply, sent, other, queued, all: posts.length };
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = posts.filter((post) => {
      if (queueFilter === "priority" && !PRIORITY_STATUSES.includes(post.status)) return false;
      if (queueFilter === "review" && post.status !== "Ready for review") return false;
      if (
        queueFilter === "apply" &&
        post.status !== "Apply via link" &&
        post.status !== "Contact on LinkedIn"
      ) {
        return false;
      }
      if (
        queueFilter === "sent" &&
        post.status !== "Sent" &&
        post.status !== "Applied" &&
        post.status !== "Simulated" &&
        post.status !== "Queued"
      ) {
        return false;
      }
      if (queueFilter === "other" && PRIORITY_STATUSES.includes(post.status)) return false;

      if (!q) return true;
      return (
        post.title.toLowerCase().includes(q) ||
        post.text.toLowerCase().includes(q) ||
        post.status.toLowerCase().includes(q) ||
        post.recipient.toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  }, [posts, queueFilter, searchQuery]);

  const sharedUnverifiedMissing = useMemo(() => {
    if (unverifiedPosts.length <= 1) return "";
    const first = missingDetails(unverifiedPosts[0]);
    if (!first) return "";
    return unverifiedPosts.every((p) => missingDetails(p) === first) ? first : "";
  }, [unverifiedPosts]);

  const latestScanSummary = useMemo(() => {
    if (!data?.latest_scan) return null;
    const added = posts.filter((p) => data.latest_scan?.members[p.id] === "new");
    const statusMap = new Map<string, number>();
    for (const post of added) {
      statusMap.set(post.status, (statusMap.get(post.status) ?? 0) + 1);
    }
    const breakdown = [...statusMap.entries()]
      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
      .join(" · ");
    return {
      summary: `${data.latest_scan.checked} checked · ${added.length} new${breakdown ? ` · ${breakdown}` : ""}`,
      id: data.latest_scan.id,
    };
  }, [data?.latest_scan, posts]);

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-[#0F172A]">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        data={data}
        extensionReady={extensionReady}
        onToggleApproval={handleToggleApproval}
        approvalSaving={approvalSaving}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Top Bar Contract: Breadcrumb on left, 1 primary action on right */}
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline">HireMate</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-base font-semibold text-slate-900 truncate">
                {SECTION_LABELS[activeSection]}
              </h1>
            </div>
          </div>

          <button
            id="scan"
            type="button"
            disabled={scanning || browserBusy}
            onClick={() => {
              if (extensionReady) {
                void handleFetchWithFilters(quickSearch);
              } else {
                void handleServerScan();
              }
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${scanning || browserBusy ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>
              {scanning || browserBusy
                ? "Fetching…"
                : extensionReady
                  ? "Fetch LinkedIn posts"
                  : "Check for posts"}
            </span>
          </button>
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-6xl w-full mx-auto space-y-6">
          {/* Persistent status live region (used by both React and Chrome extension dashboard.js) */}
          <div className={notice || browserBusy ? "bg-white border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-2" : "sr-only"}>
            <p
              id="notice"
              role="status"
              className="text-xs text-slate-700 whitespace-pre-wrap break-words"
            >
              {notice}
            </p>
            <small id="scanClock" className="text-xs font-mono-tabular text-slate-500" />
          </div>

          {/* Explicit error escalation banner with Retry Save */}
          {failedAction && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 text-xs text-red-900">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-700 mt-0.5" aria-hidden="true" />
                <span>{failedAction.message}</span>
              </div>
              <div className="flex items-center gap-2">
                {failedAction.retry && (
                  <button
                    type="button"
                    onClick={() => failedAction.retry?.()}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-700 text-white hover:bg-red-800 cursor-pointer whitespace-nowrap"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFailedAction(null)}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md text-red-800 hover:bg-red-100 cursor-pointer whitespace-nowrap"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {activeSection === "queue" && (
            <div className="space-y-5">
              {/* Inline LinkedIn Search Filter & Direct Fetch Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleFetchWithFilters(quickSearch);
                }}
                className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 text-slate-600">
                    <span className="font-semibold text-slate-900">LinkedIn search filters</span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={
                        extensionReady
                          ? "text-emerald-700 font-medium"
                          : "text-amber-700 font-medium"
                      }
                    >
                      {extensionReady
                        ? "Chrome extension connected"
                        : "Chrome extension not detected"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSection("extension")}
                    className="text-xs font-medium text-[#423499] hover:underline cursor-pointer whitespace-nowrap"
                  >
                    {extensionReady ? "Extension settings" : "Install Chrome extension"}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_144px_126px_auto] gap-2.5">
                  <input
                    type="text"
                    aria-label="Roles or skills"
                    maxLength={240}
                    value={quickSearch.roles}
                    onChange={(e) => setQuickSearch((prev) => ({ ...prev, roles: e.target.value }))}
                    placeholder="Roles or skills (e.g. Software Engineer, ML)"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 min-w-0"
                  />
                  <input
                    type="text"
                    aria-label="Locations"
                    maxLength={240}
                    value={quickSearch.locations}
                    onChange={(e) =>
                      setQuickSearch((prev) => ({ ...prev, locations: e.target.value }))
                    }
                    placeholder="Locations (e.g. Bengaluru, London)"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 min-w-0"
                  />
                  <select
                    aria-label="Work arrangement"
                    value={quickSearch.workplace}
                    onChange={(e) =>
                      setQuickSearch((prev) => ({
                        ...prev,
                        workplace: e.target.value as WorkplaceChoice,
                      }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900"
                  >
                    <option value="Any">Any workplace</option>
                    <option value="Remote">Remote</option>
                    <option value="Hybrid">Hybrid</option>
                    <option value="Onsite">Onsite</option>
                  </select>
                  <select
                    aria-label="Employment type"
                    value={quickSearch.employment}
                    onChange={(e) =>
                      setQuickSearch((prev) => ({
                        ...prev,
                        employment: e.target.value as EmploymentChoice,
                      }))
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900"
                  >
                    <option value="Any">Any type</option>
                    <option value="Full-time">Full-time</option>
                    <option value="Contract">Contract</option>
                  </select>
                  <button
                    type="submit"
                    disabled={scanning || browserBusy}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Globe className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {scanning || browserBusy
                        ? "Fetching…"
                        : extensionReady
                          ? "Fetch posts"
                          : "Save & setup extension"}
                    </span>
                  </button>
                </div>
              </form>

              {/* Quiet overview bar */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-4 border-b border-slate-200">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span className="font-medium text-slate-900">
                    {data?.source ?? "Sample posts"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{counts.all} checked</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{counts.review} ready to review</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{data?.sent_today ?? 0} sent today</span>
                  {latestScanSummary && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-500">Latest scan: {latestScanSummary.summary}</span>
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {counts.queued > 0 && (
                    <button
                      type="button"
                      disabled={dispatching}
                      onClick={handleDispatchNow}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {dispatching
                          ? "Processing…"
                          : data?.dry
                            ? `Simulate send (${counts.queued})`
                            : `Dispatch queue (${counts.queued})`}
                      </span>
                    </button>
                  )}
                  {unverifiedPosts.length > 0 && (
                    <button
                      id="recheck"
                      type="button"
                      disabled={browserBusy}
                      onClick={handleRecheckUnverified}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      Check saved leads again ({unverifiedPosts.length})
                    </button>
                  )}
                </div>
              </div>

              {/* Filter toolbar */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div
                  role="tablist"
                  aria-label="Filter leads by status"
                  className="inline-flex flex-nowrap overflow-x-auto max-w-full items-center gap-1 p-1 bg-slate-100 rounded-lg"
                >
                  {(
                    [
                      ["priority", `Actionable (${counts.priority})`],
                      ["review", `Ready for review (${counts.review})`],
                      ["apply", `Link / DM (${counts.apply})`],
                      ["sent", `Queued & applied (${counts.sent})`],
                      ["other", `Other (${counts.other})`],
                      ["all", `All (${counts.all})`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={queueFilter === id}
                      onClick={() => setQueueFilter(id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                        queueFilter === id
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full md:w-64">
                  <SearchIcon
                    className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter leads…"
                    aria-label="Filter leads by keyword"
                    className="w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 py-1.5 text-sm text-slate-900"
                  />
                </div>
              </div>

              {!data?.resume && !loading && (
                <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="font-display text-sm font-semibold text-slate-900">
                      Add your résumé to start drafting
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-600">
                      Upload a Word (.docx), PDF, or text (.txt) résumé so HireMate can evaluate
                      role fit and prepare editable outreach drafts for the leads below.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveSection("resume")}
                    className="px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Upload résumé
                  </button>
                </div>
              )}

              {sharedUnverifiedMissing && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
                  HireMate read {unverifiedPosts.length} previews. To verify the original posts it
                  still needs {sharedUnverifiedMissing}.
                </p>
              )}

              {/* Loading skeleton / Populated list / Empty state */}
              {loading ? (
                <div className="space-y-4" aria-busy="true">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 animate-pulse"
                    >
                      <div className="h-3 w-40 bg-slate-200 rounded" />
                      <div className="h-4 w-72 bg-slate-200 rounded" />
                      <div className="h-12 w-full bg-slate-100 rounded" />
                    </div>
                  ))}
                </div>
              ) : filteredPosts.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    No matching leads in this view
                  </h2>
                  <p className="text-sm text-slate-600 max-w-md mx-auto">
                    {posts.length === 0
                      ? "Run a scan or paste a LinkedIn hiring post to populate your outreach queue."
                      : "Try another status filter, clear your search keyword, or paste a new hiring post."}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    {queueFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => {
                          setQueueFilter("all");
                          setSearchQuery("");
                        }}
                        className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer"
                      >
                        Show all leads
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveSection("paste")}
                      className="px-3.5 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] cursor-pointer"
                    >
                      Paste a hiring post
                    </button>
                  </div>
                </div>
              ) : (
                <section id="list" className="space-y-4">
                  {filteredPosts.map((post: PostRecord) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      hasResume={Boolean(data?.resume)}
                      hideSharedMissingNote={Boolean(sharedUnverifiedMissing)}
                      onDraftAction={handleDraftAction}
                      onDeliveryAction={handleDeliveryAction}
                      onOutreachAction={handleOutreachAction}
                      onGenerateEmailDraft={handleGenerateEmailDraft}
                    />
                  ))}
                </section>
              )}
            </div>
          )}

          {activeSection === "search" && data && (
            <SearchPanel
              search={data.search}
              extensionReady={extensionReady}
              browserBusy={browserBusy}
              onSaveSearch={handleSaveSearch}
              onBrowserSearch={handleBrowserSearch}
            />
          )}

          {activeSection === "paste" && <ManualPostPanel onSubmitPost={handleManualPost} />}

          {activeSection === "resume" && (
            <ResumePanel resume={data?.resume ?? null} onUploadResume={handleUploadResume} />
          )}

          {activeSection === "extension" && (
            <ExtensionPanel
              extensionReady={extensionReady}
              searchUrl={data?.search_url ?? "https://www.linkedin.com/search/results/content/?keywords=hiring"}
              browserBusy={browserBusy}
              unverifiedCount={unverifiedPosts.length}
              onStartBrowserSearch={() => handleBrowserSearch(quickSearch)}
              onRecheckUnverified={handleRecheckUnverified}
            />
          )}
        </main>
      </div>
    </div>
  );
}
