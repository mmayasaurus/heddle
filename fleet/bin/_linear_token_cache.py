"""Safe shared cache for Linear OAuth client-credentials tokens."""

import json
import os
import pathlib
import secrets
import stat
import time


_TOKEN_EXPIRY_SKEW = 86400


def _cache_path(fleet_dir, key):
    return pathlib.Path(fleet_dir) / f"token-{key}.json"


def _ensure_fleet_dir(fleet_dir):
    fleet = pathlib.Path(fleet_dir)
    try:
        info = fleet.lstat()
    except FileNotFoundError:
        try:
            fleet.mkdir(mode=0o700, parents=True)
        except FileExistsError:
            pass
        info = fleet.lstat()

    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"Linear token cache directory {fleet} must be a directory owned by this user")
    if info.st_uid != os.geteuid():
        raise RuntimeError(f"Linear token cache directory {fleet} must be owned by the effective uid")
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RuntimeError(f"Linear token cache directory {fleet} is group/other-writable")
    os.chmod(fleet, 0o700)
    return fleet


def read_cached_token(fleet_dir, key):
    """Return a complete, unexpired cached access token, otherwise ``None``."""
    cache = _cache_path(fleet_dir, key)
    try:
        with open(cache, encoding="utf-8") as handle:
            tok = json.load(handle)
            # fstat the SAME open fd we just parsed — never stat the path after close, which under a
            # concurrent atomic replace would pair this file's content with a different file's mtime.
            age = time.time() - os.fstat(handle.fileno()).st_mtime
        expires_in = tok.get("expires_in", 0)
        access_token = tok.get("access_token")
        if age < expires_in - _TOKEN_EXPIRY_SKEW and isinstance(access_token, str) and access_token:
            return access_token
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return None


def _fsync_directory(directory):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(directory, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_token_cache(fleet_dir, key, tok):
    """Durably atomically replace one token cache, with no permissive-file window."""
    fleet = _ensure_fleet_dir(fleet_dir)
    cache = _cache_path(fleet, key)
    payload = json.dumps(tok).encode("utf-8")
    temporary = fleet / f".token-{key}.{os.getpid()}.{secrets.token_hex(16)}.tmp"
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.fchmod(fd, 0o600)  # force exactly 0600 on the inode regardless of umask (an owner-stripping umask could clear owner bits at create)
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, cache)
        # The token is now atomically installed at 0600. The directory fsync only hardens durability of
        # the rename across a crash; some filesystems (NFS/FUSE) reject dir fsync. It must never fail the
        # caller after a successful replace — best-effort only.
        try:
            _fsync_directory(fleet)
        except OSError:
            pass
    except BaseException:
        if fd is not None:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def get_or_mint_token(fleet_dir, key, mint_fn):
    """Read or mint one token while serializing cache refreshes for ``key``."""
    try:
        import fcntl
    except ImportError as exc:  # POSIX-only; token-free consumers import this module without needing it
        raise RuntimeError(
            "Linear token minting requires POSIX file locking (fcntl), unavailable on this platform") from exc
    fleet = _ensure_fleet_dir(fleet_dir)
    lock_path = fleet / f"token-{key}.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        cached = read_cached_token(fleet, key)
        if cached is not None:
            return cached
        tok = mint_fn()
        write_token_cache(fleet, key, tok)
        return tok["access_token"]
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
