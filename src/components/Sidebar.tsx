import {
  FileText,
  Globe,
  Inbox,
  PlusSquare,
  Search,
  X,
} from "lucide-react";
import type { DashboardPayload } from "../lib/types";
import { PWAInstallButton } from "./PWAInstallButton";

export type WorkspaceSection = "queue" | "search" | "paste" | "resume" | "extension";

interface SidebarProps {
  activeSection: WorkspaceSection;
  onSelectSection: (section: WorkspaceSection) => void;
  data: DashboardPayload | null;
  extensionReady: boolean;
  onToggleApproval: (required: boolean) => void;
  approvalSaving: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  data,
  extensionReady,
  onToggleApproval,
  approvalSaving,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const readyCount = data?.posts.filter((p) => p.status === "Ready for review").length ?? 0;
  const queuedCount = data?.posts.filter((p) => p.status === "Queued").length ?? 0;
  const unverifiedCount = data?.posts.filter((p) => p.status === "Unverified lead").length ?? 0;

  const navItems: {
    id: WorkspaceSection;
    label: string;
    icon: typeof Inbox;
    meta?: string;
  }[] = [
    {
      id: "queue",
      label: "Outreach queue",
      icon: Inbox,
      meta: readyCount > 0 ? String(readyCount) : undefined,
    },
    {
      id: "search",
      label: "Saved search",
      icon: Search,
    },
    {
      id: "paste",
      label: "Add hiring post",
      icon: PlusSquare,
    },
    {
      id: "resume",
      label: "My résumé",
      icon: FileText,
      meta: data?.resume ? "Loaded" : undefined,
    },
    {
      id: "extension",
      label: "Chrome extension",
      icon: Globe,
      meta: extensionReady ? "Connected" : "Setup",
    },
  ];

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between bg-white border-r border-slate-200">
      <div>
        <div className="flex items-center justify-between px-5 h-16 border-b border-slate-200">
          <button
            type="button"
            onClick={() => {
              onSelectSection("queue");
              onCloseMobile();
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            HireMate
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="lg:hidden p-2 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav aria-label="Workspace sections" className="p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectSection(item.id);
                  onCloseMobile();
                }}
                aria-current={active ? "page" : undefined}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? "bg-[#423499]/8 text-[#423499]"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.meta && (
                  <span className="text-xs font-mono-tabular text-slate-500 shrink-0">
                    {item.meta}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200 space-y-4">
        <div className="space-y-2 text-xs text-slate-600">
          <div className="flex items-center justify-between">
            <span>Mode</span>
            <span className="font-medium text-slate-900">
              {data?.dry ? "Practice" : "Live delivery"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Matching</span>
            <span className="font-medium text-slate-900">
              {data?.ai_configured ? "Gemini AI" : "Offline keywords"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Sent today</span>
            <span className="font-mono-tabular font-medium text-slate-900">
              {data?.sent_today ?? 0} / {data?.daily_cap ?? 20}
            </span>
          </div>
          {queuedCount > 0 && (
            <div className="flex items-center justify-between">
              <span>Queued</span>
              <span className="font-mono-tabular font-medium text-slate-900">{queuedCount}</span>
            </div>
          )}
          {unverifiedCount > 0 && (
            <div className="flex items-center justify-between">
              <span>Unverified</span>
              <span className="font-mono-tabular font-medium text-amber-700">
                {unverifiedCount}
              </span>
            </div>
          )}
        </div>

        <label className="flex items-start gap-2.5 pt-3 border-t border-slate-100 text-xs text-slate-700 cursor-pointer select-none">
          <input
            id="approval"
            type="checkbox"
            checked={Boolean(data?.approval)}
            disabled={approvalSaving || !data}
            onChange={(e) => onToggleApproval(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-[#423499] cursor-pointer"
          />
          <span className="leading-snug">Review new drafts before queuing</span>
        </label>

        <div className="pt-2 border-t border-slate-100">
          <PWAInstallButton variant="sidebar" />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-[248px] shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/30"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-10 w-[264px] max-w-[85vw] h-full">{sidebarContent}</div>
        </div>
      )}
    </>
  );
}
