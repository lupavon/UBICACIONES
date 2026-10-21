"""Publicar stock durante un proceso largo usando su sesión Copérnico existente.
Sólo biblioteca estándar. No inicia ni cierra sesiones y no imprime tokens.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
import urllib.request


def iso_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, data):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        json.dump(data, file, ensure_ascii=False, separators=(",", ":"))
        temp = file.name
    os.replace(temp, path)


def timestamp(payload):
    if not isinstance(payload, dict):
        return 0.0
    value = payload.get("updated_at") or payload.get("stock_updated_at") or ""
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


class StockPublisher:
    """Commit de dos archivos sin resetear el checkout que usa el cálculo activo."""
    def __init__(self, repo=".", remote="origin", branch="main"):
        self.repo = Path(repo).resolve()
        self.remote, self.branch = remote, branch

    def git(self, *args, env=None, data=None):
        return subprocess.run(["git", *args], cwd=self.repo, env=env, input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              check=True, timeout=25).stdout.decode().strip()

    def publish(self, extra_files=()):
        names = [name for name in ("stock.json", "stock-sync-status.json", *extra_files) if (self.repo / name).exists()]
        if not names:
            return False
        # Capturar bytes del mismo ciclo antes de reintentar contra cambios remotos.
        captured = {name: (self.repo / name).read_bytes() for name in names}
        env = os.environ.copy()
        env.update(GIT_AUTHOR_NAME="UBICACIONES AutoSync", GIT_AUTHOR_EMAIL="actions@github.com",
                   GIT_COMMITTER_NAME="UBICACIONES AutoSync", GIT_COMMITTER_EMAIL="actions@github.com")
        for attempt in range(2):
            self.git("fetch", "--no-tags", self.remote, self.branch)
            parent = self.git("rev-parse", "FETCH_HEAD")
            try:
                remote_stock = json.loads(self.git("show", parent + ":stock.json"))
            except (subprocess.CalledProcessError, ValueError):
                remote_stock = {}
            local_stock = json.loads(captured.get("stock.json", b"{}"))
            if timestamp(remote_stock) > timestamp(local_stock):
                # Otro productor ya publicó datos posteriores. Nunca retroceder.
                return False
            with tempfile.TemporaryDirectory(prefix="ubicaciones-stock-index-") as temp:
                index_env = dict(env, GIT_INDEX_FILE=str(Path(temp) / "index"))
                self.git("read-tree", parent, env=index_env)
                for name, content in captured.items():
                    blob = self.git("hash-object", "-w", "--stdin", data=content)
                    self.git("update-index", "--add", "--cacheinfo", "100644," + blob + "," + name, env=index_env)
                tree = self.git("write-tree", env=index_env)
                if tree == self.git("rev-parse", parent + "^{tree}"):
                    return False
                commit = self.git("commit-tree", tree, "-p", parent, "-m", "AutoSync Copernico · stock disponible", env=env)
                try:
                    self.git("push", self.remote, commit + ":refs/heads/" + self.branch)
                    return True
                except subprocess.CalledProcessError:
                    if attempt:
                        raise
        return False


class StockPulse:
    def __init__(self, jwt, url, extract_rows, repo=".", interval=60, timeout=45,
                 publisher=None, fetcher=None, minimum_rows=100):
        self.jwt, self.url, self.extract_rows = jwt, url, extract_rows
        self.repo = Path(repo)
        self.interval, self.timeout = max(60, interval), timeout
        self.minimum_rows = minimum_rows
        self.publisher = publisher or StockPublisher(repo)
        self.fetcher = fetcher or self.fetch
        self.stop_event = threading.Event()
        self.thread = None
        self.last_success = None
        self.last_error = ""

    def fetch(self):
        # Opener propio: no compartir CookieJar/opener con los hilos operativos.
        request = urllib.request.Request(self.url, headers={
            "Accept": "application/json", "Authorization": self.jwt,
            "Origin": "https://copernicowms.com", "Referer": "https://copernicowms.com/",
            "User-Agent": "Mozilla/5.0",
        })
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.load(response)

    def status(self, error=False):
        atomic_json(self.repo / "stock-sync-status.json", {
            "status": "error" if error else "ok", "updated_at": iso_now(),
            "stock_updated_at": self.last_success,
            "last_success_at": self.last_success,
            "message": "No se pudo renovar el stock; se conserva el último válido" if error else "Stock publicado",
            "target_interval_seconds": self.interval,
        })

    def publish(self):
        try:
            self.publisher.publish()
            self.last_error = ""
            return True
        except Exception as error:
            # No registrar texto de excepciones de red/HTTP con datos externos.
            self.last_error = type(error).__name__
            print("STOCK: publicación pendiente (" + self.last_error + ")", flush=True)
            return False

    def seed(self, updated_at, publish_now=True):
        self.last_success = updated_at
        self.status()
        if publish_now:
            self.publish()

    def tick(self):
        try:
            payload = self.fetcher()
            if self.stop_event.is_set():
                return False
            rows = self.extract_rows(payload)
            if not isinstance(rows, list) or len(rows) < self.minimum_rows or not all(isinstance(row, dict) for row in rows):
                raise ValueError("Respuesta de stock incompleta")
            updated_at = iso_now()
            atomic_json(self.repo / "stock.json", {
                "updated_at": updated_at,
                "source": "Copernico WMS · bodega 47 · misma sesión operativa",
                "row_count": len(rows), "rows": rows,
            })
            self.last_success = updated_at
            self.status()
            self.publish()
            print("STOCK: muestra renovada durante el cálculo operativo", flush=True)
            return True
        except Exception as error:
            self.status(error=True)
            self.publish()
            print("STOCK: muestra no renovada (" + type(error).__name__ + ")", flush=True)
            return False

    def start(self):
        if self.thread is not None:
            return
        def run():
            while not self.stop_event.wait(self.interval):
                self.tick()
        self.thread = threading.Thread(target=run, name="ubicaciones-stock", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            # Esperar la consulta en vuelo antes del logout; nunca iniciar otra.
            self.thread.join()
