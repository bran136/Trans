"""Load the real backend in a disposable directory without production data."""

import importlib.util
import os
from contextlib import ExitStack, contextmanager
from functools import lru_cache
from pathlib import Path
import shutil
import sys
import tempfile
from unittest.mock import patch


@lru_cache(maxsize=1)
def app_code():
    # Compile once per test run; __file__ and all mutable state remain per fixture.
    path = Path(__file__).resolve().parents[1] / "app.py"
    return compile(path.read_bytes(), str(path), "exec")


@contextmanager
def isolated_app():
    source = Path(__file__).resolve().parents[1]
    with ExitStack() as stack:
        root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="trans-test-")))
        # Explicit allowlist: never copy .env, private config, books or caches.
        for name in ("app.py", "reader_search.py", "reader_pdf.py", "reader_backup.py", "backup_crypto.py", "backup_settings.py", "pdf_translation.py", "VERSION",
                     "config/service_config.example.json"):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        stack.enter_context(patch.dict(os.environ, {
            "APP_PASSWORD": "test-only-password-not-for-deployment",
            "SECRET_KEY": "test-only-session-key-not-for-deployment",
        }, clear=True))
        stack.enter_context(patch("requests.sessions.Session.request", side_effect=AssertionError(
            "Tests must mock upstream requests; external HTTP is disabled")))
        stack.enter_context(patch("socket.socket.connect", side_effect=AssertionError(
            "Tests must not open network connections")))
        previous_path = sys.path[:]
        sys.path.insert(0, str(root))
        stack.callback(lambda: sys.path.__setitem__(slice(None), previous_path))
        # Reload only project modules. Reimporting third-party packages for every
        # case is slow and can break cached class identities in native extensions.
        names = ("trans_test_app", "reader_search", "reader_pdf", "reader_backup", "backup_crypto", "backup_settings", "pdf_translation")
        previous = {name: sys.modules.get(name) for name in names}
        def restore_modules():
            for name, value in previous.items():
                if value is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = value
        stack.callback(restore_modules)
        for name in names:
            sys.modules.pop(name, None)
        spec = importlib.util.spec_from_file_location("trans_test_app", root / "app.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        exec(app_code(), module.__dict__)
        try:
            yield module
        finally:
            for handler in list(module.app.logger.handlers):
                if getattr(handler, "baseFilename", "").startswith(str(root) + os.sep):
                    module.app.logger.removeHandler(handler)
                    handler.close()
