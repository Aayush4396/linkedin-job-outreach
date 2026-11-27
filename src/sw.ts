interface PrecacheEntry {
  url: string;
  revision?: string | null;
}

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwGlobalScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: SwFetchEvent) => void): void;
}

declare global {
  interface Window {
    __WB_MANIFEST?: Array<string | PrecacheEntry>;
  }
}

const sw = self as unknown as SwGlobalScope;

const APP_CACHE = "hiremate-app-v1";
const FONT_CACHE = "hiremate-fonts-v1";
const SHARE_CACHE = "hiremate-share-inbox-v1";
const SHARE_META_URL = "/__hiremate_share_meta__";
const SHARE_FILE_URL = "/__hiremate_share_file__";

const PRECACHE_URLS = (self.__WB_MANIFEST ?? [])
  .map((entry) => (typeof entry === "string" ? entry : entry.url))
  .filter(Boolean);

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => (PRECACHE_URLS.length > 0 ? cache.addAll(PRECACHE_URLS) : undefined))
      .catch(() => undefined)
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  const keep = new Set([APP_CACHE, FONT_CACHE, SHARE_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim().slice(0, 500);
    const text = String(formData.get("text") ?? "").trim().slice(0, 8000);
    const url = String(formData.get("url") ?? "").trim().slice(0, 2048);
    const rawFile = formData.get("screenshot");
    const file = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;

    const cache = await caches.open(SHARE_CACHE);
    await cache.delete(SHARE_META_URL);
    await cache.delete(SHARE_FILE_URL);

    await cache.put(
      SHARE_META_URL,
      new Response(
        JSON.stringify({
          title,
          text,
          url,
          hasScreenshot: Boolean(file),
          filename: file?.name || "shared-screenshot.png",
          mimeType: file?.type || "image/png",
          receivedAt: Date.now(),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    if (file) {
      const buffer = await file.arrayBuffer();
      await cache.put(
        SHARE_FILE_URL,
        new Response(buffer, {
          headers: {
            "Content-Type": file.type || "image/png",
            "X-Filename": encodeURIComponent(file.name || "shared-screenshot.png"),
          },
        }),
      );
    }
  } catch {
    // Still redirect into the app so the user can retry cleanly.
  }

  return Response.redirect("/?shared=1", 303);
}

sw.addEventListener("fetch", (event) => {
  const { request } = event;
  const reqUrl = new URL(request.url);

  // Intercept Android Web Share Target POST /share-target
  if (
    request.method === "POST" &&
    reqUrl.origin === sw.location.origin &&
    reqUrl.pathname === "/share-target"
  ) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== "GET") {
    return;
  }

  // Never cache dynamic API endpoints.
  if (reqUrl.origin === sw.location.origin && reqUrl.pathname.startsWith("/api/")) {
    return;
  }

  // CacheFirst for Google Fonts stylesheets & font binaries.
  if (
    reqUrl.origin === "https://fonts.googleapis.com" ||
    reqUrl.origin === "https://fonts.gstatic.com"
  ) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok || fresh.type === "opaque") {
          void cache.put(request, fresh.clone());
        }
        return fresh;
      }),
    );
    return;
  }

  // Network-first for navigation / same-origin assets with offline cache fallback.
  if (reqUrl.origin === sw.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (
            response.ok &&
            (request.mode === "navigate" || /\.(?:js|css|png|svg|ico|woff2?)$/i.test(reqUrl.pathname))
          ) {
            const copy = response.clone();
            void caches.open(APP_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (request.mode === "navigate") {
            const rootCached = (await caches.match("/")) ?? (await caches.match("/index.html"));
            if (rootCached) return rootCached;
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        }),
    );
  }
});

export {};
