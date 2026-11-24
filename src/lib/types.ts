export type PostStatus =
  | "Ready for review"
  | "Check delivery"
  | "Queued"
  | "Needs draft"
  | "Contact on LinkedIn"
  | "Apply via link"
  | "Unverified lead"
  | "Check application instructions"
  | "Check recipients"
  | "No email listed"
  | "Recipient already seen"
  | "Low résumé match"
  | "Outside target roles"
  | "Outside discovery window"
  | "Simulated"
  | "Sent"
  | "Applied"
  | "Skipped";

export type DateKind = "published" | "relative" | "observed" | "unknown";
export type ContentKind = "full" | "snippet";
export type WorkplaceChoice = "Any" | "Remote" | "Hybrid" | "Onsite";
export type EmploymentChoice = "Any" | "Contract" | "Full-time";
export type LinkedInActionType = "dm" | "connect" | "comment";

export interface SearchSettings {
  roles: string;
  locations: string;
  workplace: WorkplaceChoice;
  employment: EmploymentChoice;
}

export interface ResumeRecord {
  name: string;
  version: string;
  text: string;
  uploadedAt: string;
}

export interface PostRecord {
  id: string;
  url: string;
  title: string;
  text: string;
  published: string;
  published_at?: string;
  date_kind?: DateKind;
  content_kind?: ContentKind;
  status: PostStatus;
  route: PostStatus;
  recipient: string;
  apply_link: string;
  sample: boolean;
  scan_id?: string;
  verification_note?: string;
  preview_text?: string;
  preview_has_email?: boolean;
  fit_reason?: string;
  fit_resume?: string;
  fit_policy?: string;
  fit_model?: string;
  subject?: string;
  message?: string;
  draft_edited?: boolean;
  resume?: string;
  filename?: string;
  preview?: boolean;
  sent_day?: string;
  created_at?: string;
  linkedin_action?: LinkedInActionType;
  comment_keyword?: string;
  linkedin_dm_draft?: string;
  linkedin_connect_draft?: string;
  linkedin_comment_draft?: string;
}

export interface ScanRecord {
  id: string;
  checked: number;
  members: Record<string, "new" | "seen">;
  created_at?: string;
}

export interface DashboardPayload {
  latest_scan: ScanRecord | null;
  search: SearchSettings;
  search_url: string;
  sent_today: number;
  daily_cap: number;
  rotate: boolean;
  connection: string;
  source: string;
  ai_configured: boolean;
  posts: PostRecord[];
  resume: ResumeRecord | null;
  dry: boolean;
  approval: boolean;
  auth_required: boolean;
}

export interface RawPostInput {
  url: string;
  title: string;
  text: string;
  published: string;
  date_kind?: DateKind;
  content_kind?: ContentKind;
  verification_note?: string;
  preview_text?: string;
}
