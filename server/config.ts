import path from "node:path";

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.toLowerCase() !== "false" && value !== "0";
}

function parseIntClamped(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  feedUrl: string;
  feedAuthHeader: string;
  scanIntervalMinutes: number;
  scanCooldownMinutes: number;
  geminiApiKey: string;
  geminiModel: string;
  geminiWorkers: number;
  dashboardPin: string;
  dryRun: boolean;
  approvalMode: boolean;
  dailyCap: number;
  timezone: string;
  externalScheduler: boolean;
  workerOnly: boolean;
  linkedinQuery: string;
}

export function loadConfig(): AppConfig {
  const scanIntervalMinutes = parseIntClamped(
    process.env.SCAN_INTERVAL_MINUTES,
    480,
    1,
    10080,
  );
  const scanCooldownMinutes = parseIntClamped(
    process.env.SCAN_COOLDOWN_MINUTES,
    1,
    1,
    10080,
  );
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));

  return {
    port: parseIntClamped(process.env.PORT, 3000, 1, 65535),
    host: "0.0.0.0",
    dataDir,
    feedUrl: (process.env.POST_FEED_URL ?? "").trim(),
    feedAuthHeader: (process.env.FEED_AUTH_HEADER ?? "").trim(),
    scanIntervalMinutes,
    scanCooldownMinutes,
    geminiApiKey: (process.env.GEMINI_API_KEY ?? "").trim(),
    geminiModel: (process.env.GEMINI_MODEL ?? "").trim(),
    geminiWorkers: parseIntClamped(process.env.GEMINI_WORKERS, 4, 1, 16),
    dashboardPin: (process.env.DASHBOARD_PIN ?? "").trim(),
    dryRun: parseBool(process.env.DRY_RUN, true),
    approvalMode: parseBool(process.env.APPROVAL_MODE, true),
    dailyCap: parseIntClamped(process.env.MAX_EMAILS_PER_DAY, 20, 0, 20),
    timezone: (process.env.OUTREACH_TIMEZONE ?? "Asia/Kolkata").trim() || "Asia/Kolkata",
    externalScheduler: (process.env.EXTERNAL_SCHEDULER ?? "false").toLowerCase() === "true",
    workerOnly: (process.env.WORKER_ONLY ?? "false").toLowerCase() === "true",
    linkedinQuery: (process.env.LINKEDIN_QUERY ?? "hiring").trim() || "hiring",
  };
}
