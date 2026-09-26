"""Independent HTTP client for a separately deployed Zotero PDF2zh server.

No upstream implementation is bundled. See the acknowledgments in README.md.
"""
import base64
import contextlib
import fcntl
import ipaddress
import json
import os
import re
import shutil
import sqlite3
import threading
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from flask import Blueprint, jsonify, redirect, render_template, request, send_file
from pypdf import PdfReader

ACTIVE = ('queued', 'submitting', 'running', 'fetching', 'unknown')
TERMINAL = ('completed', 'failed', 'interrupted', 'download_failed', 'cancelled')
MODELS = ('deepseek-flash', 'deepseek-v4-pro')
DEFAULTS = dict(endpoint='', service_token='', reuse_deepseek=True,
                api_key='', model='deepseek-flash', qps=2, retention_days=0,
                enhance_compatibility=False, pool_size=0, thinking='disabled',
                reasoning_effort='high', json_mode=False, ocr=False,
                no_watermark=True, disable_glossary=True, translate_table_text=False,
                rich_text=True, skip_last_pages=0)
NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
    '127.0.0.0/8', '::1/128', 'fc00::/7'))


class PdfError(Exception):
    pass


class UploadBody:
    """Report completed socket writes when HTTP requests the next file chunk."""
    def __init__(self, file, length, report):
        self.file, self.length, self.report = file, length, report
        self.sent = self.pending = 0
        self.started = self.last_report = time.monotonic()

    def __len__(self):
        return self.length

    def tell(self):
        return self.file.tell()

    def read(self, size=-1):
        self.sent += self.pending
        self.pending = 0
        now = time.monotonic()
        if self.sent and (self.sent == self.length or now - self.last_report >= 1):
            self.report(self.sent, self.length, self.sent / max(now - self.started, .001))
            self.last_report = now
        chunk = self.file.read(size)
        self.pending = len(chunk)
        return chunk


def translation_progress(record):
    """Only surface recognized progress messages, never arbitrary upstream logs."""
    value = record.get('progress')
    progress = max(0, min(99, float(value))) if type(value) in (int, float) and value == value else None
    message = record.get('message')
    message = message.strip() if isinstance(message, str) else ''
    counts = re.fullmatch(r'translate\s+(\d{1,9})/(\d{1,9})', message, re.I)
    stages = {
        'Parse PDF and Create Intermediate Representation': '正在解析 PDF',
        'Detect Scanned PDF': '正在检测扫描页面',
        'Layout Analysis': '正在分析版面',
        'Table Recognition': '正在识别表格',
        'Paragraph Finding': '正在识别段落',
        'Styles and Formulas': '正在分析样式与公式',
        'Automatic Term Extraction': '正在提取术语',
        'Translate Paragraphs': '正在翻译段落',
        'Typesetting': '正在排版',
        'Font Subsetting': '正在处理字体',
        'Generate PDF': '正在生成 PDF',
        'Save PDF': '正在保存 PDF',
    }
    phase = stages.get(message, '正在翻译与排版')
    if counts and int(counts[2]) > 0:
        phase = f'正在翻译 · {int(counts[1])}/{int(counts[2])}'
    elif message in stages and message != 'Translate Paragraphs':
        # Upstream may report a parse/font substep as 100%; it is not total progress.
        progress = None
    # An initial upstream zero often means that no measurable progress exists yet.
    return phase, progress if progress else None


def service_url(value):
    """Only an explicit LAN/loopback IP, never an arbitrary proxy or redirect."""
    if not isinstance(value, str) or len(value) > 300:
        raise PdfError('服务地址无效')
    try:
        parts = urlsplit(value.strip())
        host = parts.hostname
        if host == 'localhost':
            host = '127.0.0.1'
        address = ipaddress.ip_address(host)
        if parts.scheme not in ('http', 'https') or not any(address in n for n in NETWORKS):
            raise ValueError()
        if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('', '/'):
            raise ValueError()
        port = parts.port
        netloc = f'[{host}]' if address.version == 6 else host
        if port:
            netloc += f':{port}'
        return urlunsplit((parts.scheme, netloc, '', '', ''))
    except (ValueError, TypeError):
        raise PdfError('请填写已部署服务的内网 IP 地址和端口，例如 http://127.0.0.1:30215') from None


def atomic_json(path, value):
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with temp.open('x', encoding='utf-8') as handle:
            os.chmod(temp, 0o600)
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class PdfTasks:
    def __init__(self, root, load_translation_config, logger):
        self.root = Path(root)
        self.database = self.root / 'tasks.sqlite3'
        self.load_translation_config = load_translation_config
        self.logger = logger
        self.thread = None
        self.thread_lock = threading.Lock()
        self.wake = threading.Event()
        self.last_attempt = 0
        self.last_cleanup = 0
        self.initialized = False
        self.health_lock = threading.Lock()
        self.health_snapshot = None

    def initialize(self):
        with self.thread_lock:
            if self.initialized:
                return
            self._initialize()
            self.initialized = True

    def _initialize(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, source TEXT NOT NULL,
                target TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
                reuse_deepseek INTEGER NOT NULL, qps INTEGER NOT NULL,
                status TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', progress REAL,
                created REAL NOT NULL, updated REAL NOT NULL, submitted REAL,
                finished REAL, remote_id TEXT, remote_files TEXT NOT NULL DEFAULT '{}',
                pages INTEGER NOT NULL, input_bytes INTEGER NOT NULL,
                delete_requested INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                idempotency_key TEXT UNIQUE NOT NULL)''')
            db.execute('BEGIN IMMEDIATE')
            columns = {row['name'] for row in db.execute('PRAGMA table_info(jobs)')}
            for name, definition in (('outputs', "TEXT NOT NULL DEFAULT '[\"mono\",\"dual\"]'"),
                                     ('options', "TEXT NOT NULL DEFAULT '{}'"),
                                     ('poll_warning', "TEXT NOT NULL DEFAULT ''")):
                if name not in columns:
                    db.execute(f'ALTER TABLE jobs ADD COLUMN {name} {definition}')
            db.execute('CREATE INDEX IF NOT EXISTS job_status ON jobs(status,created)')
            db.commit()
        os.chmod(self.database, 0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @contextlib.contextmanager
    def storage_lock(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.root / '.storage.lock').open('a+b') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def config(self):
        try:
            data = json.loads((self.root / 'config.json').read_text())
        except FileNotFoundError:
            data = {}
        return {key: data.get(key, value) for key, value in DEFAULTS.items()}

    def public_config(self):
        config = self.config()
        result = {k: v for k, v in config.items() if k not in ('api_key', 'service_token')}
        result.update(has_api_key=bool(config['api_key']), has_service_token=bool(config['service_token']))
        translation = self.load_translation_config()['deepseek']
        result['shared_key_available'] = bool(translation.get('api_key'))
        result['shared_official_endpoint'] = urlsplit(translation.get('base_url', '')).hostname == 'api.deepseek.com'
        try:
            self.credentials(config)
            result['ready'] = bool(config['endpoint'])
        except PdfError:
            result['ready'] = False
        return result

    def save_config(self, payload):
        with self.storage_lock():
            if self.active_jobs():
                raise PdfError('请先等待任务结束或取消排队任务，再修改 PDF 配置')
            config = self.config()
            for key in ('reuse_deepseek', 'enhance_compatibility', 'json_mode', 'ocr',
                        'no_watermark', 'disable_glossary', 'translate_table_text', 'rich_text'):
                if type(payload.get(key, config[key])) is not bool:
                    raise PdfError('配置选项无效')
                config[key] = payload.get(key, config[key])
            endpoint = payload.get('endpoint', '')
            if not isinstance(endpoint, str):
                raise PdfError('服务地址无效')
            endpoint = endpoint.strip()
            config['endpoint'] = service_url(endpoint) if endpoint else ''
            for key in ('api_key', 'service_token'):
                value = payload.get(key, '')
                if not isinstance(value, str) or len(value) > 4096 or '\n' in value or '\r' in value:
                    raise PdfError('密钥格式无效')
                if payload.get('clear_' + key) is True:
                    config[key] = ''
                elif value.strip():
                    config[key] = value.strip()
            model = payload.get('model', config['model'])
            if model not in MODELS:
                raise PdfError('不支持的 DeepSeek 模型')
            config['model'] = model
            for key, low, high in (('qps', 1, 1000), ('pool_size', 0, 1000), ('skip_last_pages', 0, 100000), ('retention_days', 0, 3650)):
                value = payload.get(key, config[key])
                if type(value) is not int or not low <= value <= high:
                    raise PdfError('配置数值超出允许范围')
                config[key] = value
            for key, allowed in (('thinking', ('disabled', 'enabled')), ('reasoning_effort', ('high', 'max'))):
                value = payload.get(key, config[key])
                if value not in allowed:
                    raise PdfError('DeepSeek 推理配置无效')
                config[key] = value
            if config['model'] != 'deepseek-v4-pro':
                config['thinking'] = 'disabled'
            atomic_json(self.root / 'config.json', config)
        self.ensure_worker(force=True)
        return self.public_config()

    def credentials(self, config, job=None):
        reuse = bool(job['reuse_deepseek']) if job else config['reuse_deepseek']
        if reuse:
            settings = self.load_translation_config()['deepseek']
            if urlsplit(settings.get('base_url', '')).hostname != 'api.deepseek.com':
                raise PdfError('PDF 功能当前仅支持 DeepSeek 官方接口，请使用独立密钥配置')
            key = settings.get('api_key', '')
            model = config['model']
        else:
            key, model = config['api_key'], config['model']
        if not key:
            raise PdfError('请先配置 DeepSeek API Key')
        if model not in MODELS:
            raise PdfError('请使用受支持的 DeepSeek 模型')
        return key, job['model'] if job else model

    def active_jobs(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM jobs WHERE deleted=0 AND status IN ('queued','submitting','running','fetching','unknown') ORDER BY created")]

    def get(self, job_id):
        if not re.fullmatch('[0-9a-f]{32}', str(job_id)):
            raise PdfError('任务不存在')
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=? AND deleted=0', (job_id,)).fetchone()
        if not row:
            raise PdfError('任务不存在或已删除')
        return dict(row)

    def update(self, job_id, allow_terminal=False, expected_status=None, **values):
        if 'status' in values:
            values.setdefault('poll_warning', '')
        values['updated'] = time.time()
        with self.connect() as db:
            condition = '' if allow_terminal else " AND status IN ('queued','submitting','running','fetching','unknown')"
            expected = ()
            if expected_status is not None:
                condition += ' AND status=?'
                expected = (expected_status,)
            changed = db.execute('UPDATE jobs SET ' + ','.join(k + '=?' for k in values) + ' WHERE id=? AND deleted=0' + condition, (*values.values(), job_id, *expected)).rowcount
            db.commit()
            return bool(changed)

    def directory(self, job_id):
        if not re.fullmatch('[0-9a-f]{32}', str(job_id)):
            raise PdfError('任务编号无效')
        return self.root / job_id

    def check_space(self, addition=0):
        if shutil.disk_usage(self.root).free < addition + 32 * 1024 * 1024:
            raise PdfError('PDF 存储空间不足，请删除不再需要的任务文件')

    def public_job(self, job):
        result = {k: job[k] for k in ('id', 'filename', 'source', 'target', 'model', 'status', 'phase', 'progress', 'created', 'updated', 'submitted', 'finished', 'pages', 'input_bytes', 'delete_requested', 'qps')}
        result['poll_warning'] = job.get('poll_warning', '') if job['status'] in ACTIVE else ''
        result['upstream_url'] = service_url(job['endpoint']) if job['status'] in ACTIVE else ''
        result['outputs'] = self.selected_outputs(job)
        options = json.loads(job.get('options') or '{}')
        # Publish only non-secret settings captured when this task was queued.
        visible = ('pool_size', 'thinking', 'reasoning_effort', 'ocr', 'no_watermark',
                   'disable_glossary', 'translate_table_text', 'rich_text',
                   'skip_last_pages', 'enhance_compatibility')
        result['settings'] = {key: options[key] for key in visible if key in options}
        result['settings']['reuse_deepseek'] = bool(job['reuse_deepseek'])
        result['files'] = {}
        if job['status'] == 'completed' and not job['delete_requested']:
            for kind in self.selected_outputs(job):
                path = self.directory(job['id']) / (kind + '.pdf')
                try:
                    result['files'][kind] = {'bytes': path.stat().st_size, 'url': f"/api/pdf/jobs/{job['id']}/files/{kind}"}
                except FileNotFoundError:
                    pass
        return result

    def list_jobs(self, query='', status='', page=1, scope='all'):
        conditions, params = ['deleted=0'], []
        if scope == 'history':
            conditions.append("status NOT IN ('queued','submitting','running','fetching','unknown')")
        elif scope != 'all':
            raise PdfError('任务分组无效')
        if query:
            conditions.append('instr(lower(filename),lower(?))>0')
            params.append(query[:120])
        if status:
            if status not in ACTIVE + TERMINAL:
                raise PdfError('任务状态无效')
            conditions.append('status=?')
            params.append(status)
        where = ' AND '.join(conditions)
        with self.connect() as db:
            count = db.execute('SELECT COUNT(*) FROM jobs WHERE ' + where, params).fetchone()[0]
            rows = db.execute('SELECT * FROM jobs WHERE ' + where + ' ORDER BY created DESC LIMIT 20 OFFSET ?', (*params, (page - 1) * 20)).fetchall()
        return dict(jobs=[self.public_job(dict(row)) for row in rows], total=count, page=page, retention_days=self.config()['retention_days'],
                    active_jobs=[self.public_job(j) for j in self.active_jobs()])

    def enqueue(self, upload, source, target, key, language_codes, outputs=None, skip_last_pages=None):
        outputs = ['mono', 'dual'] if outputs is None else outputs
        if not isinstance(outputs, list) or not outputs or any(k not in ('mono', 'dual') for k in outputs) or len(set(outputs)) != len(outputs):
            raise PdfError('请至少选择一种产物：译文 PDF 或左右对照 PDF')
        if source not in {'en', 'zh'} or target not in {'en', 'zh'} or source == target or 'auto' in (source, target):
            raise PdfError('请选择不同的源语言和目标语言；PDF 暂不使用自动检测')
        if not re.fullmatch('[0-9a-f]{32}', key or ''):
            raise PdfError('上传标识无效，请刷新页面')
        filename = str(upload.filename or '').replace('\\', '/').split('/')[-1]
        filename = ''.join(c for c in filename if ord(c) >= 32).strip()
        if not filename.lower().endswith('.pdf'):
            raise PdfError('仅支持上传 PDF 文件')
        if len(filename) > 180:
            filename = filename[:176] + '.pdf'
        with self.storage_lock():
            with self.connect() as db:
                previous = db.execute('SELECT * FROM jobs WHERE idempotency_key=?', (key,)).fetchone()
            if previous:
                if previous['deleted']:
                    raise PdfError('此上传任务已删除，请重新选择文件')
                return self.public_job(dict(previous))
            config = self.config()
            if skip_last_pages is not None:
                if not isinstance(skip_last_pages, str) or not re.fullmatch(r'[0-9]{1,6}', skip_last_pages) or int(skip_last_pages) > 100000:
                    raise PdfError('跳过末尾页数应为 0 至 100000 的整数')
                # This upload overrides the snapshot only, never the shared configuration.
                config['skip_last_pages'] = int(skip_last_pages)
            endpoint = service_url(config['endpoint'])
            _, model = self.credentials(config)
            if len(self.active_jobs()) >= 10:
                raise PdfError('排队任务已达 10 个，请等待任务完成')
            job_id = uuid.uuid4().hex
            directory = self.directory(job_id)
            directory.mkdir(mode=0o700)
            try:
                path = directory / 'source.pdf'
                size = 0
                with path.open('xb') as handle:
                    os.chmod(path, 0o600)
                    while chunk := upload.stream.read(1024 * 1024):
                        size += len(chunk)
                        self.check_space(len(chunk))
                        handle.write(chunk)
                pages = self.validate_pdf(path)
                if config['skip_last_pages'] >= pages:
                    raise PdfError('跳过末尾页数必须少于 PDF 总页数，请在上传区域调整')
                options = {k: v for k, v in config.items() if k not in ('api_key', 'service_token', 'endpoint')}
                now = time.time()
                with self.connect() as db:
                    db.execute('''INSERT INTO jobs(id,filename,source,target,model,endpoint,reuse_deepseek,qps,status,phase,created,updated,pages,input_bytes,idempotency_key,outputs,options)
                                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                               (job_id, filename, source, target, model, endpoint, int(config['reuse_deepseek']), config['qps'], 'queued', '等待翻译', now, now, pages, size, key, json.dumps(outputs), json.dumps(options)))
                    db.commit()
            except Exception:
                shutil.rmtree(directory, ignore_errors=True)
                raise
        self.ensure_worker(force=True)
        return self.public_job(self.get(job_id))

    @staticmethod
    def validate_pdf(path):
        try:
            with path.open('rb') as handle:
                if not handle.read(1024).lstrip().startswith(b'%PDF-'):
                    raise PdfError('文件不是有效的 PDF')
                handle.seek(0)
                pdf = PdfReader(handle, strict=False)
                if pdf.is_encrypted:
                    raise PdfError('暂不支持加密 PDF，请先解密')
                count = len(pdf.pages)
                if count < 1:
                    raise PdfError('PDF 没有可用页面')
                return count
        except PdfError:
            raise
        except Exception:
            raise PdfError('PDF 无法读取或已损坏') from None

    def headers(self, endpoint):
        config = self.config()
        token = config['service_token'] if endpoint == config['endpoint'] else ''
        return {'Authorization': 'Bearer ' + token} if token else {}

    @contextlib.contextmanager
    def response(self, method, endpoint, path, **kwargs):
        endpoint = service_url(endpoint)
        with requests.Session() as session:
            session.trust_env = False
            with session.request(method, endpoint + path, headers={**self.headers(endpoint), **kwargs.pop('headers', {})}, timeout=kwargs.pop('timeout', (5, 35)), allow_redirects=False, **kwargs) as response:
                if not 200 <= response.status_code < 300:
                    raise PdfError(f'上游服务返回 HTTP {response.status_code}')
                yield response

    def remote_json(self, method, endpoint, path, **kwargs):
        with self.response(method, endpoint, path, stream=True, **kwargs) as response:
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 4 * 1024 * 1024:
                    raise PdfError('上游任务响应过大')
            try:
                return json.loads(data)
            except ValueError:
                raise PdfError('上游返回了无效的 JSON') from None

    def health(self, endpoint=None, token='', clear_token=False):
        config = self.config()
        endpoint = service_url(endpoint if endpoint is not None else config['endpoint'])
        # A saved token is never forwarded to a different, unsaved service address.
        effective = token or (config['service_token'] if endpoint == config['endpoint'] and not clear_token else '')
        data = self.remote_json('GET', endpoint, '/health',
                                headers={'Authorization': 'Bearer ' + effective if effective else ''}, timeout=(3, 5))
        if not isinstance(data, dict) or data.get('status') != 'ok':
            raise PdfError('该地址不是可用的 PDF2zh 服务')
        return {'ok': True, 'version': str(data.get('version', '未知'))[:30]}

    def connection_status(self, force=False):
        # Share a short-lived probe between tabs; never confuse draft settings with saved ones.
        config = self.config()
        identity = (config['endpoint'], config['service_token'])
        with self.health_lock:
            cached = self.health_snapshot
            if not force and cached and cached[0] == identity and time.monotonic() - cached[1] < 30:
                return cached[2]
            try:
                result = self.health()
            except (PdfError, requests.RequestException):
                result = {'ok': False}
            self.health_snapshot = (identity, time.monotonic(), result)
            return result

    def remote_tasks(self, endpoint):
        data = self.remote_json('GET', endpoint, '/api/tasks')
        if not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
            raise PdfError('上游任务列表格式不兼容')
        return data['tasks']

    def ensure_worker(self, force=False):
        if not self.database.exists():
            return
        # Recovery may start from the homepage before any PDF route initializes us.
        self.initialize()
        if force:
            self.wake.set()
        with self.thread_lock:
            if self.thread and self.thread.is_alive():
                return
            if not force and time.monotonic() - self.last_attempt < 15:
                return
            self.last_attempt = time.monotonic()
            self.thread = threading.Thread(target=self.worker, name='pdf-translation', daemon=True)
            self.thread.start()

    def worker(self):
        with (self.root / '.worker.lock').open('a+b') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            while True:
                try:
                    self.tick()
                    if time.monotonic() - self.last_cleanup > 60:
                        self.cleanup()
                        self.last_cleanup = time.monotonic()
                except Exception:
                    # Do not log upstream payloads/exception strings: they may contain credentials.
                    self.logger.warning('PDF task worker encountered an error; state retained for recovery')
                self.wake.wait(3 if self.active_jobs() else 60)
                self.wake.clear()

    def tick(self):
        jobs = self.active_jobs()
        running = next((j for j in jobs if j['status'] != 'queued'), None)
        if running:
            self.process(running)
            return
        if not jobs:
            return
        job = jobs[0]
        try:
            remote = self.remote_tasks(job['endpoint'])
            if any(t.get('active') for t in remote if isinstance(t, dict)):
                self.update(job['id'], phase='上游正在处理其他任务，等待空闲')
                return
            self.credentials(self.config(), job)
        except Exception:
            self.update(job['id'], phase='服务不可用或配置无效，等待恢复；尚未提交')
            return
        # Persist before sending. A timeout/restart must NEVER automatically resubmit a chargeable job.
        with self.storage_lock():
            current = self.get(job['id'])
            if current['status'] != 'queued' or current['delete_requested']:
                return
            self.update(job['id'], status='submitting', phase='正在提交到翻译服务', submitted=time.time())
        self.submit(self.get(job['id']))

    @staticmethod
    def selected_outputs(job):
        # Old tasks were always dual-output tasks.
        return json.loads(job.get('outputs') or '["mono","dual"]')

    def translation_payload(self, job, config, key, model):
        options = {**config, **json.loads(job.get('options') or '{}')}
        outputs = self.selected_outputs(job)
        extra = {'deepseek_enable_json_mode': options['json_mode'],
                 'deepseek_thinking_mode': options['thinking'] if model == 'deepseek-v4-pro' else 'disabled'}
        if extra['deepseek_thinking_mode'] == 'enabled':
            extra['deepseek_reasoning_effort'] = options['reasoning_effort']
        return dict(fileName='trans-' + job['id'] + '.pdf',
                    engine='pdf2zh_next', service='deepseek', next_service='deepseek', asyncJob=True,
                    sourceLang='zh-CN' if job['source'] == 'zh' else job['source'],
                    targetLang='zh-CN' if job['target'] == 'zh' else job['target'],
                    mono='mono' in outputs, dual='dual' in outputs,
                    noMono='mono' not in outputs, noDual='dual' not in outputs,
                    dualMode='LR', transFirst=False,
                    translateTableText=options['translate_table_text'],
                    ocr=options['ocr'], autoOcr=False, noWatermark=options['no_watermark'],
                    disableGlossary=options['disable_glossary'], saveGlossary=False,
                    qps=job['qps'], poolSize=options['pool_size'], fontFamily='auto',
                    enhanceCompatibility=options['enhance_compatibility'],
                    disableRichTextTranslate=not options['rich_text'],
                    skipLastPages=options['skip_last_pages'], onlyIncludeTranslatedPage=False,
                    llm_api={'apiKey': key, 'model': model, 'extraData': extra})

    def submit(self, job):
        request_started = False
        try:
            key, model = self.credentials(self.config(), job)
            config = self.config()
            payload = self.translation_payload(job, config, key, model)
            self.update(job['id'], expected_status='submitting', phase='正在准备上传文件', progress=None)
            # The upstream protocol requires Base64 JSON. Spool it to disk so large
            # documents do not create several full-sized copies in RAM.
            with tempfile.TemporaryFile(dir=self.root) as body:
                body.write(json.dumps(payload).encode('utf-8')[:-1] + b',"fileContent":"')
                with (self.directory(job['id']) / 'source.pdf').open('rb') as source:
                    while chunk := source.read(3 * 256 * 1024):
                        encoded = base64.b64encode(chunk)
                        self.check_space(len(encoded))
                        body.write(encoded)
                body.write(b'"}')
                body_size = body.tell()
                body.seek(0)
                def report(sent, total, speed):
                    phase = (f'正在发送到翻译服务 · {sent / 1048576:.2f}/{total / 1048576:.2f} MB'
                             f' · {speed / 1024:.0f} KB/s')
                    if sent == total:
                        phase = '文件已发送，等待上游确认'
                    try:
                        self.update(job['id'], expected_status='submitting', phase=phase,
                                    progress=None if sent == total else sent / total * 100)
                    except sqlite3.Error:
                        # A progress-display failure must not interrupt a chargeable request.
                        pass
                self.update(job['id'], expected_status='submitting', phase='正在连接并发送到翻译服务', progress=0)
                request_started = True
                data = self.remote_json('POST', job['endpoint'], '/translate', data=UploadBody(body, body_size, report),
                                        headers={'Content-Type': 'application/json', 'Content-Length': str(body_size)},
                                        timeout=(60, 180))
            if isinstance(data, dict) and data.get('status') == 'accepted' and isinstance(data.get('taskId'), str):
                self.update(job['id'], status='running', remote_id=data['taskId'][:128], phase='翻译服务已接收', progress=None)
            elif isinstance(data, dict) and data.get('status') == 'success':
                self.receive_files(job, data.get('fileList', []))
            else:
                self.update(job['id'], status='unknown', phase='提交结果不明确，请核对上游；不会自动重复提交', progress=None)
        except Exception as exc:
            # Log only the exception type; messages may include credentials or payloads.
            self.logger.warning('PDF submission interrupted task=%s error_type=%s', job['id'], type(exc).__name__)
            if request_started:
                self.update(job['id'], status='unknown', phase='提交连接中断，正在核对上游；不会自动重复提交', progress=None)
            else:
                self.update(job['id'], status='failed', phase='文件准备失败，尚未提交上游；请检查存储空间与配置', progress=None, finished=time.time())

    def process(self, job):
        if job['status'] == 'fetching':
            self.fetch_results(job)
            return
        try:
            records = self.remote_tasks(job['endpoint'])
            match = self.find_remote(job, records)
            if not match:
                history = self.remote_json('GET', job['endpoint'], '/api/history')
                match = self.find_remote(job, history.get('history', []) if isinstance(history, dict) else [])
            if match:
                if match.get('status') in ('failed', '失败'):
                    self.update(job['id'], expected_status=job['status'], status='failed', phase='上游翻译失败，请在服务端查看日志', finished=time.time())
                    self.finish_delete(job['id'])
                elif match.get('status') in ('success', '完成') or (match.get('finished') and match.get('fileList')):
                    self.receive_files(job, match.get('fileList') or (match.get('result') or {}).get('fileList', []))
                else:
                    phase, progress = translation_progress(match)
                    values = dict(status='running', remote_id=str(match.get('taskId') or job['remote_id'] or '')[:128],
                                  phase=phase, progress=progress, poll_warning='')
                    if any(job.get(key) != value for key, value in values.items()):
                        self.update(job['id'], expected_status=job['status'], **values)
                return
            if time.time() - (job['submitted'] or job['created']) < 90:
                if job.get('poll_warning'):
                    self.update(job['id'], expected_status=job['status'], poll_warning='')
                return
            # File discovery is only for this unpredictable task prefix. Never expose upstream-wide history.
            info = self.remote_json('GET', job['endpoint'], '/translatedInfo?stem=trans-' + job['id'])
            files = [f.get('fileName') for f in info.get('files', []) if isinstance(f, dict)] if isinstance(info, dict) else []
            try:
                self.output_names(job, files)
            except PdfError:
                self.update(job['id'], expected_status=job['status'], status='unknown', phase='上游记录缺失，队列暂停；请核对上游任务是否已结束')
                return
            # Do not assume files are finished after an upstream restart; explicit confirmation is required.
            self.update(job['id'], expected_status=job['status'], status='unknown', phase='发现可能的结果，但上游状态缺失；请核对结束后选择取回结果')
        except Exception as exc:
            # A failed poll says nothing about whether the remote translation stopped.
            if isinstance(exc, requests.Timeout):
                warning = '状态查询超时，正在重试；上游任务可能仍在运行'
            elif isinstance(exc, requests.ConnectionError):
                warning = '状态查询连接失败，正在重试；上游任务可能仍在运行'
            else:
                warning = '任务状态暂未更新，正在重试；不代表上游翻译停止'
            values = {}
            if job.get('poll_warning', '') != warning:
                values['poll_warning'] = warning
                self.logger.warning('PDF status poll failed task=%s error_type=%s', job['id'], type(exc).__name__)
            if job['phase'] == '暂时无法连接上游，任务仍保留；正在等待恢复':
                values.update(phase='等待上游状态更新', progress=None)
            if values:
                self.update(job['id'], expected_status=job['status'], **values)

    @staticmethod
    def find_remote(job, records):
        for record in records:
            if not isinstance(record, dict):
                continue
            if ((job['remote_id'] and record.get('taskId') == job['remote_id'])
                    or record.get('fileName') == 'trans-' + job['id'] + '.pdf'):
                return record
        return None

    @staticmethod
    def output_names(job, filenames):
        output = {}
        prefix = 'trans-' + job['id']
        for name in filenames:
            if not isinstance(name, str) or len(name) > 240 or '/' in name or '\\' in name or not name.startswith(prefix + '.') or not name.endswith('.pdf'):
                continue
            if name.endswith('.mono.pdf'):
                output['mono'] = name
            if name.endswith('.LR_dual.pdf') or name.endswith('.dual.pdf'):
                output['dual'] = name
        expected = PdfTasks.selected_outputs(job)
        if not all(kind in output for kind in expected):
            raise PdfError('上游没有返回所选的全部 PDF 产物')
        return {kind: output[kind] for kind in expected}

    def receive_files(self, job, filenames):
        try:
            output = self.output_names(job, filenames)
        except PdfError:
            self.update(job['id'], expected_status=job['status'], status='download_failed', phase='结果不完整，请核对上游后重新获取结果', finished=time.time())
            self.finish_delete(job['id'])
            return
        if not self.update(job['id'], expected_status=job['status'], status='fetching', remote_files=json.dumps(output), phase='翻译完成，正在保存 PDF', progress=99):
            return
        self.fetch_results(self.get(job['id']))

    def fetch_results(self, job):
        if job['status'] != 'fetching':
            return
        try:
            if job['delete_requested']:
                self.update(job['id'], status='cancelled', finished=time.time())
                self.finish_delete(job['id'])
                return
            files = json.loads(job['remote_files'])
            self.output_names(job, list(files.values()))
            for kind in self.selected_outputs(job):
                path = self.directory(job['id']) / (kind + '.pdf')
                if path.is_file():
                    try:
                        self.validate_pdf(path)
                        continue
                    except PdfError:
                        path.unlink(missing_ok=True)
                temp = path.with_suffix('.part')
                try:
                    with self.response('GET', job['endpoint'], '/translatedFile/' + quote(files[kind], safe=''), stream=True) as response:
                        with temp.open('wb') as handle:
                            os.chmod(temp, 0o600)
                            for chunk in response.iter_content(1024 * 1024):
                                if self.get(job['id'])['delete_requested']:
                                    raise PdfError('任务已标记清理')
                                with self.storage_lock():
                                    self.check_space(len(chunk))
                                    handle.write(chunk)
                    self.validate_pdf(temp)
                    os.replace(temp, path)
                finally:
                    temp.unlink(missing_ok=True)
            self.update(job['id'], status='completed', phase='所选 PDF 已保存，可随时下载', progress=100, finished=time.time())
        except Exception:
            self.update(job['id'], status='download_failed', phase='结果获取或校验失败；可重新获取，不会再次翻译', finished=time.time())
        self.finish_delete(job['id'])

    def finish_delete(self, job_id):
        with self.storage_lock():
            try:
                job = self.get(job_id)
            except PdfError:
                return
            if job['delete_requested'] and job['status'] not in ACTIVE:
                self.erase(job)

    def erase(self, job):
        shutil.rmtree(self.directory(job['id']), ignore_errors=False) if self.directory(job['id']).exists() else None
        # Keep only an idempotency tombstone; no filename/config/history remains visible.
        with self.connect() as db:
            db.execute("UPDATE jobs SET deleted=1,filename='',source='',target='',model='',endpoint='',remote_id=NULL,remote_files='{}',options='{}',outputs='[]',phase='',poll_warning='',pages=0,input_bytes=0 WHERE id=?", (job['id'],))
            db.commit()

    def action(self, job_id, action):
        snapshot = self.get(job_id)
        files = None
        check_remote = (action == 'retry_download' and snapshot['status'] in ('download_failed', 'unknown', 'completed')) or (
            action in ('cancel', 'acknowledge') and snapshot['status'] == 'unknown')
        if check_remote:
            # Network probes must not block uploads, downloads or cleanup under the file lock.
            remote = self.find_remote(snapshot, self.remote_tasks(snapshot['endpoint']))
            if remote and remote.get('active'):
                raise PdfError('上游任务仍在运行，请等待结束')
            if action == 'retry_download':
                info = self.remote_json('GET', snapshot['endpoint'], '/translatedInfo?stem=trans-' + job_id)
                if not isinstance(info, dict) or not isinstance(info.get('files'), list):
                    raise PdfError('上游文件列表格式不兼容')
                files = self.output_names(snapshot, [f.get('fileName') for f in info['files'] if isinstance(f, dict)])
        with self.storage_lock():
            job = self.get(job_id)
            if check_remote and (job['status'], job['remote_id']) != (snapshot['status'], snapshot['remote_id']):
                raise PdfError('任务状态已更新，请刷新后重试')
            if action == 'delete':
                if job['status'] in ACTIVE:
                    raise PdfError('进行中的任务不能删除，请先取消或等待结束')
                self.erase(job)
            elif action == 'cancel' and job['status'] == 'queued':
                if not self.update(job_id, expected_status=job['status'], status='cancelled', phase='排队已取消，原文件仍保留', finished=time.time()):
                    raise PdfError('任务状态已更新，请刷新后重试')
            elif action == 'cancel' and job['status'] == 'unknown' and check_remote:
                if not self.update(job_id, expected_status=job['status'], status='cancelled', phase='已核对上游结束或未创建任务，取消本地跟踪', finished=time.time()):
                    raise PdfError('任务状态已更新，请刷新后重试')
            elif action == 'retry_download' and files is not None:
                if not self.update(job_id, allow_terminal=True, expected_status=job['status'], status='fetching', remote_files=json.dumps(files), phase='等待重新获取结果', finished=None):
                    raise PdfError('任务状态已更新，请刷新后重试')
            elif action == 'acknowledge' and job['status'] == 'unknown' and check_remote:
                if not self.update(job_id, expected_status=job['status'], status='interrupted', phase='已确认上游结束；如需重试，请重新上传', finished=time.time()):
                    raise PdfError('任务状态已更新，请刷新后重试')
                if job['delete_requested']:
                    self.erase(self.get(job_id))
            else:
                raise PdfError('当前任务不能执行此操作')
        self.ensure_worker(force=True)

    def cleanup(self):
        days = self.config()['retention_days']
        if not days:
            return
        with self.storage_lock():
            with self.connect() as db:
                rows = db.execute("SELECT * FROM jobs WHERE deleted=0 AND status IN ('completed','failed','interrupted','download_failed','cancelled') AND finished<?", (time.time() - days * 86400,)).fetchall()
            for row in rows:
                self.erase(dict(row))


def install(app, root, require_auth, load_config, languages):
    # Only this endpoint is exempt from the existing book/JSON request limits.
    base_request = app.request_class
    class PdfUploadRequest(base_request):
        @property
        def max_content_length(self):
            if self.path == '/api/pdf/jobs' and self.method == 'POST':
                return None
            return base_request.max_content_length.fget(self)

        @max_content_length.setter
        def max_content_length(self, value):
            base_request.max_content_length.fset(self, value)

    app.request_class = PdfUploadRequest
    manager = PdfTasks(root, load_config, app.logger)
    app.extensions['pdf_tasks'] = manager
    bp = Blueprint('pdf_translation', __name__)

    @bp.before_request
    def authenticate():
        if not require_auth():
            if request.path.startswith('/api/'):
                return jsonify(error='unauthorized'), 401
            return redirect('/login')
        manager.initialize()
        manager.ensure_worker()

    @bp.errorhandler(PdfError)
    def handle_error(error):
        return jsonify(error=str(error)), 400

    @bp.errorhandler(requests.RequestException)
    def handle_network_error(error):
        return jsonify(error='无法连接 PDF2zh 服务，请检查内网地址、端口和访问凭据'), 502

    @bp.route('/translate/pdf')
    def page():
        return render_template('pdf_translation.html', languages=[l for l in languages if l['code'] in ('en', 'zh')])

    @bp.route('/api/pdf/config', methods=['GET', 'PUT'])
    def config():
        if request.method == 'PUT':
            data = request.get_json()
            if not isinstance(data, dict):
                raise PdfError('配置必须是 JSON 对象')
            return jsonify(config=manager.save_config(data))
        return jsonify(config=manager.public_config())

    @bp.route('/api/pdf/health', methods=['GET', 'POST'])
    def health():
        if request.method == 'GET':
            return jsonify(manager.connection_status(force=request.args.get('refresh') == '1'))
        data = request.get_json(silent=True)
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise PdfError('配置格式无效')
        endpoint = data.get('endpoint', manager.config()['endpoint'])
        token = data.get('service_token', '')
        if not isinstance(token, str) or len(token) > 4096 or any(ord(c) < 32 for c in token):
            raise PdfError('访问令牌无效')
        return jsonify(manager.health(endpoint, token, data.get('clear_service_token') is True))

    @bp.route('/api/pdf/jobs', methods=['GET', 'POST'])
    def jobs():
        if request.method == 'POST':
            files = request.files.getlist('file')
            if len(files) != 1 or len(request.files) != 1:
                raise PdfError('一次请选择一个 PDF 文件')
            job = manager.enqueue(files[0], request.form.get('source', ''), request.form.get('target', ''),
                                  request.form.get('upload_id', ''), {l['code'] for l in languages},
                                  request.form.getlist('outputs') if 'outputs' in request.form else None,
                                  request.form.get('skip_last_pages'))
            return jsonify(job=job), 202
        try:
            page = max(1, min(100000, int(request.args.get('page', '1'))))
        except ValueError:
            raise PdfError('页码无效') from None
        return jsonify(manager.list_jobs(request.args.get('q', '').strip(), request.args.get('status', ''), page, request.args.get('scope', 'all')))

    @bp.route('/api/pdf/jobs/<job_id>', methods=['DELETE'])
    def delete(job_id):
        manager.action(job_id, 'delete')
        return jsonify(ok=True, message='仅删除 Trans 文件；上游副本需由服务管理员清理')

    @bp.route('/api/pdf/jobs/<job_id>/action', methods=['POST'])
    def action(job_id):
        data = request.get_json()
        if not isinstance(data, dict):
            raise PdfError('操作无效')
        manager.action(job_id, data.get('action'))
        return jsonify(ok=True)

    @bp.route('/api/pdf/jobs/<job_id>/files/<kind>')
    def download(job_id, kind):
        if kind not in ('mono', 'dual'):
            raise PdfError('文件不存在')
        with manager.storage_lock():
            job = manager.get(job_id)
            if job['status'] != 'completed' or job['delete_requested']:
                raise PdfError('结果尚未准备完成或正在删除')
            path = manager.directory(job_id) / (kind + '.pdf')
            if not path.is_file():
                raise PdfError('结果文件已丢失，请重新获取')
            handle = path.open('rb')
            # Open under the same lock as deletion; ongoing downloads retain their descriptor.
            name = Path(job['filename']).stem + ('-译文.pdf' if kind == 'mono' else '-左右对照.pdf')
            try:
                response = send_file(handle, mimetype='application/pdf',
                                     as_attachment=request.args.get('preview') != '1',
                                     download_name=name, max_age=0, conditional=False)
                length = os.fstat(handle.fileno()).st_size
                response.content_length = length
                response.make_conditional(request.environ, accept_ranges=True, complete_length=length)
                response.headers['Cache-Control'] = 'no-store'
                response.call_on_close(handle.close)
                return response
            except Exception:
                handle.close()
                raise

    app.register_blueprint(bp)

    @app.before_request
    def resume_pdf_tasks():
        # Existing queues resume on the first authenticated application request after a restart.
        if request.path.startswith('/static/') or (manager.thread and manager.thread.is_alive()):
            return
        if time.monotonic() - manager.last_attempt < 15:
            return
        if manager.database.exists() and require_auth():
            manager.ensure_worker()

    return manager
