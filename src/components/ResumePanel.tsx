import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { ResumeRecord } from "../lib/types";

interface ResumePanelProps {
  resume: ResumeRecord | null;
  onUploadResume: (file: File) => Promise<void>;
}

export function ResumePanel({ resume, onUploadResume }: ResumePanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile) return;
    setUploading(true);
    try {
      await onUploadResume(selectedFile);
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="space-y-6 max-w-3xl">
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            {resume ? `Active résumé · ${resume.name}` : "Upload your résumé"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Upload a Word (.docx), PDF, or text (.txt) résumé (up to 8 MB). HireMate extracts the
            text server-side, matches it against saved hiring posts, and drafts tailored
            applications. Existing drafts retain the résumé attached when they were prepared.
          </p>
        </div>

        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label htmlFor="file" className="block text-xs font-semibold text-slate-700">
              Choose a Word (.docx), PDF (.pdf), or text (.txt) file
            </label>
            <input
              ref={inputRef}
              id="file"
              type="file"
              accept=".docx,.txt,.pdf"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              className="mt-1.5 block w-full text-sm text-slate-700 file:mr-4 file:py-2 file:px-3.5 file:rounded-lg file:border file:border-slate-300 file:text-xs file:font-medium file:bg-white file:text-slate-800 hover:file:bg-slate-50 cursor-pointer"
            />
          </div>

          <button
            id="upload"
            type="submit"
            disabled={!selectedFile || uploading}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-[#423499] text-white hover:bg-[#34287E] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-4 h-4" aria-hidden="true" />
            <span>{uploading ? "Extracting and matching…" : "Use this résumé"}</span>
          </button>
        </form>
      </div>

      {resume && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              Extracted résumé text
            </h3>
            <span className="text-xs font-mono-tabular text-slate-500">
              {resume.text.length.toLocaleString()} characters
            </span>
          </div>
          <pre
            id="preview"
            className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-800 whitespace-pre-wrap break-words leading-relaxed font-mono"
          >
            {resume.text}
          </pre>
        </div>
      )}
    </section>
  );
}
