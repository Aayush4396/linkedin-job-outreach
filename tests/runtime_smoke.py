"""Run inside the production image, using synthetic documents only."""
import os
import pwd
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright
from pypdf import PdfReader

from app.resumes import save


assert pwd.getpwuid(os.getuid()).pw_name == "hiremate"
with TemporaryDirectory() as tmp, sync_playwright() as playwright:
    work = Path(tmp)
    os.chdir(work)
    source = work / "resume.txt"
    source.write_text("Experience preparing payroll reports.", encoding="utf-8")
    subprocess.run(["libreoffice", "--headless", "--convert-to", "doc:MS Word 97",
                    "--outdir", tmp, str(source)], check=True, timeout=60)
    assert "payroll reports" in save("resume.doc", (work / "resume.doc").read_bytes())["text"]
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1100, "height": 200})
    page.set_content('<p style="font: 48px sans-serif">Experience preparing payroll reports.</p>')
    image = page.screenshot()
    import base64
    page.set_content('<img width="700" src="data:image/png;base64,' + base64.b64encode(image).decode() + '">')
    page.locator("img").evaluate("img => img.decode()")
    pdf = page.pdf(path=str(work / "scan.pdf"))
    assert not PdfReader(work / "scan.pdf").pages[0].extract_text().strip()
    assert "payroll reports" in save("scan.pdf", pdf)["text"].lower()
    browser.close()
print("Non-root Chromium, legacy Word conversion and scanned PDF OCR passed.")
