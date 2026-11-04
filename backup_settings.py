"""Explicit tool-setting allowlists, redacted comparison and selective restore.

Authentication/deployment settings are deliberately outside this module's scope.
Restores reuse the live forms' validators, without their persistence side effects.
"""
import copy
import hmac
import json
import math
import os

import pdf_translation

TOOLS = {"translation": "在线翻译", "pdf": "PDF 翻译", "tts": "听书"}
ITEMS = ("settings", "credentials")
MAX_BYTES = 128 * 1024
FIELDS = {
    "deepseek": ("enabled", "base_url", "model", "temperature", "thinking", "reasoning_effort", "timeout", "style", "cache_limit"),
    "google": ("enabled", "endpoint", "timeout"),
    "reader_tts": ("enabled", "provider", "base_url", "balance_url", "model", "voice_id", "format", "style_prompt", "timeout", "chunk_chars", "cache_enabled"),
    "pdf": tuple(k for k in pdf_translation.DEFAULTS if k not in ("api_key", "service_token")),
}
SECRETS = {"deepseek": ("api_key",), "reader_tts": ("api_key", "balance_cookie"), "pdf": ("api_key", "service_token")}
SECTIONS = {"translation": ("deepseek", "google"), "tts": ("reader_tts",), "pdf": ("pdf",)}
URLS = {"deepseek": ("base_url",), "reader_tts": ("base_url", "balance_url"), "pdf": ("endpoint",)}
ENV_FIELDS = {"deepseek": {"api_key": "DEEPSEEK_API_KEY", "base_url": "DEEPSEEK_BASE_URL", "model": "DEEPSEEK_MODEL"},
              "reader_tts": {"api_key": "MIMO_API_KEY", "base_url": "MIMO_TTS_BASE_URL", "balance_url": "MIMO_BALANCE_URL",
                             "model": "MIMO_TTS_MODEL", "voice_id": "MIMO_TTS_VOICE", "style_prompt": "MIMO_TTS_STYLE_PROMPT"}}


def selections(rows):
    if not isinstance(rows, list) or len(rows) > len(TOOLS):
        raise ValueError("工具备份选项无效")
    result = {}
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] not in TOOLS
                or row["id"] in result or not isinstance(row.get("items"), list) or not row["items"]
                or any(x not in ITEMS for x in row["items"])):
            raise ValueError("工具备份选项无效")
        result[row["id"]] = [k for k in ITEMS if k in row["items"]]
    return result


class ToolSettings:
    def __init__(self, backend):
        self.b = backend

    @property
    def pdf(self):
        return self.b.app.extensions["pdf_tasks"]

    def current(self, tool):
        if tool == "pdf":
            return {"pdf": self.pdf.config()}
        config = self.b.load_config()
        return {section: config[section] for section in SECTIONS[tool]}

    def token(self, config):
        data = json.dumps(config, sort_keys=True, ensure_ascii=False).encode()
        key = self.b.app.secret_key
        return hmac.digest(key.encode() if isinstance(key, str) else key, data, "sha256").hex()

    def snapshot(self, selected):
        data = {}
        with self.b.CONFIG_IO_LOCK:
            for tool, items in selected.items():
                config = self.current(tool)
                entry = {"bindings": {s: {k: config[s][k] for k in URLS.get(s, ())} for s in SECTIONS[tool]}}
                for item in items:
                    fields = FIELDS if item == "settings" else SECRETS
                    entry[item] = {s: {k: config[s][k] for k in fields.get(s, ())} for s in SECTIONS[tool]}
                data[tool] = entry
        return data

    def validate(self, data, selected):
        if not isinstance(data, dict) or set(data) != set(selected):
            raise ValueError("工具备份内容与清单不一致")
        for tool, items in selected.items():
            entry = data[tool]
            if not isinstance(entry, dict) or set(entry) != {"bindings", *items}:
                raise ValueError("工具备份包含不支持的项目")
            for item, sections in entry.items():
                if not isinstance(sections, dict) or set(sections) != set(SECTIONS[tool]):
                    raise ValueError("工具备份配置分组无效")
                fields = URLS if item == "bindings" else FIELDS if item == "settings" else SECRETS
                for section, values in sections.items():
                    if not isinstance(values, dict) or set(values) != set(fields.get(section, ())):
                        raise ValueError("工具备份包含不支持的配置字段")
                    defaults = pdf_translation.DEFAULTS if section == "pdf" else self.b.DEFAULT_CONFIG[section]
                    for key, value in values.items():
                        default = defaults[key]
                        limit = 40 * 1024 if key == "balance_cookie" else 8192
                        valid = (type(value) is bool if type(default) is bool else
                                 type(value) in (int, float) and math.isfinite(value) if type(default) in (int, float) else
                                 isinstance(value, str) and len(value) <= limit and not any(c in value for c in ("\r", "\n", "\0")))
                        if not valid:
                            raise ValueError("工具备份配置值无效")
            if "settings" in items:
                for section, values in entry["bindings"].items():
                    if any(entry["settings"][section][key] != value for key, value in values.items()):
                        raise ValueError("服务地址与备份配置不一致")

    def preview(self, data, selected):
        self.validate(data, selected)
        rows = []
        for tool, items in selected.items():
            current = self.current(tool)
            entry = data[tool]
            # No secret values, hints, prefixes or password-derived data leave here.
            rows.append({"id": tool, "title": TOOLS[tool], "items": items, "token": self.token(current),
                         "settings": entry.get("settings", {}),
                         "credential_count": sum(bool(v) for values in entry.get("credentials", {}).values() for v in values.values()),
                         "changed": {item: any(current[s][k] != v for s, values in entry[item].items() for k, v in values.items()) for item in items}})
        return rows

    def restore(self, tool, entry, items, token):
        b = self.b
        if tool not in TOOLS or not items or any(i not in ITEMS or i not in entry for i in items):
            raise ValueError("请选择有效的工具恢复项目")
        # PDF and regular configuration locks follow the live service's order.
        if tool == "pdf":
            self.pdf.initialize()
        guard = self.pdf.storage_lock() if tool == "pdf" else b.TRANSLATION_CACHE_LOCK
        with guard, b.CONFIG_IO_LOCK, b.MIMO_BALANCE_LOCK:
            current = self.current(tool)
            if not hmac.compare_digest(self.token(current), str(token)):
                raise ValueError("配置在预览后发生变化，请刷新对比后重试")
            if tool == "pdf" and self.pdf.active_jobs():
                raise ValueError("请先等待 PDF 任务结束或取消排队任务")
            target = copy.deepcopy(current)
            for item in items:
                for section, values in entry[item].items():
                    target[section].update(values)
            for section, bindings in entry["bindings"].items():
                for key, address in bindings.items():
                    if "credentials" in items and target[section][key] != address:
                        raise ValueError("服务地址不同，请同时恢复工具配置与服务凭据")
                    if ("credentials" not in items and current[section][key] != target[section][key]
                            and any(current[section].get(k) for k in SECRETS.get(section, ()))):
                        raise ValueError("服务地址将改变，请同时恢复匹配的服务凭据，或先清除当前凭据")
            if tool == "pdf":
                payload = dict(target["pdf"])
                for key in SECRETS["pdf"]:
                    payload["clear_" + key] = not payload[key]
                try:
                    validated = self.pdf.validated_config(payload)
                except pdf_translation.PdfError as exc:
                    raise ValueError(str(exc)) from None
                pdf_translation.atomic_json(self.pdf.root / "config.json", validated)
            else:
                config = b.load_config()
                for section, values in target.items():
                    config[section].update(values)
                validators = {("deepseek", "base_url"): b.validate_server_api_url,
                              ("reader_tts", "base_url"): b.validate_mimo_tts_url,
                              ("reader_tts", "balance_url"): b.validate_mimo_balance_url}
                for (section, key), validate in validators.items():
                    if section in target and validate(target[section][key], "") != target[section][key]:
                        raise ValueError("备份中的服务地址不符合当前服务器的地址限制")
                if tool == "translation":
                    validated = b.update_nested_config(config, target, persist=False)
                else:
                    validated = b.update_reader_tts_config(config, target["reader_tts"], persist=False)
                refresh_audio = tool == "tts" and (
                    b.tts_offline_profile_key(current["reader_tts"]) != b.tts_offline_profile_key(validated["reader_tts"])
                    or current["reader_tts"]["chunk_chars"] != validated["reader_tts"]["chunk_chars"])
                prune_cache = tool == "translation" and current["deepseek"]["cache_limit"] != validated["deepseek"]["cache_limit"]
                env = {name: validated[s][k] for s in target for k, name in ENV_FIELDS.get(s, {}).items()}
                # Roll back I/O failures before releasing config readers. Never
                # write backup passwords or copies of these files into job metadata.
                paths = [b.BASE_DIR / ".env", b.CONFIG_FILE]
                if tool == "tts" and "credentials" in items:
                    paths.append(b.MIMO_BALANCE_STATE_FILE)
                before = {path: path.read_text() if path.exists() else None for path in paths}
                environment = {name: os.environ.get(name) for name in env}
                try:
                    b.save_config(validated)
                    if tool == "tts" and "credentials" in items:
                        b.save_mimo_balance_cookie(validated["reader_tts"]["balance_cookie"])
                    b.save_dotenv_values(env)
                except Exception:
                    try:
                        for path, text in before.items():
                            if text is None:
                                path.unlink(missing_ok=True)
                            else:
                                b.write_private_text_atomic(path, text)
                    finally:
                        # save_dotenv_values can update os.environ before its
                        # disk write fails; restore memory even if disk stays full.
                        for name, value in environment.items():
                            if value is None:
                                os.environ.pop(name, None)
                            else:
                                os.environ[name] = value
                    raise
        # Derived caches refresh through existing hooks, never by replaying API calls.
        try:
            if tool == "tts" and refresh_audio:
                b.schedule_tts_cache_stats_refresh(book_ids={book["id"] for book in b.load_book_index()})
            elif tool == "translation" and prune_cache:
                with b.TRANSLATION_CACHE_LOCK:
                    b.prune_translation_cache()
            elif tool == "pdf":
                self.pdf.ensure_worker(force=True)
        except Exception:
            b.app.logger.warning("restored tool configuration; derived refresh deferred tool=%s", tool)
