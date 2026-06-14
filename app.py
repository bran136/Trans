import json
import logging
import hashlib
import ipaddress
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from logging.handlers import RotatingFileHandler
import os
import secrets
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import Flask, jsonify, redirect, render_template, request, session, url_for


BASE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = BASE_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "app_config.json"
LOG_DIR = BASE_DIR / "logs"
CACHE_LIMIT = 100
CACHE_MAX_TEXT_CHARS = 12000
MAX_TRANSLATE_CHARS = 20000
OFFICIAL_DEEPSEEK_HOSTS = {"api.deepseek.com"}
DEEPSEEK_BALANCE_TTL = 900
DEEPSEEK_BALANCE_RETRY_INTERVAL = 60
RESTART_COOLDOWN_SECONDS = 30
TRANSLATION_CACHE = OrderedDict()
DEEPSEEK_BALANCE_CACHE = {"time": 0.0, "attempt_time": 0.0, "data": None}
RESTART_STATE = {"time": 0.0}
PROCESS_START_TIME = time.time()
CPU_SAMPLE = {"time": time.time(), "cpu": 0.0}
SYSTEM_CPU_SAMPLE = {"idle": 0, "total": 0}


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
        "endpoint": "https://translate.googleapis.com/translate_a/single",
        "timeout": 25,
    },
}


DEEPSEEK_STYLES = {
    "default": {
        "name": "默认",
        "prompt": "Translate faithfully and naturally. Keep formatting. Return only the translated text.",
    },
    "academic": {
        "name": "学术翻译",
        "prompt": "Translate in a formal academic style. Preserve terminology, logic, citations, numbers, and paragraph structure. Return only the translated text.",
    },
    "literary": {
        "name": "文学创作",
        "prompt": "Translate with literary fluency and expressive rhythm while preserving the original meaning, imagery, and tone. Return only the translated text.",
    },
    "business": {
        "name": "商务正式",
        "prompt": "Translate in a polished business style. Keep the wording professional, concise, and suitable for formal communication. Return only the translated text.",
    },
    "plain": {
        "name": "通俗易懂",
        "prompt": "Translate into clear, simple, easy-to-understand language while preserving the original meaning. Return only the translated text.",
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
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
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
        os.environ[key.strip()] = value.strip().strip('"').strip("'")


def quote_env_value(value):
    value = "" if value is None else str(value)
    if not value or any(char.isspace() for char in value) or any(char in value for char in '"\'#\\'):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def clean_single_line_value(value):
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()


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
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        return fallback
    if parsed.username or parsed.password:
        return fallback
    allow_custom = os.getenv("ALLOW_CUSTOM_DEEPSEEK_BASE_URL", "").lower() in {"1", "true", "yes"}
    if not allow_custom:
        if parsed.scheme != "https" or parsed.hostname not in OFFICIAL_DEEPSEEK_HOSTS:
            return DEFAULT_CONFIG["deepseek"]["base_url"]
        return candidate
    if not is_public_address(parsed.hostname):
        return fallback
    return candidate


def save_dotenv_values(values):
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
    env_path.write_text("\n".join(updated_lines).rstrip() + "\n", encoding="utf-8")


def apply_env(config):
    config["app_password"] = os.getenv("APP_PASSWORD", config["app_password"])
    deepseek = config["deepseek"]
    deepseek["api_key"] = os.getenv("DEEPSEEK_API_KEY", deepseek["api_key"])
    deepseek["base_url"] = os.getenv("DEEPSEEK_BASE_URL", deepseek["base_url"])
    deepseek["model"] = os.getenv("DEEPSEEK_MODEL", deepseek["model"])
    return config


def load_config():
    CONFIG_DIR.mkdir(exist_ok=True)
    if CONFIG_FILE.exists():
        saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    else:
        saved = {}
    config = apply_env(deep_merge(DEFAULT_CONFIG, saved))
    config.pop("libretranslate", None)
    config.pop("microsoft", None)
    config.pop("mymemory", None)
    config.pop("iciba", None)
    return config


def save_config(config):
    CONFIG_DIR.mkdir(exist_ok=True)
    safe = json.loads(json.dumps(config))
    safe.pop("app_password", None)
    if "deepseek" in safe:
        safe["deepseek"].pop("api_key", None)
    CONFIG_FILE.write_text(json.dumps(safe, ensure_ascii=False, indent=2), encoding="utf-8")


load_dotenv()
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))
app.config.update(
    MAX_CONTENT_LENGTH=256 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=env_flag("SESSION_COOKIE_SECURE", False),
)


def setup_logging():
    LOG_DIR.mkdir(exist_ok=True)
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


setup_logging()


@app.context_processor
def inject_asset_url():
    def asset_url(filename):
        asset_path = BASE_DIR / "static" / filename
        try:
            version = int(asset_path.stat().st_mtime)
        except OSError:
            version = int(time.time())
        return url_for("static", filename=filename, v=version)

    def app_version():
        version_files = [
            BASE_DIR / "app.py",
            BASE_DIR / "templates" / "index.html",
            BASE_DIR / "templates" / "login.html",
            BASE_DIR / "static" / "styles.css",
            BASE_DIR / "static" / "app.js",
        ]
        version = 0
        for path in version_files:
            try:
                version = max(version, int(path.stat().st_mtime))
            except OSError:
                continue
        return time.strftime("%Y%m%d.%H%M", time.localtime(version or time.time()))

    return {"asset_url": asset_url, "app_version": app_version}


def require_auth():
    return bool(session.get("authenticated"))


def public_config(config):
    safe = json.loads(json.dumps(config))
    safe["deepseek"]["api_key_configured"] = bool(safe["deepseek"].get("api_key"))
    safe["deepseek"]["api_key"] = ""
    safe["deepseek"]["allow_custom_base_url"] = (
        os.getenv("ALLOW_CUSTOM_DEEPSEEK_BASE_URL", "").lower() in {"1", "true", "yes"}
    )
    safe["app_password"] = "********" if safe.get("app_password") else ""
    safe["deepseek_styles"] = [
        {"id": key, "name": value["name"]} for key, value in DEEPSEEK_STYLES.items()
    ]
    return safe


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


def update_nested_config(config, payload):
    env_updates = {}
    if payload.get("app_password") and payload["app_password"] != "********":
        config["app_password"] = clean_single_line_value(payload["app_password"])
        env_updates["APP_PASSWORD"] = config["app_password"]

    deepseek = payload.get("deepseek", {})
    if deepseek:
        target = config["deepseek"]
        target["enabled"] = bool(deepseek.get("enabled"))
        if deepseek.get("api_key"):
            target["api_key"] = clean_single_line_value(deepseek["api_key"])
            env_updates["DEEPSEEK_API_KEY"] = target["api_key"]
        target["base_url"] = validate_server_api_url(
            deepseek.get("base_url", target["base_url"]),
            target["base_url"],
        )
        env_updates["DEEPSEEK_BASE_URL"] = target["base_url"]
        target["model"] = clean_single_line_value(deepseek.get("model", target["model"]))
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
        target["endpoint"] = clean_single_line_value(google.get("endpoint", target["endpoint"]))
        target["timeout"] = int(parse_number(google.get("timeout"), target["timeout"], 5, 120))

    if env_updates:
        save_dotenv_values(env_updates)
    return config


def cache_key_for_deepseek(text, source, target, settings):
    payload = {
        "engine": "deepseek",
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


def get_cached_translation(cache_key):
    value = TRANSLATION_CACHE.get(cache_key)
    if value is not None:
        TRANSLATION_CACHE.move_to_end(cache_key)
    return value


def set_cached_translation(cache_key, value):
    if len(value) > CACHE_MAX_TEXT_CHARS:
        return
    TRANSLATION_CACHE[cache_key] = value
    TRANSLATION_CACHE.move_to_end(cache_key)
    while len(TRANSLATION_CACHE) > CACHE_LIMIT:
        TRANSLATION_CACHE.popitem(last=False)


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
            "entries": len(TRANSLATION_CACHE),
            "limit": CACHE_LIMIT,
            "max_text_chars": CACHE_MAX_TEXT_CHARS,
        },
    }


def restart_process_later(delay=0.35):
    def restart():
        time.sleep(delay)
        try:
            subprocess.Popen(
                [sys.executable, str(BASE_DIR / "app.py")],
                cwd=BASE_DIR,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as exc:
            app.logger.error("restart spawn failed error=%s", exc)
            return
        os._exit(0)

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


def translate_deepseek(text, source, target, config):
    settings = config["deepseek"]
    if not settings.get("api_key"):
        raise RuntimeError("DeepSeek API Key 未配置")
    cache_key = cache_key_for_deepseek(text, source, target, settings)
    cached = get_cached_translation(cache_key)
    if cached is not None:
        return cached, True
    source_label = "auto-detected language" if source == "auto" else source
    style = DEEPSEEK_STYLES.get(settings.get("style"), DEEPSEEK_STYLES["default"])
    body = {
        "model": settings["model"],
        "messages": [
            {
                "role": "system",
                "content": "You are a translation engine. " + style["prompt"],
            },
            {
                "role": "user",
                "content": f"Translate from {source_label} to {target}:\n\n{text}",
            },
        ],
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
    )
    response.raise_for_status()
    data = response.json()
    translated = data["choices"][0]["message"]["content"].strip()
    set_cached_translation(cache_key, translated)
    return translated, False


ENGINES = {
    "deepseek": "DeepSeek",
    "google": "谷歌翻译",
}


@app.route("/")
def index():
    if not require_auth():
        return redirect(url_for("login"))
    return render_template("index.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    config = load_config()
    if request.method == "POST":
        password = request.form.get("password", "")
        if secrets.compare_digest(password, config["app_password"]):
            session["authenticated"] = True
            app.logger.info("login success ip=%s", request.remote_addr)
            return redirect(url_for("index"))
        app.logger.warning("login failed ip=%s", request.remote_addr)
        error = "密码不正确"
    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
def logout():
    app.logger.info("logout ip=%s", request.remote_addr)
    session.clear()
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
    config = load_config()
    updated = update_nested_config(config, request.get_json(force=True) or {})
    save_config(updated)
    app.logger.info("config updated ip=%s", request.remote_addr)
    return jsonify({"ok": True, "config": public_config(updated)})


@app.route("/api/status")
def api_status():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(system_status())


@app.route("/api/cache", methods=["DELETE"])
def api_cache_clear():
    if not require_auth():
        return jsonify({"error": "unauthorized"}), 401
    count = len(TRANSLATION_CACHE)
    TRANSLATION_CACHE.clear()
    app.logger.info("cache cleared ip=%s entries=%s", request.remote_addr, count)
    return jsonify({"ok": True, "cleared": count, "cache": {"entries": 0, "limit": CACHE_LIMIT}})


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
    payload = request.get_json(force=True) or {}
    text = (payload.get("text") or "").strip()
    source = payload.get("source") or "auto"
    target = payload.get("target") or "en"
    engine = payload.get("engine")
    if engine != "deepseek":
        return jsonify({"error": "只有 DeepSeek 通过服务器代理"}), 400
    if not text:
        return jsonify({"error": "请输入要翻译的文本"}), 400
    if len(text) > MAX_TRANSLATE_CHARS:
        return jsonify({"error": f"单次翻译最多 {MAX_TRANSLATE_CHARS} 字符"}), 400
    if source not in LANGUAGE_CODES or target not in LANGUAGE_CODES or target == "auto":
        return jsonify({"error": "语言参数无效"}), 400
    config = load_config()
    if not config["deepseek"].get("enabled"):
        return jsonify({"error": "DeepSeek 未启用"}), 400
    try:
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
        app.logger.warning("deepseek translate failed ip=%s error=%s", request.remote_addr, exc)
        return jsonify({"error": str(exc)}), 502


if __name__ == "__main__":
    port = int(os.getenv("PORT", "31000"))
    app.run(host="0.0.0.0", port=port)
