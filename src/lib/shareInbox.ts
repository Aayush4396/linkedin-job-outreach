export interface SharedAndroidPayload {
  title: string;
  text: string;
  url: string;
  screenshot: File | null;
}

const SHARE_CACHE = "hiremate-share-inbox-v1";
const SHARE_META_URL = "/__hiremate_share_meta__";
const SHARE_FILE_URL = "/__hiremate_share_file__";

export async function consumePendingShare(): Promise<SharedAndroidPayload | null> {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const directUrl = params.get("share_url")?.trim() ?? "";
  const directText = params.get("share_text")?.trim() ?? "";
  const directTitle = params.get("share_title")?.trim() ?? "";
  const isSharedFlag = params.get("shared") === "1";

  if (directUrl || directText || directTitle) {
    params.delete("share_url");
    params.delete("share_text");
    params.delete("share_title");
    const nextSearch = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
    );
    return {
      title: directTitle,
      text: directText,
      url: directUrl,
      screenshot: null,
    };
  }

  if (!isSharedFlag || typeof caches === "undefined") {
    return null;
  }

  params.delete("shared");
  const nextSearch = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`,
  );

  try {
    const cache = await caches.open(SHARE_CACHE);
    const metaResp = await cache.match(SHARE_META_URL);
    if (!metaResp) return null;

    const meta = (await metaResp.json()) as {
      title?: string;
      text?: string;
      url?: string;
      hasScreenshot?: boolean;
      filename?: string;
      mimeType?: string;
    };

    let screenshot: File | null = null;
    if (meta.hasScreenshot) {
      const fileResp = await cache.match(SHARE_FILE_URL);
      if (fileResp) {
        const blob = await fileResp.blob();
        const filename = meta.filename || "shared-screenshot.png";
        const mimeType = meta.mimeType || blob.type || "image/png";
        screenshot = new File([blob], filename, { type: mimeType });
      }
    }

    await cache.delete(SHARE_META_URL);
    await cache.delete(SHARE_FILE_URL);

    return {
      title: meta.title ?? "",
      text: meta.text ?? "",
      url: meta.url ?? "",
      screenshot,
    };
  } catch {
    return null;
  }
}
