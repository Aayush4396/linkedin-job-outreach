import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stripUndefined } from "../src/lib/postDiscovery";

type CollectionName = "posts" | "settings" | "scans" | "linkedin_ids" | "recipients";

interface StoreSnapshot {
  posts: Record<string, Record<string, unknown>>;
  settings: Record<string, Record<string, unknown>>;
  scans: Record<string, Record<string, unknown>>;
  linkedin_ids: Record<string, Record<string, unknown>>;
  recipients: Record<string, Record<string, unknown>>;
}

function emptySnapshot(): StoreSnapshot {
  return {
    posts: {},
    settings: {},
    scans: {},
    linkedin_ids: {},
    recipients: {},
  };
}

export class HireMateStore {
  private readonly storePath: string;
  private readonly resumesDir: string;
  private state: StoreSnapshot;

  constructor(private readonly dataDir: string) {
    this.storePath = path.resolve(dataDir, "hiremate-store.json");
    this.resumesDir = path.resolve(dataDir, "resumes");
    this.ensurePathInsideDataDir(this.storePath);
    this.ensurePathInsideDataDir(this.resumesDir);
    this.state = this.loadFromDisk();
  }

  private ensurePathInsideDataDir(targetPath: string): void {
    const resolvedBase = path.resolve(this.dataDir);
    const resolvedTarget = path.resolve(targetPath);
    if (
      resolvedTarget !== resolvedBase &&
      !resolvedTarget.startsWith(resolvedBase + path.sep)
    ) {
      throw new Error("Path escapes data directory");
    }
  }

  private loadFromDisk(): StoreSnapshot {
    try {
      if (!fs.existsSync(this.storePath)) {
        return emptySnapshot();
      }
      const raw = fs.readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreSnapshot>;
      return {
        posts: parsed.posts && typeof parsed.posts === "object" ? parsed.posts : {},
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
        scans: parsed.scans && typeof parsed.scans === "object" ? parsed.scans : {},
        linkedin_ids:
          parsed.linkedin_ids && typeof parsed.linkedin_ids === "object" ? parsed.linkedin_ids : {},
        recipients:
          parsed.recipients && typeof parsed.recipients === "object" ? parsed.recipients : {},
      };
    } catch {
      return emptySnapshot();
    }
  }

  private persistToDisk(snapshot: StoreSnapshot): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmpPath = path.resolve(
      this.dataDir,
      `.hiremate-store.${crypto.randomUUID()}.tmp`,
    );
    this.ensurePathInsideDataDir(tmpPath);
    const cleaned = stripUndefined(snapshot);
    fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2), "utf8");
    fs.renameSync(tmpPath, this.storePath);
  }

  read<T = Record<string, unknown>>(group: CollectionName, key: string): T | null {
    const record = this.state[group][key];
    return record ? (structuredClone(record) as T) : null;
  }

  all<T = Record<string, unknown>>(group: CollectionName): T[] {
    return Object.values(this.state[group]).map((item) => structuredClone(item) as T);
  }

  transact<R>(
    operation: (
      get: <T = Record<string, unknown>>(group: CollectionName, key: string) => T | null,
      put: (group: CollectionName, key: string, value: Record<string, unknown>) => void,
    ) => R,
  ): R {
    const working: StoreSnapshot = structuredClone(this.state);
    let dirty = false;

    const get = <T = Record<string, unknown>>(group: CollectionName, key: string): T | null => {
      const record = working[group][key];
      return record ? (structuredClone(record) as T) : null;
    };

    const put = (group: CollectionName, key: string, value: Record<string, unknown>): void => {
      working[group][key] = stripUndefined(structuredClone(value));
      dirty = true;
    };

    const result = operation(get, put);
    if (dirty) {
      this.persistToDisk(working);
      this.state = working;
    }
    return result;
  }

  saveResumeBytes(version: string, raw: Buffer): void {
    const safeName = path.basename(version);
    const targetPath = path.resolve(this.resumesDir, safeName);
    this.ensurePathInsideDataDir(targetPath);
    fs.mkdirSync(this.resumesDir, { recursive: true });
    const tmpPath = path.resolve(this.resumesDir, `.resume.${crypto.randomUUID()}.tmp`);
    this.ensurePathInsideDataDir(tmpPath);
    fs.writeFileSync(tmpPath, raw);
    fs.renameSync(tmpPath, targetPath);
  }

  readResumeBytes(version: string): Buffer | null {
    const safeName = path.basename(version);
    const targetPath = path.resolve(this.resumesDir, safeName);
    this.ensurePathInsideDataDir(targetPath);
    if (!fs.existsSync(targetPath)) return null;
    return fs.readFileSync(targetPath);
  }
}
