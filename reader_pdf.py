"""Resource-bounded PDF text import. The worker never imports the web application."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading

MAX_PDF_PAGES = 5000
MAX_BOOK_TEXT_CHARS = 3_000_000
_IMPORT_LOCK = threading.Lock()


def _limit(name, default, minimum, maximum):
    try:
        return max(minimum, min(maximum, int(os.getenv(name, default))))
    except (TypeError, ValueError):
        return default


def parse_book(path, title, max_pages=5000, max_chars=3_000_000):
    memory_mb = _limit("READER_PDF_MEMORY_MB", 800, 128, 2048)
    timeout = _limit("READER_PDF_TIMEOUT", 90, 15, 600)
    # Serialize only PDF parsing; reading and the other import formats stay available.
    with _IMPORT_LOCK, tempfile.TemporaryDirectory(prefix="trans-pdf-") as temporary:
        output = Path(temporary) / "result.json"
        try:
            process = subprocess.run([
                sys.executable, str(Path(__file__).resolve()), str(Path(path).resolve()), str(output),
                str(memory_mb), str(timeout), str(max_pages), str(max_chars),
            ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise ValueError("PDF 解析超时，请拆分文件后导入") from exc
        if process.returncode != 0 or not output.exists():
            raise ValueError("PDF 解析超过资源限制或异常退出，请拆分文件后导入")
        if output.stat().st_size > max_chars * 6 + 2 * 1024 * 1024:
            raise ValueError("PDF 提取内容过大，请拆分文件后导入")
        result = json.loads(output.read_text(encoding="utf-8"))
        if "error" in result:
            raise ValueError(result["error"])
        result["title"] = title
        return result


def _normalize_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    return re.sub(r"\n{4,}", "\n\n\n", text).strip()[:MAX_BOOK_TEXT_CHARS]


def pdf_text_paragraphs(text):
    """Reflow ordinary prose, keeping short headings, lists and math rows separate."""
    lines = str(text or "").replace("\r", "").splitlines()
    widths = sorted(len(line.strip()) for line in lines if len(line.strip()) >= 45)
    width = widths[len(widths) // 2] if widths else 80
    indents = [len(line) - len(line.lstrip()) for line in lines if len(line.strip()) >= width * .7]
    baseline = sorted(indents)[len(indents) // 2] if indents else 0
    paragraphs, previous = [], ""

    def prose(line):
        return len(re.findall(r"[A-Za-z]{2,}", line)) >= 4 or len(re.findall(r"[\u3400-\u9fff]", line)) >= 15

    for raw in lines:
        line = re.sub(r"[ \t\u00a0]+", " ", raw).strip()
        if not line:
            previous = ""
            continue
        indented = len(raw) - len(raw.lstrip()) > baseline + 2
        table_row = bool(re.search(r"\S {3,}\S", raw)) and len(re.findall(r"\b\d+(?:\.\d+)?\b", line)) >= 3
        numbered = bool(re.match(r"(?:\d+[.)]|[•●▪])\s", line))
        sentence_end = bool(re.search(r"[A-Za-z\u3400-\u9fff].*[.!?。！？][\"”’')]*$", line))
        continuation = (prose(line) and len(line) >= width * .7) or sentence_end
        join = (previous and prose(previous) and continuation and not indented and not table_row and not numbered
                and (len(previous) >= width * .7 or previous.endswith(("-", "\u00ad"))))
        if join:
            separator = "" if previous.endswith(("-", "\u00ad")) or re.search(r"[\u3400-\u9fff]$", previous) and re.match(r"[\u3400-\u9fff]", line) else " "
            paragraphs[-1] = paragraphs[-1].rstrip("\u00ad") + separator + line
        else:
            paragraphs.append(line)
        previous = "" if table_row else line
    return _normalize_text("\n\n".join(paragraphs))


def _parse_pdf_book(path, fallback_title):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("当前环境未安装 pypdf，暂不能解析 PDF") from exc
    reader = PdfReader(str(path))
    if len(reader.pages) > MAX_PDF_PAGES:
        raise ValueError(f"PDF 页数过多，最多支持 {MAX_PDF_PAGES} 页")
    chapters = []
    page_buffer = []
    start_page = 1
    total_chars = 0
    for index, page in enumerate(reader.pages, start=1):
        # Use physical line positions instead of PDF drawing-command order.
        # Do not retain alignment padding or a hard break for every printed line.
        try:
            extracted = page.extract_text(extraction_mode="layout", layout_mode_space_vertically=False)
        except (TypeError, ValueError, NotImplementedError):
            extracted = page.extract_text()
        if not (extracted or "").strip():
            extracted = page.extract_text()
        text = pdf_text_paragraphs(extracted or "")
        if text:
            remaining = MAX_BOOK_TEXT_CHARS - total_chars
            if remaining <= 0:
                break
            text = text[:remaining]
            total_chars += len(text)
            page_buffer.append(text)
        if page_buffer and (len(page_buffer) >= 20 or index == len(reader.pages)):
            end_page = index
            chapters.append({
                "title": f"第 {start_page}-{end_page} 页",
                "text": "\n\n".join(page_buffer),
            })
            start_page = index + 1
            page_buffer = []
        if total_chars >= MAX_BOOK_TEXT_CHARS:
            if page_buffer:
                chapters.append({
                    "title": f"第 {start_page}-{index} 页",
                    "text": "\n\n".join(page_buffer),
                })
            break
    if not chapters:
        raise ValueError("PDF 中没有识别到可阅读文本")
    return {"title": fallback_title, "author": "", "chapters": chapters}


if __name__ == "__main__":
    import resource

    input_path, output_path = sys.argv[1:3]
    memory_mb, seconds, MAX_PDF_PAGES, MAX_BOOK_TEXT_CHARS = map(int, sys.argv[3:7])
    # Set limits in the fresh worker, not preexec_fn in the multithreaded web process.
    memory = memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.nice(10)
    try:
        result = _parse_pdf_book(input_path, "")
    except MemoryError:
        result = {"error": "PDF 解析内存不足，请拆分文件后导入"}
    except ValueError as exc:
        result = {"error": str(exc)}
    except Exception:
        result = {"error": "PDF 无法解析，请检查文件是否损坏或加密"}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
