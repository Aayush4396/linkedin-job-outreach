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
  let diagnostic = 'The results page did not finish loading.';
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if ((await chrome.tabs.get(tab.id)).status !== "complete") continue;
    const [scan] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:readPosts});
    diagnostic = scan.result.diagnostic || diagnostic;
    if (scan.result.error) throw Error(scan.result.error);
    if (scan.result.posts.length || scan.result.empty) return scan.result.posts;
  }
  throw Error("Could not import LinkedIn results. " + diagnostic);
}

function readPosts() {
  if (!location.pathname.startsWith("/search/results/content")) {
    return {error:"Open LinkedIn, complete sign-in if prompted, then retry from HireMate."};
  }
  const root = document.querySelector("main,[role=main]") || document.body;
  const bodySelector = ".update-components-text,.feed-shared-update-v2__description,[data-testid='expandable-text-box'],[data-testid='expandable-text'],[data-view-name='feed-commentary']";
  const markerSelector = "a[href*='highlightedUpdateUrn='],a[href*='/feed/update/'],a[href*='/posts/'],[data-urn],[data-id],[componentkey*='urn:li:']";
  const headingSelector = "h1,h2,h3,h4,[role=heading]";
  function idOf(node) {
    const attr = ["data-urn","data-id","componentkey"].map(k=>node.getAttribute(k)||"").join(" ");
    const urn = attr.match(/urn:li:(activity|share|ugcPost):(\d{15,21})(?!\d)/);
    if (urn) return urn[2];
    if (!node.href) return "";
    const url = new URL(node.href);
    if (url.origin !== "https://www.linkedin.com") return "";
    const group = /^\/groups\/\d+\/?$/.test(url.pathname) && url.searchParams.get("highlightedUpdateUrn");
    return (group && group.match(/^urn:li:activity:(\d{15,21})$/)?.[1]) ||
      url.pathname.match(/^\/feed\/update\/urn:li:(?:activity|share|ugcPost):(\d{15,21})\/?$/)?.[1] ||
      url.pathname.match(/^\/posts\/[^/]*-(\d{15,21})(?:-[^/]*)?\/?$/)?.[1] || "";
  }
  const markers = Array.from(root.querySelectorAll(markerSelector)).map(node=>({node,id:idOf(node)})).filter(m=>m.id);
  const headings = Array.from(root.querySelectorAll(headingSelector)).filter(h=>/^feed post$/i.test(h.textContent.trim()));
  const menus = Array.from(root.querySelectorAll("button[aria-label]")).filter(b=>/control menu for post|more options for post/i.test(b.getAttribute("aria-label")));
  const posts = new Map();
  for (const {node,id} of markers) {
    if (posts.has(id)) continue;
    // Follow the permalink up to its own post, stopping before any neighbouring card.
    for (let card=node; card && card!==root; card=card.parentElement) {
      if (markers.some(m=>m.id!==id && card.contains(m.node)) ||
          headings.filter(h=>card.contains(h)).length>1 || menus.filter(b=>card.contains(b)).length>1) break;
      const body = card.querySelector(bodySelector);
      const singleCard = headings.some(h=>card.contains(h)) || menus.some(b=>card.contains(b)) ||
                         card.matches("article,[role=article],li,[data-urn]");
      const text = (body || card).innerText?.trim() || "";
      if (!text || (!body && (!singleCard || text.length<60 || !/\b(hiring|looking for|engineer|opening|apply|recruit|vacancy)\b/i.test(text)))) continue;
      const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime") || "";
      const expand = Array.from(card.querySelectorAll("button")).find(button => {
        const label = (button.getAttribute("aria-label") || button.innerText).trim();
        return /^(?:see |show |read )?[… ]*more(?:,? expand.*)?$/i.test(label);
      });
      if (expand && !expand.dataset.hiremateExpanded) {
        expand.dataset.hiremateExpanded = "true";
        expand.click();
        return {posts:[], diagnostic:"Waiting for LinkedIn to expand a post."};
      }
      const directLink = markers.find(m=>m.id===id && m.node.href && card.contains(m.node));
      const record = {url:directLink?.node.href || "https://www.linkedin.com/feed/update/urn:li:activity:"+id+"/",
        title:text.split("\n").find(line=>/hiring|vacancy|opening/i.test(line))?.slice(0,300) || text.split("\n")[0].slice(0,300),
        text:text.slice(0,30000),published:stamp.slice(0,10),date_kind:/^\d{4}-\d{2}-\d{2}/.test(stamp)?"published":"unknown",
        content_kind:!body || expand || text.length>30000?"snippet":"full"};
      posts.set(id,record);
      if (body || singleCard) break;
    }
    if (posts.size>=30) break;
  }
  if (posts.size < 30) {
    const boundaries = headings.length ? headings : menus;
    const searchUrl = new URL("/search/results/content/", location.origin);
    searchUrl.searchParams.set("keywords", new URL(location.href).searchParams.get("keywords") || "");
    for (const boundary of boundaries) {
      for (let card = boundary.parentElement; card && card !== root; card = card.parentElement) {
        if (boundaries.some(other => other !== boundary && card.contains(other)) ||
            markers.some(marker => card.contains(marker.node))) break;
        const body = card.querySelector(bodySelector);
        const text = (body || card).innerText?.trim() || "";
        if (!body && !headings.some(h => card.contains(h)) && !menus.some(b => card.contains(b))) continue;
        const title = text.split("\n").find(line => /\b(hiring|vacanc\w*|opening|join our team)\b/i.test(line));
        if (!title || text.length < 60) continue;
        const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime") || "";
        const published = /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0,10) : "";
        posts.set("preview:" + title + "\n" + text, {
          url: searchUrl.href, title: title.slice(0,300), text: text.slice(0,30000),
          published, date_kind: published ? "published" : "unknown", content_kind:"snippet"
        });
        break;
      }
      if (posts.size >= 30) break;
    }
  }
  const empty = !posts.size && /no results found|no results for|couldn.t find any results/i.test(root.innerText);
  return {posts:Array.from(posts.values()),empty,diagnostic:
    "Detected "+Math.max(headings.length,menus.length)+" post headings or menus and "+new Set(markers.map(m=>m.id)).size+" identifiable post links."};
}
