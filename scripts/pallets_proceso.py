"""Arma pallets-proceso.json a partir del stock EN_PROCESO y getubicaciones.

El dashboard no consulta Copérnico: cruza stock.json con este archivo.
La traza es por caja (el último movimiento cuyo destino es EN_PROCESO).
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime
from pathlib import Path


DEST_FIELDS = (
    "UbicacionFinal", "ubicacion_final", "ubicacionfinal",
    "UbicacionDestino", "ubicacion_destino", "ubicaciondestino",
    "Destino", "destino",
    "PosicionFinal", "posicion_final", "PosicionDestino", "posicion_destino",
    "UbicacionNueva", "ubicacion_nueva",
)
ORIGIN_FIELDS = (
    "UbicacionInicial", "ubicacion_inicial", "ubicacioninicial",
    "UbicacionOrigen", "ubicacion_origen", "ubicacionorigen",
    "PosicionOrigen", "posicion_origen", "posicionorigen",
    "PosicionInicial", "posicion_inicial",
    "UbicacionAnterior", "ubicacion_anterior", "ubicacionanterior",
)
GENERIC_LOCATION_FIELDS = ("Ubicacion", "ubicacion", "Location", "Posicion", "posicion")
EMPLOYEE_FIELDS = (
    "Nombre_empleado", "Nombre empleado", "NombreEmpleado", "nombreEmpleado",
    "Maquinista", "maquinista", "Nombre_maquinista",
    "Empleado", "Operario", "Usuario",
)
EMPLOYEE_ID_FIELDS = (
    "Id_empleado", "IdEmpleado", "idEmpleado", "ID empleado",
    "Id_maquinista", "id_maquinista", "IdMaquinista",
    "IdUsuario", "id_usuario", "Legajo",
)
DATE_FIELDS = (
    "fecha", "Fecha", "FechaMovimiento", "fecha_movimiento",
    "FechaHora", "Fecha Hora", "FechaRegistro", "fecharegistro",
    "FechaIngresoProceso", "fecha_ingreso_proceso",
)
CAJA_FIELDS = ("Caja", "caja", "numeroCaja", "NroCaja")
PRIORITY_FIELDS = ("Prioridad", "prioridad")


def norm_key(value):
    return (
        str(value)
        .strip()
        .lower()
        .replace(" ", "")
        .replace("_", "")
        .replace("-", "")
    )


def field(row, *names):
    if not isinstance(row, dict):
        return ""
    indexed = {norm_key(key): value for key, value in row.items()}
    for name in names:
        key = norm_key(name)
        if key not in indexed:
            continue
        value = indexed[key]
        if value is not None:
            return value
    return ""


def norm_location(value):
    return (
        str(value or "")
        .strip()
        .upper()
        .replace(" ", "")
        .replace("-", "")
        .replace("_", "")
    )


def is_process_location(value):
    return norm_location(value) == "ENPROCESO"


def caja_key(value):
    text = str(value if value is not None else "").strip()
    digits = "".join(ch for ch in text if ch.isdigit())
    digits = digits.lstrip("0")
    return digits or text


def norm_id(value):
    return str(value if value is not None else "").strip()


def parse_date(value):
    if value is None or value == "":
        return float("-inf")
    if isinstance(value, bool):
        return float("-inf")
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    formats = (
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    )
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).timestamp()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


def coerce_moves(payload):
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    for key in (
        "rows", "data", "items", "result", "results",
        "stock", "inventario", "ubicaciones", "movimientos",
        "Ubicaciones", "Movimientos",
    ):
        value = payload.get(key)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
        if isinstance(value, dict):
            for sub in ("rows", "data", "items", "results", "ubicaciones", "movimientos"):
                nested = value.get(sub)
                if isinstance(nested, list):
                    return [row for row in nested if isinstance(row, dict)]
    return []


def move_destination(move):
    dest = field(move, *DEST_FIELDS)
    if is_process_location(dest):
        return dest
    generic = field(move, *GENERIC_LOCATION_FIELDS)
    origin = field(move, *ORIGIN_FIELDS)
    if is_process_location(generic) and origin and not is_process_location(origin):
        return generic
    return ""


def move_origin(move):
    return field(move, *ORIGIN_FIELDS)


def latest_move_to_process(moves):
    candidates = []
    for move in moves or []:
        if not isinstance(move, dict):
            continue
        if move_destination(move):
            candidates.append(move)
    if not candidates:
        return None
    return max(candidates, key=lambda move: parse_date(field(move, *DATE_FIELDS)))


def _safe_fetch(fetch_payload, caja):
    try:
        return coerce_moves(fetch_payload(caja)), ""
    except Exception as exc:
        return [], str(exc)[:300]


def collect_moves(boxes, fetch_payload, max_workers=4, timeout=120):
    results = {}
    if not boxes:
        return results
    workers = max(1, min(max_workers, len(boxes)))
    executor = ThreadPoolExecutor(max_workers=workers)
    futures = {
        executor.submit(_safe_fetch, fetch_payload, caja): caja
        for caja in boxes
    }
    try:
        done, pending = wait(futures, timeout=timeout)
        for future in done:
            caja = futures[future]
            try:
                moves, error = future.result()
            except Exception as exc:
                moves, error = [], str(exc)[:300]
            results[caja] = {"moves": moves, "error": error}
        for future in pending:
            future.cancel()
            results[futures[future]] = {
                "moves": [],
                "error": "Trazabilidad no disponible en este ciclo",
            }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return results


def _load_previous(path):
    by_exact = {}
    by_caja = {}
    file_path = Path(path)
    if not file_path.is_file():
        return by_exact, by_caja
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return by_exact, by_caja
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return by_exact, by_caja
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not (row.get("PosicionOrigen") and row.get("Maquinista")):
            continue
        exact = (
            caja_key(row.get("Caja")),
            norm_id(row.get("EAN")),
            norm_id(row.get("Referencia")),
        )
        by_exact[exact] = row
        caja = exact[0]
        if caja and caja not in by_caja:
            by_caja[caja] = row
    return by_exact, by_caja


def _apply_previous(row, previous):
    row["PosicionOrigen"] = previous.get("PosicionOrigen") or ""
    row["Maquinista"] = previous.get("Maquinista") or ""
    row["Id_maquinista"] = previous.get("Id_maquinista") or ""
    row["FechaIngresoProceso"] = previous.get("FechaIngresoProceso") or ""
    row["Prioridad"] = previous.get("Prioridad") or ""
    row["Trazabilidad"] = "OK · traza previa"
    return row


def build_process_row(stock_row, trace_move=None, trace_error=""):
    return {
        "Caja": field(stock_row, *CAJA_FIELDS),
        "EAN": field(stock_row, "EAN", "ean"),
        "Referencia": field(stock_row, "referencia", "Referencia", "ref"),
        "Descripcion": field(stock_row, "Descripcion", "descripcion", "Descripción"),
        "Saldo": field(stock_row, "Saldo", "saldo", "Cantidad", "cantidad"),
        "Unidad": field(stock_row, "UnidadMedida", "unidadMedida", "Unidad"),
        "FV": field(stock_row, "FV", "fv", "FechaVencimiento"),
        "Ubicacion": field(stock_row, "Ubicacion", "ubicacion", "Location") or "EN_PROCESO",
        "PosicionOrigen": move_origin(trace_move) if trace_move else "",
        "Maquinista": field(trace_move, *EMPLOYEE_FIELDS) if trace_move else "",
        "Id_maquinista": field(trace_move, *EMPLOYEE_ID_FIELDS) if trace_move else "",
        "FechaIngresoProceso": field(trace_move, *DATE_FIELDS) if trace_move else "",
        "Prioridad": field(trace_move, *PRIORITY_FIELDS) if trace_move else "",
        "Trazabilidad": "OK" if trace_move else (trace_error or "Sin movimiento a EN_PROCESO identificado"),
    }


def _log_unmatched(caja, moves, limit_boxes):
    if limit_boxes[0] <= 0:
        return
    limit_boxes[0] -= 1
    if not moves:
        print(f"PALLETS caja {caja}: getubicaciones sin filas", flush=True)
        return
    sample = moves[0]
    keys = sorted(sample.keys())
    values = []
    for move in moves[:40]:
        for key, value in move.items():
            folded = norm_key(key)
            if not any(token in folded for token in ("ubic", "dest", "posic", "origen", "local")):
                continue
            text = str(value).strip()
            if not text:
                continue
            shown = f"{key}={text[:40]}"
            if shown not in values:
                values.append(shown)
            if len(values) >= 8:
                break
        if len(values) >= 8:
            break
    print(
        f"PALLETS caja {caja}: sin destino EN_PROCESO. campos={keys[:40]} valores={values}",
        flush=True,
    )


def build_payload(stock_rows, fetch_payload, updated_at, previous_path=None):
    process_rows_src = [
        row for row in (stock_rows or [])
        if isinstance(row, dict) and is_process_location(field(row, "Ubicacion", "ubicacion", "Location"))
    ]
    boxes = []
    seen = set()
    for row in process_rows_src:
        caja = caja_key(field(row, *CAJA_FIELDS))
        if not caja or caja in seen:
            continue
        seen.add(caja)
        boxes.append(caja)
    boxes.sort()

    fetched = collect_moves(boxes, fetch_payload)
    previous_exact, previous_caja = _load_previous(previous_path) if previous_path else ({}, {})
    log_budget = [3]
    process_rows = []

    for stock_row in process_rows_src:
        caja = caja_key(field(stock_row, *CAJA_FIELDS))
        found = fetched.get(caja, {"moves": [], "error": "Trazabilidad no disponible en este ciclo"})
        move = latest_move_to_process(found["moves"]) if not found["error"] else None
        row = build_process_row(
            stock_row,
            trace_move=move,
            trace_error=found["error"],
        )
        if not move and found["error"]:
            exact = (
                caja,
                norm_id(row.get("EAN")),
                norm_id(row.get("Referencia")),
            )
            previous = previous_exact.get(exact) or previous_caja.get(caja)
            if previous:
                _apply_previous(row, previous)
        elif not move:
            _log_unmatched(caja, found["moves"], log_budget)
        process_rows.append(row)

    identified = sum(1 for row in process_rows if row["PosicionOrigen"] and row["Maquinista"])
    payload = {
        "updated_at": updated_at,
        "source": "Copernico WMS · EN_PROCESO · trazabilidad de ubicaciones",
        "total_lineas": len(process_rows),
        "total_pallets": len(boxes),
        "identificados": identified,
        "rows": process_rows,
    }
    print(
        f"pallets-proceso.json: {len(process_rows)} líneas, {len(boxes)} cajas, {identified} identificadas",
        flush=True,
    )
    return payload


def write_pallets_proceso(stock_rows, fetch_payload, updated_at, path):
    payload = build_payload(stock_rows, fetch_payload, updated_at, previous_path=path)
    target = Path(path)
    target.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return payload
