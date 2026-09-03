import json
import logging
import hashlib
import hmac
import ipaddress
import base64
import binascii
import html
import posixpath
import re
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from html.parser import HTMLParser
from logging.handlers import RotatingFileHandler
import os
import secrets
from datetime import timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

import requests
from flask import Flask, jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
VERSION_FILE = BASE_DIR / "VERSION"
CONFIG_DIR = BASE_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "app_config.json"
SERVICE_CONFIG_FILE = CONFIG_DIR / "service_config.json"
SERVICE_CONFIG_EXAMPLE_FILE = CONFIG_DIR / "service_config.example.json"
MIMO_BALANCE_STATE_FILE = CONFIG_DIR / "mimo_balance_state.json"
LOG_DIR = BASE_DIR / "logs"
READER_DIR = BASE_DIR / "reader_data"
READER_BOOK_DIR = READER_DIR / "books"
READER_INDEX_FILE = READER_DIR / "books.json"
TTS_CACHE_DIR = READER_DIR / "tts_cache"
TTS_PACK_CACHE_DIR = READER_DIR / "tts_pack_cache"
TTS_OFFLINE_DB = READER_DIR / "tts_offline.sqlite3"
TTS_CACHE_STATS_SNAPSHOT_FILE = READER_DIR / "tts_cache_stats.json"


def load_app_version():
    try:
        version = VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError(f"无法读取版本文件: {VERSION_FILE}") from error
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z.-]+)?", version):
        raise RuntimeError(f"VERSION 中的版本号格式无效: {version!r}")
    return version


def content_fingerprint(paths, length=12, seed=""):
    digest = hashlib.sha256(seed.encode("utf-8"))
    for path in paths:
        try:
            relative_name = path.relative_to(BASE_DIR).as_posix()
        except ValueError:
            relative_name = path.name
        digest.update(relative_name.encode("utf-8"))
        digest.update(b"\0")
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(128 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            digest.update(b"missing")
        digest.update(b"\0")
    return digest.hexdigest()[:length]


APP_VERSION = load_app_version()
RUNTIME_BACKEND_FINGERPRINT = content_fingerprint((BASE_DIR / "app.py",), length=16)
BUILD_VERSION_FILES = (
    BASE_DIR / "templates" / "home.html",
    BASE_DIR / "templates" / "index.html",
    BASE_DIR / "templates" / "login.html",
    BASE_DIR / "templates" / "reader.html",
    BASE_DIR / "static" / "styles.css",
    BASE_DIR / "static" / "ui.css",
    BASE_DIR / "static" / "ui.js",
    BASE_DIR / "static" / "app.js",
    BASE_DIR / "static" / "font-cache.js",
    BASE_DIR / "static" / "home.js",
    BASE_DIR / "static" / "reader.css",
    BASE_DIR / "static" / "reader-theme.js",
    BASE_DIR / "static" / "reader.js",
    BASE_DIR / "static" / "site-icon.svg",
    BASE_DIR / "static" / "site.webmanifest",
    BASE_DIR / "static" / "media-artwork.png",
    BASE_DIR / "static" / "github-mark.svg",
)
TRANSLATION_CACHE_DB = CONFIG_DIR / "deepseek_cache.sqlite3"
CACHE_LIMIT = 500
CACHE_MAX_TEXT_CHARS = 12000
MAX_TRANSLATE_CHARS = 20000
DEEPSEEK_TRANSLATION_PROMPT_VERSION = 4
DEEPSEEK_BATCH_MAX_CHARS = 5000
DEEPSEEK_BATCH_MAX_SEGMENTS = 30
MAX_BOOK_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_BOOK_TEXT_CHARS = 3_000_000
MAX_EPUB_UNCOMPRESSED_BYTES = 80 * 1024 * 1024
MAX_EPUB_ENTRY_BYTES = 12 * 1024 * 1024
MAX_EPUB_XML_BYTES = 4 * 1024 * 1024
MAX_EPUB_ENTRIES = 10_000
MAX_PDF_PAGES = 5_000
MAX_JSON_REQUEST_BYTES = 256 * 1024
MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024
MAX_TTS_PACK_BYTES = 32 * 1024 * 1024
TTS_PACK_SCHEMA_VERSION = 2
TTS_PACK_MIN_SECONDS = 5.1
TTS_PACK_PAD_SECONDS = TTS_PACK_MIN_SECONDS + 0.25
TTS_PACK_PRUNE_INTERVAL_SECONDS = 60
TTS_CACHE_STATS_MAX_AGE_SECONDS = 60
TTS_PACK_PREFETCH_HINT_LIMIT = 16
TTS_OFFLINE_STATUS_SNAPSHOT_VERSION = 1
CHAPTER_CACHE_VERSION = 5
TTS_SENTENCE_INDEX_VERSION = 1
OFFICIAL_DEEPSEEK_HOSTS = {"api.deepseek.com"}
OFFICIAL_MIMO_TTS_HOSTS = {"api.xiaomimimo.com"}
OFFICIAL_MIMO_BALANCE_HOSTS = {"platform.xiaomimimo.com"}
DEEPSEEK_BALANCE_TTL = 900
DEEPSEEK_BALANCE_RETRY_INTERVAL = 15
MIMO_BALANCE_TTL = 900
MIMO_BALANCE_RETRY_INTERVAL = 15
RESTART_COOLDOWN_SECONDS = 30
DEEPSEEK_BALANCE_CACHE = {"time": 0.0, "attempt_time": 0.0, "data": None}
MIMO_BALANCE_CACHE = {"time": 0.0, "attempt_time": 0.0, "data": None}
RESTART_STATE = {"time": 0.0}
PROCESS_START_TIME = time.time()
CPU_SAMPLE = {"time": time.time(), "cpu": 0.0}
SYSTEM_CPU_SAMPLE = {"idle": 0, "total": 0}
SERVICE_READY_LOCK = threading.Lock()
SERVICE_READY_STATE = {"logged": False}
SUPPORTED_BOOK_EXTENSIONS = {".txt", ".epub", ".pdf"}
BOOK_EXTENSION_ALIASES = {
    ".epub.zip": ".epub",
}
READER_IO_LOCK = threading.RLock()
CONFIG_IO_LOCK = threading.RLock()
MIMO_BALANCE_LOCK = threading.RLock()
TRANSLATION_CACHE_LOCK = threading.RLock()
CHAPTER_PARSE_LOCKS = {}
CHAPTER_PARSE_LOCKS_LOCK = threading.Lock()
MAX_ACTIVE_BOOK_IMPORTS = 2
BOOK_IMPORT_JOB_RETENTION_SECONDS = 3600
BOOK_IMPORT_JOBS = OrderedDict()
BOOK_IMPORT_LOCK = threading.RLock()
LOGIN_FAILURE_WINDOW_SECONDS = 5 * 60
LOGIN_FAILURE_LIMIT = 8
LOGIN_FAILURES = {}
LOGIN_FAILURE_LOCK = threading.Lock()
LOGIN_FAILURE_MAX_IPS = 10_000
TTS_CACHE_LOCK = threading.RLock()
TTS_CACHE_KEY_LOCKS = tuple(threading.Lock() for _ in range(64))
TTS_PACK_KEY_LOCKS = tuple(threading.Lock() for _ in range(32))
TTS_SENTENCE_INDEX_LOCKS = tuple(threading.Lock() for _ in range(32))
TTS_PACK_CACHE_LOCK = threading.RLock()
TTS_PACK_PRUNE_STATE = {"time": 0.0}
TTS_CACHE_STATS_LOCK = threading.RLock()
TTS_CACHE_STATS_READY = threading.Event()
TTS_CACHE_STATS_STATE = {
    "data": None,
    "revision": 0,
    "data_revision": -1,
    "refreshed_at": 0.0,
    "refreshing": False,
    "refresh_again": False,
    "snapshot_loaded": False,
}
TTS_PACK_BUILD_SEMAPHORE = threading.BoundedSemaphore(2)
TTS_OFFLINE_LOCK = threading.RLock()
TTS_OFFLINE_STATUS_LOCKS = tuple(threading.Lock() for _ in range(32))
TTS_OFFLINE_JOB_LOCK = threading.RLock()
TTS_OFFLINE_JOBS = OrderedDict()
TTS_OFFLINE_JOB_RETENTION_SECONDS = 3600
TTS_OFFLINE_CHAPTER_WORKERS = 2
TTS_OFFLINE_MAX_CHAPTERS = 300
TTS_OFFLINE_PACK_WORKERS = 2
UNSAFE_APP_PASSWORDS = {"", "changeme", "password", "admin", "123456", "replace-with-a-strong-password"}
UNSAFE_SECRET_KEYS = {"", "replace-with-a-long-random-string", "changeme", "secret"}
SECRET_KEY_FILE = CONFIG_DIR / "secret_key"
MIMO_BALANCE_COOKIE_NAMES = (
    "api-platform_serviceToken",
    "userId",
    "api-platform_ph",
    "api-platform_slh",
)
MIMO_BALANCE_REQUIRED_COOKIE_NAMES = {"api-platform_serviceToken", "userId"}
TTS_AUDIO_FORMATS = {
    "m4a": "audio/mp4",
}
TTS_MODEL_OPTIONS = [
    "mimo-v2.5-tts",
]
TTS_VOICE_OPTIONS = [
    {"id": "mimo_default", "name": "MiMo-默认", "language": "自动", "gender": "自动", "models": ["mimo-v2.5-tts"]},
    {"id": "冰糖", "name": "冰糖", "language": "中文", "gender": "女声", "models": ["mimo-v2.5-tts"]},
    {"id": "茉莉", "name": "茉莉", "language": "中文", "gender": "女声", "models": ["mimo-v2.5-tts"]},
    {"id": "苏打", "name": "苏打", "language": "中文", "gender": "男声", "models": ["mimo-v2.5-tts"]},
    {"id": "白桦", "name": "白桦", "language": "中文", "gender": "男声", "models": ["mimo-v2.5-tts"]},
    {"id": "Mia", "name": "Mia", "language": "英语", "gender": "女声", "models": ["mimo-v2.5-tts"]},
    {"id": "Chloe", "name": "Chloe", "language": "英语", "gender": "女声", "models": ["mimo-v2.5-tts"]},
    {"id": "Milo", "name": "Milo", "language": "英语", "gender": "男声", "models": ["mimo-v2.5-tts"]},
    {"id": "Dean", "name": "Dean", "language": "英语", "gender": "男声", "models": ["mimo-v2.5-tts"]},
]


def load_service_config():
    source = SERVICE_CONFIG_FILE if SERVICE_CONFIG_FILE.exists() else SERVICE_CONFIG_EXAMPLE_FILE
    try:
        config = json.loads(source.read_text(encoding="utf-8"))
        google = config["google"]
        endpoint = google["endpoint"]
        endpoint_options = google["endpoint_options"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError(f"无法读取服务配置: {source}") from error
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise RuntimeError("服务配置中的谷歌翻译接口地址无效")
    if not isinstance(endpoint_options, list) or not all(
        isinstance(item, str) and item.strip() for item in endpoint_options
    ):
        raise RuntimeError("服务配置中的谷歌翻译接口备选列表无效")
    if source == SERVICE_CONFIG_EXAMPLE_FILE:
        CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            descriptor = os.open(SERVICE_CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
    return config


SERVICE_CONFIG = load_service_config()


DEFAULT_CONFIG = {
    "app_password": "changeme",
    "deepseek": {
        "enabled": True,
        "api_key": "",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-flash",
        "temperature": 0.2,
        "thinking": "disabled",
        "reasoning_effort": "medium",
        "timeout": 45,
        "style": "default",
    },
    "google": {
        "enabled": True,
        "endpoint": SERVICE_CONFIG["google"]["endpoint"],
        "timeout": 25,
    },
    "reader_tts": {
        "enabled": False,
        "provider": "mimo",
        "api_key": "",
        "base_url": "https://api.xiaomimimo.com/v1/chat/completions",
        "balance_url": "https://platform.xiaomimimo.com/api/v1/balance",
        "balance_cookie": "",
        "model": "mimo-v2.5-tts",
        "voice_id": "mimo_default",
        "format": "m4a",
        "style_prompt": "自然清晰地朗读，适合小说听书，语速适中，情绪跟随文本。",
        "timeout": 30,
        "chunk_chars": 260,
        "cache_enabled": True,
    },
}


DEEPSEEK_STYLES = {
    "default": {
        "name": "默认",
        "prompt": "Translate faithfully and naturally. Preserve all meaning, paragraph breaks, labels, numbering, and formatting. Return only the translated text.",
    },
    "academic": {
        "name": "学术翻译",
        "prompt": "Translate in a formal academic style. Preserve terminology, logic, citations, numbers, paragraph breaks, labels, and argument order. Return only the translated text.",
    },
    "literary": {
        "name": "文学创作",
        "prompt": "Translate with literary fluency and expressive rhythm while preserving every sentence, paragraph, meaning, imagery, and tone. Return only the translated text.",
    },
    "business": {
        "name": "商务正式",
        "prompt": "Translate in a polished business style. Keep the wording professional while preserving every sentence, paragraph, number, and label. Return only the translated text.",
    },
    "plain": {
        "name": "通俗易懂",
        "prompt": "Translate into clear, simple, easy-to-understand language while preserving every sentence, paragraph, number, and label. Return only the translated text.",
    },
}


LANGUAGES = [
    {"code": "auto", "name": "自动检测"},
    {"code": "zh", "name": "中文"},
    {"code": "en", "name": "英语"},
    {"code": "ja", "name": "日语"},
    {"code": "ko", "name": "韩语"},
    {"code": "fr", "name": "法语"},
    {"code": "de", "name": "德语"},
    {"code": "es", "name": "西班牙语"},
    {"code": "ru", "name": "俄语"},
    {"code": "it", "name": "意大利语"},
    {"code": "pt", "name": "葡萄牙语"},
    {"code": "ar", "name": "阿拉伯语"},
    {"code": "tr", "name": "土耳其语"},
    {"code": "vi", "name": "越南语"},
    {"code": "th", "name": "泰语"},
]
LANGUAGE_CODES = {language["code"] for language in LANGUAGES}


def deep_merge(base, override):
    merged = dict(base)
    for key, value in override.items():
        if isinstance(merged.get(key), dict):
            if isinstance(value, dict):
                merged[key] = deep_merge(merged[key], value)
            continue
        merged[key] = value
    return merged


def load_dotenv():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), parse_env_value(value))


def parse_env_value(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        quote = value[0]
        value = value[1:-1]
        if quote == "'":
            return value
        value = value.replace('\\"', '"').replace("\\\\", "\\")
    return value


def quote_env_value(value):
    value = "" if value is None else str(value)
    if not value or any(char.isspace() for char in value) or any(char in value for char in '"\'#\\'):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def clean_single_line_value(value):
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()


def parse_mimo_balance_cookie(value, strict=True):
    raw = clean_single_line_value(value)
    if raw.lower().startswith("cookie:"):
        raw = raw.split(":", 1)[1].strip()
    cookies = {}
    for part in raw.split(";"):
        name, separator, cookie_value = part.strip().partition("=")
        if not separator or name not in MIMO_BALANCE_COOKIE_NAMES:
            continue
        cookie_value = cookie_value.strip()
        if cookie_value and len(cookie_value) <= 8192:
            cookies[name] = cookie_value
    missing = MIMO_BALANCE_REQUIRED_COOKIE_NAMES.difference(cookies)
    if missing:
        if strict:
            names = "、".join(sorted(missing))
            raise ValueError(f"MiMo 余额 Cookie 缺少必要字段：{names}")
        return {}
    return cookies


def format_mimo_balance_cookie(cookies):
    return "; ".join(f"{name}={cookies[name]}" for name in MIMO_BALANCE_COOKIE_NAMES if name in cookies)


def normalize_mimo_balance_cookie(value, strict=True):
    return format_mimo_balance_cookie(parse_mimo_balance_cookie(value, strict=strict))


def ensure_private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def write_private_text_atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def write_private_bytes_atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def load_or_create_secret_key():
    configured = clean_single_line_value(os.getenv("SECRET_KEY", ""))
    if configured not in UNSAFE_SECRET_KEYS and len(configured) >= 32:
        return configured
    ensure_private_directory(CONFIG_DIR)
    with CONFIG_IO_LOCK:
        try:
            stored = clean_single_line_value(SECRET_KEY_FILE.read_text(encoding="utf-8"))
        except OSError:
            stored = ""
        if len(stored) >= 32:
            return stored
        generated = secrets.token_urlsafe(48)
        write_private_text_atomic(SECRET_KEY_FILE, f"{generated}\n")
        return generated


def detect_book_suffix(filename):
    normalized = clean_single_line_value(filename).lower()
    for alias, suffix in BOOK_EXTENSION_ALIASES.items():
        if normalized.endswith(alias):
            return suffix
    return Path(normalized).suffix.lower()


def clean_display_text(value, max_length=120):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:max_length]


def normalize_title_text(value, max_length=120):
    text = clean_display_text(value, max_length)
    text = re.sub(r"\s*([·、，,。；;：:])\s*", r"\1", text)
    def fix_cjk_space(match):
        before, after = match.group(1), match.group(2)
        if before in "章节回部篇集卷":
            return f"{before} {after}"
        return before + after
    text = re.sub(r"([\u4e00-\u9fff])\s+([\u4e00-\u9fff])", fix_cjk_space, text)
    return text


def env_flag(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def is_public_address(hostname):
    try:
        addresses = {
            result[4][0]
            for result in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        }
    except socket.gaierror:
        return False
    if not addresses:
        return False
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False
    return True


def validate_server_api_url(value, fallback):
    candidate = clean_single_line_value(value).rstrip("/")
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment:
        return fallback
    try:
        port = parsed.port
    except ValueError:
        return fallback
    if parsed.username or parsed.password:
        return fallback
    allow_custom = os.getenv("ALLOW_CUSTOM_DEEPSEEK_BASE_URL", "").lower() in {"1", "true", "yes"}
    if not allow_custom:
        if parsed.hostname not in OFFICIAL_DEEPSEEK_HOSTS or port not in {None, 443}:
            return DEFAULT_CONFIG["deepseek"]["base_url"]
        return candidate
    if not is_public_address(parsed.hostname):
        return fallback
    return candidate


def validate_google_translate_url(value, fallback, strict=False):
    candidate = clean_single_line_value(value)[:2048].rstrip("/")
    parsed = urlparse(candidate)
    try:
        port = parsed.port
    except ValueError:
        valid = False
    else:
        valid = bool(
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.path not in {"", "/"}
            and not parsed.query
            and not parsed.fragment
            and not parsed.username
            and not parsed.password
            and (port is None or port > 0)
        )
    if valid:
        return candidate
    if strict:
        raise ValueError("谷歌翻译接口必须是不含查询参数的 HTTPS 地址")
    return fallback


def validate_mimo_tts_url(value, fallback):
    candidate = clean_single_line_value(value).rstrip("/")
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment:
        return fallback
    try:
        port = parsed.port
    except ValueError:
        return fallback
    if parsed.username or parsed.password:
        return fallback
    allow_custom = env_flag("ALLOW_CUSTOM_MIMO_BASE_URL", False)
    if not allow_custom:
        if parsed.hostname not in OFFICIAL_MIMO_TTS_HOSTS or port not in {None, 443}:
            return DEFAULT_CONFIG["reader_tts"]["base_url"]
        return candidate
    if not is_public_address(parsed.hostname):
        return fallback
    return candidate


def validate_mimo_balance_url(value, fallback):
    candidate = clean_single_line_value(value).rstrip("/")
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.hostname or parsed.query or parsed.fragment:
        return fallback
    try:
        port = parsed.port
    except ValueError:
        return fallback
    if parsed.username or parsed.password:
        return fallback
    allow_custom = env_flag("ALLOW_CUSTOM_MIMO_BASE_URL", False)
    if not allow_custom:
        if parsed.hostname not in OFFICIAL_MIMO_BALANCE_HOSTS or port not in {None, 443}:
            return DEFAULT_CONFIG["reader_tts"]["balance_url"]
        return candidate
    if not is_public_address(parsed.hostname):
        return fallback
    return candidate


def save_dotenv_values(values):
    with CONFIG_IO_LOCK:
        env_path = BASE_DIR / ".env"
        values = {key: clean_single_line_value(value) for key, value in values.items()}
        existing = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        seen = set()
        updated_lines = []
        for line in existing:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in line:
                updated_lines.append(line)
                continue
            key = line.split("=", 1)[0].strip()
            if key in values:
                updated_lines.append(f"{key}={quote_env_value(values[key])}")
                os.environ[key] = str(values[key])
                seen.add(key)
            else:
                updated_lines.append(line)
        for key, value in values.items():
            if key not in seen:
                updated_lines.append(f"{key}={quote_env_value(value)}")
                os.environ[key] = str(value)
        write_private_text_atomic(env_path, "\n".join(updated_lines).rstrip() + "\n")


def apply_env(config):
    config["app_password"] = os.getenv("APP_PASSWORD", config["app_password"])
    deepseek = config["deepseek"]
    deepseek["api_key"] = os.getenv("DEEPSEEK_API_KEY", deepseek["api_key"])
    deepseek["base_url"] = validate_server_api_url(
        os.getenv("DEEPSEEK_BASE_URL", DEFAULT_CONFIG["deepseek"]["base_url"]),
        DEFAULT_CONFIG["deepseek"]["base_url"],
    )
    deepseek["model"] = os.getenv("DEEPSEEK_MODEL", deepseek["model"])
    reader_tts = config["reader_tts"]
    reader_tts["api_key"] = os.getenv("MIMO_API_KEY", reader_tts["api_key"])
    reader_tts["base_url"] = validate_mimo_tts_url(
        os.getenv("MIMO_TTS_BASE_URL", DEFAULT_CONFIG["reader_tts"]["base_url"]),
        DEFAULT_CONFIG["reader_tts"]["base_url"],
    )
    reader_tts["balance_url"] = validate_mimo_balance_url(
        os.getenv("MIMO_BALANCE_URL", DEFAULT_CONFIG["reader_tts"]["balance_url"]),
        DEFAULT_CONFIG["reader_tts"]["balance_url"],
    )
    reader_tts["balance_cookie"] = stored_mimo_balance_cookie()
    reader_tts["model"] = os.getenv("MIMO_TTS_MODEL", reader_tts["model"])
    if reader_tts["model"] not in TTS_MODEL_OPTIONS:
        reader_tts["model"] = TTS_MODEL_OPTIONS[0]
    reader_tts["voice_id"] = os.getenv("MIMO_TTS_VOICE", reader_tts["voice_id"])
    reader_tts["style_prompt"] = os.getenv("MIMO_TTS_STYLE_PROMPT", reader_tts.get("style_prompt", ""))
    reader_tts.pop("optimize_text_preview", None)
    config["google"]["endpoint"] = validate_google_translate_url(
        config["google"].get("endpoint", DEFAULT_CONFIG["google"]["endpoint"]),
        DEFAULT_CONFIG["google"]["endpoint"],
    )
    return config


def load_config():
    with CONFIG_IO_LOCK:
        ensure_private_directory(CONFIG_DIR)
        config_missing = not CONFIG_FILE.exists()
        if not config_missing:
            try:
                saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                saved = {}
        else:
            saved = {}
        if not isinstance(saved, dict):
            saved = {}
        config = apply_env(deep_merge(DEFAULT_CONFIG, saved))
        config.pop("libretranslate", None)
        config.pop("microsoft", None)
        config.pop("mymemory", None)
        config.pop("iciba", None)
        if config_missing:
            save_config(config)
        return config


def save_config(config):
    with CONFIG_IO_LOCK:
        ensure_private_directory(CONFIG_DIR)
        safe = json.loads(json.dumps(config))
        safe.pop("app_password", None)
        if "deepseek" in safe:
            safe["deepseek"].pop("api_key", None)
        if "reader_tts" in safe:
            safe["reader_tts"].pop("api_key", None)
            safe["reader_tts"].pop("balance_cookie", None)
        write_json_atomic(CONFIG_FILE, safe, indent=2)


class XHTMLTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    }

    SKIP_TAGS = {"head", "script", "style", "title", "svg", "math", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if not self.skip_depth and tag in self.BLOCK_TAGS:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
            return
        if not self.skip_depth and tag in self.BLOCK_TAGS:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if self.skip_depth:
            return
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self):
        raw = "".join(self.parts)
        raw = html.unescape(raw)
        raw = re.sub(r"[ \t\f\v]+", " ", raw)
        raw = re.sub(r" *\n+ *", "\n\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


class XHTMLContentExtractor(HTMLParser):
    BLOCK_TAGS = XHTMLTextExtractor.BLOCK_TAGS
    SKIP_TAGS = XHTMLTextExtractor.SKIP_TAGS

    def __init__(self, base_href):
        super().__init__(convert_charrefs=True)
        self.base_href = base_href
        self.blocks = []
        self.parts = []
        self.skip_depth = 0
        self.seen_images = set()

    def flush_text(self):
        raw = "".join(self.parts)
        self.parts = []
        text = html.unescape(raw)
        text = re.sub(r"[ \t\f\v]+", " ", text)
        text = re.sub(r" *\n+ *", "\n\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if text:
            self.blocks.append({"type": "text", "text": text})

    def remember_anchor(self, attrs):
        attr_map = {key.lower(): value for key, value in attrs if value}
        anchor = attr_map.get("id") or attr_map.get("name")
        if anchor:
            self.flush_text()
            self.blocks.append({"type": "anchor", "id": unquote(anchor)})

    def image_href(self, attrs):
        attr_map = {key.lower(): value for key, value in attrs if value}
        href = attr_map.get("src") or attr_map.get("href") or attr_map.get("xlink:href")
        if not href or href.startswith("data:"):
            return ""
        path = href.split("#", 1)[0].split("?", 1)[0]
        if Path(path).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            return ""
        try:
            return zip_path_join(posixpath.dirname(self.base_href), href)
        except ValueError:
            return ""

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        self.remember_anchor(attrs)
        if tag in self.BLOCK_TAGS:
            self.flush_text()
        if tag in {"img", "image"}:
            href = self.image_href(attrs)
            if href and href not in self.seen_images:
                self.flush_text()
                self.seen_images.add(href)
                self.blocks.append({"type": "image", "href": href})

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
            return
        if not self.skip_depth and tag in self.BLOCK_TAGS:
            self.flush_text()

    def handle_data(self, data):
        if self.skip_depth:
            return
        text = data.strip()
        if text:
            self.parts.append(text)

    def content_blocks(self):
        self.flush_text()
        return self.blocks


def ensure_reader_dirs():
    ensure_private_directory(READER_BOOK_DIR)
    for directory in (READER_DIR, READER_BOOK_DIR):
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    if not READER_INDEX_FILE.exists():
        write_private_text_atomic(READER_INDEX_FILE, "[]\n")


def load_book_index():
    ensure_reader_dirs()
    with READER_IO_LOCK:
        try:
            data = json.loads(READER_INDEX_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return data if isinstance(data, list) else []


def save_book_index(books):
    ensure_reader_dirs()
    with READER_IO_LOCK:
        write_json_atomic(READER_INDEX_FILE, books, indent=2)


def write_json_atomic(path, data, indent=None):
    if indent is None:
        content = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    else:
        content = json.dumps(data, ensure_ascii=False, indent=indent)
    write_private_text_atomic(path, content)


def chapter_parse_lock(book_id, chapter_index):
    key = (str(book_id), int(chapter_index))
    with CHAPTER_PARSE_LOCKS_LOCK:
        lock = CHAPTER_PARSE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            CHAPTER_PARSE_LOCKS[key] = lock
        return lock


def public_import_job(job):
    return {
        "id": job["id"],
        "book_id": job.get("book_id", ""),
        "name": job.get("name", ""),
        "status": job.get("status", ""),
        "message": job.get("message", ""),
        "progress": job.get("progress", 0),
        "error": job.get("error", ""),
        "book": job.get("book"),
        "created_at": job.get("created_at", 0),
        "updated_at": job.get("updated_at", 0),
    }


def cleanup_import_jobs_locked():
    now = time.time()
    for job_id in list(BOOK_IMPORT_JOBS.keys()):
        job = BOOK_IMPORT_JOBS[job_id]
        if job.get("status") in {"done", "error"} and now - float(job.get("updated_at", 0)) > BOOK_IMPORT_JOB_RETENTION_SECONDS:
            BOOK_IMPORT_JOBS.pop(job_id, None)
    while len(BOOK_IMPORT_JOBS) > 50:
        first_id, first_job = next(iter(BOOK_IMPORT_JOBS.items()))
        if first_job.get("status") in {"uploading", "parsing"}:
            break
        BOOK_IMPORT_JOBS.pop(first_id, None)


def active_import_count_locked():
    return sum(1 for job in BOOK_IMPORT_JOBS.values() if job.get("status") in {"uploading", "parsing"})


def update_import_job(job_id, **updates):
    with BOOK_IMPORT_LOCK:
        job = BOOK_IMPORT_JOBS.get(job_id)
        if not job:
            return None
        job.update(updates)
        job["updated_at"] = time.time()
        BOOK_IMPORT_JOBS.move_to_end(job_id)
        cleanup_import_jobs_locked()
        return public_import_job(job)


def book_dir(book_id):
    if not re.fullmatch(r"[0-9a-f]{32}", str(book_id or "")):
        raise ValueError("书籍 ID 无效")
    return READER_BOOK_DIR / book_id


def book_record_path(book_id):
    return book_dir(book_id) / "book.json"


def book_chapter_cache_dir(book_id):
    return book_dir(book_id) / "chapters"


def book_chapter_cache_path(book_id, chapter_index):
    return book_chapter_cache_dir(book_id) / f"{int(chapter_index):06d}.json"


def book_tts_sentence_index_path(book_id):
    return book_dir(book_id) / "tts_sentence_counts.json"


def read_book_record(book_id):
    path = book_record_path(book_id)
    with READER_IO_LOCK:
        if not path.exists():
            raise FileNotFoundError("书籍不存在")
        return json.loads(path.read_text(encoding="utf-8"))


def write_book_record(book):
    target_dir = book_dir(book["id"])
    with READER_IO_LOCK:
        target_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(target_dir, 0o700)
        write_json_atomic(book_record_path(book["id"]), book)


def book_summary(book):
    chapters = book.get("chapters", [])
    progress = book.get("progress", {})
    return {
        "id": book["id"],
        "title": book.get("title") or "未命名书籍",
        "author": book.get("author") or "",
        "format": book.get("format") or "",
        "cover_url": f"/api/books/{book['id']}/cover" if book.get("cover_name") else "",
        "created_at": book.get("created_at", 0),
        "updated_at": book.get("updated_at", 0),
        "last_opened_at": book.get("last_opened_at") or book.get("updated_at") or book.get("created_at", 0),
        "chapter_count": len(chapters),
        "char_count": sum(int(chapter.get("char_count") or len(chapter.get("text", ""))) for chapter in chapters),
        "progress": progress,
    }


def display_chapter_title(chapter, index):
    title = clean_display_text(chapter.get("title") or "", 120)
    if title.lower() == "cover":
        return "封面"
    if title in {"未知", "目录", "Contents"}:
        return f"第 {index + 1} 章"
    return title or f"第 {index + 1} 章"


def book_chapter_summaries(book):
    return [
        {
            "index": chapter.get("index", index),
            "title": display_chapter_title(chapter, index),
            "level": max(1, min(int(chapter.get("level") or 1), 4)),
            "kind": chapter.get("kind", "chapter"),
            "char_count": int(chapter.get("char_count") or len(chapter.get("text", ""))),
            "cached": bool(chapter.get("cached") or chapter.get("text")),
        }
        for index, chapter in enumerate(book.get("chapters", []))
    ]


def rebuild_book_index():
    ensure_reader_dirs()
    with READER_IO_LOCK:
        summaries = []
        for path in READER_BOOK_DIR.glob("*/book.json"):
            try:
                summaries.append(book_summary(json.loads(path.read_text(encoding="utf-8"))))
            except (OSError, json.JSONDecodeError, KeyError):
                continue
        summaries.sort(key=lambda item: (item.get("last_opened_at", 0), item.get("created_at", 0)), reverse=True)
        save_book_index(summaries)
        return summaries


def load_book_index_or_rebuild():
    books = load_book_index()
    if not all(isinstance(book, dict) and book.get("id") for book in books):
        return rebuild_book_index()
    record_ids = {path.parent.name for path in READER_BOOK_DIR.glob("*/book.json")}
    index_ids = {str(book["id"]) for book in books}
    if record_ids != index_ids or len(books) != len(index_ids):
        return rebuild_book_index()
    books.sort(key=lambda item: (item.get("last_opened_at", 0), item.get("created_at", 0)), reverse=True)
    return books


def upsert_book_index(book):
    summary = book_summary(book)
    with READER_IO_LOCK:
        books = [
            item for item in load_book_index()
            if isinstance(item, dict) and item.get("id") != summary["id"]
        ]
        books.append(summary)
        books.sort(key=lambda item: (item.get("last_opened_at", 0), item.get("created_at", 0)), reverse=True)
        save_book_index(books)
    return summary


def remove_from_book_index(book_id):
    with READER_IO_LOCK:
        books = [
            item for item in load_book_index()
            if isinstance(item, dict) and item.get("id") != book_id
        ]
        save_book_index(books)


def decode_text_bytes(raw):
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def infer_txt_author(text, filename_title=""):
    sources = [str(text or "")[:20_000], str(filename_title or "")]
    pattern = re.compile(r"(?:作者|著者|作\s*者)\s*[:：]\s*([^\r\n|｜]{1,80})", re.IGNORECASE)
    for source in sources:
        match = pattern.search(source)
        if not match:
            continue
        author = re.split(r"\s{2,}|[【\[]", match.group(1), maxsplit=1)[0]
        author = re.sub(r"\.(?:txt|text)$", "", author, flags=re.IGNORECASE)
        author = clean_display_text(author.strip(" \t　·•-_—=《》〈〉【】[]（）()"), 120)
        if author:
            return author
    return ""


def normalize_book_text(text, max_chars=MAX_BOOK_TEXT_CHARS):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = text.strip()
    if max_chars and len(text) > max_chars:
        text = text[:max_chars]
    return text


NOISY_CHAPTER_TITLES = {"", "未知", "cover", "contents", "目录", "table of contents"}
CHAPTER_NUM_CHARS = "一二三四五六七八九十百千万零〇两0123456789０１２３４５６７８９"
CHAPTER_TITLE_PATTERNS = [
    re.compile(r"^(第[一二三四五六七八九十百千万零〇两\d]{1,8}[章节回部篇集卷]\s*[^，。]{0,60})$"),
    re.compile(r"^([上中下前后][卷部篇集]\s*[^，。]{0,60})$"),
    re.compile(r"^((?:序章|楔子|引子|前言|后记|尾声|终章|番外|外传|附录|版权信息)\s*[^，。]{0,60})$"),
    re.compile(r"^([0-9０-９]{1,4}\s*[.．、]\s*[^，。]{1,70})$"),
    re.compile(r"^(Chapter\s+[0-9IVXLCDM]+[\s:：.-]*.{0,70})$", re.IGNORECASE),
]
PLAIN_CHAPTER_TITLE_PATTERNS = [
    re.compile(rf"^第[{CHAPTER_NUM_CHARS}]{{1,18}}[章节回部篇集卷]\s*[^。]{{0,90}}$", re.IGNORECASE),
    re.compile(rf"^第[{CHAPTER_NUM_CHARS}]{{1,18}}卷[^。]{{0,50}}第[{CHAPTER_NUM_CHARS}]{{1,18}}章[^。]{{0,90}}$", re.IGNORECASE),
    re.compile(r"^[上中下前后][卷部篇集]\s*[^。]{0,80}$", re.IGNORECASE),
    re.compile(r"^(?:序章|楔子|引子|前言|后记|尾声|终章|番外|外传|附录|版权信息)\s*[^。]{0,80}$", re.IGNORECASE),
    re.compile(r"^(?:[（(]\s*\d+\s*鲜币\s*[）)]\s*)?[0-9０-９]{1,5}\s*[.．、]\s*[^，。]{1,90}$", re.IGNORECASE),
    re.compile(r"^Chapter\s+[0-9IVXLCDM]+[\s:：.-]*.{0,90}$", re.IGNORECASE),
]


def is_noisy_title(value):
    title = normalize_title_text(value, 120)
    lower = title.strip().lower()
    if lower in NOISY_CHAPTER_TITLES:
        return True
    if re.fullmatch(r"\d{1,5}\.(?:gif|jpe?g|png|webp|bmp|svg)", lower):
        return True
    if re.fullmatch(r"(?:image|img|pic|figure)[-_]?\d{0,5}\.(?:gif|jpe?g|png|webp|bmp|svg)", lower):
        return True
    return False


def is_structural_title(value):
    title = normalize_title_text(value, 100)
    return any(pattern.fullmatch(title) for pattern in CHAPTER_TITLE_PATTERNS)


def normalize_plain_chapter_title(value):
    text = normalize_title_text(value, 120)

    def collapse_number(match):
        number = re.sub(r"\s+", "", match.group(1))
        return f"第{number}{match.group(2)}"

    text = re.sub(
        rf"^第\s*([{CHAPTER_NUM_CHARS}\s]{{1,18}})\s*([章节回部篇集卷])",
        collapse_number,
        text,
    )
    text = re.sub(r"^([上中下前后])\s*([卷部篇集])", r"\1\2", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def could_be_plain_chapter_title(value):
    text = str(value or "").strip()
    if not text or len(text) > 140:
        return False
    lower = text.lower()
    if re.fullmatch(r"\d{1,5}\.(?:gif|jpe?g|png|webp|bmp|svg)", lower):
        return False
    if re.search(r"(?:https?://|www\.|\.com|\.net|\.org|下载|书包网|更多精彩|点击|最新网址)", text, re.IGNORECASE):
        return False
    if re.match(r"^(?:[（(]\s*\d+\s*鲜币\s*[）)]\s*)?[0-9０-９]{1,5}\s*[.．、]\s*\S+", text):
        return True
    if re.match(r"^第\s*[" + CHAPTER_NUM_CHARS + r"\s]{1,22}\s*[章节回部篇集卷]", text):
        return True
    if re.match(r"^[上中下前后]\s*[卷部篇集]", text):
        return True
    if re.match(r"^(?:序章|楔子|引子|前言|后记|尾声|终章|番外|外传|附录|版权信息)", text):
        return True
    if re.match(r"^Chapter\s+[0-9IVXLCDM]+", text, re.IGNORECASE):
        return True
    return False


def is_plain_chapter_title(value):
    if not could_be_plain_chapter_title(value):
        return False
    title = normalize_plain_chapter_title(value)
    if not title or is_noisy_title(title):
        return False
    if len(title) > 120:
        return False
    if re.search(r"(?:https?://|www\.|\.com|\.net|\.org|下载|书包网|更多精彩|点击|最新网址)", title, re.IGNORECASE):
        return False
    if title.count("。") + title.count("，") + title.count(",") >= 2:
        return False
    if re.fullmatch(r"\d{1,5}\.[A-Za-z0-9_ -]{1,12}", title):
        return False
    return any(pattern.fullmatch(title) for pattern in PLAIN_CHAPTER_TITLE_PATTERNS)


def infer_plain_prefix_title(text):
    lines = [normalize_plain_chapter_title(line.strip()) for line in text.splitlines()]
    lines = [line for line in lines if line and not is_noisy_title(line)]
    for line in lines[:24]:
        if re.fullmatch(r"(?:编者前言|前言|序言|序|自序|引言|声明|作者声明|内容简介|作者简介)", line):
            return line
    for line in lines[:4]:
        if re.search(r"(?:https?://|www\.|书包|下载|更多精彩)", line, re.IGNORECASE):
            continue
        if len(line) <= 40 and not re.search(r"[。！？!?]$", line):
            return line
    return "正文前内容"


def compact_epub_heading(title, next_line=""):
    title = normalize_title_text(title, 100)
    next_line = normalize_title_text(next_line, 60)
    if not title:
        return ""
    if re.fullmatch(r"第[一二三四五六七八九十百千万零〇两\d]{1,8}[章节回部篇集卷]", title) and 1 < len(next_line) <= 40:
        return f"{title} {next_line}"
    if re.fullmatch(r"[上中下前后][卷部篇集]", title) and 1 < len(next_line) <= 40:
        return f"{title} {next_line}"
    return title


def detect_chapter_title_from_lines(lines, fallback="", href=""):
    cleaned = [normalize_title_text(line, 100) for line in lines]
    cleaned = [line for line in cleaned if line and not is_noisy_title(line)]
    basename = posixpath.basename(str(href or "")).lower()
    if "cover" in basename and not cleaned:
        return "封面"
    for index, line in enumerate(cleaned[:12]):
        if is_structural_title(line):
            return compact_epub_heading(line, cleaned[index + 1] if index + 1 < len(cleaned) else "")
    if cleaned:
        first = cleaned[0]
        if len(first) <= 45 and not re.search(r"[。！？!?]$", first):
            return compact_epub_heading(first, cleaned[1] if len(cleaned) > 1 else "")
    return normalize_title_text(fallback, 100)


def chapter_title_from_text(text, fallback, href=""):
    title = detect_chapter_title_from_lines(text.splitlines(), fallback, href)
    if is_noisy_title(title):
        return "封面" if "cover" in posixpath.basename(str(href or "")).lower() else normalize_title_text(fallback, 100)
    return title or normalize_title_text(fallback, 100)


def split_plain_chapters(text):
    text = normalize_book_text(text, max_chars=None)
    if not text:
        raise ValueError("没有识别到可阅读文本")
    matches = []
    cursor = 0
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        title = normalize_plain_chapter_title(stripped)
        if stripped and is_plain_chapter_title(title):
            matches.append({"start": cursor, "title": title})
        cursor += len(line)
    chapters = []
    if matches:
        prefix = text[:matches[0]["start"]].strip()
        if len(prefix) > 20:
            chapters.append({"title": infer_plain_prefix_title(prefix), "text": prefix})
        for index, match in enumerate(matches):
            start = match["start"]
            end = matches[index + 1]["start"] if index + 1 < len(matches) else len(text)
            body = text[start:end].strip()
            if body:
                chapters.append({"title": match["title"], "text": body})
    else:
        paragraphs = text.split("\n\n")
        current = []
        current_len = 0
        part = 1
        for paragraph in paragraphs:
            addition = len(paragraph)
            if current and current_len + addition > 12000:
                body = "\n\n".join(current).strip()
                chapters.append({"title": f"第 {part} 部分", "text": body})
                current = []
                current_len = 0
                part += 1
            current.append(paragraph)
            current_len += addition
        if current:
            body = "\n\n".join(current).strip()
            chapters.append({"title": f"第 {part} 部分", "text": body})
    return chapters


def parse_txt_book(path, title):
    text = decode_text_bytes(path.read_bytes())
    chapters = split_plain_chapters(text)
    return {"title": title, "author": infer_txt_author(text, title), "chapters": chapters}


def zip_path_join(base, href):
    target = posixpath.normpath(posixpath.join(base, unquote(href)))
    if target.startswith("../") or target == ".." or target.startswith("/"):
        raise ValueError("EPUB 文件路径不安全")
    return target


def read_zip_text(zf, name, max_bytes=MAX_EPUB_ENTRY_BYTES):
    try:
        info = zf.getinfo(name)
        if info.file_size > max_bytes:
            raise ValueError(f"EPUB 内文件过大：{name}")
        raw = zf.read(name)
    except KeyError as exc:
        raise ValueError(f"EPUB 缺少文件：{name}") from exc
    return decode_text_bytes(raw)


def parse_epub_xml(markup, label="XML"):
    raw = str(markup or "")
    if len(raw.encode("utf-8", errors="ignore")) > MAX_EPUB_XML_BYTES:
        raise ValueError(f"EPUB {label} 过大")
    if re.search(r"<!\s*ENTITY\b", raw, re.IGNORECASE):
        raise ValueError(f"EPUB {label} 包含不安全的实体声明")
    # EPUB 2 NCX commonly contains a harmless external DOCTYPE. ElementTree
    # does not need that DTD, so remove the declaration without resolving it.
    # Internal subsets remain rejected because they can declare entities.
    if re.search(r"<!\s*DOCTYPE\b[^>]*\[", raw, re.IGNORECASE | re.DOTALL):
        raise ValueError(f"EPUB {label} 包含不安全的内部 DTD")
    raw = re.sub(r"<!\s*DOCTYPE\b[^>]*>", "", raw, count=1, flags=re.IGNORECASE | re.DOTALL)
    if re.search(r"<!\s*DOCTYPE\b", raw, re.IGNORECASE):
        raise ValueError(f"EPUB {label} 的 DOCTYPE 格式无效")
    try:
        return ElementTree.fromstring(raw)
    except ElementTree.ParseError as exc:
        raise ValueError(f"EPUB {label} 格式无效") from exc


def locate_epub_container(zf):
    names = zf.namelist()
    if "META-INF/container.xml" in names:
        return "META-INF/container.xml", ""
    candidates = [
        name for name in names
        if name.lower().endswith("/meta-inf/container.xml") and not name.startswith("/")
    ]
    if not candidates:
        raise ValueError("EPUB 缺少文件：META-INF/container.xml")
    candidates.sort(key=lambda item: (item.count("/"), len(item)))
    container_path = candidates[0]
    root_prefix = container_path[: -len("META-INF/container.xml")]
    return container_path, root_prefix


def unwrap_nested_epub_zip(path):
    try:
        with zipfile.ZipFile(path) as outer:
            names = outer.namelist()
            try:
                locate_epub_container(outer)
                return False
            except ValueError:
                pass
            epub_names = [
                name for name in names
                if name.lower().endswith(".epub") and not name.endswith("/")
            ]
            if len(epub_names) != 1:
                return False
            info = outer.getinfo(epub_names[0])
            if info.file_size > MAX_BOOK_UPLOAD_BYTES:
                raise ValueError("书籍文件过大，最大 50MB")
            raw = outer.read(epub_names[0])
    except zipfile.BadZipFile:
        return False

    with zipfile.ZipFile(BytesIO(raw)) as inner:
        try:
            locate_epub_container(inner)
        except ValueError:
            return False
    path.write_bytes(raw)
    return True


def xml_find_text(root, names):
    for name in names:
        node = root.find(f".//{{*}}{name}")
        if node is not None and node.text:
            return clean_display_text(node.text, 160)
    return ""


def extract_html_text(markup):
    parser = XHTMLTextExtractor()
    parser.feed(markup)
    parser.close()
    return normalize_book_text(parser.text())


def extract_image_hrefs(markup, base_href):
    images = []
    for href in re.findall(r"""(?:src|href|xlink:href)\s*=\s*["']([^"']+)["']""", markup, re.IGNORECASE):
        clean_href = href.strip()
        if not clean_href or clean_href.startswith("data:"):
            continue
        path = clean_href.split("#", 1)[0].split("?", 1)[0]
        if Path(path).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            continue
        try:
            images.append(zip_path_join(posixpath.dirname(base_href), clean_href))
        except ValueError:
            continue
    seen = set()
    unique = []
    for href in images:
        if href not in seen:
            seen.add(href)
            unique.append(href)
    return unique


def extract_html_content_blocks(markup, base_href, available_names=None):
    parser = XHTMLContentExtractor(base_href)
    parser.feed(markup)
    parser.close()
    blocks = parser.content_blocks()
    if available_names is None:
        return blocks
    filtered = []
    for block in blocks:
        if block.get("type") == "image" and block.get("href") not in available_names:
            continue
        filtered.append(block)
    return filtered


def slice_content_blocks(blocks, start_fragment="", end_fragment=""):
    start_fragment = unquote(str(start_fragment or ""))
    end_fragment = unquote(str(end_fragment or ""))
    if not start_fragment and not end_fragment:
        return [block for block in blocks if block.get("type") != "anchor"]
    active = not start_fragment
    found_start = not start_fragment
    sliced = []
    for block in blocks:
        if block.get("type") == "anchor":
            anchor = block.get("id", "")
            if start_fragment and anchor == start_fragment:
                active = True
                found_start = True
                continue
            if active and end_fragment and anchor == end_fragment:
                break
            continue
        if active:
            sliced.append(block)
    if start_fragment and not found_start:
        return [block for block in blocks if block.get("type") != "anchor"]
    return sliced


def epub_href_key(href):
    base = unquote(str(href or "").split("#", 1)[0])
    return posixpath.normpath(base).lower()


def resolve_epub_href(base, href):
    href = str(href or "").strip()
    path_part, _, fragment = href.partition("#")
    source_href = zip_path_join(base, path_part)
    return source_href, unquote(fragment)


def local_xml_name(tag):
    return str(tag).rsplit("}", 1)[-1]


def flatten_text(node):
    return clean_display_text("".join(node.itertext()), 160)


def nav_entries_from_html(zf, manifest):
    entries = []
    nav_items = [
        item for item in manifest.values()
        if "nav" in str(item.get("properties", "")).split()
    ]
    for item in nav_items:
        try:
            root = parse_epub_xml(read_zip_text(zf, item["href"]), "导航文件")
        except Exception:
            continue
        nav_nodes = [
            node for node in root.iter()
            if local_xml_name(node.tag) == "nav" and "toc" in str(node.attrib.get("{http://www.idpf.org/2007/ops}type", node.attrib.get("epub:type", ""))).lower()
        ]
        if not nav_nodes:
            nav_nodes = [node for node in root.iter() if local_xml_name(node.tag) == "nav"]

        def child_nodes(node, name):
            return [child for child in list(node) if local_xml_name(child.tag) == name]

        def walk_list(list_node, level):
            for li in child_nodes(list_node, "li"):
                anchor = next((child for child in list(li) if local_xml_name(child.tag) in {"a", "span"}), None)
                nested_lists = [child for child in list(li) if local_xml_name(child.tag) in {"ol", "ul"}]
                href = anchor.attrib.get("href") if anchor is not None else ""
                title = flatten_text(anchor) if anchor is not None else ""
                if href and title:
                    try:
                        source_href, fragment = resolve_epub_href(posixpath.dirname(item["href"]), href)
                    except ValueError:
                        source_href, fragment = "", ""
                    if source_href:
                        entries.append({
                            "title": normalize_title_text(title, 120),
                            "href": source_href,
                            "fragment": fragment,
                            "level": level,
                        })
                for nested in nested_lists:
                    walk_list(nested, level + 1)

        for nav_node in nav_nodes:
            for list_node in child_nodes(nav_node, "ol") + child_nodes(nav_node, "ul"):
                walk_list(list_node, 1)
            if entries:
                return entries
    return entries


def ncx_entries(zf, manifest):
    ncx_item = next((item for item in manifest.values() if item.get("media_type") == "application/x-dtbncx+xml"), None)
    if not ncx_item:
        return []
    try:
        root = parse_epub_xml(read_zip_text(zf, ncx_item["href"]), "NCX 文件")
    except Exception:
        return []
    entries = []
    base = posixpath.dirname(ncx_item["href"])

    def walk(parent, level):
        for nav_point in parent.findall("./{*}navPoint"):
            content = nav_point.find("./{*}content")
            src = content.attrib.get("src") if content is not None else ""
            label = nav_point.find("./{*}navLabel")
            title = normalize_title_text(flatten_text(label if label is not None else nav_point), 120)
            if src and title:
                try:
                    source_href, fragment = resolve_epub_href(base, src)
                except ValueError:
                    source_href, fragment = "", ""
                if source_href:
                    entries.append({
                        "title": title,
                        "href": source_href,
                        "fragment": fragment,
                        "level": level,
                    })
            walk(nav_point, level + 1)

    nav_map = root.find(".//{*}navMap")
    walk(nav_map if nav_map is not None else root, 1)
    return entries


def nav_titles_by_href(zf, manifest):
    titles = {}
    nav_items = [
        item for item in manifest.values()
        if "nav" in str(item.get("properties", "")).split()
    ]
    for item in nav_items:
        try:
            root = parse_epub_xml(read_zip_text(zf, item["href"]), "导航文件")
        except Exception:
            continue
        for anchor in root.findall(".//{*}a"):
            href = anchor.attrib.get("href")
            title = flatten_text(anchor)
            if href and title:
                titles[epub_href_key(zip_path_join(posixpath.dirname(item["href"]), href))] = title
    return titles


def ncx_titles_by_href(zf, manifest):
    ncx_item = next((item for item in manifest.values() if item.get("media_type") == "application/x-dtbncx+xml"), None)
    if not ncx_item:
        return {}
    try:
        root = parse_epub_xml(read_zip_text(zf, ncx_item["href"]), "NCX 文件")
    except Exception:
        return {}
    titles = {}
    base = posixpath.dirname(ncx_item["href"])
    for nav_point in root.findall(".//{*}navPoint"):
        content = nav_point.find(".//{*}content")
        src = content.attrib.get("src") if content is not None else ""
        label = nav_point.find(".//{*}navLabel")
        title = flatten_text(label if label is not None else nav_point)
        if src and title:
            titles[epub_href_key(zip_path_join(base, src))] = title
    return titles


def epub_document_kind(href, text, image_count):
    basename = posixpath.basename(str(href or "")).lower()
    compact = normalize_title_text(text[:300], 300).lower()
    if "cover" in basename or ("titlepage" in basename and image_count):
        return "cover"
    if "copyright" in basename or "版权" in compact or "isbn" in compact:
        return "copyright"
    if "toc" in basename or compact in {"目录", "contents", "table of contents"}:
        return "toc"
    if not text.strip() and image_count:
        return "image"
    return "chapter"


def analyze_epub_spine_item(zf, href, nav_title, index):
    markup = read_zip_text(zf, href)
    text = extract_html_text(markup)
    images = [image for image in extract_image_hrefs(markup, href) if image in zf.namelist()]
    kind = epub_document_kind(href, text, len(images))
    lines = text.splitlines()
    detected = detect_chapter_title_from_lines(lines, "", href)
    title = ""
    nav_title = normalize_title_text(nav_title, 100)
    if nav_title and not is_noisy_title(nav_title):
        title = nav_title
    if detected and not is_noisy_title(detected):
        if not title or kind in {"chapter", "image"}:
            title = detected
    if not title:
        if kind == "cover":
            title = "封面"
        elif kind == "copyright":
            title = "版权信息"
        elif kind == "toc":
            title = "目录"
        elif kind == "image":
            title = f"插图页 {index + 1}"
        else:
            title = f"第 {index + 1} 章"
    return {
        "title": normalize_title_text(title, 100),
        "kind": kind,
        "char_count": len(text),
        "image_count": len(images),
    }


def epub_cover_item(opf, manifest):
    for item in manifest.values():
        if "cover-image" in str(item.get("properties", "")).split() and item.get("media_type", "").startswith("image/"):
            return item
    for meta in opf.findall(".//{*}metadata/{*}meta"):
        if meta.attrib.get("name", "").lower() == "cover":
            item = manifest.get(meta.attrib.get("content", ""))
            if item and item.get("media_type", "").startswith("image/"):
                return item
    candidates = [
        item for item in manifest.values()
        if item.get("media_type", "").startswith("image/") and "cover" in posixpath.basename(item.get("href", "")).lower()
    ]
    return candidates[0] if candidates else None


def parse_epub_spine(path, fallback_title):
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_EPUB_ENTRIES:
            raise ValueError("EPUB 内文件数量过多")
        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_EPUB_UNCOMPRESSED_BYTES:
            raise ValueError("EPUB 解压后内容过大")
        container_path, root_prefix = locate_epub_container(zf)
        container = parse_epub_xml(read_zip_text(zf, container_path), "container.xml")
        rootfile = container.find(".//{*}rootfile")
        if rootfile is None or not rootfile.attrib.get("full-path"):
            raise ValueError("EPUB 目录文件无效")
        opf_path = zip_path_join(root_prefix, rootfile.attrib["full-path"])
        opf_base = posixpath.dirname(opf_path)
        opf = parse_epub_xml(read_zip_text(zf, opf_path), "OPF 文件")
        title = xml_find_text(opf, ["title"]) or fallback_title
        author = xml_find_text(opf, ["creator"])
        manifest = {}
        for item in opf.findall(".//{*}manifest/{*}item"):
            item_id = item.attrib.get("id")
            href = item.attrib.get("href")
            if item_id and href:
                manifest[item_id] = {
                    "href": zip_path_join(opf_base, href),
                    "media_type": item.attrib.get("media-type", ""),
                    "properties": item.attrib.get("properties", ""),
                }
        cover = epub_cover_item(opf, manifest)
        nav_entries = nav_entries_from_html(zf, manifest)
        if len(nav_entries) < 2:
            nav_entries = ncx_entries(zf, manifest)
        spine_docs = []
        spine_by_key = {}
        for itemref in opf.findall(".//{*}spine/{*}itemref"):
            item = manifest.get(itemref.attrib.get("idref"))
            if not item:
                continue
            media_type = item["media_type"]
            if media_type not in {"application/xhtml+xml", "text/html"}:
                continue
            analysis = analyze_epub_spine_item(
                zf,
                item["href"],
                "",
                len(spine_docs),
            )
            doc = {"item": item, "analysis": analysis}
            spine_docs.append(doc)
            spine_by_key[epub_href_key(item["href"])] = doc

        chapters = []
        used_sources = set()
        if nav_entries:
            for entry in nav_entries:
                doc = spine_by_key.get(epub_href_key(entry["href"]))
                if not doc:
                    continue
                analysis = doc["analysis"]
                if analysis["kind"] in {"cover", "image", "toc"}:
                    continue
                title = normalize_title_text(entry.get("title") or analysis["title"], 120)
                chapters.append({
                    "title": title,
                    "kind": analysis["kind"],
                    "level": max(1, min(int(entry.get("level") or 1), 4)),
                    "href": doc["item"]["href"],
                    "fragment": entry.get("fragment", ""),
                    "end_fragment": "",
                    "media_type": doc["item"].get("media_type", ""),
                    "char_count": analysis["char_count"],
                    "image_count": analysis["image_count"],
                    "cached": False,
                })
                used_sources.add(epub_href_key(doc["item"]["href"]))

            for index, chapter in enumerate(chapters):
                next_chapter = chapters[index + 1] if index + 1 < len(chapters) else None
                if (
                    next_chapter
                    and next_chapter.get("href") == chapter.get("href")
                    and next_chapter.get("fragment")
                ):
                    chapter["end_fragment"] = next_chapter["fragment"]

        for doc in spine_docs:
            item = doc["item"]
            analysis = doc["analysis"]
            key = epub_href_key(item["href"])
            if key in used_sources or analysis["kind"] in {"cover", "image", "toc"}:
                continue
            chapters.append({
                "title": analysis["title"],
                "kind": analysis["kind"],
                "level": 1,
                "href": item["href"],
                "fragment": "",
                "end_fragment": "",
                "media_type": item.get("media_type", ""),
                "char_count": analysis["char_count"],
                "image_count": analysis["image_count"],
                "cached": False,
            })
        if not chapters:
            raise ValueError("EPUB 中没有识别到可阅读章节")
        return {"title": title, "author": author, "chapters": chapters, "lazy": True, "cover": cover}


def parse_epub_chapter_content(path, href, fragment="", end_fragment=""):
    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(href)
        if info.file_size > MAX_EPUB_ENTRY_BYTES:
            raise ValueError("EPUB 章节内容过大")
        markup = read_zip_text(zf, href)
        all_blocks = extract_html_content_blocks(markup, href, set(zf.namelist()))
        blocks = slice_content_blocks(all_blocks, fragment, end_fragment)
        text_blocks = [block["text"] for block in blocks if block.get("type") == "text" and block.get("text")]
        images = [block["href"] for block in blocks if block.get("type") == "image" and block.get("href")]
        text = normalize_book_text("\n\n".join(text_blocks))
        if not text and not images:
            raise ValueError("本章没有识别到可阅读内容")
        return {"text": text, "images": images, "blocks": blocks}


def parse_pdf_book(path, fallback_title):
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
        text = normalize_book_text(page.extract_text() or "")
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


def parse_book_file(path, original_name):
    suffix = path.suffix.lower()
    title = Path(original_name).stem or "未命名书籍"
    if suffix == ".txt":
        parsed = parse_txt_book(path, title)
    elif suffix == ".epub":
        parsed = parse_epub_spine(path, title)
    elif suffix == ".pdf":
        parsed = parse_pdf_book(path, title)
    else:
        raise ValueError("仅支持 TXT、EPUB、PDF")
    if parsed.get("lazy"):
        chapters = [
            {
                "index": index,
                "title": chapter["title"],
                "kind": chapter.get("kind", "chapter"),
                "level": max(1, min(int(chapter.get("level") or 1), 4)),
                "href": chapter["href"],
                "fragment": chapter.get("fragment", ""),
                "end_fragment": chapter.get("end_fragment", ""),
                "media_type": chapter.get("media_type", ""),
                "char_count": int(chapter.get("char_count") or 0),
                "image_count": int(chapter.get("image_count") or 0),
                "cached": False,
            }
            for index, chapter in enumerate(parsed["chapters"])
            if chapter.get("href")
        ]
    else:
        chapters = [
            {"index": index, "title": chapter["title"], "text": chapter["text"], "char_count": len(chapter["text"])}
            for index, chapter in enumerate(parsed["chapters"])
            if chapter.get("text")
        ]
    if not chapters:
        raise ValueError("没有识别到可阅读章节")
    return {
        "title": clean_display_text(parsed.get("title") or title, 160),
        "author": clean_display_text(parsed.get("author") or "", 120),
        "lazy": bool(parsed.get("lazy")),
        "cover": parsed.get("cover"),
        "chapters": chapters,
    }


def save_epub_cover(path, book_id, cover):
    if not cover or not cover.get("href"):
        return ""
    media_type = cover.get("media_type", "")
    extensions = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    suffix = extensions.get(media_type.lower()) or Path(cover["href"]).suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ""
    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(cover["href"])
        if info.file_size > 5 * 1024 * 1024:
            return ""
        raw = zf.read(cover["href"])
    cover_name = f"cover{'.jpg' if suffix == '.jpeg' else suffix}"
    cover_path = book_dir(book_id) / cover_name
    write_private_bytes_atomic(cover_path, raw)
    return cover_name


def reparse_book_record(book_id):
    book = read_book_record(book_id)
    stored_name = book.get("stored_name")
    if not stored_name:
        raise ValueError("书籍源文件缺失")
    source_path = book_dir(book_id) / stored_name
    if not source_path.exists():
        raise ValueError("书籍源文件不存在")
    parsed = parse_book_file(source_path, book.get("original_name") or stored_name)
    cache_dir = book_chapter_cache_dir(book_id)
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    cover_name = book.get("cover_name", "")
    if book.get("format") == "epub":
        new_cover = save_epub_cover(source_path, book_id, parsed.get("cover"))
        cover_name = new_cover or cover_name
    progress = book.get("progress") or {"chapter": 0, "sentence": 0}
    chapter_count = len(parsed["chapters"])
    progress["chapter"] = max(0, min(int(progress.get("chapter") or 0), max(chapter_count - 1, 0)))
    progress["sentence"] = max(0, int(progress.get("sentence") or 0))
    now = int(time.time())
    updated = {
        **book,
        "title": book.get("title") or parsed["title"],
        "author": book.get("author", "") if book.get("author_manually_set") else parsed.get("author", ""),
        "cover_name": cover_name,
        "lazy": bool(parsed.get("lazy")),
        "metadata_version": CHAPTER_CACHE_VERSION,
        "updated_at": now,
        "progress": progress,
        "chapters": parsed["chapters"],
    }
    write_book_record(updated)
    upsert_book_index(updated)
    return updated


def clear_txt_book_toc(book_id):
    book = read_book_record(book_id)
    if book.get("format") != "txt":
        raise ValueError("清除目录信息仅支持 TXT 文件")
    stored_name = book.get("stored_name")
    if not stored_name:
        raise ValueError("书籍源文件缺失")
    source_path = book_dir(book_id) / stored_name
    if source_path.exists():
        text = normalize_book_text(decode_text_bytes(source_path.read_bytes()), max_chars=None)
    else:
        text = normalize_book_text("\n\n".join(
            chapter.get("text", "") for chapter in book.get("chapters", []) if chapter.get("text")
        ))
    if not text:
        raise ValueError("没有识别到可阅读文本")
    cache_dir = book_chapter_cache_dir(book_id)
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    now = int(time.time())
    updated = {
        **book,
        "lazy": False,
        "metadata_version": CHAPTER_CACHE_VERSION,
        "updated_at": now,
        "progress": {"chapter": 0, "sentence": 0},
        "chapters": [{
            "index": 0,
            "title": "全文",
            "kind": "chapter",
            "level": 1,
            "text": text,
            "char_count": len(text),
        }],
    }
    write_book_record(updated)
    upsert_book_index(updated)
    return updated


def reindex_chapters(chapters):
    normalized = []
    for index, chapter in enumerate(chapters):
        text = chapter.get("text", "")
        normalized.append({
            **chapter,
            "index": index,
            "kind": chapter.get("kind", "chapter"),
            "level": max(1, min(int(chapter.get("level") or 1), 4)),
            "text": text,
            "char_count": len(text),
        })
    return normalized


def update_txt_chapter_title(book_id, chapter_index, title):
    book = read_book_record(book_id)
    if book.get("format") != "txt":
        raise ValueError("目录编辑仅支持 TXT 文件")
    chapters = book.get("chapters", [])
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise ValueError("章节不存在")
    title = clean_display_text(title, 120)
    if not title:
        raise ValueError("标题不能为空")
    chapters[chapter_index]["title"] = title
    chapters[chapter_index]["char_count"] = len(chapters[chapter_index].get("text", ""))
    book["chapters"] = reindex_chapters(chapters)
    book["updated_at"] = int(time.time())
    write_book_record(book)
    upsert_book_index(book)
    return book


def delete_txt_chapter_title(book_id, chapter_index):
    book = read_book_record(book_id)
    if book.get("format") != "txt":
        raise ValueError("目录编辑仅支持 TXT 文件")
    chapters = book.get("chapters", [])
    if len(chapters) <= 1:
        raise ValueError("至少需要保留一个章节")
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise ValueError("章节不存在")
    removed = chapters.pop(chapter_index)
    if chapter_index == 0:
        chapters[0]["text"] = "\n\n".join(part for part in [removed.get("text", ""), chapters[0].get("text", "")] if part)
    else:
        chapters[chapter_index - 1]["text"] = "\n\n".join(part for part in [chapters[chapter_index - 1].get("text", ""), removed.get("text", "")] if part)
    progress = book.get("progress") or {"chapter": 0, "sentence": 0}
    current = int(progress.get("chapter") or 0)
    if current == chapter_index:
        progress["chapter"] = max(0, chapter_index - 1)
        progress["sentence"] = 0
    elif current > chapter_index:
        progress["chapter"] = current - 1
    book["progress"] = progress
    book["chapters"] = reindex_chapters(chapters)
    book["updated_at"] = int(time.time())
    write_book_record(book)
    upsert_book_index(book)
    return book


def txt_chapter_lines(book_id, chapter_index):
    book = read_book_record(book_id)
    if book.get("format") != "txt":
        raise ValueError("目录编辑仅支持 TXT 文件")
    chapters = book.get("chapters", [])
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise ValueError("章节不存在")
    text = chapters[chapter_index].get("text", "")
    lines = []
    for index, line in enumerate(text.splitlines()):
        stripped = clean_display_text(line, 160)
        if not stripped:
            continue
        lines.append({
            "index": index,
            "text": stripped,
            "candidate": is_plain_chapter_title(stripped),
        })
    return book, lines


def split_txt_chapter_at_line(book_id, chapter_index, line_index, title=""):
    book = read_book_record(book_id)
    if book.get("format") != "txt":
        raise ValueError("目录编辑仅支持 TXT 文件")
    chapters = book.get("chapters", [])
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise ValueError("章节不存在")
    chapter = chapters[chapter_index]
    lines = chapter.get("text", "").splitlines(keepends=True)
    if line_index < 0 or line_index >= len(lines):
        raise ValueError("行不存在")
    chosen = clean_display_text(title or lines[line_index], 120)
    if not chosen:
        raise ValueError("标题不能为空")
    if line_index == 0:
        chapter["title"] = chosen
    else:
        before = "".join(lines[:line_index]).strip()
        after = "".join(lines[line_index:]).strip()
        if not before or not after:
            raise ValueError("请选择章节中间的非空行作为新标题")
        chapter["text"] = before
        chapters.insert(chapter_index + 1, {
            "title": chosen,
            "kind": "chapter",
            "level": 1,
            "text": after,
            "char_count": len(after),
        })
    book["chapters"] = reindex_chapters(chapters)
    book["updated_at"] = int(time.time())
    write_book_record(book)
    upsert_book_index(book)
    return book


def refresh_epub_chapter_metadata(book):
    if book.get("format") != "epub" or book.get("metadata_version") == CHAPTER_CACHE_VERSION:
        return book
    stored_name = book.get("stored_name")
    if not stored_name:
        return book
    source_path = book_dir(book["id"]) / stored_name
    try:
        parsed = parse_book_file(source_path, book.get("original_name") or stored_name)
    except Exception:
        return book
    cache_dir = book_chapter_cache_dir(book["id"])
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    progress = book.get("progress") or {"chapter": 0, "sentence": 0}
    progress["chapter"] = max(0, min(int(progress.get("chapter") or 0), max(len(parsed["chapters"]) - 1, 0)))
    progress["sentence"] = max(0, int(progress.get("sentence") or 0))
    if not book.get("author_manually_set"):
        book["author"] = parsed.get("author", book.get("author", ""))
    book["lazy"] = bool(parsed.get("lazy"))
    book["chapters"] = parsed["chapters"]
    book["progress"] = progress
    book["metadata_version"] = CHAPTER_CACHE_VERSION
    book["updated_at"] = int(time.time())
    write_book_record(book)
    upsert_book_index(book)
    delete_tts_offline_refs(book["id"])
    return book


def split_long_sentence(text, max_chars=220):
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    def split_by_pattern(value, pattern):
        pieces = []
        current = ""
        for chunk in re.split(pattern, value):
            if not chunk:
                continue
            candidate = f"{current}{chunk}"
            if current and len(candidate) > max_chars:
                pieces.append(current.strip())
                current = chunk
            else:
                current = candidate
        if current.strip():
            pieces.append(current.strip())
        return pieces

    def normalize_oversized(parts, pattern=None):
        normalized = []
        for part in parts:
            if len(part) <= max_chars:
                normalized.append(part)
            elif pattern:
                normalized.extend(normalize_oversized(split_by_pattern(part, pattern)))
            else:
                for start in range(0, len(part), max_chars):
                    piece = part[start:start + max_chars].strip()
                    if piece:
                        normalized.append(piece)
        return normalized

    punctuation_parts = split_by_pattern(text, r"([，,、：:])")
    space_parts = normalize_oversized(punctuation_parts, r"(\s+)")
    return normalize_oversized(space_parts)


def split_sentences(paragraph):
    chunks = re.split(r"(?<=[。！？!?；;])\s*|(?<=[.!?])\s+", paragraph.strip())
    sentences = []
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        sentences.extend(split_long_sentence(chunk))
    return sentences


def plain_text_display_paragraphs(text):
    lines = []
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            lines.append(line)
    return lines


def fallback_display_paragraphs(book, text):
    if book.get("format") == "txt":
        return plain_text_display_paragraphs(text)
    return [paragraph.strip() for paragraph in re.split(r"\n{2,}", str(text or "")) if paragraph.strip()]


def ensure_chapter_text(book, chapter_index):
    chapters = book.get("chapters", [])
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise IndexError("章节不存在")
    chapter = chapters[chapter_index]
    if chapter.get("text"):
        return chapter
    if book.get("format") != "epub" or not chapter.get("href"):
        return chapter

    lock = chapter_parse_lock(book["id"], chapter_index)
    with lock:
        chapters = book.get("chapters", [])
        chapter = chapters[chapter_index]
        if chapter.get("text"):
            return chapter
        if book.get("format") != "epub" or not chapter.get("href"):
            return chapter

        cache_path = book_chapter_cache_path(book["id"], chapter_index)
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("parser_version") == CHAPTER_CACHE_VERSION:
                chapter.update({
                    "title": cached.get("title") or chapter.get("title") or f"第 {chapter_index + 1} 章",
                    "text": cached.get("text", ""),
                    "images": cached.get("images", []),
                    "blocks": cached.get("blocks", []),
                    "char_count": int(cached.get("char_count") or len(cached.get("text", ""))),
                    "cached": True,
                })
                return chapter

        stored_name = book.get("stored_name")
        if not stored_name:
            raise ValueError("书籍源文件缺失")
        source_path = book_dir(book["id"]) / stored_name
        content = parse_epub_chapter_content(
            source_path,
            chapter["href"],
            chapter.get("fragment", ""),
            chapter.get("end_fragment", ""),
        )
        text = content["text"]
        images = content["images"]
        blocks = content.get("blocks", [])
        chapter_title = chapter_title_from_text(text, chapter.get("title") or f"第 {chapter_index + 1} 章", chapter.get("href", ""))
        cached = {
            "parser_version": CHAPTER_CACHE_VERSION,
            "index": chapter_index,
            "title": chapter_title,
            "text": text,
            "images": images,
            "blocks": blocks,
            "char_count": len(text),
        }
        write_json_atomic(cache_path, cached)
        chapter.update({
            "title": chapter_title,
            "text": text,
            "images": images,
            "blocks": blocks,
            "char_count": len(text),
            "cached": True,
        })
        try:
            latest_book = read_book_record(book["id"])
            latest_chapters = latest_book.get("chapters", [])
            if chapter_index < len(latest_chapters):
                latest_chapters[chapter_index].update({
                    "title": chapter_title,
                    "char_count": len(text),
                    "cached": True,
                })
                latest_chapters[chapter_index].pop("text", None)
                latest_book["chapters"] = latest_chapters
                latest_book["updated_at"] = int(time.time())
                write_book_record(latest_book)
                upsert_book_index(latest_book)
        except FileNotFoundError:
            pass
        return chapter


def chapter_payload(book, chapter_index, include_book=True):
    chapters = book.get("chapters", [])
    if chapter_index < 0 or chapter_index >= len(chapters):
        raise IndexError("章节不存在")
    chapter = ensure_chapter_text(book, chapter_index)
    paragraphs = []
    sentence_counter = 0
    blocks = chapter.get("blocks") or []
    if not blocks and chapter.get("images"):
        blocks = [{"type": "image", "href": href} for href in chapter.get("images", [])]
    if blocks:
        paragraph_index = 0
        image_index = 0
        for block in blocks:
            if block.get("type") == "image" and block.get("href"):
                paragraphs.append({
                    "index": f"image-{image_index}",
                    "type": "image",
                    "src": url_for("api_book_asset", book_id=book["id"], asset_path=block["href"]),
                    "alt": chapter.get("title") or f"插图 {image_index + 1}",
                })
                image_index += 1
                continue
            if block.get("type") != "text":
                continue
            paragraph = block.get("text", "").strip()
            if not paragraph:
                continue
            sentences = []
            for sentence in split_sentences(paragraph):
                sentences.append({
                    "id": f"{chapter_index}-{sentence_counter}",
                    "index": sentence_counter,
                    "text": sentence,
                })
                sentence_counter += 1
            if sentences:
                paragraphs.append({"index": paragraph_index, "sentences": sentences})
                paragraph_index += 1
    for paragraph_index, paragraph in enumerate(fallback_display_paragraphs(book, chapter.get("text", "")) if not paragraphs else []):
        sentences = []
        for sentence in split_sentences(paragraph):
            sentences.append({
                "id": f"{chapter_index}-{sentence_counter}",
                "index": sentence_counter,
                "text": sentence,
            })
            sentence_counter += 1
        if sentences:
            paragraphs.append({"index": paragraph_index, "sentences": sentences})
    result = {
        "chapter": {
            "index": chapter_index,
            "title": chapter.get("title") or f"第 {chapter_index + 1} 章",
            "paragraphs": paragraphs,
            "sentence_count": sentence_counter,
        },
    }
    if include_book:
        result["book"] = book_summary(book)
    return result


load_dotenv()
app = Flask(__name__)
app.secret_key = load_or_create_secret_key()
app.config.update(
    TEMPLATES_AUTO_RELOAD=True,
    MAX_CONTENT_LENGTH=MAX_BOOK_UPLOAD_BYTES,
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_REFRESH_EACH_REQUEST=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=env_flag("SESSION_COOKIE_SECURE", False),
)


def setup_logging():
    LOG_DIR.mkdir(mode=0o700, exist_ok=True)
    os.chmod(LOG_DIR, 0o700)
    handler = RotatingFileHandler(
        LOG_DIR / "app.log",
        maxBytes=2 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.setLevel(logging.INFO)
    app.logger.setLevel(logging.INFO)
    app.logger.addHandler(handler)
    try:
        os.chmod(LOG_DIR / "app.log", 0o600)
    except OSError:
        pass


setup_logging()


def request_host_matches(url_value):
    parsed = urlparse(url_value or "")
    return bool(parsed.netloc) and parsed.netloc == request.host


def client_ip():
    return request.remote_addr or "unknown"


def login_failures_for_ip(ip):
    now = time.time()
    with LOGIN_FAILURE_LOCK:
        failures = [
            timestamp for timestamp in LOGIN_FAILURES.get(ip, [])
            if now - timestamp < LOGIN_FAILURE_WINDOW_SECONDS
        ]
        if failures:
            LOGIN_FAILURES[ip] = failures
        else:
            LOGIN_FAILURES.pop(ip, None)
        return failures


def login_is_limited(ip):
    return len(login_failures_for_ip(ip)) >= LOGIN_FAILURE_LIMIT


def record_login_failure(ip):
    now = time.time()
    with LOGIN_FAILURE_LOCK:
        failures = [
            timestamp for timestamp in LOGIN_FAILURES.get(ip, [])
            if now - timestamp < LOGIN_FAILURE_WINDOW_SECONDS
        ]
        failures.append(now)
        LOGIN_FAILURES[ip] = failures
        if len(LOGIN_FAILURES) > LOGIN_FAILURE_MAX_IPS:
            oldest_ip = min(LOGIN_FAILURES, key=lambda key: LOGIN_FAILURES[key][-1])
            LOGIN_FAILURES.pop(oldest_ip, None)


def clear_login_failures(ip):
    with LOGIN_FAILURE_LOCK:
        LOGIN_FAILURES.pop(ip, None)


def csrf_token():
    token = session.get("csrf_token")
    if not isinstance(token, str) or len(token) < 32:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def authentication_version(password):
    key = str(app.secret_key).encode("utf-8")
    return hmac.new(key, str(password or "").encode("utf-8"), hashlib.sha256).hexdigest()


def request_json_object():
    if not request.is_json:
        raise BadRequest("请求必须使用 application/json")
    payload = request.get_json(silent=False)
    if not isinstance(payload, dict):
        raise BadRequest("JSON 请求体必须是对象")
    return payload


@app.errorhandler(BadRequest)
def handle_bad_request(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description or "请求格式无效"}), 400
    return error


@app.errorhandler(RequestEntityTooLarge)
def handle_request_too_large(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "请求内容过大"}), 413
    return error


@app.before_request
def reject_cross_site_writes():
    if (
        hasattr(os, "geteuid")
        and os.geteuid() == 0
        and not env_flag("ALLOW_ROOT_RUN", False)
        and not app.testing
    ):
        return jsonify({"error": "服务拒绝以 root 处理请求，请改用低权限用户"}), 503
    if not app.testing:
        configured_password = clean_single_line_value(load_config().get("app_password", ""))
        if configured_password.lower() in UNSAFE_APP_PASSWORDS or len(configured_password) < 12:
            return jsonify({"error": "服务拒绝使用默认或弱密码，请先配置至少 12 位的 APP_PASSWORD"}), 503
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return None
    if request.path != "/api/books":
        if request.content_length is not None and request.content_length > MAX_JSON_REQUEST_BYTES:
            return jsonify({"error": "请求内容过大"}), 413
    origin = request.headers.get("Origin")
    if origin and not request_host_matches(origin):
        app.logger.warning("blocked cross-site write ip=%s origin=%s path=%s", request.remote_addr, origin, request.path)
        return jsonify({"error": "forbidden"}), 403
    referer = request.headers.get("Referer")
    if referer and not request_host_matches(referer):
        app.logger.warning("blocked cross-site write ip=%s referer=%s path=%s", request.remote_addr, referer, request.path)
        return jsonify({"error": "forbidden"}), 403
    supplied_token = request.headers.get("X-CSRF-Token", "")
    if not supplied_token and request.path != "/api/books":
        supplied_token = request.form.get("csrf_token", "")
    expected_token = csrf_token()
    if not supplied_token or not secrets.compare_digest(supplied_token, expected_token):
        app.logger.warning("blocked write without valid csrf token ip=%s path=%s", request.remote_addr, request.path)
        if request.path.startswith("/api/") or request.path == "/logout":
            return jsonify({"error": "CSRF token 无效，请刷新页面后重试"}), 403
        return "CSRF token invalid", 403
    return None


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; "
        "object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "connect-src 'self' https:",
    )
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    )
    if request.path.startswith("/static/fonts/") and request.args.get("v"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif request.path.startswith("/api/") or request.path in {"/", "/login", "/translate", "/reader"}:
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.context_processor
def inject_asset_url():
    def asset_url(filename):
        asset_path = BASE_DIR / "static" / filename
        version = content_fingerprint((asset_path,))
        return url_for("static", filename=filename, v=version)

    def app_version():
        build_version = content_fingerprint(
            BUILD_VERSION_FILES,
            length=8,
            seed=RUNTIME_BACKEND_FINGERPRINT,
        )
        return f"{APP_VERSION}+{build_version}"

    return {"asset_url": asset_url, "app_version": app_version, "csrf_token": csrf_token}


def require_auth():
    authenticated = bool(session.get("authenticated"))
    if authenticated:
        try:
            expected = authentication_version(load_config().get("app_password", ""))
        except Exception:
            return False
        authenticated = secrets.compare_digest(str(session.get("auth_version", "")), expected)
    if authenticated:
        session.permanent = True
    else:
        session.pop("authenticated", None)
        session.pop("auth_version", None)
    return authenticated


def public_config(config):
    safe = json.loads(json.dumps(config))
    safe["deepseek"]["api_key_configured"] = bool(safe["deepseek"].get("api_key"))
    safe["deepseek"]["api_key"] = ""
    # Server-side upstreams may be configured in .env, but a browser session
    # must never be able to redirect requests carrying server credentials.
    safe["deepseek"]["allow_custom_base_url"] = False
    safe["google"]["endpoint_options"] = SERVICE_CONFIG["google"]["endpoint_options"]
    safe.pop("app_password", None)
    safe.pop("reader_tts", None)
    safe["deepseek_styles"] = [
        {"id": key, "name": value["name"]} for key, value in DEEPSEEK_STYLES.items()
    ]
    return safe


def public_reader_tts_config(config):
    settings = json.loads(json.dumps(config.get("reader_tts", DEFAULT_CONFIG["reader_tts"])))
    settings["format"] = "m4a"
    settings["api_key_configured"] = bool(settings.get("api_key"))
    settings["api_key"] = ""
    settings["balance_cookie_configured"] = bool(settings.get("balance_cookie"))
    settings["balance_cookie"] = ""
    settings["allow_custom_base_url"] = False
    settings["model_options"] = TTS_MODEL_OPTIONS
    settings["voice_options"] = TTS_VOICE_OPTIONS
    settings["offline_profile_key"] = tts_offline_profile_key(settings)
    settings["cache_stats"] = tts_cache_stats()
    settings["balance_status"] = mimo_balance_snapshot()
    return settings


def parse_number(value, fallback, min_value=None, max_value=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if min_value is not None:
        number = max(min_value, number)
    if max_value is not None:
        number = min(max_value, number)
    return number


def update_reader_tts_config(config, payload):
    settings = config["reader_tts"]
    env_updates = {}
    balance_cookie_update = None
    settings["enabled"] = bool(payload.get("enabled"))
    settings["provider"] = "mimo"
    if payload.get("api_key"):
        settings["api_key"] = clean_single_line_value(payload["api_key"])[:1000]
        env_updates["MIMO_API_KEY"] = settings["api_key"]
    settings["base_url"] = validate_mimo_tts_url(
        settings["base_url"],
        DEFAULT_CONFIG["reader_tts"]["base_url"],
    )
    if payload.get("balance_cookie"):
        settings["balance_cookie"] = normalize_mimo_balance_cookie(payload["balance_cookie"])
        balance_cookie_update = settings["balance_cookie"]
    model = clean_single_line_value(payload.get("model", settings["model"]))
    settings["model"] = model if model in TTS_MODEL_OPTIONS else TTS_MODEL_OPTIONS[0]
    env_updates["MIMO_TTS_MODEL"] = settings["model"]
    settings["voice_id"] = clean_single_line_value(payload.get("voice_id", settings["voice_id"]))[:200]
    env_updates["MIMO_TTS_VOICE"] = settings["voice_id"]
    settings["format"] = "m4a"
    settings["style_prompt"] = clean_single_line_value(payload.get("style_prompt", settings.get("style_prompt", "")))[:1000]
    env_updates["MIMO_TTS_STYLE_PROMPT"] = settings["style_prompt"]
    settings["timeout"] = int(parse_number(payload.get("timeout"), settings["timeout"], 5, 90))
    settings["chunk_chars"] = int(parse_number(payload.get("chunk_chars"), settings["chunk_chars"], 80, 800))
    settings["cache_enabled"] = bool(payload.get("cache_enabled", True))
    if env_updates:
        save_dotenv_values(env_updates)
    if balance_cookie_update is not None:
        settings["balance_cookie"] = save_mimo_balance_cookie(balance_cookie_update)
    return config


def update_app_password(config, value):
    new_password = clean_single_line_value(value)
    if len(new_password) < 12 or len(new_password) > 256 or new_password.lower() in UNSAFE_APP_PASSWORDS:
        raise ValueError("访问密码至少需要 12 位，且不能使用示例或常见弱密码")
    config["app_password"] = new_password
    save_dotenv_values({"APP_PASSWORD": new_password})
    return config


def update_nested_config(config, payload):
    env_updates = {}

    deepseek = payload.get("deepseek", {})
    if deepseek:
        target = config["deepseek"]
        target["enabled"] = bool(deepseek.get("enabled"))
        if deepseek.get("api_key"):
            target["api_key"] = clean_single_line_value(deepseek["api_key"])[:1000]
            env_updates["DEEPSEEK_API_KEY"] = target["api_key"]
        target["base_url"] = validate_server_api_url(
            target["base_url"],
            DEFAULT_CONFIG["deepseek"]["base_url"],
        )
        target["model"] = clean_single_line_value(deepseek.get("model", target["model"]))[:200]
        env_updates["DEEPSEEK_MODEL"] = target["model"]
        target["temperature"] = parse_number(deepseek.get("temperature"), target["temperature"], 0, 2)
        thinking = deepseek.get("thinking", target["thinking"])
        target["thinking"] = thinking if thinking in {"enabled", "disabled"} else "disabled"
        effort = deepseek.get("reasoning_effort", target["reasoning_effort"])
        target["reasoning_effort"] = effort if effort in {"low", "medium", "high"} else "medium"
        target["timeout"] = int(parse_number(deepseek.get("timeout"), target["timeout"], 5, 120))
        style = deepseek.get("style", target.get("style", "default"))
        target["style"] = style if style in DEEPSEEK_STYLES else "default"

    google = payload.get("google", {})
    if google:
        target = config["google"]
        target["enabled"] = bool(google.get("enabled"))
        target["endpoint"] = validate_google_translate_url(
            google.get("endpoint", target["endpoint"]),
            target["endpoint"],
            strict=True,
        )
        target["timeout"] = int(parse_number(google.get("timeout"), target["timeout"], 5, 120))

    if env_updates:
        save_dotenv_values(env_updates)
    return config


def cache_key_for_deepseek(text, source, target, settings):
    payload = {
        "engine": "deepseek",
        "scope": "paragraph",
        "prompt_version": DEEPSEEK_TRANSLATION_PROMPT_VERSION,
        "text": text,
        "source": source,
        "target": target,
        "model": settings["model"],
        "temperature": settings["temperature"],
        "thinking": settings.get("thinking"),
        "reasoning_effort": settings.get("reasoning_effort"),
        "style": settings.get("style", "default"),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def split_translation_lines(text):
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    return re.split(r"(\n+)", normalized)


def normalize_translation_segment(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\s*\n+\s*", " ", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def normalize_translation_text(value, source_text=""):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    source_paragraphs = [part for part in re.split(r"\n\s*\n", str(source_text or "").strip()) if part.strip()]
    translated_paragraphs = [part for part in re.split(r"\n\s*\n", text) if part.strip()]
    if source_paragraphs and len(translated_paragraphs) > max(len(source_paragraphs) * 2 + 2, 6):
        text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def get_cached_translation(cache_key):
    if not re.fullmatch(r"[0-9a-f]{64}", str(cache_key or "")):
        return None
    with TRANSLATION_CACHE_LOCK:
        connection = None
        try:
            connection = open_translation_cache()
            row = connection.execute(
                "SELECT value FROM translations WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
            if not row:
                return None
            value = row[0]
            if not isinstance(value, str) or len(value) > CACHE_MAX_TEXT_CHARS:
                connection.execute("DELETE FROM translations WHERE cache_key = ?", (cache_key,))
                connection.commit()
                return None
            connection.execute(
                "UPDATE translations SET touched_at = ? WHERE cache_key = ?",
                (time.time_ns(), cache_key),
            )
            connection.commit()
            return value
        except sqlite3.Error as exc:
            app.logger.error("deepseek cache read failed error=%s", exc)
            return None
        finally:
            if connection is not None:
                connection.close()


def set_cached_translation(cache_key, value):
    if not re.fullmatch(r"[0-9a-f]{64}", str(cache_key or "")):
        return
    if not isinstance(value, str) or len(value) > CACHE_MAX_TEXT_CHARS:
        return
    with TRANSLATION_CACHE_LOCK:
        connection = None
        try:
            connection = open_translation_cache()
            with connection:
                connection.execute(
                    "INSERT INTO translations(cache_key, value, touched_at) VALUES(?, ?, ?) "
                    "ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, touched_at = excluded.touched_at",
                    (cache_key, value, time.time_ns()),
                )
                connection.execute(
                    "DELETE FROM translations WHERE cache_key NOT IN "
                    "(SELECT cache_key FROM translations ORDER BY touched_at DESC LIMIT ?)",
                    (CACHE_LIMIT,),
                )
        except sqlite3.Error as exc:
            app.logger.error("deepseek cache write failed error=%s", exc)
        finally:
            if connection is not None:
                connection.close()


def open_translation_cache():
    ensure_private_directory(CONFIG_DIR)
    connection = sqlite3.connect(TRANSLATION_CACHE_DB, timeout=5)
    try:
        connection.execute("PRAGMA busy_timeout=5000")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS translations ("
            "cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, touched_at INTEGER NOT NULL"
            ") WITHOUT ROWID"
        )
        connection.commit()
        os.chmod(TRANSLATION_CACHE_DB, 0o600)
        return connection
    except Exception:
        connection.close()
        raise


def translation_cache_entries():
    with TRANSLATION_CACHE_LOCK:
        connection = None
        try:
            connection = open_translation_cache()
            return int(connection.execute("SELECT COUNT(*) FROM translations").fetchone()[0])
        except sqlite3.Error as exc:
            app.logger.error("deepseek cache count failed error=%s", exc)
            return 0
        finally:
            if connection is not None:
                connection.close()


def clear_translation_cache():
    with TRANSLATION_CACHE_LOCK:
        connection = None
        try:
            connection = open_translation_cache()
            with connection:
                count = int(connection.execute("SELECT COUNT(*) FROM translations").fetchone()[0])
                connection.execute("DELETE FROM translations")
            return count
        finally:
            if connection is not None:
                connection.close()


def tts_cache_limit_bytes():
    try:
        limit_mb = int(os.getenv("TTS_CACHE_LIMIT_MB", "80"))
    except ValueError:
        limit_mb = 80
    return max(10, min(limit_mb, 8192)) * 1024 * 1024


def tts_cache_ttl_seconds():
    try:
        ttl_days = int(os.getenv("TTS_CACHE_TTL_DAYS", "7"))
    except ValueError:
        ttl_days = 7
    return max(1, min(ttl_days, 365)) * 24 * 60 * 60


def file_allocated_bytes(stat):
    blocks = getattr(stat, "st_blocks", None)
    if blocks is None or blocks <= 0:
        return max(0, int(stat.st_size))
    return int(blocks) * 512


def scan_tts_cache_stats():
    now = time.time()
    ttl = tts_cache_ttl_seconds()
    limit = tts_cache_limit_bytes()
    entries = 0
    total_size = 0
    total_disk_size = 0
    oldest_accessed_at = None
    newest_accessed_at = None
    expired_entries = 0
    pinned_keys = pinned_tts_cache_keys(completed_only=True)
    pinned_entries = 0
    pinned_size = 0
    pinned_disk_size = 0
    if TTS_CACHE_DIR.exists():
        for path in TTS_CACHE_DIR.glob("*.m4a"):
            if not path.is_file() or path.is_symlink():
                continue
            if not re.fullmatch(r"[0-9a-f]{64}", path.stem):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size <= 0 or stat.st_size > MAX_TTS_AUDIO_BYTES:
                continue
            allocated_size = file_allocated_bytes(stat)
            if path.stem in pinned_keys:
                pinned_entries += 1
                pinned_size += stat.st_size
                pinned_disk_size += allocated_size
            entries += 1
            total_size += stat.st_size
            total_disk_size += allocated_size
            oldest_accessed_at = stat.st_mtime if oldest_accessed_at is None else min(oldest_accessed_at, stat.st_mtime)
            newest_accessed_at = stat.st_mtime if newest_accessed_at is None else max(newest_accessed_at, stat.st_mtime)
            if now - stat.st_mtime > ttl and path.stem not in pinned_keys:
                expired_entries += 1
    pack_entries = 0
    pack_size = 0
    pack_disk_size = 0
    pinned_pack_entries = 0
    pinned_pack_size = 0
    pinned_pack_disk_size = 0
    pinned_pack_keys = pinned_tts_pack_keys()
    if TTS_PACK_CACHE_DIR.exists():
        for path in TTS_PACK_CACHE_DIR.glob("*.m4a"):
            try:
                stat = path.stat()
            except OSError:
                continue
            manifest = load_tts_pack_manifest(path.stem)
            if not manifest:
                continue
            pinned = path.stem in pinned_pack_keys
            allocated_size = file_allocated_bytes(stat)
            pack_entries += 1
            pack_size += stat.st_size
            pack_disk_size += allocated_size
            if pinned:
                pinned_pack_entries += 1
                pinned_pack_size += stat.st_size
                pinned_pack_disk_size += allocated_size
    pack_manifest_disk_size = 0
    pinned_pack_manifest_disk_size = 0
    if TTS_PACK_CACHE_DIR.exists():
        for path in TTS_PACK_CACHE_DIR.glob("*.json"):
            if not load_tts_pack_manifest(path.stem):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            allocated_size = file_allocated_bytes(stat)
            pack_manifest_disk_size += allocated_size
            if path.stem in pinned_pack_keys:
                pinned_pack_manifest_disk_size += allocated_size
    cache_entries = max(0, entries - pinned_entries)
    cache_disk_size = (
        max(0, total_disk_size - pinned_disk_size)
        + max(0, pack_disk_size - pinned_pack_disk_size)
        + max(0, pack_manifest_disk_size - pinned_pack_manifest_disk_size)
    )
    fixed_disk_size = pinned_disk_size + pinned_pack_disk_size + pinned_pack_manifest_disk_size
    return {
        "entries": entries,
        "size_bytes": total_size,
        "disk_size_bytes": total_disk_size,
        "cache_entries": cache_entries,
        "cache_disk_size_bytes": cache_disk_size,
        "limit_bytes": limit,
        "ttl_days": max(1, round(ttl / 86400)),
        "oldest_accessed_at": int(oldest_accessed_at or 0),
        "newest_accessed_at": int(newest_accessed_at or 0),
        "expired_entries": expired_entries,
        "pinned_entries": pinned_entries,
        "pinned_size_bytes": pinned_size,
        "pinned_disk_size_bytes": pinned_disk_size,
        "fixed_entries": pinned_entries,
        "fixed_disk_size_bytes": fixed_disk_size,
        "pack_entries": pack_entries,
        "pack_size_bytes": pack_size,
        "pinned_pack_entries": pinned_pack_entries,
        "pinned_pack_size_bytes": pinned_pack_size,
    }


def valid_tts_cache_stats_snapshot(data):
    required = {
        "entries", "size_bytes", "disk_size_bytes", "cache_entries",
        "cache_disk_size_bytes", "limit_bytes", "ttl_days", "oldest_accessed_at",
        "newest_accessed_at", "expired_entries", "pinned_entries",
        "pinned_size_bytes", "pinned_disk_size_bytes", "fixed_entries",
        "fixed_disk_size_bytes", "pack_entries", "pack_size_bytes",
        "pinned_pack_entries", "pinned_pack_size_bytes",
    }
    return isinstance(data, dict) and required.issubset(data) and all(
        isinstance(data.get(key), int)
        and not isinstance(data.get(key), bool)
        and data[key] >= 0
        for key in required
    )


def load_tts_cache_stats_snapshot():
    with TTS_CACHE_STATS_LOCK:
        if TTS_CACHE_STATS_STATE["snapshot_loaded"]:
            return
        TTS_CACHE_STATS_STATE["snapshot_loaded"] = True
        try:
            payload = json.loads(TTS_CACHE_STATS_SNAPSHOT_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        data = payload.get("data") if isinstance(payload, dict) and payload.get("schema") == 1 else None
        if not valid_tts_cache_stats_snapshot(data):
            return
        TTS_CACHE_STATS_STATE["data"] = data
        TTS_CACHE_STATS_STATE["data_revision"] = TTS_CACHE_STATS_STATE["revision"]
        # Return the disk snapshot immediately, then reconcile it in the background.
        TTS_CACHE_STATS_STATE["refreshed_at"] = (
            time.monotonic() - TTS_CACHE_STATS_MAX_AGE_SECONDS
        )
        TTS_CACHE_STATS_READY.set()
    app.logger.info(
        "tts cache stats snapshot loaded entries=%s packs=%s",
        data["entries"],
        data["pack_entries"],
    )


def save_tts_cache_stats_snapshot(data):
    try:
        ensure_private_directory(READER_DIR)
        write_json_atomic(TTS_CACHE_STATS_SNAPSHOT_FILE, {
            "schema": 1,
            "saved_at": int(time.time()),
            "data": data,
        })
    except OSError as exc:
        app.logger.warning("tts cache stats snapshot write failed error=%s", exc)


def refresh_tts_cache_stats_snapshot(target_revision):
    started = time.perf_counter()
    try:
        data = scan_tts_cache_stats()
    except Exception as exc:
        app.logger.warning("tts cache stats refresh failed error=%s", exc)
        with TTS_CACHE_STATS_LOCK:
            TTS_CACHE_STATS_STATE["refreshing"] = False
            refresh_again = TTS_CACHE_STATS_STATE["refresh_again"]
            TTS_CACHE_STATS_STATE["refresh_again"] = False
            TTS_CACHE_STATS_READY.set()
        if refresh_again:
            schedule_tts_cache_stats_refresh(force=True)
        return
    with TTS_CACHE_STATS_LOCK:
        TTS_CACHE_STATS_STATE["data"] = data
        TTS_CACHE_STATS_STATE["data_revision"] = target_revision
        TTS_CACHE_STATS_STATE["refreshed_at"] = time.monotonic()
        TTS_CACHE_STATS_STATE["refreshing"] = False
        refresh_again = TTS_CACHE_STATS_STATE["refresh_again"]
        TTS_CACHE_STATS_STATE["refresh_again"] = False
        TTS_CACHE_STATS_READY.set()
    save_tts_cache_stats_snapshot(data)
    app.logger.info(
        "tts cache stats refreshed entries=%s packs=%s elapsed=%.3fs",
        data["entries"],
        data["pack_entries"],
        time.perf_counter() - started,
    )
    if refresh_again:
        schedule_tts_cache_stats_refresh(force=True)


def schedule_tts_cache_stats_refresh(force=False):
    load_tts_cache_stats_snapshot()
    now = time.monotonic()
    with TTS_CACHE_STATS_LOCK:
        state = TTS_CACHE_STATS_STATE
        fresh = (
            state["data"] is not None
            and state["data_revision"] == state["revision"]
            and now - state["refreshed_at"] < TTS_CACHE_STATS_MAX_AGE_SECONDS
        )
        if fresh and not force:
            return False
        if state["refreshing"]:
            if force:
                state["refresh_again"] = True
            return False
        state["refreshing"] = True
        target_revision = state["revision"]
        TTS_CACHE_STATS_READY.clear()
    threading.Thread(
        target=refresh_tts_cache_stats_snapshot,
        args=(target_revision,),
        name="tts-cache-stats",
        daemon=True,
    ).start()
    return True


def invalidate_tts_cache_stats(refresh=False):
    with TTS_CACHE_STATS_LOCK:
        TTS_CACHE_STATS_STATE["revision"] += 1
    if refresh:
        schedule_tts_cache_stats_refresh(force=True)


def tts_cache_stats():
    load_tts_cache_stats_snapshot()
    with TTS_CACHE_STATS_LOCK:
        data = TTS_CACHE_STATS_STATE["data"]
        stale = (
            data is None
            or TTS_CACHE_STATS_STATE["data_revision"] != TTS_CACHE_STATS_STATE["revision"]
            or time.monotonic() - TTS_CACHE_STATS_STATE["refreshed_at"] >= TTS_CACHE_STATS_MAX_AGE_SECONDS
        )
    if data is not None:
        schedule_tts_cache_stats_refresh()
        result = dict(data)
        result["refreshing"] = stale
        return result
    schedule_tts_cache_stats_refresh()
    TTS_CACHE_STATS_READY.wait(timeout=1.0)
    with TTS_CACHE_STATS_LOCK:
        data = TTS_CACHE_STATS_STATE["data"]
    if data is not None:
        result = dict(data)
        result["refreshing"] = False
        return result
    data = scan_tts_cache_stats()
    with TTS_CACHE_STATS_LOCK:
        TTS_CACHE_STATS_STATE["data"] = data
        TTS_CACHE_STATS_STATE["data_revision"] = TTS_CACHE_STATS_STATE["revision"]
        TTS_CACHE_STATS_STATE["refreshed_at"] = time.monotonic()
    save_tts_cache_stats_snapshot(data)
    result = dict(data)
    result["refreshing"] = False
    return result


def clean_tts_text(value, max_chars):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:max_chars]


def tts_cache_payload(text, settings):
    return {
        "schema": 2,
        "provider": "mimo",
        "text": text,
        "model": settings.get("model"),
        "voice_id": settings.get("voice_id"),
        # Keep the legacy cache namespace so converted WAV files retain their keys.
        "format": "wav",
        "style_prompt": settings.get("style_prompt"),
    }

def tts_cache_key(text, settings):
    raw = json.dumps(tts_cache_payload(text, settings), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def tts_cache_path(cache_key, audio_format):
    suffix = audio_format if audio_format in TTS_AUDIO_FORMATS else "m4a"
    return TTS_CACHE_DIR / f"{cache_key}.{suffix}"



def tts_cache_key_lock(cache_key):
    return TTS_CACHE_KEY_LOCKS[int(cache_key[:8], 16) % len(TTS_CACHE_KEY_LOCKS)]

def open_tts_offline_db():
    ensure_private_directory(READER_DIR)
    connection = sqlite3.connect(TTS_OFFLINE_DB, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute("PRAGMA synchronous=NORMAL")
    os.chmod(TTS_OFFLINE_DB, 0o600)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_tts_refs (
            book_id TEXT NOT NULL,
            chapter_index INTEGER NOT NULL,
            chapter_hash TEXT NOT NULL,
            sentence_index INTEGER NOT NULL,
            sentence_text TEXT NOT NULL,
            profile_key TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            audio_format TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            PRIMARY KEY (book_id, chapter_index, sentence_index, profile_key)
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS offline_tts_cache_key ON offline_tts_refs(cache_key)")
    connection.execute("CREATE INDEX IF NOT EXISTS offline_tts_book_profile ON offline_tts_refs(book_id, profile_key)")
    connection.commit()
    return connection


def tts_offline_profile_key(settings):
    payload = tts_cache_payload("", settings)
    payload.pop("text", None)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def tts_offline_chapter_data(book, chapter_index, settings, include_cache_keys=True):
    payload = chapter_payload(book, chapter_index, include_book=False)
    chapter = payload["chapter"]
    max_chars = int(settings.get("chunk_chars", 260))
    sentences = []
    for paragraph in chapter.get("paragraphs", []):
        if paragraph.get("type") == "image":
            continue
        for sentence in paragraph.get("sentences", []):
            text = clean_tts_text(sentence.get("text", ""), max_chars)
            if not text or not re.search(r"[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", text):
                continue
            item = {
                "index": int(sentence.get("index", len(sentences))),
                "text": text,
            }
            if include_cache_keys:
                item["cache_key"] = tts_cache_key(text, settings)
            sentences.append(item)
    chapter_raw = json.dumps(
        [item["text"] for item in sentences],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return {
        "book_id": book["id"],
        "index": int(chapter.get("index", chapter_index)),
        "title": chapter.get("title", f"第 {chapter_index + 1} 章"),
        "hash": hashlib.sha256(chapter_raw.encode("utf-8")).hexdigest(),
        "sentences": sentences,
    }



def tts_sentence_index_book_key(book):
    payload = {
        "format": book.get("format", ""),
        "metadata_version": int(book.get("metadata_version") or 0),
    }
    if book.get("format") == "epub":
        stored_name = book.get("stored_name", "")
        source_path = book_dir(book["id"]) / stored_name if stored_name else None
        try:
            stat = source_path.stat() if source_path else None
        except OSError:
            stat = None
        payload.update({
            "stored_name": stored_name,
            "source_size": int(stat.st_size) if stat else -1,
            "source_mtime_ns": int(stat.st_mtime_ns) if stat else -1,
            "chapters": [
                [
                    int(chapter.get("index", index)),
                    chapter.get("href", ""),
                    chapter.get("fragment", ""),
                    chapter.get("end_fragment", ""),
                ]
                for index, chapter in enumerate(book.get("chapters", []))
            ],
        })
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def tts_sentence_index_chapter_key(book, chapter_record, fallback_index, book_key):
    if book.get("format") == "epub":
        payload = {
            "book": book_key,
            "index": int(chapter_record.get("index", fallback_index)),
            "href": chapter_record.get("href", ""),
            "fragment": chapter_record.get("fragment", ""),
            "end_fragment": chapter_record.get("end_fragment", ""),
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    else:
        raw = str(chapter_record.get("text", ""))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_tts_sentence_index(book_id):
    path = book_tts_sentence_index_path(book_id)
    with READER_IO_LOCK:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return data if isinstance(data, dict) else {}


def save_tts_sentence_index(book_id, data):
    with READER_IO_LOCK:
        write_json_atomic(book_tts_sentence_index_path(book_id), data)


def ensure_tts_sentence_counts(book, settings):
    book_id = book["id"]
    lock = TTS_SENTENCE_INDEX_LOCKS[int(book_id[:8], 16) % len(TTS_SENTENCE_INDEX_LOCKS)]
    max_chars = int(settings.get("chunk_chars", 260))
    started = time.perf_counter()
    with lock:
        latest = read_book_record(book_id)
        book_key = tts_sentence_index_book_key(latest)
        cached = load_tts_sentence_index(book_id)
        cached_entries = cached.get("chapters", {}) if (
            cached.get("version") == TTS_SENTENCE_INDEX_VERSION
            and cached.get("book_key") == book_key
            and int(cached.get("chunk_chars") or 0) == max_chars
            and isinstance(cached.get("chapters"), dict)
        ) else {}
        entries = {}
        counts = {}
        parsed = 0
        for fallback_index, chapter_record in enumerate(latest.get("chapters", [])):
            chapter_index = int(chapter_record.get("index", fallback_index))
            source_key = tts_sentence_index_chapter_key(latest, chapter_record, fallback_index, book_key)
            cached_entry = cached_entries.get(str(chapter_index), {})
            count = cached_entry.get("sentence_count") if (
                isinstance(cached_entry, dict) and cached_entry.get("source_key") == source_key
            ) else None
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                chapter = tts_offline_chapter_data(
                    latest,
                    chapter_index,
                    settings,
                    include_cache_keys=False,
                )
                count = len(chapter["sentences"])
                parsed += 1
            counts[chapter_index] = count
            entries[str(chapter_index)] = {
                "source_key": source_key,
                "sentence_count": count,
            }
        data = {
            "version": TTS_SENTENCE_INDEX_VERSION,
            "book_key": book_key,
            "chunk_chars": max_chars,
            "chapters": entries,
        }
        if data != cached:
            save_tts_sentence_index(book_id, data)
    if parsed:
        app.logger.info(
            "tts sentence index updated book=%s parsed=%s cached=%s elapsed=%.3fs",
            book_id,
            parsed,
            len(counts) - parsed,
            time.perf_counter() - started,
        )
    return latest, counts


def pinned_tts_cache_keys(completed_only=False):
    pending_cutoff = time.time() - TTS_OFFLINE_JOB_RETENTION_SECONDS
    where = "size_bytes > 0 AND audio_format = 'm4a'" if completed_only else "size_bytes > 0 OR created_at >= ?"
    params = () if completed_only else (pending_cutoff,)
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            return {
                row["cache_key"]
                for row in connection.execute(
                    f"SELECT DISTINCT cache_key FROM offline_tts_refs WHERE {where}",
                    params,
                )
            }
        finally:
            connection.close()


def is_tts_cache_pinned(cache_key):
    pending_cutoff = time.time() - TTS_OFFLINE_JOB_RETENTION_SECONDS
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            row = connection.execute(
                "SELECT 1 FROM offline_tts_refs WHERE cache_key = ? AND (size_bytes > 0 OR created_at >= ?) LIMIT 1",
                (cache_key, pending_cutoff),
            ).fetchone()
            return row is not None
        finally:
            connection.close()


def save_tts_offline_ref(book_id, chapter, sentence, profile_key, audio_format, size_bytes=0):
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO offline_tts_refs (
                        book_id, chapter_index, chapter_hash, sentence_index, sentence_text,
                        profile_key, cache_key, audio_format, size_bytes, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(book_id, chapter_index, sentence_index, profile_key) DO UPDATE SET
                        chapter_hash = excluded.chapter_hash,
                        sentence_text = excluded.sentence_text,
                        cache_key = excluded.cache_key,
                        audio_format = excluded.audio_format,
                        size_bytes = CASE WHEN offline_tts_refs.cache_key = excluded.cache_key AND excluded.size_bytes = 0 THEN offline_tts_refs.size_bytes ELSE excluded.size_bytes END,
                        created_at = excluded.created_at
                    """,
                    (
                        book_id,
                        chapter["index"],
                        chapter["hash"],
                        sentence["index"],
                        sentence["text"],
                        profile_key,
                        sentence["cache_key"],
                        audio_format,
                        max(0, int(size_bytes)),
                        time.time(),
                    ),
                )
        finally:
            connection.close()


def remove_tts_offline_ref(book_id, chapter_index, sentence_index, profile_key):
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            with connection:
                connection.execute(
                    "DELETE FROM offline_tts_refs WHERE book_id = ? AND chapter_index = ? AND sentence_index = ? AND profile_key = ?",
                    (book_id, chapter_index, sentence_index, profile_key),
                )
        finally:
            connection.close()


def load_tts_offline_refs_by_chapter(book_id, profile_key):
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            rows = connection.execute(
                """
                SELECT chapter_index, chapter_hash, sentence_index, sentence_text,
                       cache_key, audio_format
                FROM offline_tts_refs
                WHERE book_id = ? AND profile_key = ? AND size_bytes > 0
                """,
                (book_id, profile_key),
            ).fetchall()
        finally:
            connection.close()
    grouped = {}
    for row in rows:
        grouped.setdefault(int(row["chapter_index"]), []).append(row)
    return grouped


def valid_tts_offline_sentence_indexes_from_rows(chapter, rows):
    expected = {int(item["index"]): item for item in chapter["sentences"]}
    valid = set()
    for row in rows:
        sentence = expected.get(int(row["sentence_index"]))
        if (
            row["audio_format"] != "m4a"
            or row["chapter_hash"] != chapter["hash"]
            or not sentence
            or row["sentence_text"] != sentence["text"]
            or row["cache_key"] != sentence["cache_key"]
        ):
            continue
        path = tts_cache_path(row["cache_key"], "m4a")
        try:
            if path.is_file() and path.stat().st_size > 0:
                valid.add(int(row["sentence_index"]))
        except OSError:
            continue
    return valid


def valid_tts_offline_sentence_indexes(book_id, chapter, profile_key):
    rows = load_tts_offline_refs_by_chapter(book_id, profile_key).get(int(chapter["index"]), [])
    return valid_tts_offline_sentence_indexes_from_rows(chapter, rows)


def valid_tts_offline_pack(book_id, chapter, spec, profile_key, valid_sentences=None):
    required = {int(item["index"]) for item in spec["sentences"]}
    if valid_sentences is None:
        valid_sentences = valid_tts_offline_sentence_indexes(book_id, chapter, profile_key)
    if not required or not required.issubset(valid_sentences):
        return None
    manifest = load_tts_pack_manifest(spec["pack_key"])
    if not tts_pack_manifest_matches(manifest, book_id, chapter, spec, profile_key):
        return None
    segment_indexes = {int(item.get("index", -1)) for item in manifest.get("segments", [])}
    return manifest if segment_indexes == required else None


def tts_offline_chapter_status(
    book,
    chapter_record,
    fallback_index,
    settings,
    profile_key,
    chapter_rows=None,
    inspect=False,
    known_sentence_count=None,
):
    chapter_index = int(chapter_record.get("index", fallback_index))
    rows = list(chapter_rows or [])
    if not rows and not inspect:
        if known_sentence_count is None:
            known_sentence_count = len(tts_offline_chapter_data(
                book, chapter_index, settings, include_cache_keys=False,
            )["sentences"])
        return {
            "index": chapter_index,
            "title": display_chapter_title(chapter_record, fallback_index),
            "chapter_hash": "",
            "server_sentences": 0,
            "total_sentences": int(known_sentence_count),
            "server_packs": 0,
            "total_packs": None,
            "server_size_bytes": 0,
            "server_sentence_size_bytes": 0,
            "server_pack_size_bytes": 0,
        }

    chapter = tts_offline_chapter_data(book, chapter_index, settings)
    valid_sentences = valid_tts_offline_sentence_indexes_from_rows(chapter, rows)
    sentence_size_bytes = 0
    seen_sentence_keys = set()
    for sentence in chapter["sentences"]:
        if sentence["index"] not in valid_sentences or sentence["cache_key"] in seen_sentence_keys:
            continue
        seen_sentence_keys.add(sentence["cache_key"])
        try:
            sentence_size_bytes += tts_cache_path(sentence["cache_key"], "m4a").stat().st_size
        except OSError:
            pass
    pack_size_bytes = 0
    pack_count = 0
    specs = tts_pack_specs(chapter, settings)
    for spec in specs:
        manifest = valid_tts_offline_pack(book["id"], chapter, spec, profile_key, valid_sentences)
        if not manifest:
            continue
        pack_count += 1
        pack_size_bytes += int(manifest.get(
            "cache_size_bytes",
            manifest.get("size_bytes", 0),
        ))
    return {
        "index": chapter_index,
        "title": display_chapter_title(chapter_record, fallback_index),
        "chapter_hash": chapter["hash"],
        "server_sentences": len(valid_sentences),
        "total_sentences": len(chapter["sentences"]),
        "server_packs": pack_count,
        "total_packs": len(specs),
        "server_size_bytes": sentence_size_bytes + pack_size_bytes,
        "server_sentence_size_bytes": sentence_size_bytes,
        "server_pack_size_bytes": pack_size_bytes,
    }


def tts_offline_status_lock(book_id):
    return TTS_OFFLINE_STATUS_LOCKS[
        int(book_id[:8], 16) % len(TTS_OFFLINE_STATUS_LOCKS)
    ]


def tts_offline_status_snapshot_path(book_id, profile_key):
    return book_dir(book_id) / f"tts_offline_status_{profile_key}.json"


def invalidate_tts_offline_status_snapshot(book_id, profile_key):
    with tts_offline_status_lock(book_id):
        try:
            tts_offline_status_snapshot_path(book_id, profile_key).unlink()
        except OSError:
            pass


def tts_offline_ref_fingerprint(book_id, profile_key):
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            row = connection.execute(
                """
                SELECT COUNT(*) AS entries,
                       COALESCE(SUM(size_bytes), 0) AS size_bytes,
                       COALESCE(MAX(created_at), 0) AS newest_created_at,
                       COALESCE(SUM(chapter_index), 0) AS chapter_sum,
                       COALESCE(SUM(sentence_index), 0) AS sentence_sum
                FROM offline_tts_refs
                WHERE book_id = ? AND profile_key = ?
                """,
                (book_id, profile_key),
            ).fetchone()
        finally:
            connection.close()
    return [
        int(row["entries"]),
        int(row["size_bytes"]),
        float(row["newest_created_at"]),
        int(row["chapter_sum"]),
        int(row["sentence_sum"]),
    ]


def tts_offline_book_signature(book, settings):
    sentence_index = load_tts_sentence_index(book["id"])
    payload = {
        "sentence_index_version": TTS_SENTENCE_INDEX_VERSION,
        "pack_schema_version": TTS_PACK_SCHEMA_VERSION,
        "chunk_chars": int(settings.get("chunk_chars", 260)),
        "sentence_index": sentence_index,
        "chapter_titles": [
            [
                int(chapter.get("index", index)),
                display_chapter_title(chapter, index),
            ]
            for index, chapter in enumerate(book.get("chapters", []))
        ],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load_tts_offline_status_snapshot(book_id, profile_key, book_signature, ref_fingerprint):
    path = tts_offline_status_snapshot_path(book_id, profile_key)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("version") != TTS_OFFLINE_STATUS_SNAPSHOT_VERSION
        or payload.get("profile_key") != profile_key
        or payload.get("book_signature") != book_signature
        or payload.get("ref_fingerprint") != ref_fingerprint
        or not isinstance(payload.get("status"), dict)
        or not isinstance(payload["status"].get("chapters"), list)
    ):
        return None
    return payload["status"]


def save_tts_offline_status_snapshot(
    book_id,
    profile_key,
    book_signature,
    ref_fingerprint,
    status,
):
    try:
        write_json_atomic(
            tts_offline_status_snapshot_path(book_id, profile_key),
            {
                "version": TTS_OFFLINE_STATUS_SNAPSHOT_VERSION,
                "saved_at": int(time.time()),
                "profile_key": profile_key,
                "book_signature": book_signature,
                "ref_fingerprint": ref_fingerprint,
                "status": status,
            },
        )
    except OSError as exc:
        app.logger.warning("tts offline status snapshot write failed book=%s error=%s", book_id, exc)


def tts_offline_book_status(book, settings, use_snapshot=True):
    started = time.perf_counter()
    book, sentence_counts = ensure_tts_sentence_counts(book, settings)
    sentence_index_seconds = time.perf_counter() - started
    profile_key = tts_offline_profile_key(settings)
    book_signature = tts_offline_book_signature(book, settings)
    lock = tts_offline_status_lock(book["id"])

    with lock:
        refs_started = time.perf_counter()
        ref_fingerprint = tts_offline_ref_fingerprint(book["id"], profile_key)
        refs_seconds = time.perf_counter() - refs_started
        snapshot_started = time.perf_counter()
        if use_snapshot:
            cached = load_tts_offline_status_snapshot(
                book["id"],
                profile_key,
                book_signature,
                ref_fingerprint,
            )
            if cached is not None:
                return cached, {
                    "sentence_index_seconds": sentence_index_seconds,
                    "refs_seconds": refs_seconds,
                    "chapters_seconds": 0.0,
                    "snapshot_seconds": time.perf_counter() - snapshot_started,
                    "snapshot_hit": True,
                    "total_seconds": time.perf_counter() - started,
                }

        snapshot_seconds = time.perf_counter() - snapshot_started
        refs_started = time.perf_counter()
        refs_by_chapter = load_tts_offline_refs_by_chapter(book["id"], profile_key)
        refs_seconds += time.perf_counter() - refs_started
        chapters_started = time.perf_counter()
        chapters = [
            tts_offline_chapter_status(
                book,
                chapter_record,
                index,
                settings,
                profile_key,
                refs_by_chapter.get(int(chapter_record.get("index", index)), []),
                known_sentence_count=sentence_counts[int(chapter_record.get("index", index))],
            )
            for index, chapter_record in enumerate(book.get("chapters", []))
        ]
        chapters_seconds = time.perf_counter() - chapters_started

        voice_id = settings.get("voice_id") or "mimo_default"
        voice = next((item for item in TTS_VOICE_OPTIONS if item.get("id") == voice_id), None)
        status = {
            "profile_key": profile_key,
            "profile_label": (voice or {}).get("name") or voice_id,
            "pack_schema_version": TTS_PACK_SCHEMA_VERSION,
            "chapters": chapters,
        }
        if use_snapshot and ref_fingerprint == tts_offline_ref_fingerprint(book["id"], profile_key):
            save_tts_offline_status_snapshot(
                book["id"],
                profile_key,
                book_signature,
                ref_fingerprint,
                status,
            )

    return status, {
        "sentence_index_seconds": sentence_index_seconds,
        "refs_seconds": refs_seconds,
        "chapters_seconds": chapters_seconds,
        "snapshot_seconds": snapshot_seconds,
        "snapshot_hit": False,
        "total_seconds": time.perf_counter() - started,
    }


def tts_offline_chapter_manifest(book, chapter_index, config):
    settings = config["reader_tts"]
    profile_key = tts_offline_profile_key(settings)
    chapter = tts_offline_chapter_data(book, chapter_index, settings)
    valid_sentences = valid_tts_offline_sentence_indexes(book["id"], chapter, profile_key)
    entries = []
    specs = tts_pack_specs(chapter, settings)
    for position, spec in enumerate(specs):
        manifest = valid_tts_offline_pack(book["id"], chapter, spec, profile_key, valid_sentences)
        if not manifest:
            continue
        entries.append(public_tts_pack_manifest(
            manifest,
            f"/api/books/{book['id']}/tts-offline/chapters/{chapter['index']}/packs/{spec['pack_key']}",
            specs[position + 1:],
        ))
    return {
        "book_id": book["id"],
        "chapter_index": chapter["index"],
        "chapter_title": chapter["title"],
        "chapter_hash": chapter["hash"],
        "profile_key": profile_key,
        "sentence_count": len(chapter["sentences"]),
        "pack_count": len(specs),
        "entries": entries,
    }


def cleanup_tts_offline_jobs_locked():
    cutoff = time.time() - TTS_OFFLINE_JOB_RETENTION_SECONDS
    stale = [
        job_id for job_id, job in TTS_OFFLINE_JOBS.items()
        if job.get("status") in {"done", "error", "cancelled"} and job.get("updated_at", 0) < cutoff
    ]
    for job_id in stale:
        TTS_OFFLINE_JOBS.pop(job_id, None)


def active_tts_offline_job_for_book(book_id):
    with TTS_OFFLINE_JOB_LOCK:
        cleanup_tts_offline_jobs_locked()
        job = next((
            item for item in TTS_OFFLINE_JOBS.values()
            if item.get("book_id") == book_id and item.get("status") in {"queued", "running"}
        ), None)
        return public_tts_offline_job(job) if job else None

def public_tts_offline_job(job):
    return {
        key: job.get(key)
        for key in (
            "id", "book_id", "chapter_indexes", "status", "message", "progress", "total_sentences",
            "completed_sentences", "failed_sentences", "cached_sentences", "generated_sentences",
            "total_packs", "completed_packs", "failed_packs", "size_bytes", "error",
            "cancel_requested", "created_at", "updated_at",
        )
    }


def update_tts_offline_job(job_id, **updates):
    with TTS_OFFLINE_JOB_LOCK:
        job = TTS_OFFLINE_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = time.time()
        total = max(1, int(job.get("total_sentences") or 0))
        completed = int(job.get("completed_sentences") or 0) + int(job.get("failed_sentences") or 0)
        if job.get("status") == "done":
            job["progress"] = 100
        elif total:
            job["progress"] = min(99, round(completed / total * 100))


def tts_offline_job_cancel_requested(job_id):
    with TTS_OFFLINE_JOB_LOCK:
        job = TTS_OFFLINE_JOBS.get(job_id)
        return bool(job and job.get("cancel_requested"))


def process_tts_offline_job(job_id, book_id, chapter_indexes):
    try:
        config = load_config()
        config = json.loads(json.dumps(config))
        config["reader_tts"]["cache_enabled"] = True
        settings = config["reader_tts"]
        book = read_book_record(book_id)
        chapters = [tts_offline_chapter_data(book, index, settings) for index in chapter_indexes]
        total = sum(len(chapter["sentences"]) for chapter in chapters)
        total_packs = sum(len(tts_pack_specs(chapter, settings)) for chapter in chapters)
        if tts_offline_job_cancel_requested(job_id):
            update_tts_offline_job(job_id, status="cancelled", message="任务已取消", total_sentences=total)
            return
        worker_count = min(TTS_OFFLINE_CHAPTER_WORKERS, len(chapters))
        message = "正在生成并固定服务器缓存"
        if worker_count > 1:
            message += f"（{worker_count} 章并行）"
        update_tts_offline_job(
            job_id,
            status="running",
            message=message,
            total_sentences=total,
            total_packs=total_packs,
        )
        profile_key = tts_offline_profile_key(settings)
        audio_format = "m4a"
        stats = {
            "completed_sentences": 0,
            "failed_sentences": 0,
            "cached_sentences": 0,
            "generated_sentences": 0,
            "completed_packs": 0,
            "failed_packs": 0,
            "size_bytes": 0,
            "error": "",
        }
        stats_lock = threading.Lock()

        def process_chapter(chapter):
            for sentence in chapter["sentences"]:
                if tts_offline_job_cancel_requested(job_id):
                    return
                save_tts_offline_ref(book_id, chapter, sentence, profile_key, audio_format)
                succeeded = False
                cached_result = False
                size = 0
                error = ""
                try:
                    result = synthesize_reader_tts(sentence["text"], config)
                    path = result.get("path") or tts_cache_path(sentence["cache_key"], audio_format)
                    if not path.is_file() and result.get("data"):
                        with TTS_CACHE_LOCK:
                            ensure_private_directory(TTS_CACHE_DIR)
                            write_private_bytes_atomic(path, result["data"])
                    size = path.stat().st_size
                    save_tts_offline_ref(book_id, chapter, sentence, profile_key, audio_format, size)
                    succeeded = True
                    cached_result = bool(result.get("cached"))
                except Exception as exc:
                    error = " ".join(str(exc).split())[:500]
                    try:
                        remove_tts_offline_ref(book_id, chapter["index"], sentence["index"], profile_key)
                    except sqlite3.Error as cleanup_error:
                        app.logger.warning(
                            "tts offline failed ref cleanup error book=%s chapter=%s sentence=%s error=%s",
                            book_id,
                            chapter["index"],
                            sentence["index"],
                            cleanup_error,
                        )
                    app.logger.warning(
                        "tts offline sentence failed book=%s chapter=%s sentence=%s key=%s chars=%s error=%s",
                        book_id,
                        chapter["index"],
                        sentence["index"],
                        sentence["cache_key"][:12],
                        len(sentence["text"]),
                        error,
                    )

                with stats_lock:
                    if succeeded:
                        stats["completed_sentences"] += 1
                        stats["size_bytes"] += size
                        if cached_result:
                            stats["cached_sentences"] += 1
                        else:
                            stats["generated_sentences"] += 1
                    else:
                        stats["failed_sentences"] += 1
                        stats["error"] = error
                    update_tts_offline_job(job_id, **stats)

            if tts_offline_job_cancel_requested(job_id):
                return
            valid_sentences = valid_tts_offline_sentence_indexes(book_id, chapter, profile_key)
            pack_specs = tts_pack_specs(chapter, settings)
            if pack_specs:
                update_tts_offline_job(job_id, message="正在生成固定播放包")

            def process_pack(spec):
                if tts_offline_job_cancel_requested(job_id):
                    return
                required = {int(item["index"]) for item in spec["sentences"]}
                succeeded = False
                error = ""
                try:
                    if not required.issubset(valid_sentences):
                        raise ValueError("播放包包含生成失败的句子")
                    build_reader_tts_pack(book_id, chapter, spec, config, prune_cache=False)
                    succeeded = True
                except Exception as exc:
                    error = " ".join(str(exc).split())[:500]
                    app.logger.warning(
                        "tts offline pack failed book=%s chapter=%s pack=%s sentences=%s-%s error=%s",
                        book_id,
                        chapter["index"],
                        spec["pack_key"][:12],
                        spec["start_sentence_index"],
                        spec["end_sentence_index"],
                        error,
                    )
                with stats_lock:
                    if succeeded:
                        stats["completed_packs"] += 1
                    else:
                        stats["failed_packs"] += 1
                        if not stats["error"]:
                            stats["error"] = error
                    update_tts_offline_job(job_id, **stats)

            pack_worker_count = min(TTS_OFFLINE_PACK_WORKERS, len(pack_specs))
            if pack_worker_count == 1:
                process_pack(pack_specs[0])
            elif pack_worker_count > 1:
                with ThreadPoolExecutor(
                    max_workers=pack_worker_count,
                    thread_name_prefix="tts-offline-pack",
                ) as executor:
                    list(executor.map(process_pack, pack_specs))

        if worker_count == 1:
            process_chapter(chapters[0])
        else:
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="tts-offline-chapter",
            ) as executor:
                list(executor.map(process_chapter, chapters))

        maybe_prune_tts_pack_cache(force=True)

        with stats_lock:
            final_stats = dict(stats)
        cached = final_stats["cached_sentences"]
        generated = final_stats["generated_sentences"]
        failed = final_stats["failed_sentences"]
        completed_packs = final_stats["completed_packs"]
        failed_packs = final_stats["failed_packs"]
        total_size = final_stats["size_bytes"]
        if tts_offline_job_cancel_requested(job_id):
            message = f"已取消：复用 {cached} 句，生成 {generated} 句"
            if failed:
                message += f"，失败 {failed} 句"
            update_tts_offline_job(job_id, status="cancelled", message=message)
            app.logger.info(
                "tts offline job cancelled book=%s chapters=%s cached=%s generated=%s failed=%s bytes=%s",
                book_id,
                len(chapter_indexes),
                cached,
                generated,
                failed,
                total_size,
            )
            return
        message = f"完成：复用 {cached} 句，生成 {generated} 句"
        if failed:
            message += f"，失败 {failed} 句"
        message += f"；播放包 {completed_packs}/{total_packs}"
        if failed_packs:
            message += f"，失败 {failed_packs} 包"
        update_tts_offline_job(job_id, status="done", message=message)
        app.logger.info(
            "tts offline job done book=%s chapters=%s cached=%s generated=%s failed=%s bytes=%s",
            book_id,
            len(chapter_indexes),
            cached,
            generated,
            failed,
            total_size,
        )
    except Exception as exc:
        app.logger.warning("tts offline job failed book=%s error=%s", book_id, exc)
        update_tts_offline_job(job_id, status="error", message="服务器固定缓存失败", error=str(exc))
    finally:
        invalidate_tts_cache_stats(refresh=True)


def delete_tts_offline_refs(book_id, chapter_indexes=None, profile_key=None, delete_files=False):
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            params = [book_id]
            where = "book_id = ?"
            if chapter_indexes is not None:
                placeholders = ",".join("?" for _ in chapter_indexes)
                if not placeholders:
                    return {"entries": 0, "size_bytes": 0}
                where += f" AND chapter_index IN ({placeholders})"
                params.extend(chapter_indexes)
            if profile_key:
                where += " AND profile_key = ?"
                params.append(profile_key)
            rows = connection.execute(
                f"SELECT DISTINCT cache_key, audio_format, size_bytes FROM offline_tts_refs WHERE {where}",
                params,
            ).fetchall()
            with connection:
                connection.execute(f"DELETE FROM offline_tts_refs WHERE {where}", params)
            remaining = {
                row["cache_key"]
                for row in connection.execute(
                    "SELECT DISTINCT cache_key FROM offline_tts_refs WHERE cache_key IN ({})".format(
                        ",".join("?" for _ in rows)
                    ),
                    [row["cache_key"] for row in rows],
                )
            } if rows else set()
        finally:
            connection.close()
    affected_size = sum(max(0, int(row["size_bytes"] or 0)) for row in rows)
    # Every reference for this book is gone, so its own manifests cannot still
    # be pinned. Partial removals still protect packs used by other chapters.
    preserve_pinned_packs = chapter_indexes is not None or bool(profile_key)
    with TTS_PACK_CACHE_LOCK:
        removed_packs = delete_unpinned_tts_pack_files(
            book_id, chapter_indexes, profile_key, preserve_pinned_packs,
        )
    removed_size = int(removed_packs["size_bytes"])
    if not delete_files:
        result = {
            "entries": len(rows),
            "pack_entries": removed_packs["entries"],
            "size_bytes": affected_size + removed_size,
            "removed_size_bytes": removed_size,
        }
        invalidate_tts_cache_stats(refresh=True)
        return result
    for row in rows:
        if row["cache_key"] in remaining:
            continue
        path = tts_cache_path(row["cache_key"], row["audio_format"])
        try:
            removed_size += path.stat().st_size
            path.unlink()
        except OSError:
            pass
    result = {
        "entries": len(rows),
        "pack_entries": removed_packs["entries"],
        "size_bytes": affected_size + removed_packs["size_bytes"],
        "removed_size_bytes": removed_size,
    }
    invalidate_tts_cache_stats(refresh=True)
    return result


def pinned_tts_pack_keys():
    if not TTS_PACK_CACHE_DIR.is_dir():
        return set()
    with TTS_OFFLINE_LOCK:
        connection = open_tts_offline_db()
        try:
            rows = connection.execute(
                """
                SELECT book_id, chapter_index, chapter_hash, profile_key, sentence_index,
                       cache_key, audio_format
                FROM offline_tts_refs WHERE size_bytes > 0
                """
            ).fetchall()
        finally:
            connection.close()
    references = set()
    for row in rows:
        path = tts_cache_path(row["cache_key"], row["audio_format"])
        try:
            if not path.is_file() or path.stat().st_size <= 0:
                continue
        except OSError:
            continue
        references.add((
            row["book_id"], int(row["chapter_index"]), row["chapter_hash"],
            row["profile_key"], int(row["sentence_index"]),
        ))
    pinned = set()
    for manifest_path in TTS_PACK_CACHE_DIR.glob("*.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("kind", "chapter") != "chapter":
                continue
            identity = (
                manifest["book_id"], int(manifest["chapter_index"]),
                manifest["chapter_hash"], manifest["profile_key"],
            )
            required = {identity + (int(segment["index"]),) for segment in manifest["segments"]}
            pack_key = manifest["pack_key"]
        except (OSError, KeyError, TypeError, ValueError):
            continue
        if required and required.issubset(references):
            pinned.add(pack_key)
    return pinned


def delete_unpinned_tts_pack_files(
    book_id,
    chapter_indexes=None,
    profile_key=None,
    preserve_pinned=True,
):
    selected = None if chapter_indexes is None else {int(index) for index in chapter_indexes}
    entries = 0
    size_bytes = 0
    if not TTS_PACK_CACHE_DIR.is_dir():
        return {"entries": 0, "size_bytes": 0}
    pinned_keys = pinned_tts_pack_keys() if preserve_pinned else set()
    for manifest_path in TTS_PACK_CACHE_DIR.glob("*.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        pack_key = manifest_path.stem
        if not re.fullmatch(r"[0-9a-f]{64}", pack_key) or manifest.get("pack_key") != pack_key:
            continue
        if manifest.get("book_id") != book_id:
            continue
        if selected is not None and int(manifest.get("chapter_index", -1)) not in selected:
            continue
        if profile_key and manifest.get("profile_key") != profile_key:
            continue
        if pack_key in pinned_keys:
            continue
        audio_path, stored_manifest_path = tts_pack_cache_paths(pack_key)
        try:
            size_bytes += audio_path.stat().st_size
        except OSError:
            pass
        for candidate in (audio_path, stored_manifest_path):
            try:
                candidate.unlink()
            except OSError:
                pass
        entries += 1
    return {"entries": entries, "size_bytes": size_bytes}


def find_cached_tts(cache_path):
    if not cache_path.exists():
        return None
    try:
        stat = cache_path.stat()
        if not cache_path.is_file() or stat.st_size <= 0:
            cache_path.unlink(missing_ok=True)
            invalidate_tts_cache_stats()
            return None
        if time.time() - stat.st_mtime > tts_cache_ttl_seconds() and not is_tts_cache_pinned(cache_path.stem):
            cache_path.unlink()
            invalidate_tts_cache_stats()
            return None
        os.chmod(cache_path, 0o600)
        os.utime(cache_path, None)
        return cache_path
    except OSError:
        return None


def prune_tts_cache():
    ensure_private_directory(TTS_CACHE_DIR)
    files = []
    total = 0
    now = time.time()
    ttl = tts_cache_ttl_seconds()
    pinned_keys = pinned_tts_cache_keys()
    for path in TTS_CACHE_DIR.glob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if path.stem in pinned_keys:
            continue
        if now - stat.st_mtime > ttl:
            try:
                path.unlink()
            except OSError:
                pass
            continue
        files.append((stat.st_mtime, stat.st_size, path))
        total += stat.st_size
    limit = max(5 * 1024 * 1024, tts_cache_limit_bytes() // 2)
    if total <= limit:
        return
    for _, size, path in sorted(files):
        try:
            path.unlink()
            total -= size
        except OSError:
            continue
        if total <= limit:
            break


def prune_tts_pack_cache():
    ensure_private_directory(TTS_PACK_CACHE_DIR)
    now = time.time()
    ttl = tts_cache_ttl_seconds()
    candidates = []
    total = 0
    pinned_keys = pinned_tts_pack_keys()
    for manifest_path in TTS_PACK_CACHE_DIR.glob("*.json"):
        pack_key = manifest_path.stem
        try:
            indexed = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            indexed = None
        if (
            not isinstance(indexed, dict)
            or not re.fullmatch(r"[0-9a-f]{64}", pack_key)
            or indexed.get("pack_key") != pack_key
        ):
            for candidate in tts_pack_cache_paths(pack_key):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            continue
        manifest = load_tts_pack_manifest(pack_key)
        if not manifest:
            for candidate in tts_pack_cache_paths(pack_key):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            continue
        if manifest.get("audio_source") != "tts_cache":
            continue
        if pack_key in pinned_keys:
            continue
        try:
            if now - manifest_path.stat().st_mtime > ttl:
                manifest_path.unlink()
        except OSError:
            pass
    for audio_path in TTS_PACK_CACHE_DIR.glob("*.m4a"):
        manifest = load_tts_pack_manifest(audio_path.stem)
        if not manifest:
            for candidate in tts_pack_cache_paths(audio_path.stem):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            continue
        try:
            stat = audio_path.stat()
        except OSError:
            continue
        if audio_path.stem in pinned_keys:
            continue
        _, manifest_path = tts_pack_cache_paths(audio_path.stem)
        if now - stat.st_mtime > ttl:
            for candidate in (audio_path, manifest_path):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            continue
        candidates.append((stat.st_mtime, stat.st_size, audio_path, manifest_path))
        total += stat.st_size
    limit = max(5 * 1024 * 1024, tts_cache_limit_bytes() // 2)
    for _, size, audio_path, manifest_path in sorted(candidates):
        if total <= limit:
            break
        for candidate in (audio_path, manifest_path):
            try:
                candidate.unlink()
            except OSError:
                pass
        total -= size


def maybe_prune_tts_pack_cache(force=False):
    now = time.monotonic()
    with TTS_PACK_CACHE_LOCK:
        if not force and now - TTS_PACK_PRUNE_STATE["time"] < TTS_PACK_PRUNE_INTERVAL_SECONDS:
            return False
        TTS_PACK_PRUNE_STATE["time"] = now
        try:
            prune_tts_pack_cache()
        except (OSError, sqlite3.Error) as exc:
            app.logger.warning("tts pack cache prune failed error=%s", exc)
            return False
    return True


def decode_mimo_audio_payload(payload):
    base_resp = payload.get("base_resp") or {}
    status_code = base_resp.get("status_code")
    if status_code not in (None, 0):
        raise ValueError(base_resp.get("status_msg") or "MiMo TTS 请求失败")
    choices = payload.get("choices") or []
    message = choices[0].get("message", {}) if choices else {}
    audio_payload = message.get("audio") or payload.get("audio") or {}
    audio = audio_payload.get("data") or audio_payload.get("audio") or audio_payload.get("audio_base64")
    if not audio:
        error_payload = payload.get("error") or {}
        detail = next((
            value for value in (
                error_payload.get("message") if isinstance(error_payload, dict) else error_payload,
                base_resp.get("status_msg"),
                message.get("content"),
                choices[0].get("finish_reason") if choices else "",
            )
            if value
        ), "")
        detail = " ".join(str(detail).split())[:200]
        raise ValueError("MiMo TTS 未返回音频" + (f"：{detail}" if detail else ""))
    audio = str(audio).strip()
    if re.fullmatch(r"[0-9a-fA-F]+", audio) and len(audio) % 2 == 0:
        if len(audio) // 2 > MAX_TTS_AUDIO_BYTES:
            raise ValueError("MiMo TTS 返回的音频过大")
        return bytes.fromhex(audio)
    if len(audio) > (MAX_TTS_AUDIO_BYTES * 4 // 3) + 16:
        raise ValueError("MiMo TTS 返回的音频过大")
    try:
        data = base64.b64decode(audio, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("MiMo TTS 音频格式无法识别") from exc
    if len(data) > MAX_TTS_AUDIO_BYTES:
        raise ValueError("MiMo TTS 返回的音频过大")
    return data



def transcode_wav_to_aac(data):
    if not data:
        raise ValueError("MiMo TTS 返回的音频为空")
    try:
        with tempfile.TemporaryDirectory(prefix="trans-tts-") as temporary_dir:
            output_path = Path(temporary_dir) / "audio.m4a"
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "wav",
                    "-i",
                    "pipe:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "24000",
                    "-c:a",
                    "aac",
                    "-profile:a",
                    "aac_low",
                    "-b:a",
                    "80k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "ipod",
                    str(output_path),
                ],
                input=data,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=45,
                check=False,
            )
            if result.returncode != 0 or not output_path.is_file():
                detail = result.stderr.decode("utf-8", "replace").strip()[:300]
                raise ValueError("AAC 音频转码失败" + (f": {detail}" if detail else ""))
            if output_path.stat().st_size > MAX_TTS_AUDIO_BYTES:
                raise ValueError("AAC 音频过大")
            encoded = output_path.read_bytes()
    except FileNotFoundError as exc:
        raise ValueError("服务器未安装 ffmpeg，无法生成 AAC 音频") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError("AAC 音频转码超时") from exc
    except OSError as exc:
        raise ValueError("AAC 音频临时文件处理失败") from exc
    if not encoded:
        raise ValueError("AAC 音频转码结果为空")
    return encoded

def iso_bmff_boxes(data, start=0, end=None):
    limit = len(data) if end is None else min(int(end), len(data))
    position = max(0, int(start))
    while position + 8 <= limit:
        size = struct.unpack_from(">I", data, position)[0]
        box_type = data[position + 4:position + 8]
        header_size = 8
        if size == 1:
            if position + 16 > limit:
                raise ValueError("M4A 扩展容器头无效")
            size = struct.unpack_from(">Q", data, position + 8)[0]
            header_size = 16
        elif size == 0:
            size = limit - position
        if size < header_size or position + size > limit:
            raise ValueError("M4A 容器长度无效")
        yield box_type, position + header_size, position + size
        position += size


def iso_bmff_child(data, start, end, expected_type):
    return next(
        ((payload_start, box_end) for box_type, payload_start, box_end in iso_bmff_boxes(data, start, end)
         if box_type == expected_type),
        None,
    )


def m4a_container_duration(path):
    data = path.read_bytes()
    moov = iso_bmff_child(data, 0, len(data), b"moov")
    if not moov:
        raise ValueError("M4A 缺少 moov 容器")
    movie_header = iso_bmff_child(data, *moov, b"mvhd")
    if not movie_header:
        raise ValueError("M4A 缺少 mvhd 时间轴")
    has_audio = False
    for box_type, track_start, track_end in iso_bmff_boxes(data, *moov):
        if box_type != b"trak":
            continue
        media = iso_bmff_child(data, track_start, track_end, b"mdia")
        if not media:
            continue
        handler = iso_bmff_child(data, *media, b"hdlr")
        if handler and handler[0] + 12 <= handler[1] and data[handler[0] + 8:handler[0] + 12] == b"soun":
            has_audio = True
            break
    if not has_audio:
        raise ValueError("M4A 缺少音频轨道")
    payload_start, payload_end = movie_header
    if payload_start >= payload_end:
        raise ValueError("M4A 时间轴为空")
    version = data[payload_start]
    if version == 0 and payload_start + 20 <= payload_end:
        timescale = struct.unpack_from(">I", data, payload_start + 12)[0]
        duration_ticks = struct.unpack_from(">I", data, payload_start + 16)[0]
    elif version == 1 and payload_start + 32 <= payload_end:
        timescale = struct.unpack_from(">I", data, payload_start + 20)[0]
        duration_ticks = struct.unpack_from(">Q", data, payload_start + 24)[0]
    else:
        raise ValueError("M4A 时间轴版本无效")
    if not timescale or not duration_ticks:
        raise ValueError("M4A 时间轴无效")
    duration = duration_ticks / timescale
    if not duration > 0:
        raise ValueError("M4A 音频时长无效")
    return duration


def tts_audio_duration(path):
    try:
        return m4a_container_duration(path)
    except (OSError, ValueError, struct.error):
        pass
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise ValueError("服务器未安装 ffprobe，无法生成播放包时间轴") from exc
    if result.returncode != 0:
        raise ValueError("无法读取 AAC 音频时长")
    try:
        duration = float(result.stdout.strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("AAC 音频时长无效") from exc
    if not duration > 0:
        raise ValueError("AAC 音频时长无效")
    return duration

def estimate_tts_duration(text):
    compact = re.sub(r"\s+", "", str(text or ""))
    if not compact:
        return 0.0
    latin_tokens = re.findall(r"[A-Za-z0-9]+", compact)
    latin_words = len(latin_tokens)
    cjk_chars = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", compact))
    punctuation = len(re.findall(r"[，。！？；：,.!?;:]", compact))
    other = max(0, len(compact) - cjk_chars - sum(len(word) for word in latin_tokens))
    return max(0.8, cjk_chars / 4.6 + latin_words / 2.5 + other / 5.0 + punctuation * 0.12)


def tts_pack_sentence_groups(chapter):
    groups = []
    current = []
    estimated = 0.0

    for sentence in chapter["sentences"]:
        current.append(sentence)
        estimated += estimate_tts_duration(sentence["text"])
        if estimated >= TTS_PACK_MIN_SECONDS:
            groups.append(current)
            current = []
            estimated = 0.0

    if current:
        if groups:
            groups[-1].extend(current)
        else:
            groups.append(current)
    return groups


def tts_pack_specs(chapter, settings):
    profile_key = tts_offline_profile_key(settings)
    groups = []
    for current in tts_pack_sentence_groups(chapter):
        estimated = sum(estimate_tts_duration(item["text"]) for item in current)
        payload = {
            "schema": TTS_PACK_SCHEMA_VERSION,
            "kind": "chapter",
            "book_id": chapter["book_id"],
            "chapter_index": int(chapter["index"]),
            "profile_key": profile_key,
            "chapter_hash": chapter["hash"],
            "sentences": [[item["index"], item["cache_key"]] for item in current],
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        groups.append({
            "kind": "chapter",
            "pack_key": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "start_sentence_index": current[0]["index"],
            "end_sentence_index": current[-1]["index"],
            "sentence_count": len(current),
            "estimated_duration": round(estimated, 3),
            "sentences": list(current),
        })
    return groups


def tts_pack_cache_paths(pack_key):
    return TTS_PACK_CACHE_DIR / f"{pack_key}.m4a", TTS_PACK_CACHE_DIR / f"{pack_key}.json"


def indexed_tts_pack_key_matches(manifest):
    if manifest.get("audio_source") != "tts_cache":
        return True
    try:
        segment = manifest["segments"][0]
        payload = {
            "schema": TTS_PACK_SCHEMA_VERSION,
            "kind": manifest.get("kind", "chapter"),
            "book_id": manifest["book_id"],
            "chapter_index": int(manifest["chapter_index"]),
            "profile_key": manifest["profile_key"],
            "chapter_hash": manifest["chapter_hash"],
            "sentences": [[
                int(segment["index"]),
                manifest["audio_cache_key"],
            ]],
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest() == manifest["pack_key"]
    except (IndexError, KeyError, TypeError, ValueError):
        return False


def tts_pack_audio_path(manifest):
    if manifest.get("audio_source") == "tts_cache":
        cache_key = str(manifest.get("audio_cache_key") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            raise ValueError("单句播放包索引无效")
        return tts_cache_path(cache_key, "m4a")
    return tts_pack_cache_paths(manifest["pack_key"])[0]


def touch_tts_pack_cache(pack_key, manifest=None):
    current = manifest or load_tts_pack_manifest(pack_key)
    paths = [tts_pack_cache_paths(pack_key)[1]]
    if current:
        try:
            paths.append(tts_pack_audio_path(current))
        except (KeyError, TypeError, ValueError):
            pass
    else:
        paths.append(tts_pack_cache_paths(pack_key)[0])
    for path in paths:
        try:
            os.utime(path, None)
        except OSError:
            pass


def tts_pack_key_lock(pack_key):
    return TTS_PACK_KEY_LOCKS[int(pack_key[:8], 16) % len(TTS_PACK_KEY_LOCKS)]


def load_tts_pack_manifest(pack_key):
    _, manifest_path = tts_pack_cache_paths(pack_key)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            return None
        audio_path = tts_pack_audio_path(manifest)
        audio_size = audio_path.stat().st_size
    except (KeyError, OSError, ValueError, TypeError):
        return None
    audio_source = manifest.get("audio_source", "pack_cache")
    size_limit = MAX_TTS_AUDIO_BYTES if audio_source == "tts_cache" else MAX_TTS_PACK_BYTES
    if (
        manifest.get("pack_key") != pack_key
        or int(manifest.get("schema_version", 0)) != TTS_PACK_SCHEMA_VERSION
        or not isinstance(manifest.get("segments"), list)
        or not manifest["segments"]
        or audio_source not in {"pack_cache", "tts_cache"}
        or not indexed_tts_pack_key_matches(manifest)
        or audio_size <= 0
        or audio_size > size_limit
        or (
            audio_source == "tts_cache"
            and (
                int(manifest.get("sentence_count", 0)) != 1
                or len(manifest["segments"]) != 1
            )
        )
    ):
        return None
    previous_end = 0.0
    first_segment = True
    try:
        for segment in manifest["segments"]:
            start = float(segment["start"])
            end = float(segment["end"])
            int(segment["index"])
            if (first_segment and abs(start) > 0.05) or start < previous_end - 0.01 or end <= start:
                return None
            first_segment = False
            previous_end = end
        if int(manifest.get("sentence_count", 0)) != len(manifest["segments"]):
            return None
        duration = float(manifest.get("duration", 0))
        if duration < TTS_PACK_MIN_SECONDS - 0.05 or abs(previous_end - duration) > 0.1:
            return None
    except (KeyError, TypeError, ValueError):
        return None
    return manifest


def tts_pack_manifest_matches(manifest, book_id, chapter, spec, profile_key):
    if not manifest:
        return False
    try:
        if (
            manifest.get("kind", "chapter") != spec.get("kind", "chapter")
            or manifest.get("book_id") != book_id
            or int(manifest.get("chapter_index", -1)) != int(chapter["index"])
            or manifest.get("chapter_hash") != chapter["hash"]
            or manifest.get("profile_key") != profile_key
            or int(manifest.get("start_sentence_index", -1)) != int(spec["start_sentence_index"])
            or int(manifest.get("end_sentence_index", -1)) != int(spec["end_sentence_index"])
            or int(manifest.get("sentence_count", 0)) != int(spec["sentence_count"])
        ):
            return False
        expected = [(int(item["index"]), item["text"]) for item in spec["sentences"]]
        actual = [
            (int(item.get("index", -1)), item.get("text", ""))
            for item in manifest.get("segments", [])
        ]
    except (KeyError, TypeError, ValueError):
        return False
    return actual == expected


def reader_tts_pack_manifest(
    book_id,
    chapter,
    spec,
    profile_key,
    duration,
    size_bytes,
    segments,
    **extra,
):
    return {
        "schema_version": TTS_PACK_SCHEMA_VERSION,
        "kind": "chapter",
        "pack_key": spec["pack_key"],
        "book_id": book_id,
        "chapter_index": int(chapter["index"]),
        "chapter_hash": chapter["hash"],
        "profile_key": profile_key,
        "start_sentence_index": spec["start_sentence_index"],
        "end_sentence_index": spec["end_sentence_index"],
        "sentence_count": spec["sentence_count"],
        "duration": round(duration, 3),
        "size_bytes": int(size_bytes),
        "segments": segments,
        "created_at": time.time(),
        **extra,
    }


def index_single_sentence_tts_pack(book_id, chapter, spec, profile_key):
    if int(spec.get("sentence_count", 0)) != 1 or len(spec.get("sentences", [])) != 1:
        return None
    sentence = spec["sentences"][0]
    cache_key = str(sentence.get("cache_key") or "")
    if not re.fullmatch(r"[0-9a-f]{64}", cache_key):
        return None
    with TTS_CACHE_LOCK:
        source_path = find_cached_tts(tts_cache_path(cache_key, "m4a"))
    if source_path is None:
        return None
    try:
        source_size = source_path.stat().st_size
        if source_size > MAX_TTS_AUDIO_BYTES:
            return None
        duration = tts_audio_duration(source_path)
    except (OSError, ValueError):
        return None
    if duration < TTS_PACK_MIN_SECONDS:
        return None
    manifest = reader_tts_pack_manifest(
        book_id,
        chapter,
        spec,
        profile_key,
        duration,
        source_size,
        [{
            "index": int(sentence["index"]),
            "start": 0.0,
            "end": round(duration, 3),
            "text": sentence["text"],
        }],
        audio_source="tts_cache",
        audio_cache_key=cache_key,
        cache_size_bytes=0,
    )
    audio_path, manifest_path = tts_pack_cache_paths(spec["pack_key"])
    with TTS_PACK_CACHE_LOCK:
        write_json_atomic(manifest_path, manifest)
        try:
            audio_path.unlink()
        except OSError:
            pass
    invalidate_tts_cache_stats()
    invalidate_tts_offline_status_snapshot(book_id, profile_key)
    return manifest


def public_tts_pack_manifest(manifest, audio_url, next_specs=None):
    following = list(next_specs or [])
    return {
        "schema_version": TTS_PACK_SCHEMA_VERSION,
        "kind": manifest.get("kind", "chapter"),
        "pack_key": manifest["pack_key"],
        "book_id": manifest["book_id"],
        "chapter_index": int(manifest["chapter_index"]),
        "chapter_hash": manifest["chapter_hash"],
        "profile_key": manifest["profile_key"],
        "start_sentence_index": int(manifest["start_sentence_index"]),
        "end_sentence_index": int(manifest["end_sentence_index"]),
        "sentence_count": int(manifest["sentence_count"]),
        "duration": float(manifest["duration"]),
        "size_bytes": int(manifest["size_bytes"]),
        "format": "m4a",
        "segments": manifest["segments"],
        "url": audio_url,
        "next_start_sentence_indexes": [
            int(spec["start_sentence_index"])
            for spec in following[:TTS_PACK_PREFETCH_HINT_LIMIT]
        ],
        "remaining_pack_count": len(following),
    }


def build_reader_tts_pack(book_id, chapter, spec, config, prune_cache=True):
    pack_key = spec["pack_key"]
    audio_path, manifest_path = tts_pack_cache_paths(pack_key)
    with tts_pack_key_lock(pack_key):
        settings = config["reader_tts"]
        profile_key = tts_offline_profile_key(settings)
        cached = load_tts_pack_manifest(pack_key)
        if tts_pack_manifest_matches(cached, book_id, chapter, spec, profile_key):
            touch_tts_pack_cache(pack_key, cached)
            return cached
        if cached:
            for candidate in (audio_path, manifest_path):
                try:
                    candidate.unlink()
                except OSError:
                    pass
            invalidate_tts_offline_status_snapshot(book_id, profile_key)
        with TTS_PACK_BUILD_SEMAPHORE:
            ensure_private_directory(TTS_PACK_CACHE_DIR)
            try:
                if settings.get("cache_enabled", True):
                    indexed = index_single_sentence_tts_pack(
                        book_id, chapter, spec, profile_key,
                    )
                    if indexed:
                        if prune_cache:
                            maybe_prune_tts_pack_cache()
                        return indexed
                with tempfile.TemporaryDirectory(prefix="trans-tts-pack-") as temporary_dir:
                    temporary_root = Path(temporary_dir)
                    segments = []
                    offset = 0.0
                    list_lines = []
                    for position, sentence in enumerate(spec["sentences"]):
                        input_path = temporary_root / f"sentence-{position}.m4a"
                        result = synthesize_reader_tts(sentence["text"], config)
                        source_path = result.get("path")
                        if source_path and len(spec["sentences"]) == 1:
                            indexed = index_single_sentence_tts_pack(
                                book_id, chapter, spec, profile_key,
                            )
                            if indexed:
                                if prune_cache:
                                    maybe_prune_tts_pack_cache()
                                return indexed
                        if source_path:
                            with TTS_CACHE_LOCK:
                                shutil.copyfile(source_path, input_path)
                        else:
                            write_private_bytes_atomic(input_path, result.get("data", b""))
                        duration = tts_audio_duration(input_path)
                        segments.append({
                            "index": int(sentence["index"]),
                            "start": round(offset, 3),
                            "end": round(offset + duration, 3),
                            "text": sentence["text"],
                        })
                        offset += duration
                        list_lines.append(f"file '{input_path.name}'\n")
                    list_path = temporary_root / "concat.txt"
                    list_path.write_text("".join(list_lines), encoding="utf-8")
                    output_path = temporary_root / "pack.m4a"
                    copy_command = [
                        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "concat", "-safe", "1", "-i", list_path.name,
                        "-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart",
                        "-f", "ipod", output_path.name,
                    ]
                    encode_command = [
                        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "concat", "-safe", "1", "-i", list_path.name,
                        "-af", f"apad=whole_dur={TTS_PACK_PAD_SECONDS}",
                        "-vn", "-ac", "1", "-ar", "24000", "-c:a", "aac",
                        "-profile:a", "aac_low", "-b:a", "80k", "-movflags", "+faststart",
                        "-f", "ipod", output_path.name,
                    ]
                    command = encode_command if offset < TTS_PACK_MIN_SECONDS else copy_command
                    result = subprocess.run(
                        command,
                        cwd=temporary_root,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        timeout=90,
                        check=False,
                    )
                    if result.returncode != 0 and command is copy_command:
                        result = subprocess.run(
                            encode_command,
                            cwd=temporary_root,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            timeout=90,
                            check=False,
                        )
                    if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size <= 0:
                        detail = result.stderr.decode("utf-8", "replace").strip()[:300]
                        raise ValueError("AAC 播放包生成失败" + (f": {detail}" if detail else ""))
                    if output_path.stat().st_size > MAX_TTS_PACK_BYTES:
                        raise ValueError("AAC 播放包过大")
                    output_duration = tts_audio_duration(output_path)
                    if output_duration < TTS_PACK_MIN_SECONDS and command is copy_command:
                        result = subprocess.run(
                            encode_command,
                            cwd=temporary_root,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            timeout=90,
                            check=False,
                        )
                        if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size <= 0:
                            detail = result.stderr.decode("utf-8", "replace").strip()[:300]
                            raise ValueError("AAC 播放包补齐失败" + (f": {detail}" if detail else ""))
                        if output_path.stat().st_size > MAX_TTS_PACK_BYTES:
                            raise ValueError("AAC 播放包过大")
                        output_duration = tts_audio_duration(output_path)
                    if output_duration < TTS_PACK_MIN_SECONDS - 0.05:
                        raise ValueError("AAC 播放包实际时长不足")
                    if offset < TTS_PACK_MIN_SECONDS and segments:
                        segments[0]["start"] = 0.0
                        segments[-1]["end"] = round(output_duration, 3)
                    elif offset > 0 and segments:
                        scale = output_duration / offset
                        for segment in segments:
                            segment["start"] = round(segment["start"] * scale, 3)
                            segment["end"] = round(segment["end"] * scale, 3)
                        segments[0]["start"] = 0.0
                        segments[-1]["end"] = round(output_duration, 3)
                    output_size = output_path.stat().st_size
                    manifest = reader_tts_pack_manifest(
                        book_id,
                        chapter,
                        spec,
                        profile_key,
                        output_duration,
                        output_size,
                        segments,
                        audio_source="pack_cache",
                        cache_size_bytes=output_size,
                    )
                    with TTS_PACK_CACHE_LOCK:
                        write_private_bytes_atomic(audio_path, output_path.read_bytes())
                        write_json_atomic(manifest_path, manifest)
                        if prune_cache:
                            maybe_prune_tts_pack_cache()
                    invalidate_tts_cache_stats()
                    invalidate_tts_offline_status_snapshot(book_id, profile_key)
                    return manifest
            except FileNotFoundError as exc:
                raise ValueError("服务器未安装 ffmpeg 或 ffprobe，无法生成播放包") from exc
            except subprocess.TimeoutExpired as exc:
                raise ValueError("AAC 播放包生成超时") from exc


def request_mimo_tts(text, settings):
    audio_format = "wav"
    model = settings.get("model", "mimo-v2.5-tts")
    style_prompt = clean_single_line_value(settings.get("style_prompt", ""))
    messages = []
    if style_prompt:
        messages.append({"role": "user", "content": style_prompt})
    messages.append({"role": "assistant", "content": text})
    audio = {
        "format": audio_format,
        "voice": settings.get("voice_id", "mimo_default"),
    }
    body = {
        "model": model,
        "messages": messages,
        "audio": audio,
    }
    response = requests.post(
        settings["base_url"],
        headers={
            "api-key": settings["api_key"],
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=int(settings.get("timeout", 30)),
        allow_redirects=False,
    )
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        detail = response.text[:500] if response.text else str(exc)
        raise ValueError(f"MiMo TTS 请求失败：{detail}") from exc
    content_type = response.headers.get("Content-Type", "")
    if content_type.startswith("audio/"):
        if len(response.content) > MAX_TTS_AUDIO_BYTES:
            raise ValueError("MiMo TTS 返回的音频过大")
        return response.content
    payload = response.json()
    return decode_mimo_audio_payload(payload)


def prepare_reader_tts_request(text, config):
    settings = config["reader_tts"]
    if not settings.get("enabled"):
        raise ValueError("听书服务未启用")
    if not settings.get("api_key"):
        raise ValueError("请先配置 MiMo API Key")
    if not settings.get("voice_id"):
        raise ValueError("请先配置音色")
    text = clean_tts_text(text, int(settings.get("chunk_chars", 260)))
    if not text:
        raise ValueError("没有可朗读文本")
    audio_format = settings.get("format", "m4a")
    if audio_format not in TTS_AUDIO_FORMATS:
        audio_format = "m4a"
    cache_key = tts_cache_key(text, settings)
    cache_path = tts_cache_path(cache_key, audio_format)
    return settings, text, audio_format, cache_key, cache_path


def synthesize_reader_tts(text, config):
    total_started = time.perf_counter()
    settings, text, audio_format, cache_key, cache_path = prepare_reader_tts_request(text, config)
    with tts_cache_key_lock(cache_key):
        cache_started = time.perf_counter()
        if settings.get("cache_enabled", True):
            with TTS_CACHE_LOCK:
                cached_path = find_cached_tts(cache_path)
                if cached_path is not None:
                    cache_ms = (time.perf_counter() - cache_started) * 1000
                    return {
                        "path": cached_path,
                        "format": audio_format,
                        "cached": True,
                        "cache_key": cache_key,
                        "cache_ms": round(cache_ms, 2),
                        "generate_ms": 0.0,
                        "write_ms": 0.0,
                        "total_ms": round((time.perf_counter() - total_started) * 1000, 2),
                    }
        cache_ms = (time.perf_counter() - cache_started) * 1000
        generate_started = time.perf_counter()
        data = transcode_wav_to_aac(request_mimo_tts(text, settings))
        generate_ms = (time.perf_counter() - generate_started) * 1000
        write_ms = 0.0
        if settings.get("cache_enabled", True) and data:
            with TTS_CACHE_LOCK:
                ensure_private_directory(TTS_CACHE_DIR)
                write_started = time.perf_counter()
                try:
                    write_private_bytes_atomic(cache_path, data)
                    os.utime(cache_path, None)
                    prune_tts_cache()
                    invalidate_tts_cache_stats()
                    write_ms = (time.perf_counter() - write_started) * 1000
                    if cache_path.exists():
                        return {
                            "path": cache_path,
                            "format": audio_format,
                            "cached": False,
                            "cache_key": cache_key,
                            "cache_ms": round(cache_ms, 2),
                            "generate_ms": round(generate_ms, 2),
                            "write_ms": round(write_ms, 2),
                            "total_ms": round((time.perf_counter() - total_started) * 1000, 2),
                        }
                except OSError:
                    write_ms = (time.perf_counter() - write_started) * 1000
        return {
            "data": data,
            "format": audio_format,
            "cached": False,
            "cache_key": cache_key,
            "cache_ms": round(cache_ms, 2),
            "generate_ms": round(generate_ms, 2),
            "write_ms": round(write_ms, 2),
            "total_ms": round((time.perf_counter() - total_started) * 1000, 2),
        }


def read_meminfo():
    info = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            info[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError):
        return {}
    return info


def read_process_stat():
    stat = {}
    try:
        status = Path("/proc/self/status").read_text(encoding="utf-8")
        for line in status.splitlines():
            if line.startswith(("VmRSS:", "VmSize:", "Threads:")):
                key, value = line.split(":", 1)
                stat[key] = value.strip()
        parts = Path("/proc/self/stat").read_text(encoding="utf-8").split()
        ticks = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
        stat["cpu_seconds"] = (int(parts[13]) + int(parts[14])) / ticks
    except (OSError, ValueError, IndexError, KeyError):
        stat["cpu_seconds"] = 0.0
    return stat


def parse_kb_value(value):
    try:
        return int(value.split()[0]) * 1024
    except (AttributeError, ValueError, IndexError):
        return 0


def process_cpu_percent(cpu_seconds):
    now = time.time()
    previous_time = CPU_SAMPLE["time"]
    previous_cpu = CPU_SAMPLE["cpu"]
    CPU_SAMPLE["time"] = now
    CPU_SAMPLE["cpu"] = cpu_seconds
    elapsed = max(now - previous_time, 0.001)
    return max(0.0, (cpu_seconds - previous_cpu) / elapsed * 100)


def system_cpu_percent():
    try:
        values = [int(value) for value in Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0].split()[1:]]
    except (OSError, ValueError, IndexError):
        return 0.0
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    total = sum(values)
    previous_idle = SYSTEM_CPU_SAMPLE["idle"]
    previous_total = SYSTEM_CPU_SAMPLE["total"]
    SYSTEM_CPU_SAMPLE["idle"] = idle
    SYSTEM_CPU_SAMPLE["total"] = total
    total_delta = total - previous_total
    idle_delta = idle - previous_idle
    if total_delta <= 0 or previous_total == 0:
        return 0.0
    return round(max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100)), 2)


def system_status():
    mem = read_meminfo()
    proc = read_process_stat()
    disk = shutil.disk_usage(BASE_DIR)
    total_mem = mem.get("MemTotal", 0)
    available_mem = mem.get("MemAvailable", 0)
    used_mem = max(total_mem - available_mem, 0) if total_mem else 0
    process_rss = parse_kb_value(proc.get("VmRSS"))
    process_vms = parse_kb_value(proc.get("VmSize"))
    return {
        "pid": os.getpid(),
        "uptime_seconds": int(time.time() - PROCESS_START_TIME),
        "process": {
            "rss_bytes": process_rss,
            "vms_bytes": process_vms,
            "threads": int(proc.get("Threads", "0")),
            "cpu_percent": round(process_cpu_percent(proc.get("cpu_seconds", 0.0)), 2),
        },
        "system": {
            "load_avg": os.getloadavg() if hasattr(os, "getloadavg") else [0, 0, 0],
            "cpu_count": os.cpu_count() or 1,
            "cpu_percent": system_cpu_percent(),
            "memory_total_bytes": total_mem,
            "memory_used_bytes": used_mem,
            "memory_available_bytes": available_mem,
            "memory_used_percent": round(used_mem / total_mem * 100, 2) if total_mem else 0,
        },
        "disk": {
            "total_bytes": disk.total,
            "used_bytes": disk.used,
            "free_bytes": disk.free,
            "used_percent": round(disk.used / disk.total * 100, 2) if disk.total else 0,
        },
        "cache": {
            "entries": translation_cache_entries(),
            "limit": CACHE_LIMIT,
            "max_text_chars": CACHE_MAX_TEXT_CHARS,
            "persistent": True,
        },
        "tts_cache": tts_cache_stats(),
    }


def validate_runtime_security():
    if hasattr(os, "geteuid") and os.geteuid() == 0 and not env_flag("ALLOW_ROOT_RUN", False):
        raise RuntimeError("拒绝以 root 运行：请改用低权限用户，或显式设置 ALLOW_ROOT_RUN=true 承担风险")
    password = clean_single_line_value(load_config().get("app_password", ""))
    if password.lower() in UNSAFE_APP_PASSWORDS or len(password) < 12:
        raise RuntimeError("拒绝启动：请先把 APP_PASSWORD 设置为至少 12 位的非默认密码")


def running_under_gunicorn():
    executable = Path(sys.argv[0]).name.lower()
    return "gunicorn" in executable or "gunicorn" in sys.modules


def restart_process_later(delay=0.35):
    def restart():
        time.sleep(delay)
        try:
            if running_under_gunicorn():
                # Let the Gunicorn master replace this worker with the same command.
                app.logger.info("restart worker exiting pid=%s", os.getpid())
                os._exit(0)
            replacement = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import os, sys, time; time.sleep(1.0); os.execv(sys.executable, [sys.executable, sys.argv[1]])",
                    str(BASE_DIR / "app.py"),
                ],
                cwd=BASE_DIR,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            app.logger.info(
                "restart replacement launched old_pid=%s replacement_pid=%s",
                os.getpid(),
                replacement.pid,
            )
            os._exit(0)
        except Exception as exc:
            app.logger.error("restart failed error=%s", exc)

    threading.Thread(target=restart, daemon=True).start()


def fetch_deepseek_balance(config, force=False):
    settings = config["deepseek"]
    if not settings.get("api_key"):
        raise RuntimeError("DeepSeek API Key 未配置")
    now = time.time()
    cached = DEEPSEEK_BALANCE_CACHE["data"]
    if not force and cached and now - DEEPSEEK_BALANCE_CACHE["time"] < DEEPSEEK_BALANCE_TTL:
        return cached
    if not force and now - DEEPSEEK_BALANCE_CACHE["attempt_time"] < DEEPSEEK_BALANCE_RETRY_INTERVAL:
        if cached:
            return cached
        raise RuntimeError("DeepSeek 余额查询过于频繁，请稍后再试")
    DEEPSEEK_BALANCE_CACHE["attempt_time"] = now
    response = requests.get(
        f"{settings['base_url'].rstrip('/')}/user/balance",
        headers={"Authorization": f"Bearer {settings['api_key']}"},
        timeout=min(int(settings.get("timeout", 45)), 20),
        allow_redirects=False,
    )
    response.raise_for_status()
    data = response.json()
    balances = data.get("balance_infos") or []
    preferred = next((item for item in balances if item.get("currency") == "CNY"), None)
    preferred = preferred or (balances[0] if balances else {})
    result = {
        "available": bool(data.get("is_available")),
        "currency": preferred.get("currency", ""),
        "total_balance": preferred.get("total_balance", ""),
        "updated_at": int(now),
        "ttl": DEEPSEEK_BALANCE_TTL,
    }
    DEEPSEEK_BALANCE_CACHE["time"] = now
    DEEPSEEK_BALANCE_CACHE["data"] = result
    return result


def normalize_balance_payload(data, now, ttl):
    balances = data.get("balance_infos") or data.get("balances") or []
    preferred = {}
    if isinstance(balances, list) and balances:
        preferred = next((item for item in balances if item.get("currency") == "CNY"), None)
        preferred = preferred or balances[0]
    nested = data.get("data") if isinstance(data.get("data"), dict) else {}
    source = preferred if preferred else nested if nested else data
    currency = source.get("currency") or source.get("currency_code") or data.get("currency") or ""
    total = next((
        value for value in (
            source.get("total_balance"),
            source.get("balance"),
            source.get("available_balance"),
            source.get("available"),
            source.get("remaining"),
            source.get("amount"),
        ) if value not in (None, "") and not isinstance(value, bool)
    ), "")
    return {
        "available": bool(data.get("is_available", True)),
        "currency": currency,
        "total_balance": str(total) if total != "" else "",
        "updated_at": int(now),
        "ttl": ttl,
    }


class MimoBalanceError(RuntimeError):
    def __init__(self, message, code="temporary_failure"):
        super().__init__(message)
        self.code = code


def empty_mimo_balance_state():
    return {"version": 1, "cookies": {}, "balance": None, "auth_expired": False, "error": ""}


def load_mimo_balance_state():
    with MIMO_BALANCE_LOCK:
        try:
            state = json.loads(MIMO_BALANCE_STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty_mimo_balance_state()
        if not isinstance(state, dict):
            return empty_mimo_balance_state()
        balance = state.get("balance")
        if not isinstance(balance, dict):
            balance = None
        elif not balance.get("total_balance") or not balance.get("currency"):
            balance = None
        else:
            try:
                updated_at = float(balance.get("updated_at") or 0)
            except (TypeError, ValueError):
                updated_at = 0
            balance = {
                "total_balance": str(balance.get("total_balance", "")),
                "currency": clean_single_line_value(balance.get("currency", ""))[:20],
                "updated_at": updated_at,
            }
        raw_cookies = state.get("cookies")
        cookies = {}
        if isinstance(raw_cookies, dict):
            for name in MIMO_BALANCE_COOKIE_NAMES:
                cookie_value = clean_single_line_value(raw_cookies.get(name, ""))
                if cookie_value and len(cookie_value) <= 8192:
                    cookies[name] = cookie_value
        if MIMO_BALANCE_REQUIRED_COOKIE_NAMES.difference(cookies):
            cookies = {}
        return {
            "version": 1,
            "cookies": cookies,
            "balance": balance,
            "auth_expired": bool(state.get("auth_expired")),
            "error": clean_display_text(state.get("error", ""), 300),
        }


def save_mimo_balance_state(state):
    with MIMO_BALANCE_LOCK:
        ensure_private_directory(CONFIG_DIR)
        write_json_atomic(MIMO_BALANCE_STATE_FILE, state, indent=2)


def stored_mimo_balance_cookie():
    return format_mimo_balance_cookie(load_mimo_balance_state().get("cookies", {}))


def save_mimo_balance_cookie(value):
    cookies = parse_mimo_balance_cookie(value) if value else {}
    with MIMO_BALANCE_LOCK:
        state = load_mimo_balance_state()
        state["cookies"] = cookies
        state["auth_expired"] = False
        state["error"] = ""
        save_mimo_balance_state(state)
        MIMO_BALANCE_CACHE["data"] = None
        MIMO_BALANCE_CACHE["time"] = 0.0
        MIMO_BALANCE_CACHE["attempt_time"] = 0.0
    return format_mimo_balance_cookie(cookies)


def mimo_balance_snapshot(state=None):
    state = state or load_mimo_balance_state()
    balance = dict(state.get("balance") or {})
    balance.update({
        "auth_expired": bool(state.get("auth_expired")),
        "stale": bool(state.get("auth_expired")),
        "error": clean_display_text(state.get("error", ""), 300),
    })
    return balance


def mimo_balance_cookie_matches_state(state, cookie):
    current = format_mimo_balance_cookie(state.get("cookies", {}))
    return bool(current) and secrets.compare_digest(current, cookie)


def mark_mimo_balance_auth_expired(message, expected_cookie=""):
    with MIMO_BALANCE_LOCK:
        state = load_mimo_balance_state()
        if expected_cookie and not mimo_balance_cookie_matches_state(state, expected_cookie):
            raise MimoBalanceError("MiMo 余额 Cookie 已更新，已忽略旧查询结果", "cookie_changed")
        state["auth_expired"] = True
        state["error"] = clean_display_text(message, 300)
        save_mimo_balance_state(state)
        MIMO_BALANCE_CACHE["data"] = None
        MIMO_BALANCE_CACHE["time"] = 0.0
    return mimo_balance_snapshot(state)


def save_successful_mimo_balance(result, expected_cookie=""):
    with MIMO_BALANCE_LOCK:
        state = load_mimo_balance_state()
        if expected_cookie and not mimo_balance_cookie_matches_state(state, expected_cookie):
            raise MimoBalanceError("MiMo 余额 Cookie 已更新，已忽略旧查询结果", "cookie_changed")
        state["balance"] = {
            "total_balance": str(result.get("total_balance", "")),
            "currency": clean_single_line_value(result.get("currency", ""))[:20],
            "updated_at": float(result.get("updated_at") or time.time()),
        }
        state["auth_expired"] = False
        state["error"] = ""
        save_mimo_balance_state(state)
        snapshot = mimo_balance_snapshot(state)
        MIMO_BALANCE_CACHE["time"] = time.time()
        MIMO_BALANCE_CACHE["data"] = snapshot
    return snapshot


def mimo_balance_error_message(response):
    if response.status_code == 404:
        return "MiMo 余额接口地址不可用，请检查余额接口配置"
    if response.status_code == 429:
        return "MiMo 余额接口请求过于频繁，请稍后再试"
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    message = clean_display_text(payload.get("message") or payload.get("msg") or response.reason or "未知错误", 300)
    return f"MiMo 余额查询失败：HTTP {response.status_code} {message}"


def fetch_mimo_balance(config, force=False):
    settings = config["reader_tts"]
    if not settings.get("api_key"):
        raise RuntimeError("MiMo API Key 未配置")
    balance_url = validate_mimo_balance_url(
        settings.get("balance_url", DEFAULT_CONFIG["reader_tts"]["balance_url"]),
        DEFAULT_CONFIG["reader_tts"]["balance_url"],
    )
    now = time.time()
    state = load_mimo_balance_state()
    if state.get("auth_expired") and not force:
        return mimo_balance_snapshot(state)
    with MIMO_BALANCE_LOCK:
        cached = MIMO_BALANCE_CACHE["data"]
        if not force and cached and now - MIMO_BALANCE_CACHE["time"] < MIMO_BALANCE_TTL:
            return cached
        if not force and now - MIMO_BALANCE_CACHE["attempt_time"] < MIMO_BALANCE_RETRY_INTERVAL:
            raise MimoBalanceError("MiMo 余额查询过于频繁，请稍后再试")
        MIMO_BALANCE_CACHE["attempt_time"] = now
    balance_cookie = normalize_mimo_balance_cookie(settings.get("balance_cookie", ""), strict=False)
    if not balance_cookie:
        raise MimoBalanceError(
            "MiMo 余额 Cookie 未配置，请在听书配置里填写 platform.xiaomimimo.com 的 Cookie",
            "missing_cookie",
        )
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": f"Mozilla/5.0 TransTools/{APP_VERSION}",
        "Cookie": balance_cookie,
        "Origin": "https://platform.xiaomimimo.com",
        "Referer": "https://platform.xiaomimimo.com/",
    }
    try:
        response = requests.get(
            balance_url,
            headers=headers,
            timeout=min(int(settings.get("timeout", 30)), 20),
            allow_redirects=False,
        )
    except requests.Timeout as exc:
        raise MimoBalanceError("MiMo 余额查询超时，请检查服务器到小米平台的网络") from exc
    except requests.RequestException as exc:
        raise MimoBalanceError(f"MiMo 余额查询网络错误：{exc}") from exc
    if response.status_code in {301, 302, 303, 307, 308, 401, 403}:
        return mark_mimo_balance_auth_expired("MiMo 余额 Cookie 已过期，请更新 Cookie", balance_cookie)
    if not response.ok:
        message = mimo_balance_error_message(response)
        auth_markers = ("login", "cookie", "auth", "登录", "登陆", "未认证", "凭证", "会话")
        if response.status_code in {400, 419} and any(marker in message.lower() for marker in auth_markers):
            return mark_mimo_balance_auth_expired("MiMo 余额 Cookie 已过期，请更新 Cookie", balance_cookie)
        raise MimoBalanceError(message)
    if "text/html" in response.headers.get("Content-Type", "").lower():
        return mark_mimo_balance_auth_expired("MiMo 余额 Cookie 已过期，请更新 Cookie", balance_cookie)
    try:
        payload = response.json()
    except ValueError as exc:
        raise MimoBalanceError("MiMo 余额接口返回内容不是 JSON") from exc
    if payload.get("code") not in (None, 0, "0"):
        message = payload.get("message") or payload.get("msg") or "未知错误"
        normalized_message = str(message).lower()
        auth_markers = ("login", "cookie", "auth", "登录", "登陆", "未认证", "凭证", "会话")
        if str(payload.get("code")) in {"401", "403"} or any(marker in normalized_message for marker in auth_markers):
            return mark_mimo_balance_auth_expired("MiMo 余额 Cookie 已过期，请更新 Cookie", balance_cookie)
        raise MimoBalanceError(f"MiMo 余额查询失败：{message}")
    result = normalize_balance_payload(payload, now, MIMO_BALANCE_TTL)
    if not result.get("total_balance") or not result.get("currency"):
        raise MimoBalanceError("MiMo 余额接口返回数据不完整，请稍后重试")
    result = save_successful_mimo_balance(result, balance_cookie)
    return result


def mimo_balance_http_status(error):
    if isinstance(error, MimoBalanceError) and error.code == "missing_cookie":
        return 400
    message = str(error)
    if "过于频繁" in message:
        return 429
    if "Cookie" in message or "未配置" in message or "接口地址" in message or "返回数据不完整" in message:
        return 400
    return 502


def deepseek_system_prompt(style):
    return (
        "You are a precise translation engine. "
        "Translate the complete source text. "
        "Do not omit, summarize, deduplicate, rewrite as an abstract, or add commentary. "
        "Translate every paragraph and sentence in order. "
        "Preserve numbering, labels such as Q/A markers, figure/table references, units, dates, URLs, and technical terms. "
        + style["prompt"]
    )


def deepseek_chat(settings, messages):
    body = {
        "model": settings["model"],
        "messages": messages,
        "temperature": settings["temperature"],
        "stream": False,
    }
    if settings.get("thinking") in {"enabled", "disabled"}:
        body["thinking"] = {"type": settings["thinking"]}
    if settings.get("reasoning_effort"):
        body["reasoning_effort"] = settings["reasoning_effort"]
    response = requests.post(
        f"{settings['base_url'].rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=settings["timeout"],
        allow_redirects=False,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


def strip_json_fence(value):
    text = str(value or "").strip()
    match = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.S | re.I)
    return match.group(1).strip() if match else text


def parse_deepseek_translation_list(value, expected_count):
    text = strip_json_fence(value)
    try:
        payload = json.loads(text)
    except ValueError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            payload = json.loads(text[start:end + 1])
        except ValueError:
            return None
    translations = payload.get("translations") if isinstance(payload, dict) else payload
    if not isinstance(translations, list) or len(translations) != expected_count:
        return None
    cleaned = [normalize_translation_segment(item) for item in translations]
    return cleaned if all(cleaned) else None


def translate_deepseek_segments_batch(segments, source, target, settings, style):
    source_label = "auto-detected language" if source == "auto" else source
    if len(segments) == 1:
        user_prompt = (
            f"Source language: {source_label}\n"
            f"Target language: {target}\n\n"
            "Translate this single paragraph. Return only the translated paragraph, with no blank lines:\n\n"
            f"{segments[0]}"
        )
        raw = deepseek_chat(settings, [
            {"role": "system", "content": deepseek_system_prompt(style)},
            {"role": "user", "content": user_prompt},
        ])
        translated = normalize_translation_segment(raw)
        if not translated:
            raise RuntimeError("DeepSeek 返回了空翻译")
        return [translated]
    user_prompt = (
        f"Source language: {source_label}\n"
        f"Target language: {target}\n\n"
        "Translate each item in the JSON array independently and completely. "
        "Keep the same item count and order. "
        "Return valid JSON only, exactly in this shape: {\"translations\":[\"...\"]}. "
        "Each translated item must be a single paragraph with no blank lines.\n\n"
        + json.dumps({"segments": segments}, ensure_ascii=False)
    )
    raw = deepseek_chat(settings, [
        {"role": "system", "content": deepseek_system_prompt(style)},
        {"role": "user", "content": user_prompt},
    ])
    translations = parse_deepseek_translation_list(raw, len(segments))
    if translations is None:
        translations = []
        for segment in segments:
            translations.extend(translate_deepseek_segments_batch([segment], source, target, settings, style))
    return translations


def chunk_deepseek_segments(segments):
    batch = []
    batch_chars = 0
    for segment in segments:
        segment_chars = len(segment)
        if batch and (
            len(batch) >= DEEPSEEK_BATCH_MAX_SEGMENTS
            or batch_chars + segment_chars > DEEPSEEK_BATCH_MAX_CHARS
        ):
            yield batch
            batch = []
            batch_chars = 0
        batch.append(segment)
        batch_chars += segment_chars
    if batch:
        yield batch


def translate_deepseek(text, source, target, config):
    settings = config["deepseek"]
    if not settings.get("api_key"):
        raise RuntimeError("DeepSeek API Key 未配置")
    style = DEEPSEEK_STYLES.get(settings.get("style"), DEEPSEEK_STYLES["default"])
    parts = split_translation_lines(text)
    translated_by_segment = {}
    segment_keys = {}
    uncached_segments = []
    all_cached = True
    for part in parts:
        segment = part.strip()
        if not segment or "\n" in part:
            continue
        if segment in translated_by_segment or segment in segment_keys:
            continue
        cache_key = cache_key_for_deepseek(segment, source, target, settings)
        segment_keys[segment] = cache_key
        cached = get_cached_translation(cache_key)
        if cached is None:
            uncached_segments.append(segment)
            all_cached = False
            continue
        normalized_cached = normalize_translation_segment(cached)
        if normalized_cached != cached:
            set_cached_translation(cache_key, normalized_cached)
        translated_by_segment[segment] = normalized_cached
    for batch in chunk_deepseek_segments(uncached_segments):
        translations = translate_deepseek_segments_batch(batch, source, target, settings, style)
        for segment, translated in zip(batch, translations):
            translated_by_segment[segment] = translated
            set_cached_translation(segment_keys[segment], translated)
    output_parts = []
    for part in parts:
        if "\n" in part:
            output_parts.append(part)
            continue
        segment = part.strip()
        if not segment:
            output_parts.append(part)
            continue
        leading = part[:len(part) - len(part.lstrip(" \t"))]
        trailing = part[len(part.rstrip(" \t")):]
        output_parts.append(f"{leading}{translated_by_segment.get(segment, segment)}{trailing}")
    return "".join(output_parts), all_cached


def google_language_code(code):
    return "zh-CN" if code == "zh" else code


def translate_google(text, source, target, config):
    settings = config["google"]
    try:
        response = requests.get(
            settings["endpoint"],
            params={
                "client": "dict-chrome-ex",
                "sl": google_language_code(source),
                "tl": google_language_code(target),
                "q": text,
            },
            headers={
                "Accept": "application/json, text/plain, */*",
                "User-Agent": f"Mozilla/5.0 TransTools/{APP_VERSION}",
            },
            timeout=max(5, min(int(settings.get("timeout", 25)), 120)),
            allow_redirects=False,
        )
    except requests.Timeout as exc:
        raise RuntimeError("服务器请求谷歌翻译超时") from exc
    except requests.RequestException as exc:
        raise RuntimeError("服务器无法连接谷歌翻译") from exc
    if response.status_code == 429:
        raise RuntimeError("服务器访问谷歌翻译受到限流")
    if not response.ok:
        raise RuntimeError(f"谷歌翻译返回状态 {response.status_code}")
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("谷歌翻译返回内容不是 JSON") from exc
    translated = ""
    detected_source = ""
    if isinstance(data, list) and data and isinstance(data[0], list):
        first = data[0]
        if first and isinstance(first[0], str):
            translated = first[0].strip()
            detected_source = first[1] if len(first) > 1 and isinstance(first[1], str) else ""
        else:
            translated = "".join(
                str(part[0]) for part in first
                if isinstance(part, list) and part and part[0] is not None
            ).strip()
            detected_source = data[2] if len(data) > 2 and isinstance(data[2], str) else ""
    if not translated:
        raise RuntimeError("谷歌翻译未返回结果")
    return translated, detected_source


ENGINES = {
    "deepseek": "DeepSeek",
    "google": "谷歌翻译",
}

LOGIN_TARGETS = {
    "translate": "translate_page",
    "reader": "reader_page",
}


@app.route("/")
def index():
    if not require_auth():
        return redirect(url_for("login"))
    schedule_tts_cache_stats_refresh()
    return render_template("home.html")


@app.route("/translate")
def translate_page():
    if not require_auth():
        return redirect(url_for("login"))
    return render_template("index.html")


@app.route("/reader")
def reader_page():
    if not require_auth():
        return redirect(url_for("login"))
    schedule_tts_cache_stats_refresh()
    return render_template("reader.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if require_auth():
        return redirect(url_for("index"))
    error = ""
    config = load_config()
    if request.method == "POST":
        password = request.form.get("password", "")
        target = request.form.get("target") if request.form.get("target") in LOGIN_TARGETS else "translate"
        ip = client_ip()
        if login_is_limited(ip):
            app.logger.warning("login limited ip=%s", ip)
            error = "尝试次数过多，请稍后再试"
            return render_template("login.html", error=error), 429
        if secrets.compare_digest(password, config["app_password"]):
            session.permanent = True
            session["authenticated"] = True
            session["auth_version"] = authentication_version(config["app_password"])
            clear_login_failures(ip)
            if target == "reader":
                schedule_tts_cache_stats_refresh()
            app.logger.info("login success ip=%s", ip)
            return redirect(url_for(LOGIN_TARGETS[target]))
        record_login_failure(ip)
        app.logger.warning("login failed ip=%s", ip)
        error = "密码不正确"
    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
def logout():
    app.logger.info("logout ip=%s", request.remote_addr)
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/books")
def api_books():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"books": load_book_index_or_rebuild(), "supported": sorted(SUPPORTED_BOOK_EXTENSIONS)})


@app.route("/api/book-imports")
def api_book_imports():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    with BOOK_IMPORT_LOCK:
        cleanup_import_jobs_locked()
        jobs = [public_import_job(job) for job in BOOK_IMPORT_JOBS.values()]
        return jsonify({"jobs": jobs, "active": active_import_count_locked(), "limit": MAX_ACTIVE_BOOK_IMPORTS})


@app.route("/api/reader/tts-config")
def api_reader_tts_config():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"config": public_reader_tts_config(load_config())})


@app.route("/api/reader/tts-config", methods=["PUT"])
def api_reader_tts_config_update():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        config = load_config()
        updated = update_reader_tts_config(config, request_json_object())
        save_config(updated)
        app.logger.info("reader tts config updated ip=%s", request.remote_addr)
        return jsonify({"ok": True, "config": public_reader_tts_config(updated)})
    except Exception as exc:
        app.logger.warning("reader tts config failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/reader/mimo-balance")
def api_reader_mimo_balance():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    config = load_config()
    try:
        force = request.args.get("force", "").lower() in {"1", "true", "yes"}
        balance = fetch_mimo_balance(config, force=force)
        return jsonify({"ok": True, "balance": balance})
    except Exception as exc:
        app.logger.warning("mimo balance failed ip=%s error=%s", request.remote_addr, exc)
        code = exc.code if isinstance(exc, MimoBalanceError) else "temporary_failure"
        return jsonify({"error": str(exc), "code": code, "balance": mimo_balance_snapshot()}), mimo_balance_http_status(exc)


@app.route("/api/reader/tts-pack", methods=["POST"])
def api_reader_tts_pack():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        started = time.perf_counter()
        payload = request_json_object()
        book_id = str(payload.get("book_id") or "")
        chapter_index = int(payload.get("chapter_index"))
        sentence_index = int(payload.get("sentence_index"))
        config = load_config()
        settings = config["reader_tts"]
        if not settings.get("enabled") or not settings.get("api_key"):
            raise ValueError("请先启用并配置听书服务")
        book = read_book_record(book_id)
        chapter = tts_offline_chapter_data(book, chapter_index, settings)
        specs = tts_pack_specs(chapter, settings)
        spec_position = next((
            position for position, item in enumerate(specs)
            if item["start_sentence_index"] <= sentence_index <= item["end_sentence_index"]
        ), None)
        if spec_position is None:
            raise ValueError("当前句没有可用播放包")
        spec = specs[spec_position]
        manifest = build_reader_tts_pack(book_id, chapter, spec, config)
        app.logger.info(
            "reader tts pack ready ip=%s book=%s chapter=%s sentence=%s kind=%s elapsed=%.3fs",
            request.remote_addr,
            book_id,
            chapter_index,
            sentence_index,
            manifest.get("kind", "chapter"),
            time.perf_counter() - started,
        )
        return jsonify(public_tts_pack_manifest(
            manifest,
            url_for("api_reader_tts_pack_audio", pack_key=manifest["pack_key"]),
            specs[spec_position + 1:],
        ))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except (TypeError, ValueError, IndexError) as exc:
        app.logger.warning("reader tts pack failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("reader tts pack failed ip=%s", request.remote_addr)
        return jsonify({"error": str(exc)}), 500


@app.route("/api/reader/tts-packs/<pack_key>")
def api_reader_tts_pack_audio(pack_key):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    if not re.fullmatch(r"[0-9a-f]{64}", pack_key):
        return jsonify({"error": "播放包缓存键无效"}), 400
    manifest = load_tts_pack_manifest(pack_key)
    if not manifest:
        return jsonify({"error": "播放包不存在，请重新生成"}), 404
    current_profile = tts_offline_profile_key(load_config()["reader_tts"])
    if manifest.get("profile_key") != current_profile:
        return jsonify({"error": "听书配置已变化，请重新生成播放包"}), 409
    touch_tts_pack_cache(pack_key, manifest)
    audio_path = tts_pack_audio_path(manifest)
    response = send_file(
        audio_path,
        mimetype="audio/mp4",
        download_name=f"{pack_key}.m4a",
        conditional=True,
        max_age=0,
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.route("/api/books/<book_id>/tts-offline")
def api_book_tts_offline_status(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book = read_book_record(book_id)
        active_job = active_tts_offline_job_for_book(book_id)
        result, timing = tts_offline_book_status(
            book,
            load_config()["reader_tts"],
            use_snapshot=active_job is None,
        )
        result["active_job"] = active_job
        app.logger.info(
            "tts offline status ready ip=%s book=%s chapters=%s snapshot=%s "
            "sentence_index=%.3fs refs=%.3fs validation=%.3fs snapshot_read=%.3fs total=%.3fs",
            request.remote_addr,
            book_id,
            len(result["chapters"]),
            "hit" if timing["snapshot_hit"] else "miss",
            timing["sentence_index_seconds"],
            timing["refs_seconds"],
            timing["chapters_seconds"],
            timing["snapshot_seconds"],
            timing["total_seconds"],
        )
        return jsonify(result)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/tts-offline/timing", methods=["POST"])
def api_book_tts_offline_timing(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()

    def milliseconds(name):
        try:
            return max(0.0, min(float(payload.get(name, 0)), 180_000.0))
        except (TypeError, ValueError):
            return 0.0

    try:
        local_packs = max(0, min(int(payload.get("local_packs", 0) or 0), 1_000_000))
    except (TypeError, ValueError):
        local_packs = 0
    app.logger.info(
        "tts offline client timing ip=%s book=%s server=%.1fms local=%.1fms "
        "db_open=%.1fms index=%.1fms metadata=%.1fms storage=%.1fms total=%.1fms local_packs=%s",
        request.remote_addr,
        clean_display_text(book_id, 64),
        milliseconds("server_ms"),
        milliseconds("local_ms"),
        milliseconds("db_open_ms"),
        milliseconds("index_ms"),
        milliseconds("metadata_ms"),
        milliseconds("storage_ms"),
        milliseconds("total_ms"),
        local_packs,
    )
    return jsonify({"ok": True})


@app.route("/api/books/<book_id>/tts-offline", methods=["POST"])
def api_book_tts_offline_create(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        settings = load_config()["reader_tts"]
        if not settings.get("enabled"):
            raise ValueError("请先启用听书服务")
        if not settings.get("api_key"):
            raise ValueError("请先配置 MiMo API Key")
        payload = request_json_object()
        requested = payload.get("chapters")
        if not isinstance(requested, list) or not requested:
            raise ValueError("请选择需要缓存的章节")
        book = read_book_record(book_id)
        valid_indexes = {int(chapter.get("index", index)) for index, chapter in enumerate(book.get("chapters", []))}
        requested_indexes = sorted({int(index) for index in requested if int(index) in valid_indexes})
        if not requested_indexes:
            raise ValueError("没有有效的章节")
        if len(requested_indexes) > TTS_OFFLINE_MAX_CHAPTERS:
            raise ValueError(f"单次最多缓存 {TTS_OFFLINE_MAX_CHAPTERS} 章")

        profile_key = tts_offline_profile_key(settings)
        refs_by_chapter = load_tts_offline_refs_by_chapter(book_id, profile_key)
        chapter_records = {
            int(chapter.get("index", index)): (index, chapter)
            for index, chapter in enumerate(book.get("chapters", []))
        }
        chapter_indexes = []
        for chapter_index in requested_indexes:
            fallback_index, chapter_record = chapter_records[chapter_index]
            chapter_status = tts_offline_chapter_status(
                book,
                chapter_record,
                fallback_index,
                settings,
                profile_key,
                refs_by_chapter.get(chapter_index, []),
                inspect=True,
            )
            sentences_incomplete = (
                int(chapter_status["server_sentences"])
                < int(chapter_status["total_sentences"])
            )
            packs_incomplete = (
                int(chapter_status["server_packs"])
                < int(chapter_status["total_packs"])
            )
            if sentences_incomplete or packs_incomplete:
                chapter_indexes.append(chapter_index)
        if not chapter_indexes:
            return jsonify({
                "ok": True,
                "complete": True,
                "chapter_indexes": requested_indexes,
                "message": "所选章节已完整固定",
            })

        with TTS_OFFLINE_JOB_LOCK:
            active = next(
                (job for job in TTS_OFFLINE_JOBS.values() if job.get("status") in {"queued", "running"}),
                None,
            )
            if active:
                return jsonify({"error": "已有离线缓存任务正在运行", "job": public_tts_offline_job(active)}), 429
            job_id = uuid.uuid4().hex
            now = time.time()
            TTS_OFFLINE_JOBS[job_id] = {
                "id": job_id,
                "book_id": book_id,
                "chapter_indexes": chapter_indexes,
                "status": "queued",
                "message": "等待生成并固定服务器缓存",
                "progress": 0,
                "total_sentences": 0,
                "completed_sentences": 0,
                "failed_sentences": 0,
                "cached_sentences": 0,
                "generated_sentences": 0,
                "total_packs": 0,
                "completed_packs": 0,
                "failed_packs": 0,
                "size_bytes": 0,
                "error": "",
                "cancel_requested": False,
                "created_at": now,
                "updated_at": now,
            }
            job = public_tts_offline_job(TTS_OFFLINE_JOBS[job_id])
        worker = threading.Thread(
            target=process_tts_offline_job,
            args=(job_id, book_id, chapter_indexes),
            daemon=True,
        )
        worker.start()
        app.logger.info("tts offline job created ip=%s book=%s chapters=%s", request.remote_addr, book_id, len(chapter_indexes))
        return jsonify({"ok": True, "job": job}), 202
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/reader/tts-offline/jobs/<job_id>")
def api_reader_tts_offline_job(job_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    with TTS_OFFLINE_JOB_LOCK:
        cleanup_tts_offline_jobs_locked()
        job = TTS_OFFLINE_JOBS.get(job_id)
        if not job:
            return jsonify({"error": "离线缓存任务不存在或已过期"}), 404
        return jsonify({"job": public_tts_offline_job(job)})


@app.route("/api/reader/tts-offline/jobs/<job_id>/cancel", methods=["POST"])
def api_reader_tts_offline_job_cancel(job_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    with TTS_OFFLINE_JOB_LOCK:
        cleanup_tts_offline_jobs_locked()
        job = TTS_OFFLINE_JOBS.get(job_id)
        if not job:
            return jsonify({"error": "离线缓存任务不存在或已过期"}), 404
        if job.get("status") in {"queued", "running"}:
            job["cancel_requested"] = True
            job["message"] = "正在取消，当前处理完成后停止"
            job["updated_at"] = time.time()
        return jsonify({"ok": True, "job": public_tts_offline_job(job)})

@app.route("/api/books/<book_id>/tts-offline/chapters/<int:chapter_index>")
def api_book_tts_offline_manifest(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(tts_offline_chapter_manifest(read_book_record(book_id), chapter_index, load_config()))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/tts-offline/chapters/<int:chapter_index>/packs/<pack_key>")
def api_book_tts_offline_pack(book_id, chapter_index, pack_key):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    if not re.fullmatch(r"[0-9a-f]{64}", pack_key):
        return jsonify({"error": "播放包缓存键无效"}), 400
    try:
        config = load_config()
        settings = config["reader_tts"]
        profile_key = tts_offline_profile_key(settings)
        book = read_book_record(book_id)
        chapter = tts_offline_chapter_data(book, chapter_index, settings)
        matched = next((item for item in tts_pack_specs(chapter, settings) if item["pack_key"] == pack_key), None)
        manifest = (
            valid_tts_offline_pack(book_id, chapter, matched, profile_key)
            if matched else None
        )
        if not manifest:
            return jsonify({"error": "离线播放包不存在或未完整固定"}), 404
        touch_tts_pack_cache(pack_key, manifest)
        audio_path = tts_pack_audio_path(manifest)
        response = send_file(
            audio_path,
            mimetype="audio/mp4",
            download_name=f"{pack_key}.m4a",
            conditional=True,
            max_age=0,
        )
        response.headers["Cache-Control"] = "private, no-store"
        return response
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/tts-offline", methods=["DELETE"])
def api_book_tts_offline_delete(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        with TTS_OFFLINE_JOB_LOCK:
            active = active_tts_offline_job_for_book(book_id)
            if active:
                return jsonify({
                    "error": "该书正在生成离线缓存，请等待任务完成",
                    "job": active,
                }), 409
            book = read_book_record(book_id)
            payload = request_json_object()
            requested = payload.get("chapters")
            if not isinstance(requested, list) or not requested:
                raise ValueError("请选择需要取消固定的章节")
            valid_indexes = {int(chapter.get("index", index)) for index, chapter in enumerate(book.get("chapters", []))}
            chapter_indexes = sorted({int(index) for index in requested if int(index) in valid_indexes})
            if not chapter_indexes:
                raise ValueError("没有有效的章节")
            removed = delete_tts_offline_refs(
                book_id,
                chapter_indexes,
                tts_offline_profile_key(load_config()["reader_tts"]),
            )
        app.logger.info(
            "tts offline unpinned ip=%s book=%s entries=%s bytes=%s",
            request.remote_addr,
            book_id,
            removed["entries"],
            removed["size_bytes"],
        )
        return jsonify({"ok": True, **removed})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


def process_book_import_job(job_id, book_id, original_path, original_name, safe_name, suffix, remote_addr):
    job_started = time.perf_counter()
    update_import_job(job_id, status="parsing", message="正在解析书本", progress=35)
    target_dir = book_dir(book_id)
    try:
        if suffix == ".epub" and unwrap_nested_epub_zip(original_path):
            app.logger.info("nested epub zip unwrapped ip=%s name=%s", remote_addr, original_name)
        parse_started = time.perf_counter()
        parsed = parse_book_file(original_path, original_name)
        parse_seconds = time.perf_counter() - parse_started
        update_import_job(job_id, status="parsing", message="正在保存书籍", progress=76)
        cover_name = save_epub_cover(original_path, book_id, parsed.get("cover")) if suffix == ".epub" else ""
        now = int(time.time())
        book = {
            "id": book_id,
            "title": parsed["title"],
            "author": parsed["author"],
            "author_manually_set": False,
            "format": suffix.lstrip("."),
            "original_name": original_name,
            "stored_name": safe_name,
            "cover_name": cover_name,
            "lazy": bool(parsed.get("lazy")),
            "metadata_version": CHAPTER_CACHE_VERSION,
            "created_at": now,
            "updated_at": now,
            "last_opened_at": now,
            "progress": {"chapter": 0, "sentence": 0},
            "chapters": parsed["chapters"],
        }
        write_started = time.perf_counter()
        write_book_record(book)
        write_seconds = time.perf_counter() - write_started
        summary = book_summary(book)
        update_import_job(job_id, status="parsing", message="正在更新书架", progress=92)
        index_started = time.perf_counter()
        upsert_book_index(book)
        index_seconds = time.perf_counter() - index_started
        update_import_job(job_id, status="done", message="导入完成", progress=100, book=summary)
        app.logger.info(
            "book uploaded ip=%s id=%s name=%s size=%s parse=%.3fs write=%.3fs index=%.3fs total=%.3fs chapters=%s",
            remote_addr,
            book_id,
            original_name,
            original_path.stat().st_size,
            parse_seconds,
            write_seconds,
            index_seconds,
            time.perf_counter() - job_started,
            len(parsed["chapters"]),
        )
    except Exception as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        update_import_job(job_id, status="error", message="导入失败", progress=100, error=str(exc))
        app.logger.warning("book upload failed ip=%s name=%s error=%s", remote_addr, original_name, exc)


@app.route("/api/books", methods=["POST"])
def api_books_upload():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    with BOOK_IMPORT_LOCK:
        cleanup_import_jobs_locked()
        if active_import_count_locked() >= MAX_ACTIVE_BOOK_IMPORTS:
            return jsonify({"error": "已有 2 本书正在导入，请等待至少一本完成"}), 429
    upload = request.files.get("book")
    if not upload or not upload.filename:
        return jsonify({"error": "请选择要导入的书籍文件"}), 400
    original_name = clean_single_line_value(upload.filename)
    suffix = detect_book_suffix(original_name)
    if suffix not in SUPPORTED_BOOK_EXTENSIONS:
        app.logger.warning("book upload unsupported ip=%s name=%s suffix=%s", request.remote_addr, original_name, suffix)
        return jsonify({"error": "当前支持 TXT、EPUB、PDF"}), 400
    if request.content_length and request.content_length > MAX_BOOK_UPLOAD_BYTES:
        return jsonify({"error": "书籍文件过大，最大 50MB"}), 413
    book_id = uuid.uuid4().hex
    target_dir = book_dir(book_id)
    target_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(target_dir, 0o700)
    safe_name = secure_filename(original_name)
    if not safe_name or Path(safe_name).suffix.lower() != suffix:
        safe_stem = Path(safe_name).stem or "book"
        if safe_stem.lower().endswith(".epub"):
            safe_stem = safe_stem[:-5] or "book"
        safe_name = f"{safe_stem}{suffix}"
    original_path = target_dir / safe_name
    job_id = uuid.uuid4().hex
    now = time.time()
    with BOOK_IMPORT_LOCK:
        cleanup_import_jobs_locked()
        if active_import_count_locked() >= MAX_ACTIVE_BOOK_IMPORTS:
            shutil.rmtree(target_dir, ignore_errors=True)
            return jsonify({"error": "已有 2 本书正在导入，请等待至少一本完成"}), 429
        BOOK_IMPORT_JOBS[job_id] = {
            "id": job_id,
            "book_id": book_id,
            "name": original_name,
            "status": "uploading",
            "message": "正在上传",
            "progress": 0,
            "error": "",
            "book": None,
            "created_at": now,
            "updated_at": now,
        }
    try:
        save_started = time.perf_counter()
        upload.save(original_path)
        os.chmod(original_path, 0o600)
        save_seconds = time.perf_counter() - save_started
        if original_path.stat().st_size > MAX_BOOK_UPLOAD_BYTES:
            raise ValueError("书籍文件过大，最大 50MB")
        update_import_job(job_id, status="parsing", message="服务器已接收文件", progress=25)
        app.logger.info(
            "book upload received ip=%s id=%s name=%s size=%s save=%.3fs",
            request.remote_addr,
            book_id,
            original_name,
            original_path.stat().st_size,
            save_seconds,
        )
        worker = threading.Thread(
            target=process_book_import_job,
            args=(job_id, book_id, original_path, original_name, safe_name, suffix, request.remote_addr),
            daemon=True,
        )
        worker.start()
        with BOOK_IMPORT_LOCK:
            return jsonify({"ok": True, "job": public_import_job(BOOK_IMPORT_JOBS[job_id])}), 202
    except Exception as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        update_import_job(job_id, status="error", message="导入失败", progress=100, error=str(exc))
        app.logger.warning("book upload failed before parsing ip=%s name=%s error=%s", request.remote_addr, original_name, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>")
def api_book_detail(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book = read_book_record(book_id)
        needs_metadata_refresh = (
            book.get("format") == "epub"
            and book.get("metadata_version") != CHAPTER_CACHE_VERSION
        )
        if needs_metadata_refresh:
            with TTS_OFFLINE_JOB_LOCK:
                active = active_tts_offline_job_for_book(book_id)
                if active:
                    return jsonify({
                        "error": "该书正在生成离线缓存，请等待任务完成后重新打开",
                        "job": active,
                    }), 409
                book = refresh_epub_chapter_metadata(book)
        if request.args.get("inspect") != "1":
            now = int(time.time())
            book["last_opened_at"] = now
            book["updated_at"] = max(int(book.get("updated_at") or 0), now)
            write_book_record(book)
            upsert_book_index(book)
        return jsonify({"book": book_summary(book), "chapters": book_chapter_summaries(book)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 404


@app.route("/api/books/<book_id>", methods=["PATCH"])
def api_book_update(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()
    has_title = "title" in payload
    has_author = "author" in payload
    if not has_title and not has_author:
        return jsonify({"error": "没有可更新的书籍信息"}), 400
    title = clean_display_text(payload.get("title"), 160) if has_title else ""
    author = clean_display_text(payload.get("author"), 120) if has_author else ""
    if has_title and not title:
        return jsonify({"error": "书名不能为空"}), 400
    try:
        with READER_IO_LOCK:
            book = read_book_record(book_id)
            if has_title:
                book["title"] = title
            if has_author:
                book["author"] = author
                book["author_manually_set"] = True
            book["updated_at"] = int(time.time())
            write_book_record(book)
            upsert_book_index(book)
        app.logger.info(
            "book metadata updated ip=%s id=%s fields=%s",
            request.remote_addr,
            book_id,
            ",".join(key for key, present in (("title", has_title), ("author", has_author)) if present),
        )
        return jsonify({"ok": True, "book": book_summary(book)})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/reparse", methods=["POST"])
def api_book_reparse(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        with TTS_OFFLINE_JOB_LOCK:
            active = active_tts_offline_job_for_book(book_id)
            if active:
                return jsonify({
                    "error": "该书正在生成离线缓存，请等待任务完成",
                    "job": active,
                }), 409
            book = reparse_book_record(book_id)
            delete_tts_offline_refs(book_id)
        app.logger.info("book reparsed ip=%s id=%s", request.remote_addr, book_id)
        return jsonify({"ok": True, "book": book_summary(book)})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        app.logger.warning("book reparse failed ip=%s id=%s error=%s", request.remote_addr, book_id, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/clear-toc", methods=["POST"])
def api_book_clear_toc(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        with TTS_OFFLINE_JOB_LOCK:
            active = active_tts_offline_job_for_book(book_id)
            if active:
                return jsonify({
                    "error": "该书正在生成离线缓存，请等待任务完成",
                    "job": active,
                }), 409
            book = clear_txt_book_toc(book_id)
            delete_tts_offline_refs(book_id)
        app.logger.info("book toc cleared ip=%s id=%s", request.remote_addr, book_id)
        return jsonify({"ok": True, "book": book_summary(book)})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        app.logger.warning("book clear toc failed ip=%s id=%s error=%s", request.remote_addr, book_id, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/cover")
def api_book_cover(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book = read_book_record(book_id)
        cover_name = book.get("cover_name", "")
        if not cover_name or Path(cover_name).name != cover_name:
            return jsonify({"error": "封面不存在"}), 404
        cover_path = book_dir(book_id) / cover_name
        if not cover_path.exists():
            return jsonify({"error": "封面不存在"}), 404
        return send_file(cover_path)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 404


@app.route("/api/books/<book_id>/assets/<path:asset_path>")
def api_book_asset(book_id, asset_path):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book = read_book_record(book_id)
        if book.get("format") != "epub":
            return jsonify({"error": "资源不存在"}), 404
        asset_path = posixpath.normpath(unquote(asset_path))
        if asset_path.startswith("../") or asset_path.startswith("/") or asset_path == "..":
            return jsonify({"error": "资源路径无效"}), 400
        suffix = Path(asset_path).suffix.lower()
        mime = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(suffix)
        if not mime:
            return jsonify({"error": "资源类型不支持"}), 400
        source_path = book_dir(book_id) / book.get("stored_name", "")
        with zipfile.ZipFile(source_path) as zf:
            info = zf.getinfo(asset_path)
            if info.file_size > 8 * 1024 * 1024:
                return jsonify({"error": "图片过大"}), 413
            return send_file(BytesIO(zf.read(asset_path)), mimetype=mime)
    except KeyError:
        return jsonify({"error": "资源不存在"}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 404


@app.route("/api/books/<book_id>/chapters/<int:chapter_index>")
def api_book_chapter(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book = read_book_record(book_id)
        return jsonify(chapter_payload(book, chapter_index))
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/chapters/<int:chapter_index>/title", methods=["PATCH"])
def api_txt_chapter_title_update(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()
    try:
        book = update_txt_chapter_title(book_id, chapter_index, payload.get("title", ""))
        return jsonify({"ok": True, "book": book_summary(book)})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/chapters/<int:chapter_index>/title", methods=["DELETE"])
def api_txt_chapter_title_delete(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    started = time.perf_counter()
    try:
        with TTS_OFFLINE_JOB_LOCK:
            active = active_tts_offline_job_for_book(book_id)
            if active:
                return jsonify({
                    "error": "该书正在生成离线缓存，请等待任务完成",
                    "job": active,
                }), 409
            book = delete_txt_chapter_title(book_id, chapter_index)
            cleanup_started = time.perf_counter()
            delete_tts_offline_refs(book_id)
            cleanup_seconds = time.perf_counter() - cleanup_started
        app.logger.info(
            "txt chapter title deleted ip=%s book=%s chapter=%s cleanup=%.3fs total=%.3fs",
            request.remote_addr,
            book_id,
            chapter_index,
            cleanup_seconds,
            time.perf_counter() - started,
        )
        return jsonify({
            "ok": True,
            "book": book_summary(book),
            "chapters": book_chapter_summaries(book),
        })
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/chapters/<int:chapter_index>/lines")
def api_txt_chapter_lines(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        book, lines = txt_chapter_lines(book_id, chapter_index)
        return jsonify({"book": book_summary(book), "lines": lines})
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/chapters/<int:chapter_index>/split", methods=["POST"])
def api_txt_chapter_split(book_id, chapter_index):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()
    started = time.perf_counter()
    try:
        line_index = int(payload.get("line_index", -1))
        with TTS_OFFLINE_JOB_LOCK:
            active = active_tts_offline_job_for_book(book_id)
            if active:
                return jsonify({
                    "error": "该书正在生成离线缓存，请等待任务完成",
                    "job": active,
                }), 409
            book = split_txt_chapter_at_line(book_id, chapter_index, line_index, payload.get("title", ""))
            cleanup_started = time.perf_counter()
            delete_tts_offline_refs(book_id)
            cleanup_seconds = time.perf_counter() - cleanup_started
        app.logger.info(
            "txt chapter title added ip=%s book=%s chapter=%s line=%s cleanup=%.3fs total=%.3fs",
            request.remote_addr,
            book_id,
            chapter_index,
            line_index,
            cleanup_seconds,
            time.perf_counter() - started,
        )
        return jsonify({
            "ok": True,
            "book": book_summary(book),
            "chapters": book_chapter_summaries(book),
        })
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>/progress", methods=["PUT"])
def api_book_progress(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()
    try:
        with READER_IO_LOCK:
            book = read_book_record(book_id)
            chapter = int(payload.get("chapter", 0))
            sentence = int(payload.get("sentence", 0))
            chapter = max(0, min(chapter, max(len(book.get("chapters", [])) - 1, 0)))
            sentence = max(0, sentence)
            now = int(time.time())
            book["progress"] = {"chapter": chapter, "sentence": sentence}
            book["updated_at"] = now
            book["last_opened_at"] = now
            write_book_record(book)
            upsert_book_index(book)
        return jsonify({"ok": True, "book": book_summary(book)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/books/<book_id>", methods=["DELETE"])
def api_book_delete(book_id):
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        target_dir = book_dir(book_id)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    started = time.perf_counter()
    with TTS_OFFLINE_JOB_LOCK:
        active = active_tts_offline_job_for_book(book_id)
        if active:
            return jsonify({
                "error": "该书正在生成离线缓存，请等待任务完成",
                "job": active,
            }), 409
        with READER_IO_LOCK:
            if not target_dir.exists():
                return jsonify({"error": "书籍不存在"}), 404
            cleanup_started = time.perf_counter()
            removed = delete_tts_offline_refs(book_id, delete_files=True)
            cleanup_seconds = time.perf_counter() - cleanup_started
            shutil.rmtree(target_dir)
            remove_from_book_index(book_id)
    app.logger.info(
        "book deleted ip=%s id=%s refs=%s packs=%s cleanup=%.3fs total=%.3fs",
        request.remote_addr,
        book_id,
        removed["entries"],
        removed["pack_entries"],
        cleanup_seconds,
        time.perf_counter() - started,
    )
    return jsonify({"ok": True})


@app.route("/api/bootstrap")
def bootstrap():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    config = load_config()
    engines = [
        {"id": key, "name": label, "enabled": config.get(key, {}).get("enabled", False)}
        for key, label in ENGINES.items()
    ]
    return jsonify({"languages": LANGUAGES, "engines": engines, "config": public_config(config)})


@app.route("/api/config", methods=["PUT"])
def api_config():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        config = load_config()
        payload = request_json_object()
        if "app_password" in payload:
            raise ValueError("访问密码只能通过监控页的专用接口修改")
        updated = update_nested_config(config, payload)
        save_config(updated)
        session["authenticated"] = True
        session["auth_version"] = authentication_version(updated["app_password"])
        app.logger.info("config updated ip=%s", request.remote_addr)
        return jsonify({"ok": True, "config": public_config(updated)})
    except Exception as exc:
        app.logger.warning("config update failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/password", methods=["PUT"])
def api_password():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    try:
        payload = request_json_object()
        current_password = payload.get("current_password")
        new_password = payload.get("new_password")
        if not isinstance(current_password, str) or not current_password:
            raise ValueError("请输入当前访问密码")
        if not isinstance(new_password, str) or not new_password:
            raise ValueError("请输入新的访问密码")
        ip = client_ip()
        if login_is_limited(ip):
            return jsonify({"error": "密码验证失败次数过多，请稍后再试"}), 429
        config = load_config()
        expected_password = str(config.get("app_password", ""))
        if len(current_password) > 256 or not secrets.compare_digest(current_password, expected_password):
            record_login_failure(ip)
            app.logger.warning("access password verification failed ip=%s", ip)
            return jsonify({"error": "当前密码不正确"}), 403
        clear_login_failures(ip)
        normalized_new_password = clean_single_line_value(new_password)
        if secrets.compare_digest(normalized_new_password, expected_password):
            raise ValueError("新密码不能与当前密码相同")
        updated = update_app_password(config, normalized_new_password)
        session["authenticated"] = True
        session["auth_version"] = authentication_version(updated["app_password"])
        app.logger.info("access password updated ip=%s", ip)
        return jsonify({"ok": True})
    except Exception as exc:
        app.logger.warning("access password update failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 400


@app.route("/api/status")
def api_status():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    started = time.perf_counter()
    result = system_status()
    with SERVICE_READY_LOCK:
        first_ready = not SERVICE_READY_STATE["logged"]
        if first_ready:
            SERVICE_READY_STATE["logged"] = True
    if first_ready:
        app.logger.info(
            "service ready pid=%s uptime=%.3fs status_elapsed=%.3fs",
            os.getpid(),
            time.time() - PROCESS_START_TIME,
            time.perf_counter() - started,
        )
    return jsonify(result)


@app.route("/api/cache", methods=["GET", "DELETE"])
def api_cache_clear():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    if request.method == "GET":
        return jsonify({"entries": translation_cache_entries(), "limit": CACHE_LIMIT, "persistent": True})
    try:
        count = clear_translation_cache()
    except sqlite3.Error as exc:
        app.logger.error("deepseek cache clear failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": "缓存清空失败"}), 500
    app.logger.info("cache cleared ip=%s entries=%s", request.remote_addr, count)
    return jsonify({"ok": True, "cleared": count, "entries": 0, "limit": CACHE_LIMIT, "persistent": True})


@app.route("/api/restart", methods=["POST"])
def api_restart():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    now = time.time()
    if now - RESTART_STATE["time"] < RESTART_COOLDOWN_SECONDS:
        return jsonify({"error": "重启操作过于频繁，请稍后再试"}), 429
    RESTART_STATE["time"] = now
    app.logger.warning("restart requested ip=%s", request.remote_addr)
    restart_process_later()
    return jsonify({"ok": True, "message": "服务正在重启"})


@app.route("/api/deepseek/balance")
def api_deepseek_balance():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    config = load_config()
    try:
        balance = fetch_deepseek_balance(config)
        return jsonify({"ok": True, "balance": balance})
    except Exception as exc:
        app.logger.warning("deepseek balance failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 502


@app.route("/api/translate", methods=["POST"])
def api_translate():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    payload = request_json_object()
    text = (payload.get("text") or "").strip()
    source = payload.get("source") or "auto"
    target = payload.get("target") or "en"
    engine = payload.get("engine")
    if engine not in ENGINES:
        return jsonify({"error": "翻译引擎无效"}), 400
    if not text:
        return jsonify({"error": "请输入要翻译的文本"}), 400
    if len(text) > MAX_TRANSLATE_CHARS:
        return jsonify({"error": f"单次翻译最多 {MAX_TRANSLATE_CHARS} 字符"}), 400
    if source not in LANGUAGE_CODES or target not in LANGUAGE_CODES or target == "auto":
        return jsonify({"error": "语言参数无效"}), 400
    config = load_config()
    if not config[engine].get("enabled"):
        return jsonify({"error": f"{ENGINES[engine]} 未启用"}), 400
    try:
        if engine == "google":
            translated, detected_source = translate_google(text, source, target, config)
            app.logger.info(
                "google translate ok ip=%s chars=%s target=%s",
                request.remote_addr,
                len(text),
                target,
            )
            return jsonify({"text": translated, "detectedSource": detected_source})
        translated, cached = translate_deepseek(text, source, target, config)
        app.logger.info(
            "deepseek translate ok ip=%s chars=%s target=%s cached=%s",
            request.remote_addr,
            len(text),
            target,
            cached,
        )
        return jsonify({"text": translated, "cached": cached})
    except Exception as exc:
        app.logger.warning("%s translate failed ip=%s error=%s", engine, request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 502


if __name__ == "__main__":
    host = clean_single_line_value(os.getenv("HOST", "127.0.0.1")) or "127.0.0.1"
    port = int(os.getenv("PORT", "31000"))
    if port < 1 or port > 65535:
        raise RuntimeError("PORT 必须在 1 到 65535 之间")
    app.logger.info("service process starting pid=%s host=%s port=%s", os.getpid(), host, port)
    try:
        validate_runtime_security()
        app.run(host=host, port=port)
    except Exception:
        app.logger.exception("service process startup failed pid=%s", os.getpid())
        raise
