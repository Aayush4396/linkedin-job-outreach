import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Globe, RefreshCw } from "lucide-react";

interface ExtensionPanelProps {
  extensionReady: boolean;
  searchUrl: string;
  browserBusy: boolean;
  unverifiedCount: number;
  onStartBrowserSearch: () => void;
  onRecheckUnverified: () => void;
}

export function ExtensionPanel({
  extensionReady,
  searchUrl,
  browserBusy,
  unverifiedCount,
  onStartBrowserSearch,
  onRecheckUnverified,
}: ExtensionPanelProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);

  const dashboardOrigin =
    typeof window !== "undefined" ? `${window.location.origin}/` : "http://localhost:3000/";

  async function handleCopyOrigin() {
    try {
      await navigator.clipboard.writeText(dashboardOrigin);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      setCopiedUrl(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span
              className={
                extensionReady
                  ? "text-emerald-700 font-semibold"
                  : "text-amber-700 font-semibold"
              }
            >
              {extensionReady ? "Extension connected" : "Not detected in this tab"}
            </span>
            <span aria-hidden="true">·</span>
            <span>Uses your signed-in Chrome LinkedIn session</span>
          </div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Fetch LinkedIn posts directly from Chrome
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed">
            The HireMate Chrome extension runs inside your own signed-in desktop Chrome session. It
            never asks for your LinkedIn password or session cookies, avoids cloud IP blocks and
            account checkpoints, and imports full hiring posts matching your active search filters.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {extensionReady ? (
            <button
              type="button"
              disabled={browserBusy}
              onClick={onStartBrowserSearch}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Globe className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{browserBusy ? "Fetching from LinkedIn…" : "Fetch LinkedIn posts now"}</span>
            </button>
          ) : (
            <a
              href="/api/extension/download"
              download="hiremate-chrome-extension.zip"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Download extension (.zip)</span>
            </a>
          )}

          {extensionReady && (
            <a
              href="/api/extension/download"
              download="hiremate-chrome-extension.zip"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Download .zip</span>
            </a>
          )}

          <button
            type="button"
            onClick={handleCopyOrigin}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            {copiedUrl ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                <span>Dashboard URL copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Copy dashboard URL</span>
              </>
            )}
          </button>

          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Preview LinkedIn search</span>
          </a>

          {unverifiedCount > 0 && extensionReady && (
            <button
              type="button"
              disabled={browserBusy}
              onClick={onRecheckUnverified}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Recheck unverified ({unverifiedCount})</span>
            </button>
          )}
        </div>

        <ol className="pt-4 border-t border-slate-100 space-y-2.5 text-xs text-slate-600 list-decimal list-inside leading-relaxed">
          <li>
            Download and unzip <code className="font-mono text-slate-800">hiremate-chrome-extension.zip</code>{" "}
            (or use the local <code className="font-mono text-slate-800">browser/</code> folder).
          </li>
          <li>
            Open <code className="font-mono text-slate-800">chrome://extensions</code> in Chrome,
            enable <strong>Developer mode</strong>, click <strong>Load unpacked</strong>, and select
            the unzipped folder.
          </li>
          <li>
            Open{" "}
            <code className="font-mono text-slate-800 break-all">{dashboardOrigin}</code> directly
            in a top-level Chrome tab where you are signed in to LinkedIn, then click{" "}
            <strong>Fetch LinkedIn posts</strong>.
          </li>
        </ol>
      </section>
    </div>
  );
}
