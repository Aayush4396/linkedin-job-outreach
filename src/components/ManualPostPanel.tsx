import { useEffect, useRef, useState } from "react";
import { Camera, Link2, PlusSquare, Sparkles, Upload, X } from "lucide-react";

export type ImportMode = "screenshot" | "link" | "text";

export interface IncomingImportPrefill {
  mode?: ImportMode;
  url?: string;
  published?: string;
  helperNote?: string;
}

interface ManualPostPanelProps {
  prefill?: IncomingImportPrefill | null;
  onSubmitPost: (payload: {
    url: string;
    title: string;
    published: string;
    text: string;
  }) => Promise<boolean>;
  onSubmitScreenshot: (file: File, optionalUrl?: string) => Promise<boolean>;
  onSubmitUrl: (payload: { url: string }) => Promise<{
    imported: boolean;
    blocked?: boolean;
    url?: string;
    published?: string;
    reason?: string;
  }>;
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10);
}

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function ManualPostPanel({
  prefill,
  onSubmitPost,
  onSubmitScreenshot,
  onSubmitUrl,
}: ManualPostPanelProps) {
  const [mode, setMode] = useState<ImportMode>(prefill?.mode ?? "screenshot");
  const [helperNote, setHelperNote] = useState<string>(prefill?.helperNote ?? "");

  // Screenshot-to-draft state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [screenshotPostUrl, setScreenshotPostUrl] = useState<string>(prefill?.url ?? "");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // LinkedIn link state
  const [shareUrl, setShareUrl] = useState<string>(prefill?.url ?? "");

  // Manual text paste state
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [title, setTitle] = useState("");
  const [published, setPublished] = useState(prefill?.published || defaultToday());
  const [text, setText] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.mode) setMode(prefill.mode);
    if (prefill.url) {
      setScreenshotPostUrl(prefill.url);
      setShareUrl(prefill.url);
      setUrl(prefill.url);
    }
    if (prefill.published) {
      setPublished(prefill.published);
    }
    if (prefill.helperNote) {
      setHelperNote(prefill.helperNote);
    }
  }, [prefill]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedFile]);

  function handleSelectImage(file: File | null) {
    setValidationError(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.type && !ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setValidationError("Choose a PNG, JPEG, or WebP screenshot image.");
      return;
    }
    if (file.size > 8_000_000) {
      setValidationError("Choose a screenshot smaller than 8 MB.");
      return;
    }
    setSelectedFile(file);
  }

  function handlePasteImage(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleSelectImage(file);
          return;
        }
      }
    }
  }

  async function handleScreenshotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!selectedFile) {
      setValidationError("Choose or paste a screenshot of the hiring post first.");
      return;
    }
    const trimmedUrl = screenshotPostUrl.trim();
    if (trimmedUrl && !trimmedUrl.startsWith("https://")) {
      setValidationError("Optional post link must start with https://.");
      return;
    }

    setSubmitting(true);
    try {
      const ok = await onSubmitScreenshot(selectedFile, trimmedUrl || undefined);
      if (ok) {
        setSelectedFile(null);
        setScreenshotPostUrl("");
        setHelperNote("");
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);
    setHelperNote("");

    const trimmed = shareUrl.trim();
    if (!trimmed.startsWith("https://") || !trimmed.toLowerCase().includes("linkedin.com")) {
      setValidationError("Paste a public https://www.linkedin.com post link.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await onSubmitUrl({ url: trimmed });
      if (result.imported) {
        setShareUrl("");
      } else if (result.blocked) {
        const nextUrl = result.url || trimmed;
        setScreenshotPostUrl(nextUrl);
        setUrl(nextUrl);
        if (result.published) setPublished(result.published);
        setHelperNote(
          result.reason ||
            "LinkedIn requires sign-in for this post. Upload a screenshot below to draft in one tap.",
        );
        setMode("screenshot");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (!url.trim().startsWith("https://")) {
      setValidationError("Enter a valid HTTPS URL (for example, a LinkedIn post permalink).");
      return;
    }
    if (title.trim().length < 2) {
      setValidationError("Enter a role title or headline for this post.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(published.trim())) {
      setValidationError("Choose a valid publication date.");
      return;
    }
    if (text.trim().length < 15) {
      setValidationError("Paste the full text of the hiring post.");
      return;
    }

    setSubmitting(true);
    try {
      const ok = await onSubmitPost({
        url: url.trim(),
        title: title.trim(),
        published: published.trim(),
        text: text.trim(),
      });
      if (ok) {
        setUrl("");
        setTitle("");
        setPublished(defaultToday());
        setText("");
        setHelperNote("");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      onPaste={mode === "screenshot" ? handlePasteImage : undefined}
      className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 max-w-2xl space-y-5"
    >
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">Add a hiring post</h2>
        <p className="mt-1 text-sm text-slate-600">
          On Android or desktop, upload a screenshot, share a LinkedIn post link, or paste the post
          text. HireMate extracts the role, recruiter name, and email/DM instructions—then drafts
          your outreach automatically.
        </p>
      </div>

      {/* Mode tabs */}
      <div
        role="tablist"
        aria-label="Choose how to import a hiring post"
        className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
      >
        {(
          [
            ["screenshot", "Screenshot", Camera],
            ["link", "LinkedIn link", Link2],
            ["text", "Paste text", PlusSquare],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => {
              setMode(id);
              setValidationError(null);
            }}
            className={`inline-flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              mode === id
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {helperNote && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900"
        >
          {helperNote}
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800"
        >
          {validationError}
        </div>
      )}

      {/* 1. Screenshot-to-Draft */}
      {mode === "screenshot" && (
        <form onSubmit={handleScreenshotSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="screenshot-file" className="block text-xs font-semibold text-slate-700">
              Hiring post screenshot (PNG, JPG, or WebP)
            </label>
            <input
              ref={fileInputRef}
              id="screenshot-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => handleSelectImage(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
            {!selectedFile ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/70 hover:bg-slate-50 hover:border-[#423499]/50 px-4 py-8 text-center transition-colors cursor-pointer"
              >
                <Upload className="w-6 h-6 text-[#423499] mx-auto" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-slate-900">
                  Choose a screenshot from your phone or computer
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Supports PNG, JPG, WebP up to 8 MB · You can also paste an image here or use
                  Android Share → HireMate
                </p>
              </button>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-slate-800 truncate">{selectedFile.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-[#423499] font-medium hover:underline cursor-pointer"
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      aria-label="Remove selected screenshot"
                      onClick={() => {
                        setSelectedFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt="Selected hiring post screenshot preview"
                    className="max-h-72 w-auto mx-auto rounded-lg border border-slate-200 object-contain bg-white"
                  />
                )}
              </div>
            )}
          </div>

          <div>
            <label
              htmlFor="screenshot-post-url"
              className="block text-xs font-semibold text-slate-700"
            >
              LinkedIn post link <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <input
              id="screenshot-post-url"
              type="url"
              value={screenshotPostUrl}
              onChange={(e) => setScreenshotPostUrl(e.target.value)}
              placeholder="https://www.linkedin.com/posts/..."
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
            <p className="mt-1 text-xs text-slate-500">
              Add the link if you want an exact timestamp decoded and a one-tap link back to the
              post.
            </p>
          </div>

          <div className="pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-4 h-4" aria-hidden="true" />
              <span>
                {submitting ? "Reading screenshot & drafting…" : "Extract & draft outreach"}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* 2. Import from LinkedIn Link */}
      {mode === "link" && (
        <form onSubmit={handleLinkSubmit} className="space-y-4">
          <div>
            <label htmlFor="share-linkedin-url" className="block text-xs font-semibold text-slate-700">
              LinkedIn post URL
            </label>
            <input
              id="share-linkedin-url"
              type="url"
              required
              value={shareUrl}
              onChange={(e) => setShareUrl(e.target.value)}
              placeholder="https://www.linkedin.com/posts/..."
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Works automatically for public LinkedIn posts. If LinkedIn hides a post behind
              sign-in, HireMate keeps the link and switches you straight to Screenshot upload.
            </p>
          </div>

          <div className="pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Link2 className="w-4 h-4" aria-hidden="true" />
              <span>{submitting ? "Fetching post & drafting…" : "Fetch & draft"}</span>
            </button>
          </div>
        </form>
      )}

      {/* 3. Manual Paste Text */}
      {mode === "text" && (
        <form onSubmit={handleTextSubmit} className="space-y-4">
          <div>
            <label htmlFor="manual-url" className="block text-xs font-semibold text-slate-700">
              Post URL (HTTPS)
            </label>
            <input
              id="manual-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.linkedin.com/feed/update/urn:li:activity:7234567890123456789/"
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="manual-title" className="block text-xs font-semibold text-slate-700">
                Role title or headline
              </label>
              <input
                id="manual-title"
                type="text"
                required
                maxLength={300}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Staff Backend Engineer (Remote)"
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="manual-published"
                className="block text-xs font-semibold text-slate-700"
              >
                Published date
              </label>
              <input
                id="manual-published"
                type="date"
                required
                value={published}
                onChange={(e) => setPublished(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono-tabular text-slate-900"
              />
            </div>
          </div>

          <div>
            <label htmlFor="manual-text" className="block text-xs font-semibold text-slate-700">
              Full hiring post text
            </label>
            <textarea
              id="manual-text"
              required
              rows={7}
              maxLength={30000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="We're hiring a Senior Frontend Engineer to work on our React and TypeScript platform. Send your résumé to talent@example.org."
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 leading-relaxed"
            />
          </div>

          <div className="pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <PlusSquare className="w-4 h-4" aria-hidden="true" />
              <span>{submitting ? "Importing and matching…" : "Import and match post"}</span>
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
