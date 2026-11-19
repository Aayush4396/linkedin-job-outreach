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
    const [scan] = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:readPosts,args:[attempt<29]});
    diagnostic = scan.result.diagnostic || diagnostic;
    if (scan.result.error) throw Error(scan.result.error);
    if (scan.result.posts.length || scan.result.empty) {
      const posts = scan.result.posts;
      for (const post of posts) {
        if (post.date_kind !== "published" || post.content_kind !== "full") {
          await checkOriginal(post);
        }
      }
      return posts;
    }
  }
  throw Error("Could not import LinkedIn results. " + diagnostic);
}

async function checkOriginal(post) {
  const url = new URL(post.url);
  if (url.origin !== "https://www.linkedin.com" || url.pathname.startsWith("/search/")) return;
  let originalTab;
  try {
    originalTab = await chrome.tabs.create({url:url.href, active:false});
    for (let attempt=0; attempt<20; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,400));
      if ((await chrome.tabs.get(originalTab.id)).status!=="complete") continue;
      const [scan] = await chrome.scripting.executeScript({
        target:{tabId:originalTab.id}, func:publicationRecord, args:[post.url]
      });
      const result = scan.result;
      if (result.stop) {
        post.verification_note = result.stop;
        return;
      }
      Object.assign(post,result.evidence);
      if (post.content_kind==="full" && post.date_kind==="published") {
        post.verification_note = "Confirmed the original post, publication date and complete text.";
        return;
      }
    }
    post.verification_note = post.date_kind==="published" ? "Opened the original; the complete text is still unconfirmed." :
      "Opened the original; the publication date is still unconfirmed.";
  } catch {
    post.verification_note = "The original post could not be read in the signed-in browser.";
  } finally {
    if (originalTab) await chrome.tabs.remove(originalTab.id).catch(()=>{});
  }
}

function publicationRecord(original) {
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

async function readPosts(allowExpansion=true) {
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
  // LinkedIn can generate the URL inside its copy handler. Capture just that
  // command's outgoing permalink; never read the user's clipboard.
  async function copyPermalink(button) {
    let finish;
    const captured = new Promise(resolve=>{finish=resolve});
    const restore = [];
    function accept(text) {
      if (typeof text!=="string" || text.length>2048) return false;
      let url;
      try { url = new URL(text.trim()); } catch { return false; }
      if (url.origin!==location.origin || !idOf({href:url.href,getAttribute:()=>""})) return false;
      finish(url.href);
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
        menu.dataset.hiremateCheck = "The post menu opened without a usable link to the original.";
        for (const item of panels[0].querySelectorAll("[data-clipboard-text]")) {
          const href = item.getAttribute("data-clipboard-text");
          if (/^https:\/\/www\.linkedin\.com\//.test(href) && idOf({href,getAttribute:()=>""})) {
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
        if (copy) {
          const href = await copyPermalink(copy);
          if (href) {
            menu.dataset.hiremateLink = href;
            return href;
          }
          menu.dataset.hiremateCheck = "The copy-link command did not return an identifiable LinkedIn post.";
          break;
        }
        const embed = actions
          .find(item=>/^embed (?:this )?post$/i.test(item.innerText.trim()));
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
              const src = dialog.querySelector("iframe")?.getAttribute("src") || code.match(/<iframe\b[^>]*\bsrc=["']([^"']+)/i)?.[1];
              if (!src) continue;
              const embedUrl = new URL(src, location.origin);
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
      const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime") || "";
      const expand = expandControl(card);
      if (expandOnce(expand)) {
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
        if (expandOnce(expandControl(card))) {
          return {posts:[], diagnostic:"Waiting for LinkedIn to expand a search preview."};
        }
        const stamp = card.querySelector("time[datetime]")?.getAttribute("datetime") || "";
        const published = /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0,10) : "";
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
