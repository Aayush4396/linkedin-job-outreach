import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import settings as cfg
from .storage import transact

__all__ = [
    "attachment",
    "save",
]


def command(args):
    subprocess.run(args, check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def extract(path, work):
    suffix = path.suffix
    if suffix == ".txt":
        raw = path.read_bytes()
        return raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    if suffix == ".doc":
        target = work / "word"
        target.mkdir()
        command(["libreoffice", "-env:UserInstallation=" + (work / "profile").as_uri(),
                 "--headless", "--convert-to", "docx", "--outdir", str(target), str(path)])
        path = target / "resume.docx"
        suffix = ".docx"
    if suffix == ".docx":
        import zipfile
        from defusedxml import ElementTree
        with zipfile.ZipFile(path) as doc:
            entry = doc.getinfo("word/document.xml")
            if entry.file_size > 8_000_000:
                raise ValueError("Word document is too large")
            root = ElementTree.fromstring(doc.read(entry))
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        return "\n".join("".join(node.text or "" for node in p.iter(ns + "t")) for p in root.iter(ns + "p"))
    from pypdf import PdfReader
    pages = PdfReader(path).pages
    if len(pages) > 25:
        raise ValueError("Choose a résumé under 26 pages")
    pieces = []
    for i, page in enumerate(pages, 1):
        text = page.extract_text() or ""
        if not text.strip():
            prefix = str(work / "ocr")
            command(["pdftoppm", "-f", str(i), "-l", str(i), "-singlefile", "-scale-to", "1800", "-png", str(path), prefix])
            command(["tesseract", prefix + ".png", prefix])
            text = Path(prefix + ".txt").read_text(encoding="utf8")
        pieces.append(text)
    return "\n".join(pieces)


def object_store():
    from google.cloud import storage
    return storage.Client(project=cfg.PROJECT).bucket(cfg.BUCKET)


def save(name, raw):
    name = Path(name.replace("\\", "/")).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".doc", ".docx", ".txt", ".pdf"}:
        raise ValueError("Choose a Word, text, or PDF file")
    version = hashlib.sha256(raw).hexdigest() + suffix
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        path = work / ("resume" + suffix)
        path.write_bytes(raw)
        text = extract(path, work).strip()
        if not text or "\x00" in text or len(text) > 100_000:
            raise ValueError("Could not read a usable résumé")
        if cfg.BUCKET:
            object_store().blob("resumes/" + version).upload_from_filename(str(path))
        else:
            folder = Path("data/resumes")
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / version
            with tempfile.NamedTemporaryFile(dir=folder, delete=False) as out:
                out.write(raw)
            Path(out.name).replace(target)
    resume = {"name": name, "version": version, "text": text}
    transact(lambda get, put: put("settings", "resume", resume))
    return resume


def attachment(version):
    if cfg.BUCKET:
        return object_store().blob("resumes/" + version).download_as_bytes()
    return (Path("data/resumes") / version).read_bytes()
