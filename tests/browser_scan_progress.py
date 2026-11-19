"""Exercise scan progress, lost connections and retry timeouts in the dashboard."""
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chrome")
    page = browser.new_page()
    page.route("**/*", lambda route: route.fulfill(body='<title>HireMate</title><p id="notice"></p><small id="scanClock"></small>',content_type="text/html"))
    page.goto("http://localhost/")
    page.clock.install()
    page.evaluate("""() => {
      const event = () => ({addListener(fn){this.send=fn}});
      window.chrome = {runtime:{connect(){
        window.port = {onMessage:event(),onDisconnect:event(),postMessage(){},disconnect(){}};
        return port;
      }}};
      window.finished=0;
      document.addEventListener("hiremate-finished",()=>finished++);
      window.start=()=>document.dispatchEvent(new CustomEvent("hiremate-search",{detail:"url"}));
    }""")
    page.add_script_tag(path=str(root / "browser/dashboard.js"))
    page.evaluate("start()")
    page.evaluate("port.onMessage.send({status:'Checking original post 2 of 5…'})")
    assert "2 of 5" in page.locator("#notice").inner_text()
    page.clock.fast_forward(21000)
    assert "No new update" in page.locator("#scanClock").inner_text()
    page.clock.fast_forward(70000)
    assert "retry" in page.locator("#notice").inner_text()
    assert page.evaluate("finished") == 1
    page.evaluate("start(); port.onDisconnect.send()")
    assert page.evaluate("finished") == 2
    page.evaluate("""() => {
      window.fetch=(url)=>url.includes('browser-progress') ?
        Promise.resolve(new Response('{"completed":1,"total":3,"retry_in":12}')) :
        new Promise(resolve=>window.saved=()=>resolve(new Response('{"checked":1,"new":1}')));
      start();port.onMessage.send({posts:[{}]});
    }""")
    assert "résumé" in page.locator("#notice").inner_text()
    page.clock.fast_forward(2000)
    page.wait_for_function("document.querySelector('#notice').textContent.includes('Retrying in 12s')")
    page.evaluate("saved()")
    assert "1 new post added" in page.locator("#notice").inner_text()
    assert page.evaluate("finished") == 3
    page.evaluate("""() => {
      window.fetch=async()=>new Response("Internal Server Error",{status:500});
      start(); port.onMessage.send({posts:[]});
    }""")
    page.wait_for_function("finished===4")
    assert "Check the saved posts" in page.locator("#notice").inner_text()
    page.evaluate("""() => {
      window.fetch=async()=>new Response('{"checked":1,"new":0,"status":"Unverified lead"}');
      document.addEventListener("hiremate-finished", e=>window.outcome=e.detail,{once:true});
      document.dispatchEvent(new CustomEvent("hiremate-search",{detail:{target:{id:"lead"},position:"Lead 1 of 1"}}));
      port.onMessage.send({posts:[{}]});
    }""")
    page.wait_for_function("window.outcome?.success === true")
    assert page.evaluate("window.outcome.status") == "Unverified lead"

    # Exercise both dashboard retry workers with real DOM events and Web Locks.
    page = browser.new_page()
    dashboard = (root / "app/index.html").read_text(encoding="utf8")
    page.route("http://localhost/", lambda r: r.fulfill(body=dashboard, content_type="text/html"))
    leads = [dict(id=str(i), status="Unverified lead", url="https://www.linkedin.com/search/results/content/",
                  title="Role", text="Hiring", published="", content_kind="snippet") for i in range(5)]
    page.route("**/api/posts", lambda r: r.fulfill(json=dict(posts=leads, dry=True, search={}, sent_today=0)))
    page.goto("http://localhost/")
    page.evaluate("""() => {
      const event=()=>({addListener(fn){this.send=fn}});
      window.ports=[];
      window.chrome={runtime:{connect(){
        const port={onMessage:event(),onDisconnect:event(),disconnect(){},
          postMessage(message){this.id=message.target.id}};
        ports.push(port);return port;
      }}};
      const realFetch=window.fetch.bind(window);
      window.imports=[];
      window.fetch=(url,opts)=>url==='/api/browser-results' ? new Promise(resolve=>{
        imports.push({id:opts.headers['X-HireMate-Recheck'],done:code=>resolve(new Response(
          JSON.stringify({checked:1,new:0,status:'Unverified lead'}),{status:code}))});
      }) : realFetch(url,opts);
    }""")
    page.add_script_tag(path=str(root / "browser/dashboard.js"))
    page.locator("#recheck").click()
    assert page.evaluate("ports.map(p=>p.id)") == ["0","1"]
    page.evaluate("ports[1].onMessage.send({posts:[]}); ports[0].onMessage.send({posts:[]})")
    page.wait_for_function("imports.length===1")
    assert page.evaluate("imports[0].id") == "1"
    page.evaluate("imports[0].done(200)")
    page.wait_for_function("ports.length===3 && imports.length===2")
    page.evaluate("imports[1].done(429)")
    page.wait_for_function("!document.querySelector('#recheck').disabled")
    assert page.evaluate("ports.length") == 3
    assert "1 of 5 retry results saved" in page.locator("#notice").inner_text()
    assert "retry limit" in page.locator("#notice").inner_text()

print("Progress, delayed update, timeout, disconnection, retry and server error checks passed.")
