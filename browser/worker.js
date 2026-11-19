// A discovery scan reserves both slots for its original-post checks.
const activeJobs = new Map();
class PauseBatch extends Error {}
let nextTabStart = 0;

// Space navigation starts across both lookup slots in this extension worker.
async function openLinkedInTab(options, signal) {
  signal.throwIfAborted();
  const now = performance.now();
  const start = Math.max(now, nextTabStart);
  nextTabStart = start + 1000;
  if (start > now) await new Promise(resolve=>setTimeout(resolve, start - now));
  signal.throwIfAborted();
  return chrome.tabs.create(options);
}

async function tabReady(tabId, signal) {
  signal.throwIfAborted();
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== "complete") return false;
  let message;
  if (/^https:\/\/www\.linkedin\.com\/(?:login|signup|authwall|checkpoint|uas)(?:[/?#]|$)/.test(tab.url || "")) {
    message = "LinkedIn requested sign-in or account verification. The batch has stopped.";
  } else {
    const [navigation] = await chrome.scripting.executeScript({target:{tabId},func:()=>
      performance.getEntriesByType("navigation")[0]?.responseStatus});
    if ([403,429,999].includes(navigation?.result))
      message = "LinkedIn limited access to this page. The batch has stopped.";
  }
  if (message) {
    const error = new PauseBatch(message);
    for (const job of activeJobs.keys()) job.abort(error);
    throw error;
  }
  signal.throwIfAborted();
  return true;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "hiremate-search") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(()=>controller.abort());
  async function start(message) {
    port.onMessage.removeListener(start);
    const report = status => {
      controller.signal.throwIfAborted();
      port.postMessage({status});
    };
    const slots = message.target ? 1 : 2;
    const used = [...activeJobs.values()].reduce((sum, value)=>sum + value, 0);
    if (used + slots > 2) {
      port.postMessage({error:"Another browser search is running. Wait for it to finish.",pause:true});
      return;
    }
    activeJobs.set(controller, slots);
    try {
      const posts = message.target ? await recheck(message.target, port.sender, report, controller.signal) :
        await search(message, port.sender, report, controller.signal);
      controller.signal.throwIfAborted();
      port.postMessage({posts});
    } catch (error) {
      if (controller.signal.reason instanceof PauseBatch) {
        port.postMessage({error:controller.signal.reason.message,pause:true});
        return;
      }
      if (controller.signal.aborted) return;
      if (message.target) {
        const verification_note = ("Retry failed: " + error.message).slice(0,240);
        port.postMessage({posts:[{...message.target, verification_note}]});
      } else {
        port.postMessage({error:error.message});
      }
    } finally {
      activeJobs.delete(controller);
    }
  }
  port.onMessage.addListener(start);
});

function matchesSavedPreview(saved, candidate) {
  // Keep addresses, links and skill names such as C++ intact.
  const words = text => (text.normalize("NFKC").match(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[\p{L}\p{N}][\p{L}\p{M}\p{N}]*[+#]*/giu) || [])
    .map(word => /^https?:/i.test(word) ? word.replace(/[.,;!?]+$/, "") : word.toLowerCase());
  const preview = words(saved.text);
  if (preview.length < 8 || preview.join(" ") === words(saved.title).join(" ")) return false;
  return [candidate.text, candidate.preview_text].some(text => {
    if (!text) return false;
    const actual = words(text);
    return (actual.length === preview.length || (actual.length > preview.length && preview.join(" ").length >= 100)) &&
      preview.every((word, index) => word === actual[index]);
  });
}

async function recheck(saved, sender, report, signal) {
  const dashboard = new URL(sender.url);
  const url = new URL(saved.url);
  if (dashboard.protocol !== "http:" || !["localhost","127.0.0.1"].includes(dashboard.hostname) ||
      dashboard.pathname !== "/" || url.origin !== "https://www.linkedin.com")
    throw Error("Open your local HireMate dashboard first.");
  let post = {...saved};
  if (url.pathname === "/search/results/content/") {
    const query = new URL("/search/results/content/", url.origin);
    query.searchParams.set("keywords", saved.title.split(/\s+/).slice(0,12).join(" "));
    report("Looking for this saved post on LinkedIn…");
    async function lookup() {
      const results = await search({url:query.href, targeted:true}, sender, report, signal);
      return results.filter(row => matchesSavedPreview(saved, row));
    }
    let matches = await lookup();
    if (!matches.length) {
      const body = saved.text.replace(saved.title, "");
      const phrases = body.split(/[\n.!?]+/).map(line => line.match(/[\p{L}\p{M}][\p{L}\p{M}\p{N}+#-]*/gu) || []);
      const phrase = phrases.find(words => words.length >= 6);
      if (phrase) {
        query.searchParams.set("keywords", phrase.slice(0,8).join(" "));
        report("Looking for a phrase from the saved post…");
        matches = await lookup();
      }
    }
    if (matches.length !== 1) {
      post.verification_note = matches.length ? "Several posts matched the saved preview." :
        "The saved preview could not be found in the current search results.";
      return [post];
    }
    if (new URL(matches[0].url).pathname.startsWith("/search/")) {
      if (hasPostDate(matches[0])) {
        post.published = matches[0].published;
        post.date_kind = matches[0].date_kind;
      }
      post.verification_note = matches[0].verification_note || "The matching preview still has no direct post link.";
      return [post];
    }
    post = {...matches[0], preview_text:saved.text};
  } else if (!/^\/(?:feed\/update|posts|groups)\//.test(url.pathname)) {
    throw Error("This lead needs a LinkedIn post link.");
  }
  report("Checking the original LinkedIn post…");
  await checkOriginal(post, signal);
  signal.throwIfAborted();
  return [post];
}

const postAgeSelector = "time,.update-components-actor__sub-description,.feed-shared-actor__sub-description,[data-view-name='feed-actor-sub-description']";

function applyVisibleAge(post) {
  const label = post.age_label;
  delete post.age_label;
  if (post.date_kind === "published" || !label) return;
  const match = label.trim().match(/^(\d+)\s*(m|h|d|w)(?:\s*(?:[·•]|$))/i);
  if (!match) return;
  const days = Number(match[1]) * ({m:0,h:0,d:1,w:7})[match[2].toLowerCase()];
  if (!Number.isSafeInteger(days) || days > 36500) return;
  const date = new Date();
  date.setDate(date.getDate() - days);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  Object.assign(post,{published:localDate.toISOString().slice(0,10),date_kind:"relative"});
}

const hasPostDate = post => post.date_kind === "published" || post.date_kind === "relative";

async function search(message, sender, report, signal) {
  const dashboard = new URL(sender.url);
  const url = new URL(message.url);
  if (dashboard.protocol !== "http:" || !["localhost","127.0.0.1"].includes(dashboard.hostname) ||
      dashboard.pathname !== "/" || url.origin !== "https://www.linkedin.com" ||
      url.pathname !== "/search/results/content/") throw Error("Open your local HireMate dashboard first.");
  report("Opening LinkedIn. Return to HireMate to follow the search.");
  const tab = await openLinkedInTab({url: url.href, active:!message.targeted},signal);
  try {
    // Keep the results visible so the user can inspect them or complete sign-in.
    let diagnostic = 'The results page did not finish loading.';
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      signal.throwIfAborted();
      if (!await tabReady(tab.id,signal)) continue;
      report("Reading LinkedIn search results…");
      const scan = await readResults(tab.id,attempt<29,report,signal);
      diagnostic = scan.result.diagnostic || diagnostic;
      if (scan.result.error) throw Error(scan.result.error);
      if (scan.result.posts.length || scan.result.empty) {
        const posts = scan.result.posts;
        posts.forEach(applyVisibleAge);
        if (message.targeted) return posts;
        const originals = posts.filter(post => !new URL(post.url).pathname.startsWith("/search/") &&
          (!hasPostDate(post) || post.content_kind !== "full"));
        let next = 0, completed = 0;
        async function verify() {
          while (next < originals.length) {
            signal.throwIfAborted();
            const post = originals[next++];
            report("Checking original posts · "+completed+" of "+originals.length+" finished");
            await checkOriginal(post, signal);
            completed++;
          }
        }
        const outcomes = await Promise.allSettled([verify(), verify()]);
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        return posts;
      }
    }
    throw Error("Could not import LinkedIn results. " + diagnostic);
  } finally {
    if (message.targeted) await chrome.tabs.remove(tab.id).catch(()=>{});
  }
}

async function readResults(tabId, allowExpansion, report, signal) {
  // Menu lookups run in the page and can take several seconds per result.
  // Sample their actual position while the main script is still executing.
  let active = true;
  let polling = false;
  let previous = "";
  const timer = setInterval(async () => {
    if (polling || signal.aborted) return;
    polling = true;
    try {
      const [state] = await chrome.scripting.executeScript({
        target:{tabId}, func:()=>document.documentElement.dataset.hiremateReadPosition
      });
      const position = state?.result;
      if (active && !signal.aborted && position!==previous && /^\d+ of \d+$/.test(position)) {
        previous = position;
        report("Reading LinkedIn result " + position + "…");
      }
    } catch { /* The main read reports navigation and tab errors. */ }
    finally { polling = false; }
  },1500);
  try {
    const [scan] = await chrome.scripting.executeScript({
      target:{tabId},world:"MAIN",func:readPosts,args:[allowExpansion,postAgeSelector]
    });
    return scan;
  } finally {
    active = false;
    clearInterval(timer);
  }
}

async function checkOriginal(post, signal) {
  const url = new URL(post.url);
  if (url.origin !== "https://www.linkedin.com" || url.pathname.startsWith("/search/")) return;
  let originalTab;
  try {
    originalTab = await openLinkedInTab({url:url.href, active:false},signal);
    for (let attempt=0; attempt<20; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,400));
      signal.throwIfAborted();
      if (!await tabReady(originalTab.id,signal)) continue;
      const [scan] = await chrome.scripting.executeScript({
        target:{tabId:originalTab.id}, func:publicationRecord, args:[post.url,postAgeSelector]
      });
      const result = scan.result;
      if (result.stop) {
        post.verification_note = result.stop;
        return;
      }
      Object.assign(post,result.evidence);
      applyVisibleAge(post);
      if (post.content_kind==="full" && hasPostDate(post)) {
        post.verification_note = post.date_kind==="relative" ?
          "Read the original post and its visible age." : "Confirmed the original post, publication date and complete text.";
        return;
      }
    }
    post.verification_note = hasPostDate(post) ? "Opened the original; the complete text is still unconfirmed." :
      "Opened the original; the publication date is still unconfirmed.";
  } catch {
    signal.throwIfAborted();
    post.verification_note = "The original post could not be read in the signed-in browser.";
  } finally {
    if (originalTab) await chrome.tabs.remove(originalTab.id).catch(()=>{});
  }
}

function publicationRecord(original, ageSelector="time") {
  function postId(value) {
    let url;
    try { url = new URL(value, "https://www.linkedin.com"); } catch { return ""; }
    if (url.origin !== "https://www.linkedin.com") return "";
    if (/^\/groups\/\d+\/?$/.test(url.pathname)) {
      return url.searchParams.get("highlightedUpdateUrn")?.match(/^urn:li:activity:(\d{15,21})$/)?.[1] || "";
    }
    return url.pathname.match(/^\/feed\/update\/urn:li:(?:activity|share|ugcPost):(\d{15,21})\/?$/)?.[1] ||
      url.pathname.match(/^\/posts\/[^/]*-(\d{15,21})(?:-[^/]*)?\/?$/)?.[1] || "";
  }
  const id = postId(original);
  if (/^\/(?:signup|authwall|checkpoint|login|uas)(?:\/|$)/.test(location.pathname)) {
    return {stop:"LinkedIn requested sign-in when opening the original post."};
  }
  if (!id || postId(location.href)!==id) return {stop:"LinkedIn opened a different page from the requested post."};
  const evidence = {};
  function addDate(date) {
    if (typeof date==="string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(date) && Number.isFinite(Date.parse(date))) {
      Object.assign(evidence,{published:date.slice(0,10),date_kind:"published"});
    }
  }
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (canonical && postId(canonical)===id) {
    addDate(document.querySelector('meta[property="article:published_time"]')?.getAttribute("content"));
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(script.textContent); } catch { continue; }
    const nodes = [data].flat().flatMap(node=>[node,...[node?.["@graph"]].flat()]);
    for (const node of nodes) {
      if (![node?.["@type"]].flat().includes("SocialMediaPosting")) continue;
      const links = [node.url,node["@id"],node.mainEntityOfPage?.["@id"],node.mainEntityOfPage];
      if (!links.some(link=>typeof link==="string" && postId(link)===id)) continue;
      addDate(node.datePublished);
      if (typeof node.articleBody==="string" && node.articleBody.trim() && node.articleBody.length<=30000) {
        Object.assign(evidence,{text:node.articleBody.trim(),content_kind:"full"});
      }
    }
  }
  const cards = Array.from(document.querySelectorAll("[data-urn],[data-activity-urn],[data-id]"))
    .filter(node=>["data-urn","data-activity-urn","data-id"].some(attr=>
      ["activity","share","ugcPost"].some(type=>node.getAttribute(attr)==="urn:li:"+type+":"+id)));
  for (const card of cards) {
    if (card.querySelector("article,[role=article],[data-urn^='urn:li:activity:']")) continue;
    const body = card.querySelector(".update-components-text,.feed-shared-update-v2__description,[data-view-name='feed-commentary'],[data-testid='expandable-text-box']");
    if (!body) continue;
    const stamp = card.querySelector("time[datetime]");
    if (!evidence.published && stamp) addDate(stamp.getAttribute("datetime"));
    const age = card.querySelector(ageSelector);
    if (!evidence.published && age?.getClientRects().length) evidence.age_label = age.innerText;
    const more = Array.from(card.querySelectorAll("button,[role=button]")).find(button=>
      /^(?:(?:see|show|read)\s+)?[.…\s]*more(?:,?\s+expand.*)?$/i.test((button.getAttribute("aria-label") || button.innerText || "").trim()));
    if (more && !more.dataset.hiremateExpanded) {
      more.dataset.hiremateExpanded="true";
      more.click();
    }
    const text = body.innerText.trim();
    if (!more && text && text.length<=30000 && !evidence.text) Object.assign(evidence,{text,content_kind:"full"});
  }
  return {evidence};
}

async function readPosts(allowExpansion=true, ageSelector="time") {
  delete document.documentElement.dataset.hiremateReadPosition;
  if (!location.pathname.startsWith("/search/results/content")) {
    return {error:"Open LinkedIn, complete sign-in if prompted, then retry from HireMate."};
  }
  const root = document.querySelector("main,[role=main]") || document.body;
  const bodySelector = ".update-components-text,.feed-shared-update-v2__description,[data-testid='expandable-text-box'],[data-testid='expandable-text'],[data-view-name='feed-commentary']";
  const markerSelector = "a[href*='highlightedUpdateUrn='],a[href*='/feed/update/'],a[href*='/posts/'],[data-urn],[data-activity-urn],[data-id],[componentkey*='urn:li:']";
  const headingSelector = "h1,h2,h3,h4,[role=heading]";
  function idOf(node) {
    const attr = ["data-urn","data-activity-urn","data-id","componentkey"].map(k=>node.getAttribute(k)||"").join(" ");
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
  function actionPermalink(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    let url;
    try { url = new URL(value, location.origin); } catch { return ""; }
    if (url.protocol !== "https:" || !["linkedin.com","www.linkedin.com"].includes(url.hostname) ||
        url.port || url.username || url.password) return "";
    url.hostname = "www.linkedin.com";
    // Some share controls percent-encode the URN separators in feed links.
    if (url.pathname.startsWith("/feed/update/")) url.pathname = url.pathname.replace(/%3a/gi,":");
    return idOf({href:url.href,getAttribute:()=>""}) ? url.href : "";
  }
  // LinkedIn can generate the URL inside its copy handler. Capture just that
  // command's outgoing permalink; never read the user's clipboard.
  async function copyPermalink(button) {
    let finish;
    const captured = new Promise(resolve=>{finish=resolve});
    const restore = [];
    function accept(text) {
      const href = actionPermalink(text);
      if (!href) return false;
      finish(href);
      return true;
    }
    function wrap(target, name, interceptor) {
      if (!target || typeof target[name]!=="function") return;
      const prior = Object.getOwnPropertyDescriptor(target,name);
      const original = target[name];
      const wrapped = function(...args) {
        return interceptor.call(this,original,args);
      };
      Object.defineProperty(target,name,{configurable:true,writable:true,value:wrapped});
      restore.push(()=>{
        if (target[name]!==wrapped) return;
        if (prior) Object.defineProperty(target,name,prior);
        else delete target[name];
      });
    }
    let timer;
    try {
      wrap(navigator.clipboard,"writeText",function(original,args) {
        return accept(args[0]) ? Promise.resolve() : original.apply(this,args);
      });
      wrap(document,"execCommand",function(original,args) {
        if (String(args[0]).toLowerCase()==="copy") {
          const field = document.activeElement;
          const selected = field && /^(INPUT|TEXTAREA)$/.test(field.tagName) ?
            field.value.slice(field.selectionStart,field.selectionEnd) : window.getSelection()?.toString();
          if (accept(selected)) return true;
        }
        return original.apply(this,args);
      });
      const timeout = new Promise(resolve=>{timer=setTimeout(()=>resolve(""),800)});
      button.click();
      return await Promise.race([captured,timeout]);
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
      for (const reset of restore.reverse()) reset();
    }
  }
  async function menuPermalink(card) {
    const menu = menus.find(button=>card.contains(button));
    if (!menu) return "";
    if (menu.dataset.hiremateLinkChecked) return menu.dataset.hiremateLink || "";
    menu.dataset.hiremateLinkChecked = "true";
    const visibleMenus = () => Array.from(document.querySelectorAll('[role=menu],.artdeco-dropdown__content'))
      .filter(node=>node.getClientRects().length);
    const existing = new Set(visibleMenus());
    const wasOpen = menu.getAttribute("aria-expanded")==="true";
    let copyTried = false;
    if (!wasOpen) menu.click();
    try {
      for (let i=0; i<12; i++) {
        await new Promise(resolve=>setTimeout(resolve,100));
        const owned = (menu.getAttribute("aria-controls") || menu.getAttribute("aria-owns") || "")
          .split(/\s+/).map(id=>document.getElementById(id)).filter(node=>node?.getClientRects().length);
        const labelled = menu.id ? Array.from(document.querySelectorAll('[aria-labelledby]')).filter(node=>
          node.getAttribute("aria-labelledby").split(/\s+/).includes(menu.id) && node.getClientRects().length) : [];
        const panels = owned.length ? owned : labelled.length ? labelled : visibleMenus().filter(node=>!existing.has(node));
        if (panels.length!==1) continue;
        if (!copyTried) menu.dataset.hiremateCheck = "The post menu opened without a usable link to the original.";
        for (const item of panels[0].querySelectorAll("[data-clipboard-text]")) {
          const href = actionPermalink(item.getAttribute("data-clipboard-text"));
          if (href) {
            menu.dataset.hiremateLink = href;
            return href;
          }
        }
        for (const link of panels[0].querySelectorAll("a[href]")) {
          if (/^(?:view|open|go to|link to|copy link to)(?: this)? post$/i.test(link.innerText.trim()) &&
              idOf(link) && new URL(link.href).origin===location.origin) {
            menu.dataset.hiremateLink = link.href;
            return link.href;
          }
        }
        const actions = Array.from(panels[0].querySelectorAll('button,[role=button],[role=menuitem],a'));
        const copy = actions.find(item=>[item.getAttribute("aria-label"),item.innerText].some(label=>
          /^copy (?:post link|link(?: to (?:this )?post)?)$/i.test((label || "").trim())));
        const embed = actions.find(item=>[item.getAttribute("aria-label"),item.innerText].some(label=>
          /^embed (?:this )?post$/i.test((label || "").trim())));
        if (copy && !copyTried) {
          copyTried = true;
          const href = await copyPermalink(copy);
          if (href) {
            menu.dataset.hiremateLink = href;
            return href;
          }
          menu.dataset.hiremateCheck = "LinkedIn’s copy action did not provide a direct post link.";
          if (!embed) break;
          // Copy may dismiss or replace the menu. Look up Embed again in this post’s panel.
          if (!panels[0].isConnected || !panels[0].getClientRects().length) menu.click();
          i = -1;
          continue;
        }
        const visibleDialog = () => Array.from(document.querySelectorAll('[role=dialog],dialog[open]'))
          .find(node=>node.getClientRects().length);
        if (embed && !visibleDialog()) {
          menu.dataset.hiremateCheck = "LinkedIn offered an embed, but its original post link could not be read.";
          embed.click();
          let dialog;
          try {
            for (let wait=0; wait<8; wait++) {
              await new Promise(resolve=>setTimeout(resolve,100));
              dialog = visibleDialog();
              if (!dialog || !/\bembed\b/i.test(dialog.innerText)) continue;
              const code = dialog.querySelector("textarea")?.value || dialog.querySelector("code")?.textContent || "";
              const src = code.match(/<iframe\b[^>]*\bsrc=["']([^"']+)/i)?.[1] || dialog.querySelector("iframe")?.getAttribute("src");
              if (!src) continue;
              let embedUrl;
              try { embedUrl = new URL(src, location.origin); } catch { continue; }
              const match = embedUrl.pathname.match(/^\/embed\/feed\/update\/(urn:li:(?:share|ugcPost|activity):\d{15,21})\/?$/);
              if (embedUrl.origin===location.origin && match) {
                menu.dataset.hiremateLink = location.origin+"/feed/update/"+match[1]+"/";
                return menu.dataset.hiremateLink;
              }
            }
          } finally {
            if (dialog && /\bembed\b/i.test(dialog.innerText)) {
              dialog.querySelector('button[aria-label*="ismiss"],button[aria-label*="lose"]')?.click();
            }
          }
          break;
        }
      }
      return "";
    } finally {
      if (!wasOpen && (menu.getAttribute("aria-expanded")==="true" || visibleMenus().some(node=>!existing.has(node)))) menu.click();
    }
  }
  function dateEvidence(card) {
    const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime") || "";
    if (/^\d{4}-\d{2}-\d{2}/.test(stamp)) return {published:stamp.slice(0,10),date_kind:"published"};
    const age = card.querySelector(ageSelector);
    return {published:"",date_kind:"unknown",age_label:age?.getClientRects().length ? age.innerText : ""};
  }
  function expandControl(card) {
    return Array.from(card.querySelectorAll("button,[role=button]")).find(button => {
      const label = (button.getAttribute("aria-label") || button.innerText || "").trim();
      return /^(?:(?:see|show|read)\s+)?[.…\s]*more(?:,?\s+expand.*)?$/i.test(label);
    });
  }
  function expandOnce(control) {
    if (!allowExpansion || !control || control.dataset.hiremateExpanded) return false;
    control.dataset.hiremateExpanded = "true";
    control.click();
    return true;
  }
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
      const expand = expandControl(card);
      if (expandOnce(expand)) {
        return {posts:[], diagnostic:"Waiting for LinkedIn to expand a post."};
      }
      const directLink = markers.find(m=>m.id===id && m.node.href && card.contains(m.node));
      const record = {url:directLink?.node.href || "https://www.linkedin.com/feed/update/urn:li:activity:"+id+"/",
        title:text.split("\n").find(line=>/hiring|vacancy|opening/i.test(line))?.slice(0,300) || text.split("\n")[0].slice(0,300),
        text:text.slice(0,30000),...dateEvidence(card),
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
    for (const [index,boundary] of boundaries.entries()) {
      document.documentElement.dataset.hiremateReadPosition = (index+1) + " of " + boundaries.length;
      for (let card = boundary.parentElement; card && card !== root; card = card.parentElement) {
        if (boundaries.some(other => other !== boundary && card.contains(other)) ||
            markers.some(marker => card.contains(marker.node))) break;
        const body = card.querySelector(bodySelector);
        const text = (body || card).innerText?.trim() || "";
        if (!body && !headings.some(h => card.contains(h)) && !menus.some(b => card.contains(b))) continue;
        const title = text.split("\n").find(line => /\b(hiring|vacanc\w*|opening|join our team)\b/i.test(line));
        if (!title || text.length < 60) continue;
        if (expandOnce(expandControl(card))) {
          return {posts:[], diagnostic:"Waiting for LinkedIn to expand a search preview."};
        }
        // The controls can sit beside the text container. Look within the same
        // result only, stopping before a neighbouring post or identified card.
        let controls = card;
        while (!menus.some(menu=>controls.contains(menu))) {
          const parent = controls.parentElement;
          if (!parent || parent===root || boundaries.some(other=>other!==boundary && parent.contains(other)) ||
              markers.some(marker=>parent.contains(marker.node)) || menus.filter(menu=>parent.contains(menu)).length>1) break;
          controls = parent;
        }
        const original = await menuPermalink(controls);
        const menu = menus.find(button=>controls.contains(button));
        posts.set(original || "preview:" + title + "\n" + text, {
          ...(original ? {preview_text:text.slice(0,30000)} : {}),
          verification_note:original ? "Found the original link in the post menu." :
            menu?.dataset.hiremateCheck || (menu ? "The post menu could not be read." : "No post menu or original link was found on this search card."),
          url: original || searchUrl.href, title: title.slice(0,300), text: text.slice(0,30000),
          ...dateEvidence(controls), content_kind:"snippet"
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
