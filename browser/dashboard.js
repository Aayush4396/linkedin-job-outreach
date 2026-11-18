if (location.pathname === "/" && document.title.startsWith("HireMate")) {
  document.documentElement.dataset.hiremateBrowser = "ready";
  document.addEventListener("hiremate-search", async event => {
    const notice = document.querySelector("#notice");
    try {
      const result = await chrome.runtime.sendMessage({url: event.detail});
      if (result.error) throw Error(result.error);
      const response = await fetch("/api/browser-results", {
        method: "POST", headers: {"Content-Type":"application/json", "X-HireMate":"1"},
        body: JSON.stringify(result.posts)
      });
      const data = await response.json();
      if (!response.ok) throw Error(typeof data.detail === "string" ? data.detail : "Could not import posts.");
      notice.textContent = data.checked + " posts checked · " + data.new + " new matches";
      document.dispatchEvent(new Event("hiremate-results"));
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      document.dispatchEvent(new Event("hiremate-finished"));
    }
  });
}
