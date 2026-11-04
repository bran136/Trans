"""Selected reading/tool archives: authenticated encryption, preview and explicit restore.

Authentication data, arbitrary configuration files and derived indexes are excluded.
"""
from contextlib import contextmanager, nullcontext, ExitStack
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import threading
import time
import uuid
import zipfile

import backup_crypto
import backup_settings

from flask import jsonify, redirect, render_template, request, send_file

CHUNK_BYTES = 4 * 1024 * 1024
JSON_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 100000
RESERVE_BYTES = 512 * 1024 * 1024
RETENTION = 24 * 3600
ID = re.compile(r"[a-f0-9]{32}\Z")
ITEMS = ("source", "reading", "txt_backup", "audio")
KEY = re.compile(r"[a-f0-9]{64}\Z")
REF_COLUMNS = ("book_id", "chapter_index", "chapter_hash", "sentence_index", "sentence_text",
               "profile_key", "cache_key", "audio_format", "size_bytes", "created_at")


def digest_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(archive, name):
    if archive.getinfo(name).file_size > JSON_BYTES:
        raise ValueError("备份中的目录或记录过大")
    return json.loads(archive.read(name))


def safe_name(name):
    return isinstance(name, str) and name not in {"", ".", ".."} and Path(name).name == name and "\\" not in name


def selected_items(value):
    if not isinstance(value, list) or not value or any(x not in ITEMS for x in value):
        raise ValueError("请选择有效的备份项目")
    return [x for x in ITEMS if x in value]


def layout_key(book):
    # EPUB cached text and counts may be filled lazily; only structural fields belong here.
    keys = ("title", "href", "fragment", "end_fragment") if book.get("format") == "epub" else ("title", "text")
    value = [book.get("format"), book.get("metadata_version"),
             [{k: chapter.get(k, "") for k in keys} for chapter in book["chapters"]]]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class ReadingBackups:
    def __init__(self, backend):
        self.b = backend
        self.tools = backup_settings.ToolSettings(backend)
        self.root = backend.READER_DIR / "backups"
        self.lock = threading.RLock()
        self.busy = False
        self.jobs = {}
        self.recover_interrupted()
        self.load_jobs()

    def recover_interrupted(self):
        # Roll back only our own interrupted transaction, never import an uploaded
        # archive automatically. Keep the journal until both files and refs agree.
        if not self.root.exists():
            return
        b = self.b
        for journal in self.root.glob("*/pending.json"):
            if not ID.fullmatch(journal.parent.name):
                continue
            try:
                record = json.loads(journal.read_text())
                identity = record["book_id"]
                target = b.book_dir(identity)
                stage = journal.parent / "restore"
                old = stage / "previous"
                with b.READER_IO_LOCK, b.TTS_OFFLINE_LOCK:
                    if old.exists():
                        if target.exists():
                            displaced = stage / "interrupted"
                            shutil.rmtree(displaced, ignore_errors=True)
                            os.replace(target, displaced)
                        os.replace(old, target)
                    connection = b.open_tts_offline_db()
                    try:
                        with connection:
                            connection.execute("DELETE FROM offline_tts_refs WHERE book_id=?", (identity,))
                            connection.executemany(
                                "INSERT INTO offline_tts_refs (" + ",".join(REF_COLUMNS) + ") VALUES (" + ",".join("?" for _ in REF_COLUMNS) + ")",
                                [tuple(row[key] for key in REF_COLUMNS) for row in record["refs"]])
                    finally:
                        connection.close()
                    if not record["existed"] and target.exists():
                        shutil.rmtree(target)
                    b.forget_book_record(identity)
                    b.READER_INDEX_FILE.unlink(missing_ok=True)
                    journal.unlink()
                    shutil.rmtree(stage, ignore_errors=True)
                b.app.logger.warning("rolled back interrupted reading restore book=%s", identity)
            except Exception:
                # Never expire the only surviving original after an I/O failure.
                b.app.logger.exception("reading restore rollback needs attention journal=%s", journal.name)
                self.busy = True

    def space(self, required):
        self.b.ensure_private_directory(self.root)
        if shutil.disk_usage(self.root).free < required + RESERVE_BYTES:
            raise ValueError("磁盘空间不足，请下载并清理旧备份后重试（预留 512 MiB）")

    def persist(self, job):
        self.b.write_json_atomic(self.root / job["id"] / "job.json", job)

    def require_recovered(self):
        # A failed directory rollback may contain the only original copy. Never
        # overwrite its staging directory or delete it as an ordinary backup.
        if next(self.root.glob("*/pending.json"), None) is not None:
            raise ValueError("上次恢复尚未完成，请重启服务完成回滚后再操作；原数据已保留")

    def load_jobs(self):
        if not self.root.exists():
            return
        for path in self.root.glob("*/job.json"):
            if not ID.fullmatch(path.parent.name):
                continue
            try:
                job = json.loads(path.read_text())
                if job.get("id") != path.parent.name:
                    continue
                if job.get("status") == "working":
                    job.update(status="error", message="服务重启中断了操作，请刷新对比或创建备份")
                archive_path = path.parent / "backup.zip"
                if archive_path.is_file():
                    job.update(size=archive_path.stat().st_size, encrypted=backup_crypto.is_encrypted(archive_path))
                self.jobs[job["id"]] = job
            except (ValueError, OSError, AttributeError):
                self.b.app.logger.warning("unreadable backup job metadata")

        # Adopt archives made before task metadata was persisted. Inspection is
        # read-only; a full checksum pass still precedes any restore.
        for path in self.root.glob("*/backup.zip"):
            identity = path.parent.name
            if not ID.fullmatch(identity) or identity in self.jobs:
                continue
            try:
                encrypted = backup_crypto.is_encrypted(path)
                manifest = None
                if not encrypted:
                    with zipfile.ZipFile(path) as archive:
                        manifest = self.inspect(archive)
                created = path.stat().st_mtime
                job = {"id": identity, "kind": "selected", "status": "locked" if encrypted else "ready", "progress": 100,
                       "created_at": created, "expires_at": created + RETENTION, "size": path.stat().st_size,
                       "encrypted": encrypted, "manifest": manifest,
                       "message": "请输入备份密码查看内容" if encrypted else "备份已就绪"}
                self.jobs[identity] = job
                self.persist(job)
            except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile):
                self.b.app.logger.warning("older backup could not be listed id=%s", identity)

    def cleanup(self):
        self.b.ensure_private_directory(self.root)
        with self.lock:
            if self.busy:
                return
            for path in self.root.iterdir():
                if not ID.fullmatch(path.name) or not path.is_dir() or (path / "pending.json").exists():
                    continue
                job = self.jobs.get(path.name, {})
                expiry = job.get("expires_at", job.get("created_at", path.stat().st_mtime) + RETENTION)
                if time.time() >= expiry:
                    shutil.rmtree(path)
                    self.jobs.pop(path.name, None)

    def list_jobs(self):
        self.cleanup()
        with self.lock:
            return [self.public(job) for job in sorted(self.jobs.values(), key=lambda x: x["created_at"], reverse=True)]

    def delete(self, identity):
        with self.lock:
            self.require_recovered()
            if self.busy:
                raise ValueError("已有备份操作正在进行，请稍后再试")
            self.get(identity)
            shutil.rmtree(self.root / identity)
            self.jobs.pop(identity, None)

    def catalog(self):
        books = []
        for book in self.b.load_book_index_or_rebuild():
            directory = self.b.book_dir(book["id"])
            books.append({**{k: book.get(k) for k in ("id", "title", "author", "format")},
                          "has_txt_backup": (directory / ".source-before-edit").is_file()})
        return books

    def selections(self, rows):
        if not isinstance(rows, list) or not 0 <= len(rows) <= 1000:
            raise ValueError("请至少选择一本书及需要备份的项目")
        result = {}
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not ID.fullmatch(row["id"]):
                raise ValueError("书籍标识无效")
            result[row["id"]] = selected_items(row.get("items"))
        return result

    def estimate(self, selections):
        size, audio_ids = 0, []
        for identity, items in selections.items():
            book = self.b.read_book_record(identity)
            directory = self.b.book_dir(identity)
            names = []
            if "source" in items:
                names.append(book["stored_name"])
                if book.get("cover_name"):
                    names.append(book["cover_name"])
            if "reading" in items:
                names += ["book.json", "progress.json", "bookmarks.json"]
            if "txt_backup" in items:
                names.append(".source-before-edit")
            for name in names:
                path = directory / name
                if path.is_file():
                    size += path.stat().st_size
            size += 2048  # Manifest and per-book compatibility information.
            if "audio" in items:
                audio_ids.append(identity)
        if audio_ids:
            with self.b.TTS_OFFLINE_LOCK:
                conn = self.b.open_tts_offline_db()
                try:
                    marks = ",".join("?" for _ in audio_ids)
                    # A shared sentence audio file is archived only once.
                    size += conn.execute(f"SELECT COALESCE(SUM(n),0) FROM (SELECT MAX(size_bytes) n FROM offline_tts_refs WHERE book_id IN ({marks}) AND size_bytes>0 GROUP BY cache_key,audio_format)", audio_ids).fetchone()[0]
                    size += conn.execute(f"SELECT COALESCE(SUM(length(CAST(sentence_text AS BLOB))+450),0) FROM offline_tts_refs WHERE book_id IN ({marks}) AND size_bytes>0", audio_ids).fetchone()[0]
                finally:
                    conn.close()
        return size


    def new(self, kind):
        self.cleanup()
        with self.lock:
            self.require_recovered()
            if self.busy:
                raise ValueError("已有备份操作正在进行，请稍后再试")
            self.space(0)
            identity = uuid.uuid4().hex
            path = self.root / identity
            path.mkdir(mode=0o700)
            job = {"id": identity, "kind": kind, "status": "uploading" if kind == "upload" else "working",
                   "progress": 0, "message": "", "created_at": time.time()}
            job["expires_at"] = job["created_at"] + RETENTION
            self.jobs[identity] = job
            self.persist(job)
            return job

    def get(self, identity):
        if not ID.fullmatch(identity) or identity not in self.jobs:
            raise ValueError("备份会话已失效，请重新上传或创建")
        return self.jobs[identity]

    def start(self, job, operation, *args):
        with self.lock:
            self.require_recovered()
            if self.busy:
                raise ValueError("已有备份操作正在进行，请稍后再试")
            self.busy = True
            job.update(status="working", message="正在处理", progress=0)
        def run():
            try:
                operation(job, *args)
            except Exception as exc:
                self.b.app.logger.warning("reading backup failed operation=%s error=%s", operation.__name__, type(exc).__name__)
                message = str(exc) if isinstance(exc, ValueError) else "处理失败，请检查磁盘空间及备份文件后重试"
                job.update(status="error", message=message)
            finally:
                with self.lock:
                    try:
                        self.persist(job)
                    finally:
                        self.busy = False
        threading.Thread(target=run, name="reading-backup", daemon=True).start()

    @contextmanager
    def book_lock(self, identity):
        directory = self.b.book_dir(identity)
        with (directory / ".text-edit.lock").open("a+b") as handle:
            os.chmod(handle.name, 0o600)
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("书籍正在更新，请稍后重试") from None
            with self.b.TTS_OFFLINE_JOB_LOCK:
                if self.b.read_txt_edit_lease(identity) or self.b.active_tts_offline_job_for_book(identity):
                    raise ValueError("请先结束本书的全文编辑或听书缓存任务")
                yield handle

    @contextmanager
    def search_lock(self):
        # The index builder keeps a stable installation-wide lock outside book
        # directories. Do not swap a directory while that builder writes into it.
        path = self.b.READER_DIR / "search-build.lock"
        with path.open("a+b") as handle:
            os.chmod(path, 0o600)
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("正文搜索索引正在建立，请完成后重试恢复") from None
            yield

    @contextmanager
    def audio_lock(self, key):
        lock = self.b.tts_cache_key_lock(key)
        if not lock.acquire(blocking=False):
            raise ValueError("相关音频正在生成或清理，请稍后重试恢复")
        try:
            yield
        finally:
            lock.release()

    def fingerprint(self, identity):
        directory = self.b.book_dir(identity)
        if not (directory / "book.json").exists():
            return ""
        # Include progress and bookmarks: an open reader changing either invalidates a preview.
        values = []
        for name in ("book.json", "progress.json", "bookmarks.json", ".source-before-edit"):
            try:
                s = (directory / name).stat()
                values.append((name, s.st_ino, s.st_size, s.st_mtime_ns))
            except FileNotFoundError:
                pass
        book = self.b.read_book_record(identity)
        source = directory / book["stored_name"]
        try:
            info = source.stat()
            values.append((book["stored_name"], info.st_ino, info.st_size, info.st_mtime_ns))
        except FileNotFoundError:
            pass
        # Audio operations do not touch book.json, but must invalidate overwrite previews.
        refs = self.current_refs(identity)
        values.append(sorted(tuple(row[k] for k in REF_COLUMNS) for row in refs))
        return hashlib.sha256(repr(values).encode()).hexdigest()

    def snapshot(self, identity, stage, items):
        b = self.b
        destination = stage / "books" / identity
        destination.mkdir(parents=True, mode=0o700)
        refs, audio_names = [], set()
        with self.book_lock(identity), b.READER_IO_LOCK:
            book = b.read_book_record(identity)
            source = b.book_dir(identity)
            stored = book.get("stored_name")
            if not safe_name(stored) or not (source / stored).is_file():
                raise ValueError("书籍原文件缺失，请先修复书籍")
            descriptor = {k: book.get(k) for k in ("id", "title", "author", "format", "stored_name", "original_name", "cover_name")}
            descriptor.update(author=book.get("author") or "", original_name=book.get("original_name") or stored, cover_name=book.get("cover_name") or "")
            descriptor.update(source_sha256=digest_file(source / stored), layout_key=layout_key(book),
                              chapters=len(book["chapters"]))
            b.write_json_atomic(destination / "descriptor.json", descriptor)
            names = set()
            if "source" in items:
                names.add(stored)
                if book.get("cover_name"):
                    names.add(book["cover_name"])
            if "reading" in items:
                b.write_json_atomic(destination / "book.json", book)
                names.add("bookmarks.json")
            if "txt_backup" in items:
                names.add(".source-before-edit")
            for name in names:
                if not safe_name(name):
                    raise ValueError("书籍文件名无效")
                file = source / name
                if file.is_symlink():
                    raise ValueError("备份不支持符号链接")
                if file.is_file():
                    os.link(file, destination / name)
            if "audio" in items:
                with b.TTS_OFFLINE_LOCK:
                    conn = b.open_tts_offline_db()
                    try:
                        rows = conn.execute("SELECT * FROM offline_tts_refs WHERE book_id=? AND size_bytes>0", (identity,)).fetchall()
                    finally:
                        conn.close()
                    for row in rows:
                        audio = b.tts_cache_path(row["cache_key"], row["audio_format"])
                        if not audio.is_file() or audio.is_symlink() or not audio.stat().st_size:
                            raise ValueError("服务器固定音频缺失，请先检查听书缓存")
                        name = "audio/" + audio.name
                        target = stage / name
                        target.parent.mkdir(mode=0o700, exist_ok=True)
                        if not target.exists():
                            os.link(audio, target)
                        refs.append(dict(row))
                        audio_names.add(name)
                b.write_json_atomic(destination / "audio-refs.json", refs)
        return {**descriptor, "items": items, "progress": book.get("progress", {}) if "reading" in items else None,
                "files": [str(p.relative_to(stage)) for p in sorted(destination.iterdir())],
                "audio": sorted(audio_names), "pinned_sentences": len(refs)}


    def export(self, job, selections, tools=None, password=""):
        tools = tools or {}
        backup_crypto.password_value(password, required=any("credentials" in items for items in tools.values()))
        if not selections and not tools:
            raise ValueError("请选择备份项目")
        job["encrypted"] = bool(password)
        settings = self.tools.snapshot(tools)
        self.tools.validate(settings, tools)
        settings_data = json.dumps(settings, ensure_ascii=False).encode() if tools else b""
        if len(settings_data) > backup_settings.MAX_BYTES:
            raise ValueError("工具备份数据过大，请分开备份")
        directory = self.root / job["id"]
        stage = directory / "snapshot"
        stage.mkdir(mode=0o700)
        try:
            books = []
            for number, (identity, items) in enumerate(selections.items()):
                books.append(self.snapshot(identity, stage, items))
                job.update(message=f"正在整理书籍 {number + 1}/{len(selections)}", progress=round((number + 1) / len(selections) * 20))
            files = sorted(p for p in stage.rglob("*") if p.is_file())
            if len(files) + 1 + bool(tools) > MAX_ENTRIES:
                raise ValueError("备份文件条目过多，请分批选择书籍")
            if any(p.stat().st_size > JSON_BYTES for p in files if not p.is_relative_to(stage / "audio")):
                raise ValueError("书籍记录过大，请减少备份项目或分开备份")
            total = sum(p.stat().st_size for p in files)
            self.space(total + 1024 * 1024)
            manifest = {"format": "trans-backup-3" if tools else "trans-reading-2", "created_at": time.time(), "books": books, "files": {}}
            if tools:
                manifest["tools"] = [{"id": key, "items": value} for key, value in tools.items()]
            done = 0
            with backup_crypto.write_archive(directory / "backup.zip", password) as archive:
                for path in files:
                    name = path.relative_to(stage).as_posix()
                    checksum = hashlib.sha256()
                    info = zipfile.ZipInfo.from_file(path, name)
                    info.compress_type = zipfile.ZIP_STORED if name.startswith("audio/") else zipfile.ZIP_DEFLATED
                    with path.open("rb") as source, archive.open(info if name.startswith("audio/") else name, "w", force_zip64=True) as target:
                        while data := source.read(1024 * 1024):
                            checksum.update(data)
                            target.write(data)
                            done += len(data)
                            job.update(message="正在打包", progress=20 + round(done / max(1, total) * 79))
                    manifest["files"][name] = {"size": path.stat().st_size, "sha256": checksum.hexdigest(), "mtime": path.stat().st_mtime}
                if tools:
                    archive.writestr("tools.json", settings_data)
                    manifest["files"]["tools.json"] = {"size": len(settings_data), "sha256": hashlib.sha256(settings_data).hexdigest()}
                manifest_data = json.dumps(manifest, ensure_ascii=False).encode()
                if len(manifest_data) > JSON_BYTES:
                    raise ValueError("备份清单过大，请分批选择书籍")
                archive.writestr("manifest.json", manifest_data)
            os.chmod(directory / "backup.zip", 0o600)
            job.update(status="ready", progress=100, message="备份已就绪", size=(directory / "backup.zip").stat().st_size,
                       manifest=manifest, expires_at=time.time() + RETENTION)
            self.persist(job)
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def inspect(self, archive, encrypted=False):
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES or len({i.filename for i in infos}) != len(infos):
            raise ValueError("备份文件条目过多或存在重复路径")
        for info in infos:
            path = PurePosixPath(info.filename)
            if (path.is_absolute() or ".." in path.parts or "\\" in info.filename or info.is_dir()
                    or stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1):
                raise ValueError("备份包含不安全路径或不支持的文件")
        manifest = read_json(archive, "manifest.json")
        if not isinstance(manifest, dict) or manifest.get("format") not in {"trans-reading-1", "trans-reading-2", "trans-backup-3"}:
            raise ValueError("请选择 Trans 创建的备份")
        books, files = manifest.get("books"), manifest.get("files")
        if manifest["format"] == "trans-reading-1" and manifest.get("kind") not in {"light", "full"}:
            raise ValueError("备份类型无效")
        if not isinstance(books, list) or not 0 <= len(books) <= 1000 or not isinstance(files, dict):
            raise ValueError("备份目录无效")
        if set(files) | {"manifest.json"} != {i.filename for i in infos}:
            raise ValueError("备份文件清单不一致")
        for name, entry in files.items():
            if (not isinstance(entry, dict) or type(entry.get("size")) is not int or entry["size"] < 0
                    or archive.getinfo(name).file_size != entry["size"] or not KEY.fullmatch(str(entry.get("sha256", "")))):
                raise ValueError("备份文件大小或校验值无效")
        tools = backup_settings.selections(manifest.get("tools", []))
        if not books and not tools:
            raise ValueError("备份没有可恢复的项目")
        if tools and manifest["format"] != "trans-backup-3":
            raise ValueError("工具备份格式无效")
        seen, used = set(), set()
        if tools:
            if any("credentials" in items for items in tools.values()) and not encrypted:
                raise ValueError("包含服务凭据的备份必须加密")
            if "tools.json" not in files or files["tools.json"]["size"] > backup_settings.MAX_BYTES:
                raise ValueError("工具备份数据缺失或过大")
            self.tools.validate(read_json(archive, "tools.json"), tools)
            used.add("tools.json")
        for book in books:
            if not isinstance(book, dict):
                raise ValueError("备份书籍信息无效")
            identity = book.get("id", "")
            if not isinstance(identity, str) or not ID.fullmatch(identity) or identity in seen:
                raise ValueError("备份书籍标识无效")
            seen.add(identity)
            prefix = f"books/{identity}/"
            names = book.get("files", [])
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                raise ValueError("备份文件清单无效")
            if manifest["format"] == "trans-reading-1":
                record = read_json(archive, prefix + "book.json")
                self.validate_book(record, identity)
                book.update(items=["source", "reading", "txt_backup"] + (["audio"] if manifest["kind"] == "full" else []),
                            stored_name=record["stored_name"], cover_name=record.get("cover_name"),
                            source_sha256=files[prefix + record["stored_name"]]["sha256"], layout_key=layout_key(record))
            else:
                selected_items(book.get("items"))
                record = read_json(archive, prefix + "descriptor.json")
                if (not isinstance(record, dict) or set(record) - {"id", "title", "author", "format", "stored_name", "original_name", "cover_name", "source_sha256", "layout_key", "chapters"}
                        or record.get("id") != identity or record.get("format") not in {"txt", "epub", "pdf"}
                        or not safe_name(record.get("stored_name")) or not record["stored_name"].endswith("." + record["format"])
                        or record.get("cover_name") and not re.fullmatch(r"cover\.(jpg|jpeg|png|webp|gif)", record["cover_name"])
                        or any(not KEY.fullmatch(str(record.get(k, ""))) for k in ("source_sha256", "layout_key"))
                        or type(record.get("chapters")) is not int or not 1 <= record["chapters"] <= 100000):
                    raise ValueError("备份书籍兼容信息无效")
                book.update(record)
                if "reading" in book["items"]:
                    reading = read_json(archive, prefix + "book.json")
                    self.validate_book(reading, identity)
                    if layout_key(reading) != book["layout_key"] or reading["stored_name"] != book["stored_name"]:
                        raise ValueError("备份目录与书籍不一致")
            allowed = {"descriptor.json"}
            required = set()
            if "source" in book["items"]:
                allowed.add(book["stored_name"])
                required.add(book["stored_name"])
                if book.get("cover_name"):
                    allowed.add(book["cover_name"])
            if "reading" in book["items"]:
                allowed.update(("book.json", "progress.json", "bookmarks.json"))
                required.add("book.json")
            if "txt_backup" in book["items"]:
                allowed.add(".source-before-edit")
            if "audio" in book["items"]:
                allowed.add("audio-refs.json")
                required.add("audio-refs.json")
            elif book.get("audio"):
                raise ValueError("未选择固定音频却包含音频文件")
            if "source" in book["items"] and files.get(prefix + book["stored_name"], {}).get("sha256") != book["source_sha256"]:
                raise ValueError("原书校验信息不一致")
            if not all(prefix + name in names for name in required):
                raise ValueError("备份缺少所选项目文件")
            for name in names:
                if not name.startswith(prefix) or name[len(prefix):] not in allowed or name not in files:
                    raise ValueError("备份包含非阅读数据")
                if files[name]["size"] > JSON_BYTES:
                    raise ValueError("备份中的单个书籍文件过大")
            for name in book.get("audio", []):
                if not re.fullmatch(r"audio/[a-f0-9]{64}\.(m4a|mp3|wav|aac|pcm|opus)", name) or name not in files:
                    raise ValueError("备份音频清单无效")
            used.update(names)
            used.update(book.get("audio", []))
        if used != set(files):
            raise ValueError("备份存在未归属书籍的文件")
        return manifest

    def validate_book(self, book, identity):
        if (not isinstance(book, dict) or book.get("id") != identity or book.get("format") not in {"txt", "epub", "pdf"}
                or not safe_name(book.get("stored_name")) or not str(book["stored_name"]).endswith("." + book["format"])
                or book.get("cover_name") and not re.fullmatch(r"cover\.(jpg|jpeg|png|webp|gif)", book["cover_name"])):
            raise ValueError("书籍记录无效")
        for key in ("title", "author", "original_name", "content_revision"):
            if key in book and (not isinstance(book[key], str) or len(book[key]) > 2000):
                raise ValueError("书籍信息无效")
        for key in ("created_at", "updated_at", "last_opened_at"):
            if key in book and (type(book[key]) not in (int, float) or not math.isfinite(book[key]) or book[key] < 0):
                raise ValueError("书籍时间无效")
        if "lazy" in book and type(book["lazy"]) is not bool:
            raise ValueError("书籍类型无效")
        chapters = book.get("chapters")
        if not isinstance(chapters, list) or not chapters or len(chapters) > 100000:
            raise ValueError("章节目录无效")
        for chapter in chapters:
            if not isinstance(chapter, dict) or not isinstance(chapter.get("text", ""), str) or not isinstance(chapter.get("title", ""), str):
                raise ValueError("章节记录无效")
            for key in ("index", "level", "char_count", "image_count"):
                if key in chapter and (type(chapter[key]) is not int or chapter[key] < 0):
                    raise ValueError("章节信息无效")
            for key in ("href", "fragment", "end_fragment", "media_type"):
                if key in chapter and not isinstance(chapter[key], str):
                    raise ValueError("章节资源无效")
        progress = book.get("progress", {})
        if not isinstance(progress, dict) or any(type(progress.get(key, 0)) is not int or progress.get(key, 0) < 0 for key in ("chapter", "sentence")):
            raise ValueError("阅读进度无效")
        if progress.get("chapter", 0) >= len(chapters):
            raise ValueError("阅读进度超出目录")
        if "percent" in progress and (type(progress["percent"]) not in (int, float)
                or not math.isfinite(progress["percent"]) or not 0 <= progress["percent"] <= 100):
            raise ValueError("阅读百分比无效")

    @contextmanager
    def open_archive(self, job, password=""):
        path = self.root / job["id"] / "backup.zip"
        job["encrypted"] = backup_crypto.is_encrypted(path)
        def report(done, total):
            job.update(message="正在解密备份", progress=min(99, round(done / max(1, total) * 100)))
        with backup_crypto.read_archive(path, password, self.space, report) as archive:
            yield archive

    def tool_data(self, archive, manifest):
        tools = backup_settings.selections(manifest.get("tools", []))
        if not tools:
            return {}, tools
        if archive.getinfo("tools.json").file_size > backup_settings.MAX_BYTES:
            raise ValueError("工具备份数据过大")
        raw = archive.read("tools.json")
        if hashlib.sha256(raw).hexdigest() != manifest["files"]["tools.json"]["sha256"]:
            raise ValueError("工具备份校验失败")
        data = json.loads(raw)
        self.tools.validate(data, tools)
        return data, tools

    def preview(self, job, password=""):
        with self.open_archive(job, password) as archive:
            manifest = self.inspect(archive, job["encrypted"])
            total = sum(entry["size"] for entry in manifest["files"].values())
            done = 0
            for name, entry in manifest["files"].items():
                checksum = hashlib.sha256()
                with archive.open(name) as source:
                    while data := source.read(1024 * 1024):
                        checksum.update(data)
                        done += len(data)
                        job.update(message="正在校验备份", progress=min(99, round(done / max(1, total) * 100)))
                if checksum.hexdigest() != entry["sha256"]:
                    raise ValueError("备份校验失败，文件可能已损坏")
            job["manifest"] = manifest
            self.compare(job, archive=archive)
        job.update(status="preview", message="校验完成，请选择项目恢复", progress=100,
                   size=(self.root / job["id"] / "backup.zip").stat().st_size)
        self.persist(job)

    def restore_tool(self, job, tool, items, token, password=""):
        with self.open_archive(job, password) as archive:
            data, selected = self.tool_data(archive, job["manifest"])
            if tool not in selected or not isinstance(items, list) or not set(items) <= set(selected[tool]):
                raise ValueError("工具恢复选项无效")
            self.tools.restore(tool, data[tool], items, token)
            self.finish_restore(job, f"已恢复：{backup_settings.TOOLS[tool]}", archive)

    def finish_restore(self, job, message, archive):
        try:
            self.compare(job, archive=archive)
        except Exception as exc:
            # The write has committed. A subsequent comparison/read failure must
            # not be reported as a failed restore or leave stale action tokens.
            self.b.app.logger.warning("backup restored; comparison failed error=%s", type(exc).__name__)
            job.update(books=[], tools=[], comparison_warning=True)
            message += "；对比更新失败，请点击刷新对比"
        job.update(status="preview", message=message, progress=100)

    def current_refs(self, identity):
        with self.b.TTS_OFFLINE_LOCK:
            conn = self.b.open_tts_offline_db()
            try:
                return [dict(row) for row in conn.execute("SELECT * FROM offline_tts_refs WHERE book_id=?", (identity,))]
            finally:
                conn.close()

    def compatible(self, entry, current):
        if not current or current.get("format") != entry["format"]:
            return False
        source = self.b.book_dir(current["id"]) / current["stored_name"]
        return source.is_file() and digest_file(source) == entry["source_sha256"] and layout_key(current) == entry["layout_key"]

    @staticmethod
    def merge_issue(previous, incoming):
        chapters, positions = {}, {}
        for row in previous + incoming:
            chapter = (row["profile_key"], row["chapter_index"])
            if chapter in chapters and chapters[chapter] != row["chapter_hash"]:
                return "同一音色配置的章节内容或切句结果不同"
            chapters[chapter] = row["chapter_hash"]
            position = (*chapter, row["sentence_index"])
            value = (row["chapter_hash"], row["sentence_text"], row["cache_key"], row["audio_format"])
            if position in positions and positions[position] != value:
                return "同一音色配置的句子位置或音频记录冲突"
            positions[position] = value
        return ""

    def compare(self, job, password="", archive=None):
        rows = []
        existing = self.b.load_book_index_or_rebuild()
        with (nullcontext(archive) if archive else self.open_archive(job, password)) as archive:
            data, selected = self.tool_data(archive, job["manifest"])
            job["tools"] = self.tools.preview(data, selected)
            for book in job["manifest"]["books"]:
                identity = book["id"]
                with self.b.READER_IO_LOCK:
                    token = self.fingerprint(identity)
                    current = self.b.read_book_record(identity) if token else None
                    compatible = self.compatible(book, current)
                same_titles = any(x["id"] != identity and x.get("title") == book.get("title") for x in existing)
                issue = ""
                if "audio" in book["items"] and current:
                    incoming = read_json(archive, f"books/{identity}/audio-refs.json")
                    issue = ("原书或目录结构不同" if not compatible else
                             self.merge_issue(self.current_refs(identity), incoming))
                rows.append({**{k: book.get(k) for k in ("id", "title", "author", "format", "chapters", "progress", "pinned_sentences", "items")},
                             "token": token, "current": self.b.book_summary(current) if current else None,
                             "compatible": compatible, "merge_issue": issue, "same_title": same_titles})
        job["books"] = rows
        job.pop("comparison_warning", None)


    def extract(self, archive, manifest, names, stage, job, reusable=None):
        total = sum(manifest["files"][name]["size"] for name in names)
        completed = 0
        reusable = reusable or {}
        for name in names:
            target = stage / name
            target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            if name in reusable:
                os.link(reusable[name], target)
                if digest_file(target) != manifest["files"][name]["sha256"]:
                    raise ValueError("已有音频在核对后发生变化，请重试恢复")
                completed += manifest["files"][name]["size"]
                job.update(message="正在恢复文件", progress=10 + round(completed / max(1, total) * 80))
                continue
            checksum = hashlib.sha256()
            with archive.open(name) as source, target.open("xb") as output:
                os.chmod(target, 0o600)
                while data := source.read(1024 * 1024):
                    checksum.update(data)
                    output.write(data)
                    completed += len(data)
                    job.update(message="正在恢复文件", progress=10 + round(completed / max(1, total) * 80))
                output.flush()
                os.fsync(output.fileno())
            if checksum.hexdigest() != manifest["files"][name]["sha256"]:
                raise ValueError("备份内容已改变，请重新上传")
            stamp = manifest["files"][name].get("mtime")
            if type(stamp) in (int, float) and 0 <= stamp <= time.time():
                os.utime(target, (stamp, stamp))

    def restore(self, job, identity, token, replace, items=None, audio_mode="merge", password=""):
        self.require_recovered()
        b = self.b
        entry = next((book for book in job["manifest"]["books"] if book["id"] == identity), None)
        if not entry:
            raise ValueError("备份中不存在这本书")
        items = selected_items(items if items is not None else entry["items"])
        if not set(items) <= set(entry["items"]) or audio_mode not in {"merge", "replace"}:
            raise ValueError("恢复选项无效")
        with b.READER_IO_LOCK:
            if self.fingerprint(identity) != token or token and not replace:
                raise ValueError("书籍已存在或预览后发生变化，请刷新对比后确认")
            current = b.read_book_record(identity) if token else None
            compatible = self.compatible(entry, current)
            if not current and "source" not in items:
                raise ValueError("书架中没有原书，请同时选择原始书籍")
            if current and not compatible and "source" not in items and "reading" in items:
                # A different directory is allowed, but it must refer to the same original file.
                source = b.book_dir(identity) / current["stored_name"]
                if digest_file(source) != entry["source_sha256"]:
                    raise ValueError("原书内容不同，请同时恢复原始书籍与目录进度书签")
            if "audio" in items and not compatible and not {"source", "reading"} <= set(items):
                raise ValueError("音频与现有正文或目录不一致，请同时恢复原始书籍、目录进度书签")
            if "audio" in items and current and not compatible and audio_mode != "replace":
                raise ValueError("原书或目录不同，无法合并，请明确选择覆盖固定音频")
        prefix = f"books/{identity}/"
        def wanted(name):
            local = name[len(prefix):]
            return (local == "descriptor.json" or
                    "source" in items and local in {entry["stored_name"], entry.get("cover_name")} or
                    "reading" in items and local in {"book.json", "progress.json", "bookmarks.json"} or
                    "txt_backup" in items and local == ".source-before-edit" or
                    "audio" in items and local == "audio-refs.json")
        names = [name for name in entry["files"] if wanted(name)]
        audio_names = entry.get("audio", []) if "audio" in items else []
        names = list(dict.fromkeys(names + audio_names))
        reusable = {}
        for index, name in enumerate(audio_names):
            existing = b.TTS_CACHE_DIR / PurePosixPath(name).name
            metadata = job["manifest"]["files"][name]
            if existing.exists():
                if existing.is_symlink() or existing.stat().st_size != metadata["size"] or digest_file(existing) != metadata["sha256"]:
                    raise ValueError("同标识音频文件内容不同，无法安全替换共享音频；请先核对听书缓存")
                reusable[name] = existing
            job.update(message="正在核对已有音频", progress=round((index + 1) / max(1, len(audio_names)) * 10))
        required_space = sum(job["manifest"]["files"][name]["size"] for name in names if name not in reusable)
        directory = self.root / job["id"]
        stage = directory / "restore"
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(mode=0o700)
        archives = ExitStack()
        try:
            archive = archives.enter_context(self.open_archive(job, password))
            self.space(required_space)  # Include the temporary decrypted archive in current disk usage.
            self.extract(archive, job["manifest"], names, stage, job, reusable)
            incoming = stage / "books" / identity
            incoming.mkdir(parents=True, exist_ok=True)
            target = b.book_dir(identity)
            # Preserve unselected durable data; derived indexes are rebuilt after a content restore.
            keep = []
            if current:
                keep = [current["stored_name"], current.get("cover_name"), ".source-before-edit", "bookmarks.json"]
            with b.READER_IO_LOCK:
                if self.fingerprint(identity) != token:
                    raise ValueError("书籍已变化，请刷新对比后确认")
                for name in filter(None, keep):
                    selected = ("source" in items and name in {current["stored_name"], current.get("cover_name")}
                                or "reading" in items and name == "bookmarks.json"
                                or "txt_backup" in items and name == ".source-before-edit")
                    path = target / name
                    if not selected and path.is_file() and not (incoming / name).exists():
                        if path.is_symlink():
                            raise ValueError("书籍包含不支持的符号链接")
                        os.link(path, incoming / name)
            if "reading" in items:
                book = json.loads((incoming / "book.json").read_text())
            elif current:
                book = dict(current)
            else:
                book = {k: entry.get(k) for k in ("id", "title", "author", "format", "stored_name", "original_name", "cover_name")}
                book.update(created_at=time.time(), progress={"chapter": 0, "sentence": 0})
            source_changed = "source" in items and (not current or not (target / current["stored_name"]).is_file()
                                                   or digest_file(target / current["stored_name"]) != entry["source_sha256"])
            if "source" in items:
                book.update({k: entry.get(k) for k in ("format", "stored_name", "original_name", "cover_name")})
            elif current and "reading" in items:
                book.update({k: current.get(k, "") for k in ("format", "stored_name", "original_name", "cover_name")})
            if "reading" not in items and (not current or source_changed):
                parsed = b.parse_book_file(incoming / book["stored_name"], book.get("original_name") or book["stored_name"])
                book.update(chapters=parsed["chapters"], lazy=parsed["lazy"], metadata_version=b.CHAPTER_CACHE_VERSION,
                            progress={"chapter": 0, "sentence": 0})
                book.pop("txt_pending_parse", None)
            self.validate_book(book, identity)
            changed = "reading" in items or source_changed
            old_revision = book.get("content_revision", "")
            if changed:
                book.update(content_revision=uuid.uuid4().hex, progress_version=0, progress_writer="", progress_sequence=0,
                            updated_at=time.time())
            b.write_json_atomic(incoming / "book.json", book)
            b.write_private_text_atomic(incoming / "search-revision", book.get("content_revision", "original"))
            (incoming / "progress.json").unlink(missing_ok=True)
            (incoming / "descriptor.json").unlink(missing_ok=True)
            bookmark_path = incoming / "bookmarks.json"
            if bookmark_path.exists():
                bookmarks = json.loads(bookmark_path.read_text())
                if not isinstance(bookmarks, list) or len(bookmarks) > 200 or not all(isinstance(x, dict) for x in bookmarks):
                    raise ValueError("书签记录无效")
                for item in bookmarks:
                    if (not isinstance(item.get("id"), str) or not isinstance(item.get("quote", ""), str)
                            or any(type(item.get(key)) is not int or item[key] < 0 for key in ("chapter", "sentence"))):
                        raise ValueError("书签内容无效")
                    if "reading" in items and item.get("content_revision", "") == old_revision:
                        item["content_revision"] = book["content_revision"]
                b.write_json_atomic(bookmark_path, bookmarks)
            refs_path = incoming / "audio-refs.json"
            refs = json.loads(refs_path.read_text()) if refs_path.exists() else []
            self.validate_refs(refs, entry, stage, len(book["chapters"]))
            if self.merge_issue([], refs):
                raise ValueError("备份内的固定音频记录互相冲突")
            refs_path.unlink(missing_ok=True)
            job.update(message="正在保存所选项目", progress=95)
            b.ensure_private_directory(b.READER_BOOK_DIR)
            created = False
            with b.READER_IO_LOCK:
                if not target.exists():
                    target.mkdir(mode=0o700)
                    created = True
            try:
                with self.search_lock(), self.book_lock(identity), b.READER_IO_LOCK:
                    if self.fingerprint(identity) != token:
                        raise ValueError("书籍已变化，请刷新对比后确认")
                    os.link(target / ".text-edit.lock", incoming / ".text-edit.lock")
                    old = stage / "previous"
                    b.ensure_private_directory(b.TTS_CACHE_DIR)
                    with b.TTS_OFFLINE_LOCK:
                        connection = b.open_tts_offline_db()
                        try:
                            connection.execute("BEGIN IMMEDIATE")
                            previous_refs = [dict(row) for row in connection.execute(
                                "SELECT * FROM offline_tts_refs WHERE book_id=?", (identity,))]
                            if "audio" in items and audio_mode == "merge":
                                issue = self.merge_issue(previous_refs, refs)
                                if issue:
                                    raise ValueError(issue + "，无法合并，请选择覆盖固定音频")
                            b.write_json_atomic(directory / "pending.json", {
                                "book_id": identity, "existed": not created, "refs": previous_refs})
                            content_changed = current and (source_changed or layout_key(current) != layout_key(book))
                            if "audio" in items and audio_mode == "replace" or content_changed:
                                connection.execute("DELETE FROM offline_tts_refs WHERE book_id=?", (identity,))
                            audio_sizes = {}
                            for name in audio_names:
                                filename = PurePosixPath(name).name
                                source = stage / name
                                audio = b.TTS_CACHE_DIR / filename
                                # Do not wait behind synthesis while holding the reference lock.
                                with self.audio_lock(filename.split(".")[0]):
                                    if not audio.exists():
                                        os.link(source, audio)
                                    elif audio.is_symlink() or (not os.path.samefile(source, audio)
                                            and digest_file(audio) != job["manifest"]["files"][name]["sha256"]):
                                        raise ValueError("音频文件已改变，请刷新对比后重试")
                                    audio_sizes[filename] = audio.stat().st_size
                            for row in refs:
                                row["size_bytes"] = audio_sizes[row["cache_key"] + "." + row["audio_format"]]
                            connection.executemany(
                                "INSERT OR REPLACE INTO offline_tts_refs (" + ",".join(REF_COLUMNS) + ") VALUES (" + ",".join("?" for _ in REF_COLUMNS) + ")",
                                [tuple(row[key] for key in REF_COLUMNS) for row in refs])
                            os.replace(target, old)
                            try:
                                os.replace(incoming, target)
                                connection.commit()
                            except Exception:
                                if target.exists():
                                    os.replace(target, incoming)
                                os.replace(old, target)
                                raise
                        except Exception:
                            connection.rollback()
                            if not old.exists():
                                (directory / "pending.json").unlink(missing_ok=True)
                            raise
                        finally:
                            connection.close()
                    (directory / "pending.json").unlink(missing_ok=True)
                    b.forget_book_record(identity)
                    try:
                        b.upsert_book_index(book)
                    except Exception:
                        b.READER_INDEX_FILE.unlink(missing_ok=True)
                    try:
                        b.invalidate_tts_cache_stats(refresh=True, book_id=identity)
                    except Exception:
                        b.app.logger.warning("restored book statistics refresh deferred book=%s", identity)
            except Exception:
                if created and not (target / "book.json").exists():
                    shutil.rmtree(target, ignore_errors=True)
                raise
            self.finish_restore(job, f"已恢复：{entry['title']}", archive)
            self.persist(job)
        finally:
            archives.close()
            if not (directory / "pending.json").exists():
                shutil.rmtree(stage, ignore_errors=True)

    def validate_refs(self, refs, entry, stage, chapter_count):
        if not isinstance(refs, list) or len(refs) > 500000:
            raise ValueError("固定音频记录无效")
        allowed = set(entry.get("audio", []))
        for row in refs:
            if (not isinstance(row, dict) or any(k not in row for k in REF_COLUMNS) or row["book_id"] != entry["id"]
                    or any(not KEY.fullmatch(str(row[k])) for k in ("cache_key", "chapter_hash", "profile_key"))
                    or type(row["chapter_index"]) is not int or not 0 <= row["chapter_index"] < chapter_count
                    or type(row["sentence_index"]) is not int or row["sentence_index"] < 0
                    or not isinstance(row["sentence_text"], str) or len(row["sentence_text"]) > 10000
                    or row["audio_format"] not in self.b.TTS_AUDIO_FORMATS
                    or type(row["created_at"]) not in (int, float) or not math.isfinite(row["created_at"])):
                raise ValueError("固定音频记录无效")
            if entry.get("pinned_sentences") is None:
                raise ValueError("固定音频清单无效")
            name = f"audio/{row['cache_key']}.{row['audio_format']}"
            if name not in allowed or not (stage / name).is_file():
                raise ValueError("固定音频文件缺失")

    def public(self, job):
        result = {k: v for k, v in dict(job).items() if k != "manifest"}
        result["contents"] = [{k: book.get(k) for k in ("id", "title", "items", "pinned_sentences")}
                              for book in (job.get("manifest") or {}).get("books", [])]
        result["tool_contents"] = (job.get("manifest") or {}).get("tools", [])
        return result


def install(app, backend):
    service = ReadingBackups(backend)
    app.extensions["reading_backups"] = service

    @app.route("/reader/backup")
    def reader_backup_page():
        if not backend.require_auth():
            return redirect("/login")
        return render_template("reader_backup.html")

    @app.route("/api/reader/backups", methods=["GET", "POST"])
    @app.route("/api/reader/backups/<identity>", methods=["GET", "POST", "PUT", "DELETE"])
    def api_reader_backup(identity=None):
        if not backend.require_auth():
            return jsonify(error="unauthorized"), 401
        try:
            if identity is None:
                if request.method == "GET":
                    return jsonify(backups=service.list_jobs(), books=service.catalog())
                body = backend.request_json_object()
                kind = body.get("kind")
                if body.get("action") == "estimate":
                    books = service.selections(body.get("books", []))
                    tools = backup_settings.selections(body.get("tools", []))
                    settings_size = len(json.dumps(service.tools.snapshot(tools)).encode()) if tools else 0
                    return jsonify(size=service.estimate(books) + settings_size + (4096 if tools else 0))
                if kind not in {"selected", "upload"}:
                    raise ValueError("请选择备份项目")
                selections = service.selections(body.get("books", [])) if kind == "selected" else {}
                tools = backup_settings.selections(body.get("tools", [])) if kind == "selected" else {}
                password = backup_crypto.password_value(body.get("password", ""), required=any("credentials" in i for i in tools.values()))
                if kind == "selected" and not selections and not tools:
                    raise ValueError("请选择备份项目")
                with service.lock:
                    job = service.new(kind)
                    if kind == "selected":
                        service.start(job, service.export, selections, tools, password)
                return jsonify(service.public(job)), 202
            job = service.get(identity)
            directory = service.root / identity
            if request.method == "GET":
                return jsonify(service.public(job))
            with service.lock:
                service.require_recovered()
                job = service.get(identity)  # Expiry/deletion may have run since the first lookup.
                if service.busy:
                    return jsonify(error="已有备份操作正在进行，请稍后重试"), 409
                if request.method == "DELETE":
                    service.delete(identity)
                    return jsonify(ok=True)
                if request.method == "PUT":
                    if job["status"] != "uploading":
                        raise ValueError("此会话不能继续上传")
                    data = request.get_data()
                    if not data or len(data) > CHUNK_BYTES:
                        raise ValueError("上传分块大小无效")
                    path = directory / "backup.zip"
                    offset = path.stat().st_size if path.exists() else 0
                    if str(offset) != request.headers.get("X-Upload-Offset"):
                        return jsonify(error="上传位置不一致，请重新上传"), 409
                    service.space(len(data))
                    with path.open("ab") as output:
                        os.chmod(path, 0o600)
                        output.write(data)
                    job["size"] = offset + len(data)
                    if offset == 0:
                        job["encrypted"] = data.startswith(backup_crypto.MAGIC)
                    service.persist(job)
                    return jsonify(offset=offset + len(data))
                body = backend.request_json_object()
                action = body.get("action")
                password = backup_crypto.password_value(body.get("password", ""))
                if action in {"preview", "compare", "restore", "restore_tool"} and (directory / "backup.zip").exists():
                    encrypted = backup_crypto.is_encrypted(directory / "backup.zip")
                    if encrypted and not password:
                        return jsonify(error="请输入备份密码", password_required=True), 400
                if action == "preview" and (directory / "backup.zip").exists():
                    service.start(job, service.preview, password)
                elif action == "compare" and job.get("manifest"):
                    # Hash comparison may take time for large source files; keep it off the request thread.
                    def compare(job):
                        service.compare(job, password)
                        job.update(status="preview", message="对比已刷新", progress=100)
                    service.start(job, compare)
                elif action == "restore_tool" and job.get("manifest"):
                    if body.get("confirm") is not True:
                        raise ValueError("请确认覆盖所选工具配置或凭据")
                    service.start(job, service.restore_tool, body.get("tool"), body.get("items"), body.get("token", ""), password)
                elif action == "restore" and job.get("manifest"):
                    book_id = body.get("book_id", "")
                    if not isinstance(book_id, str) or not ID.fullmatch(book_id):
                        raise ValueError("书籍标识无效")
                    items = selected_items(body.get("items"))
                    service.start(job, service.restore, book_id, body.get("token", ""),
                                  body.get("replace") is True, items, body.get("audio_mode", "merge"), password)
                else:
                    raise ValueError("备份操作无效")
                return jsonify(service.public(job)), 202
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except (KeyError, TypeError, zipfile.BadZipFile):
            return jsonify(error="操作无效或会话已过期，请检查输入并重新尝试"), 400
        except OSError:
            return jsonify(error="备份文件读写失败，请检查磁盘空间"), 500

    @app.before_request
    def expire_backups():
        # At most once a minute while the service is used; never refresh expiry on reads.
        now = time.monotonic()
        if now - getattr(service, "last_cleanup", 0) >= 60:
            service.last_cleanup = now
            if service.root.exists():
                try:
                    service.cleanup()
                except OSError:
                    app.logger.warning("backup cleanup deferred after I/O error")

    @app.route("/api/reader/backups/<identity>/download")
    def download_reader_backup(identity):
        if not backend.require_auth():
            return jsonify(error="unauthorized"), 401
        try:
            job = service.get(identity)
            if not job.get("manifest") or job["status"] in {"working", "uploading"}:
                raise ValueError("备份尚未就绪")
            extension = "transbak" if backup_crypto.is_encrypted(service.root / identity / "backup.zip") else "zip"
            return send_file(service.root / identity / "backup.zip", as_attachment=True, mimetype="application/octet-stream",
                             download_name=f"Trans-backup-{time.strftime('%Y%m%d-%H%M%S', time.localtime(job['created_at']))}.{extension}", conditional=True)
        except (ValueError, OSError):
            return jsonify(error="备份尚未就绪或已清理"), 404
