#!/usr/bin/env python3
"""Consulta getmovimientos de una caja y escribe datos/trazabilidad/<caja>.json.

Usa COPERNICO_EMAIL y COPERNICO_PASSWORD del entorno. No imprime la clave ni el JWT.
La interfaz estática no dispara este script: lo corre un operador con workflow_dispatch.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LOGIN_URL = "https://services.copernicowms.com/users/api/login"
LOGOUT_URL = "https://services.copernicowms.com/users/api/logout"
MOVEMENTS_URL = "https://services.copernicowms.com/backweb25/caja/getmovimientos"
DEFAULT_TECH_USER_ID = 11257

FIELD_ALIASES = {
    "Fecha": ("Fecha", "fecha", "FechaHora", "Fecha Hora", "FechaMovimiento", "Fecha Mov"),
    "EAN": ("EAN", "ean"),
    "Estado": ("Estado", "estado"),
    "Movimiento": ("Movimiento", "movimiento"),
    "Saldo": ("Saldo", "saldo"),
    "Transaccion": ("Transaccion", "Transacción", "transaccion"),
    "Nombre_empleado": ("Nombre_empleado", "Nombre empleado", "NombreEmpleado"),
    "Id_empleado": ("Id_empleado", "ID empleado", "IdEmpleado"),
    "NoControl": ("NoControl", "No Control", "nocontrol"),
}


def normalize_key(value):
    return re.sub(r"[\s_-]+", "", str(value or "").strip().lower())


def normalize_caja(value):
    text = str(value or "").strip()
    labeled = re.search(r"Nw:\s*(\d+)", text, re.I)
    digits = re.sub(r"\D", "", labeled.group(1) if labeled else text)
    digits = re.sub(r"^0+(?=\d)", "", digits)
    return digits if re.fullmatch(r"\d{3,12}", digits) else ""


def extract_rows(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("rows", "data", "items", "result", "results", "movimientos", "stock", "inventario"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            for sub in ("rows", "data", "items", "results"):
                if isinstance(value.get(sub), list):
                    return value[sub]
    return []


def _pick(row, names):
    if not isinstance(row, dict):
        return ""
    indexed = {normalize_key(key): value for key, value in row.items()}
    for name in names:
        key = normalize_key(name)
        if key in indexed and indexed[key] is not None:
            return indexed[key]
    return ""


def normalize_movimientos(payload):
    rows = extract_rows(payload)[:2500]
    out = []
    for row in rows:
        out.append({name: _pick(row, aliases) for name, aliases in FIELD_ALIASES.items()})
    return out


def build_document(caja, movimientos, elapsed_ms, warning=""):
    now = datetime.now(timezone.utc).isoformat()
    rows = list(movimientos or [])
    return {
        "ok": True,
        "caja": caja,
        "source": "Copernico WMS · getmovimientos",
        "fetched_at": now,
        "updated_at": now,
        "elapsed_ms": int(elapsed_ms),
        "movimientos_count": len(rows),
        "warning": warning or "",
        "movimientos": rows,
    }


def output_path(caja, root=None):
    base = Path(root) if root else Path(__file__).resolve().parents[1]
    return base / "datos" / "trazabilidad" / f"{caja}.json"


def _headers(jwt=""):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://copernicowms.com",
        "Referer": "https://copernicowms.com/",
        "User-Agent": "Mozilla/5.0",
    }
    if jwt:
        headers["Authorization"] = jwt
    return headers


def request_json(method, url, payload=None, jwt="", timeout=45):
    data = None
    headers = _headers(jwt)
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    if not raw:
        return status, {}
    try:
        return status, json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return status, {}


def user_id_from(login, jwt, fallback):
    if isinstance(login, dict):
        for candidate in (login.get("id"), (login.get("user") or {}).get("id"), (login.get("usuario") or {}).get("id")):
            try:
                number = int(candidate)
            except (TypeError, ValueError):
                continue
            if number > 0:
                return number
    return int(fallback)


def login(email, password, tech_id):
    body = {"email": email, "password": password, "plataforma": "Copernico WMS"}
    status, data = request_json("POST", LOGIN_URL, body)
    if status in (403, 418):
        request_json("POST", LOGOUT_URL, {"id": int(tech_id)})
        status, data = request_json("POST", LOGIN_URL, body)
    jwt = data.get("jwt") if isinstance(data, dict) else ""
    if status >= 400 or not jwt:
        raise RuntimeError("No se pudo abrir la sesión técnica de Copérnico")
    return jwt, user_id_from(data, jwt, tech_id)


class SessionExpired(RuntimeError):
    pass


def fetch_movimientos(jwt, caja):
    started = time.monotonic()
    status, data = request_json("GET", MOVEMENTS_URL + "?caja=" + urllib.request.quote(str(caja)), jwt=jwt)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if status == 401:
        raise SessionExpired("Copérnico no devolvió los movimientos de la caja")
    if status == 404:
        return [], elapsed_ms, "Copérnico no tiene movimientos para esta caja."
    if status >= 400:
        raise RuntimeError("Copérnico no devolvió los movimientos de la caja")
    return normalize_movimientos(data), elapsed_ms, ""


def logout(user_id, jwt):
    try:
        request_json("POST", LOGOUT_URL, {"id": int(user_id)}, jwt=jwt, timeout=15)
    except Exception:
        return


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    caja = normalize_caja(os.environ.get("CAJA") or (argv[0] if argv else ""))
    if not caja:
        print("Número de caja inválido", file=sys.stderr)
        return 2
    email = os.environ.get("COPERNICO_EMAIL") or ""
    password = os.environ.get("COPERNICO_PASSWORD") or ""
    if not email or not password:
        print("Faltan COPERNICO_EMAIL y COPERNICO_PASSWORD", file=sys.stderr)
        return 2
    tech_id = int(os.environ.get("COPERNICO_USER_ID") or DEFAULT_TECH_USER_ID)
    jwt = ""
    user_id = tech_id
    try:
        jwt, user_id = login(email, password, tech_id)
        try:
            movimientos, elapsed_ms, warning = fetch_movimientos(jwt, caja)
        except SessionExpired:
            logout(user_id, jwt)
            jwt, user_id = login(email, password, tech_id)
            movimientos, elapsed_ms, warning = fetch_movimientos(jwt, caja)
        document = build_document(caja, movimientos, elapsed_ms, warning)
        path = output_path(caja)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"caja {caja}: {len(movimientos)} movimientos en {elapsed_ms} ms -> {path}")
        return 0
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if jwt:
            logout(user_id, jwt)


if __name__ == "__main__":
    raise SystemExit(main())
