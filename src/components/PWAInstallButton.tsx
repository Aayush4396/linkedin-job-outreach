import { useState } from "react";
import { Download, Smartphone, X } from "lucide-react";
import { usePWAInstall } from "../hooks/usePWAInstall";

interface PWAInstallButtonProps {
  variant?: "sidebar" | "compact";
}

export function PWAInstallButton({ variant = "sidebar" }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  // Native Chromium / Android install prompt when available.
  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={
          variant === "compact"
            ? "inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            : "w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors cursor-pointer whitespace-nowrap"
        }
      >
        <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{variant === "compact" ? "Install" : "Install app"}</span>
      </button>
    );
  }

  // Guided install button when beforeinstallprompt hasn't fired yet (Android Chrome menu / iOS Safari / desktop).
  const label =
    variant === "compact"
      ? "Install"
      : isIOS
        ? "Install on iPhone"
        : isAndroid
          ? "Install on Android"
          : "Install mobile app";

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className={
          variant === "compact"
            ? "inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
            : "w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
        }
      >
        <Smartphone className="w-3.5 h-3.5 text-[#423499] shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white border border-slate-200 p-5 shadow-lg space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h3
                id="pwa-install-title"
                className="font-display text-base font-semibold text-slate-900"
              >
                {isIOS ? "Install HireMate on iPhone" : "Install HireMate on Android"}
              </h3>
              <button
                type="button"
                aria-label="Close install instructions"
                onClick={() => setShowGuide(false)}
                className="p-1 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="list-decimal list-inside space-y-1.5 text-xs text-slate-600 leading-relaxed">
                <li>
                  Tap the <strong>Share</strong> button in Safari’s toolbar.
                </li>
                <li>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
            ) : (
              <div className="space-y-2.5 text-xs text-slate-600 leading-relaxed">
                <ol className="list-decimal list-inside space-y-1.5">
                  <li>
                    Open this HireMate URL directly in <strong>Chrome on Android</strong>.
                  </li>
                  <li>
                    Tap Chrome’s <strong>⋮ menu</strong> (top-right) and choose{" "}
                    <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                  </li>
                </ol>
                <p className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-slate-700">
                  Once installed on Android, <strong>HireMate</strong> appears in your phone’s{" "}
                  <strong>Share</strong> menu so you can share LinkedIn links or screenshots
                  straight into drafts.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full px-4 py-2 text-xs font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] transition-colors cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
