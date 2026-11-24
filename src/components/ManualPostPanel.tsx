import { useState } from "react";
import { PlusSquare } from "lucide-react";

interface ManualPostPanelProps {
  onSubmitPost: (payload: {
    url: string;
    title: string;
    published: string;
    text: string;
  }) => Promise<boolean>;
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ManualPostPanel({ onSubmitPost }: ManualPostPanelProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [published, setPublished] = useState(defaultToday);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
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
      // Only clear inputs after confirmed successful persistence.
      if (ok) {
        setUrl("");
        setTitle("");
        setPublished(defaultToday());
        setText("");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-5">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">Paste a hiring post</h2>
        <p className="mt-1 text-sm text-slate-600">
          Import any LinkedIn or web hiring post directly without needing the Chrome extension.
          HireMate automatically detects application emails, external links, or DM instructions and
          matches the role against your résumé.
        </p>
      </div>

      {validationError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800"
        >
          {validationError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
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
    </section>
  );
}
