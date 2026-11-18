chrome.runtime.onMessage.addListener((message, sender, reply) => {
  search(message, sender).then(posts => reply({posts})).catch(error => reply({error: error.message}));
  return true;
});

async function search(message, sender) {
  const dashboard = new URL(sender.url);
  const url = new URL(message.url);
  if (dashboard.protocol !== "http:" || !["localhost","127.0.0.1"].includes(dashboard.hostname) ||
      dashboard.pathname !== "/" || url.origin !== "https://www.linkedin.com" ||
      url.pathname !== "/search/results/content/") throw Error("Open your local HireMate dashboard first.");
  const tab = await chrome.tabs.create({url: url.href, active:true});
  // Keep the results visible so the user can inspect them or complete sign-in.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if ((await chrome.tabs.get(tab.id)).status !== "complete") continue;
    const [scan] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:readPosts});
    if (scan.result.error) throw Error(scan.result.error);
    if (scan.result.posts.length || scan.result.empty) return scan.result.posts;
  }
  throw Error("Could not identify individual posts on this results page. Check the open LinkedIn tab.");
}

function readPosts() {
  if (!location.pathname.startsWith("/search/results/content")) {
    return {error:"Open LinkedIn, complete sign-in if prompted, then retry from HireMate."};
  }
  const main = document.querySelector("main, [role=main]");
  const posts = [];
  const seen = new Set();
  for (const card of main?.querySelectorAll("[data-urn],article,[role=article],li") || []) {
    const body = card.querySelector(".update-components-text,.feed-shared-update-v2__description,[data-testid='expandable-text-box']");
    if (!body || card.querySelectorAll(".update-components-text").length > 1) continue;
    const urn = card.getAttribute("data-urn");
    const link = card.querySelector("a[href*='highlightedUpdateUrn='],a[href*='/feed/update/'],a[href*='/posts/']");
    const url = /^urn:li:(activity|ugcPost):\d+$/.test(urn) ? "https://www.linkedin.com/feed/update/"+urn+"/" : link?.href;
    if (!url || seen.has(url) || !url.startsWith("https://www.linkedin.com/")) continue;
    const text = body.innerText.trim();
    if (!text) continue;
    const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime")?.slice(0,10);
    const clipped = body.querySelector("button[aria-expanded=false]") ||
      Array.from(card.querySelectorAll("button")).some(b => /see more|show more|^…more$/i.test(b.innerText.trim()));
    posts.push({url,title:text.split("\n")[0].slice(0,300),text:text.slice(0,30000),
      published:stamp || "", date_kind:stamp?"published":"unknown",
      content_kind:clipped || text.length>30000?"snippet":"full"});
    seen.add(url);
    if (posts.length === 30) break;
  }
  return {posts,empty:!posts.length && /no results found/i.test(main?.innerText || "")};
}
