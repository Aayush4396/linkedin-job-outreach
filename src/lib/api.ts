import type { DashboardPayload, SearchSettings } from "./types";

const BASE_HEADERS = { "X-HireMate": "1" };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string"
        ? (data as { detail: string }).detail
        : "Request failed. Please try again.";
    throw new ApiError(detail, response.status);
  }
  return data as T;
}

export function fetchDashboard(): Promise<DashboardPayload> {
  return requestJson<DashboardPayload>("/api/posts");
}

export function runServerScan(): Promise<{ new: number }> {
  return requestJson<{ new: number }>("/api/scan", {
    method: "POST",
    headers: BASE_HEADERS,
  });
}

export function saveSearchPreferences(search: SearchSettings): Promise<{ url: string }> {
  return requestJson<{ url: string }>("/api/preferences/search", {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(search),
    signal: AbortSignal.timeout(15_000),
  });
}

export function saveApprovalPreference(required: boolean): Promise<{ required: boolean }> {
  return requestJson<{ required: boolean }>("/api/preferences/approval", {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ required }),
  });
}

export function uploadResumeFile(file: File): Promise<{ name: string }> {
  return requestJson<{ name: string }>("/api/resume", {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      "X-Filename": encodeURIComponent(file.name),
      "Content-Type": "application/octet-stream",
    },
    body: file,
  });
}

export function updateDraft(
  id: string,
  payload: { subject: string; message: string; action: "save" | "approve" | "skip" },
): Promise<{ ok: boolean; status: string }> {
  return requestJson<{ ok: boolean; status: string }>(`/api/posts/${id}`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateDelivery(
  id: string,
  action: "mark_sent" | "requeue",
): Promise<{ ok: boolean; status: string }> {
  return requestJson<{ ok: boolean; status: string }>(`/api/posts/${id}/delivery`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export function dispatchQueuedNow(): Promise<{ processed: number }> {
  return requestJson<{ processed: number }>("/api/dispatch-now", {
    method: "POST",
    headers: BASE_HEADERS,
  });
}

export function submitManualPost(payload: {
  url: string;
  title: string;
  published: string;
  text: string;
}): Promise<{ ok: boolean; new: number; matched_search: boolean }> {
  return requestJson<{ ok: boolean; new: number; matched_search: boolean }>("/api/posts/manual", {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateOutreach(
  id: string,
  payload: {
    action: "save" | "mark_applied" | "skip" | "reopen";
    dm?: string;
    connect_note?: string;
    comment?: string;
  },
): Promise<{ ok: boolean; status: string }> {
  return requestJson<{ ok: boolean; status: string }>(`/api/posts/${id}/outreach`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function generateEmailDraft(
  id: string,
): Promise<{ ok: boolean; status: string; recipient: string; subject: string }> {
  return requestJson<{ ok: boolean; status: string; recipient: string; subject: string }>(
    `/api/posts/${id}/draft`,
    {
      method: "POST",
      headers: BASE_HEADERS,
    },
  );
}


