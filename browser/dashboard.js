if (location.pathname === "/" && document.title.startsWith("HireMate")) {
  document.documentElement.dataset.hiremateBrowser = "ready";
  document.documentElement.dataset.hiremateProgress = "1";
  document.documentElement.dataset.hiremateRecheck = "4";
  const active = new Map();
  let scanning = false;

  document.addEventListener("hiremate-search", async event => {
    const target = event.detail?.target;
    if (scanning || active.size >= 2 || (!target && active.size)) return;
    scanning = !target;
    let pause;
    function stopBatch(reason) {
      pause = reason;
      for (const other of active.keys()) other.abort(new Error(reason));
    }
    const prefix = target ? event.detail.position+" · " : "";
    let success = false;
    let resultStatus;
    document.dispatchEvent(new Event("hiremate-started"));
    const notice = document.querySelector("#notice");
    const clock = document.querySelector("#scanClock");
    const started = Date.now();
    let lastUpdate = started;
    let importing = false;
    let stage = "Connecting to the browser…";
    let port;
    let pollTimer;
    const controller = new AbortController();

    active.set(controller, prefix + stage);

    function update(message) {
      if (stage !== message) lastUpdate = Date.now();
      stage = message;
      active.set(controller, prefix + stage);
      notice.textContent = [...active.values()].join("\n");
    }
    function tick() {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const idle = Math.floor((Date.now() - lastUpdate) / 1000);
      if (clock) clock.textContent = elapsed + "s elapsed" +
        (idle >= 20 ? " · No new update for " + idle + "s" : "");
      if (idle >= (importing ? 180 : 90)) {
        const help = importing ? "HireMate is still waiting for the server. Refresh to check for saved posts before retrying." :
          "Check the open LinkedIn tab for a sign-in prompt, then select Find posts in my browser to retry.";
        controller.abort(new Error("No update while " + stage.replace(/[… .]+$/, "").toLowerCase() + ". " + help));
      }
    }
    const timer = setInterval(tick,1000);
    try {
      update(stage);
      tick();
      port = chrome.runtime.connect({name:"hiremate-search"});
      const posts = await new Promise((resolve,reject) => {
        controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true});
        port.onDisconnect.addListener(()=>{
          const error = chrome.runtime.lastError;
          reject(Error(error ? "Lost the connection to the extension. Refresh HireMate and retry." :
            "The browser stopped checking posts. Select Find posts in my browser to retry."));
        });
        port.onMessage.addListener(message=>{
          if (message.status) update(message.status);
          else if (message.error) {
            if (message.pause) stopBatch(message.error);
            reject(Error(message.error));
          }
          else if (Array.isArray(message.posts)) resolve(message.posts);
        });
        port.postMessage(target ? {target} : {url:event.detail});
      });
      importing = true;
      update("Saving " + posts.length + " " + (posts.length===1 ? "post" : "posts") + " and checking résumé matches…");
      port.disconnect();
      port = null;
      const scanId = crypto.randomUUID();
      let polling = false;
      pollTimer = setInterval(async()=>{
        if (polling) return;
        polling = true;
        try {
          const status = await fetch("/api/browser-progress/"+scanId,{signal:AbortSignal.timeout(5000)});
          if (!status.ok) return;
          const {completed,total,retry_in} = await status.json();
          if (importing && total>0 && Number.isInteger(completed)) {
            const progress = completed+" of "+total+" matches finished";
            update(retry_in > 0 ? "Vertex is busy. Retrying in "+retry_in+"s · "+progress : "Checking résumés · "+progress);
          }
        } catch { /* The import request and inactivity timer handle a stopped server. */ }
        finally { polling = false; }
      },2000);
      const response = await navigator.locks.request("hiremate-browser-import", {signal:controller.signal}, async()=>{
        controller.signal.throwIfAborted();
        const response = await fetch("/api/browser-results", {
          method:"POST", headers:{"Content-Type":"application/json","X-HireMate":"1","X-HireMate-Scan":scanId,...(target ? {"X-HireMate-Recheck":target.id} : {})},
          body:JSON.stringify(posts), signal:controller.signal
        });
        if (response.status===429) stopBatch("Résumé matching reached its retry limit. Try the remaining leads later.");
        return response;
      });
      const data = await response.json().catch(()=>null);
      if (!response.ok || !Number.isInteger(data?.checked) || !Number.isInteger(data?.new)) {
        throw Error(typeof data?.detail==="string" ? data.detail :
          "HireMate could not finish this import. Check the saved posts below and try again.");
      }
      const imported = data.new === 1 ? "1 new post added" : data.new + " new posts added";
      const checked = data.checked === 1 ? "1 LinkedIn post checked" : data.checked + " LinkedIn posts checked";
      success = true;
      resultStatus = data.status;
      notice.textContent = target ? prefix + data.status : checked + " · " + imported;
      document.dispatchEvent(new Event("hiremate-results"));
    } catch (error) {
      notice.textContent = (controller.signal.reason || error).message;
      if (importing) document.dispatchEvent(new Event("hiremate-results"));
    } finally {
      importing = false;
      clearInterval(pollTimer);
      clearInterval(timer);
      if (clock) clock.textContent = "";
      port?.disconnect();
      active.delete(controller);
      if (!target) scanning = false;
      document.dispatchEvent(new CustomEvent("hiremate-finished",{detail:{id:target?.id,success,status:resultStatus,pause:pause || (controller.signal.aborted && controller.signal.reason?.message)}}));
    }
  });
}
