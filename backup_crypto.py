"""Versioned, streaming encrypted archives; passwords never enter task metadata.

V1: magic + salt(16) + nonce(12) + header HMAC(32), GCM ciphertext, tag(16).
Scrypt derives independent AES-256 and header-authentication keys. Fixed KDF
parameters prevent an uploaded file from requesting unbounded CPU or memory.
"""
from contextlib import contextmanager
import hmac
import os
import tempfile
import zipfile

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"TRANSBK\x01"
HEADER_SIZE = len(MAGIC) + 16 + 12 + 32
MAX_BYTES = (1 << 36) - 32  # GCM's per-message plaintext limit.


def password_value(value, required=False):
    if not isinstance(value, str) or len(value) > 256 or (value or required) and len(value) < 12:
        raise ValueError("加密备份密码需要 12～256 个字符")
    return value


def keys(password, salt):
    return Scrypt(salt=salt, length=64, n=2**15, r=8, p=1).derive(password.encode("utf-8"))


def is_encrypted(path):
    with path.open("rb") as stream:
        return stream.read(len(MAGIC)) == MAGIC


class EncryptedWriter:
    """Non-seekable ZIP sink; no plaintext archive is ever written to a path."""
    def __init__(self, stream, password):
        salt, nonce = os.urandom(16), os.urandom(12)
        key = keys(password, salt)
        header = MAGIC + salt + nonce
        header += hmac.digest(key[32:], header, "sha256")
        self.cipher = Cipher(algorithms.AES(key[:32]), modes.GCM(nonce)).encryptor()
        self.cipher.authenticate_additional_data(header)
        self.stream, self.position = stream, 0
        stream.write(header)

    def tell(self):
        return self.position

    def write(self, data):
        if self.position + len(data) > MAX_BYTES:
            raise ValueError("单份加密备份过大，请分批备份")
        self.stream.write(self.cipher.update(data))
        self.position += len(data)
        return len(data)

    def flush(self):
        self.stream.flush()

    def finish(self):
        self.stream.write(self.cipher.finalize())
        self.stream.write(self.cipher.tag)


@contextmanager
def write_archive(path, password=""):
    password_value(password)
    try:
        with path.open("wb") as stream:
            os.chmod(path, 0o600)
            target = EncryptedWriter(stream, password) if password else stream
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
                yield archive
            if password:
                target.finish()
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@contextmanager
def read_archive(path, password="", reserve=None, report=None):
    if not is_encrypted(path):
        with zipfile.ZipFile(path) as archive:
            yield archive
        return
    password_value(password, required=True)
    with path.open("rb") as stream:
        header = stream.read(HEADER_SIZE)
        remaining = path.stat().st_size - HEADER_SIZE - 16
        if len(header) != HEADER_SIZE or not 0 <= remaining <= MAX_BYTES:
            raise ValueError("加密备份文件不完整或过大")
        key = keys(password, header[8:24])
        if not hmac.compare_digest(hmac.digest(key[32:], header[:-32], "sha256"), header[-32:]):
            raise ValueError("备份密码错误或文件已损坏")
        if reserve:
            reserve(remaining)
        total = remaining
        # POSIX TemporaryFile is unlinked: it cannot survive a crash or appear in
        # the server's backup list. Authenticate fully before parsing any ZIP data.
        with tempfile.TemporaryFile(dir=path.parent) as plaintext:
            cipher = Cipher(algorithms.AES(key[:32]), modes.GCM(header[24:36])).decryptor()
            cipher.authenticate_additional_data(header)
            while remaining:
                data = stream.read(min(1024 * 1024, remaining))
                if not data:
                    raise ValueError("加密备份文件不完整")
                plaintext.write(cipher.update(data))
                remaining -= len(data)
                if report:
                    report(total - remaining, total)
            try:
                plaintext.write(cipher.finalize_with_tag(stream.read(16)))
            except (InvalidTag, ValueError):
                raise ValueError("备份密码错误或文件已损坏") from None
            plaintext.seek(0)
            with zipfile.ZipFile(plaintext) as archive:
                yield archive
