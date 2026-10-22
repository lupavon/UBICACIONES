"""Actualización incremental de Picking con la sesión WMS ya abierta.

Publica cada fuente al obtenerla. Los detalles tienen cupo por ciclo, se
revalidan por antigüedad y nunca bloquean la publicación del avance general.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request

from scripts.stock_refresh import DatasetPublisher, atomic_json, iso_now, timestamp

BASE = "https://services.copernicowms.com/backweb25/"
PLAN = "https://ubicaciones-api.pavonlucas-m.workers.dev/store"
ZONES = ("MFCA", "MFCB", "MFCC", "AR", "BR")


def field(row, *names):
    def key(value):
        return str(value).strip().lower().replace(" ", "").replace("_", "").replace("-", "")
    indexed = {key(k): v for k, v in row.items()}
    return next((indexed[key(k)] for k in names if indexed.get(key(k)) is not None), "")


def sval(row, *names):
    return str(field(row, *names)).strip()


def rows(payload):
    if isinstance(payload, list):
        if not all(isinstance(row, dict) for row in payload):
            raise ValueError("Filas inválidas")
        return payload
    if isinstance(payload, dict):
        for name in ("rows", "data", "items", "result", "results"):
            if isinstance(payload.get(name), (list, dict)):
                return rows(payload[name])
    raise ValueError("Respuesta sin colección de filas")


def zone(row):
    value = sval(row, "zonapiso", "ZonaPiso", "zona", "Zona").upper()
    return next((z for z in ZONES if value == z or value.startswith(z + " ") or (z.startswith("MFC") and value.startswith(z))), "")


def executed(row):
    state = sval(row, "describeestadolinea", "descripcionlinea", "EstadoDeLinea", "EstadoLinea", "Estado").upper()
    return any(word in state for word in ("EJECUT", "CONFIRM", "NEGAD"))


class PickingPulse:
    def __init__(self, jwt, build_summary, parse_date, repo=".", interval=30,
                 publisher=None, fetcher=None, detail_limit=8, workers=4):
        self.jwt = jwt
        self.build_summary, self.parse_date = build_summary, parse_date
        self.repo = Path(repo)
        self.interval = max(30, interval)
        self.publisher = publisher or DatasetPublisher(repo)
        self.fetcher = fetcher or self.fetch
        self.detail_limit, self.workers = min(8, max(1, detail_limit)), min(4, max(1, workers))
        self.stop_event = threading.Event()
        self.thread = None
        self.pick_rows, self.prod_rows = [], []
        self.pick_ok = self.prod_ok = False
        self.plan_rows, self.plan_at, self.plan_day = [], 0, ""
        self.detail_attempts = {}
        self.day = ""
        self.status = {}

    def fetch(self, url, timeout=45):
        headers = {"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
        # El JWT sólo se envía al WMS, jamás al almacenamiento de la planilla.
        if url.startswith(BASE):
            headers.update(Authorization=self.jwt, Origin="https://copernicowms.com", Referer="https://copernicowms.com/")
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)

    def read(self, name):
        try:
            return json.loads((self.repo / name).read_text())
        except (OSError, ValueError):
            return {}

    def write(self, name, payload):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(path, payload)

    def publish(self, names):
        try:
            self.publisher.publish_files(names)
            return True
        except Exception as error:
            print("PICKING: publicación pendiente (" + type(error).__name__ + ")", flush=True)
            return False

    def record_status(self, source, success, stamp=None):
        previous = self.status.get(source, {})
        self.status[source] = {
            "status": "ok" if success else "error",
            "last_attempt_at": iso_now(),
            "last_success_at": stamp if success else previous.get("last_success_at"),
        }
        self.write("picking-sync-status.json", {
            "updated_at": iso_now(), "fecha_query": self.day,
            "target_interval_seconds": self.interval, "sources": self.status,
        })

    def progress(self, pick, stamp, label):
        result, units, counts = [], {}, {}
        for row in pick:
            sku = sval(row, "ean", "EAN", "product", "Product")
            quantity = field(row, "Cant", "Cantidad", "unidad") or 0
            result.append({
                "Pedido": sval(row, "pedido", "NumPedido"),
                "Picking": sval(row, "NumPicking", "Picking"),
                "Zona": sval(row, "zonapiso", "zona").upper(),
                "Estado": sval(row, "EstadoDeLinea", "EstadoLinea", "Estado"),
                "SKU": sku, "Descripcion": sval(row, "descripcion", "Descripción"),
                "Ubicacion": sval(row, "ubicacion_asig", "ubicacion"), "Cantidad": quantity,
            })
            if executed(row) and sku:
                try:
                    qty = float(quantity)
                except (ValueError, TypeError):
                    qty = 0
                sku = sku.upper()
                units[sku] = units.get(sku, 0) + max(0, qty)
                counts[sku] = counts.get(sku, 0) + 1
        return {
            "updated_at": stamp, "fecha": label, "fecha_query": self.day,
            "source": "Copernico Líneas de Picking", "lineas_count": len(result),
            "processed_units_by_sku": units, "processed_lines_by_sku": counts,
            "processed_sku_source": "Líneas de Picking · Cant de Confirmadas + Negadas · global por SKU",
            "rows": result,
        }

    def plan(self):
        if self.plan_day == self.day and time.monotonic() - self.plan_at < 120:
            return self.plan_rows
        if self.plan_day != self.day:
            self.plan_rows = []
        self.plan_day, self.plan_at = self.day, time.monotonic()
        try:
            payload = self.fetcher(PLAN, timeout=10)
            day_iso = f"{self.day[:4]}-{self.day[4:6]}-{self.day[6:]}"
            obj = payload.get("days", {}).get(day_iso, {})
            daily = obj.get("dailyPlanilla") or {}
            sector = next((sec for sec in daily.get("sectors", []) if "UNITARIO" in str(sec.get("name", "")).upper() and "SECO" in str(sec.get("name", "")).upper()), None)
            self.plan_rows = (sector or obj.get("unitarioPlanilla") or {}).get("rows") or []
        except Exception:
            pass  # Conservar la planilla conocida del mismo día.
        return self.plan_rows

    def live_order(self, pk, lines, meta, stamp, source):
        zones = {z: {"total": 0, "ejecutadas": 0, "pendientes": 0} for z in ZONES}
        done = 0
        for row in lines:
            is_done, z = executed(row), zone(row)
            done += int(is_done)
            if z:
                zones[z]["total"] += 1
                zones[z]["ejecutadas" if is_done else "pendientes"] += 1
        total = len(lines)
        return dict(meta, picking=pk, lineas=total, ejecutadas=done,
                    pendientes=total-done, avance=round(100*done/total, 1) if total else 0,
                    zonas=zones, updated_at=stamp, source=source)

    def live(self, pick, prod, stamp, label):
        cached = self.read("picking-en-curso.json")
        old = {str(o["picking"]): o for o in cached.get("orders", [])} if cached.get("fecha_query") == self.day else {}
        grouped = {}
        for row in pick:
            pk = sval(row, "NumPicking", "Picking")
            if pk:
                grouped.setdefault(pk, []).append(row)
        candidates = {}
        for idx, row in enumerate(self.plan(), 1):
            pk = sval(row, "Picking", "TR")
            if pk:
                candidates[pk] = {"pedido": sval(row, "Pedido"), "tienda": sval(row, "Tienda"), "orden_plan": idx,
                                  "lineas_plan": row.get("TotalLineas", 0), "unidades_plan": row.get("UnidadesPlanificadas", 0)}
        for pk, rr in grouped.items():
            if pk not in candidates and any(zone(row) for row in rr):
                candidates[pk] = {"pedido": sval(rr[0], "pedido", "NumPedido"), "tienda": "", "orden_plan": 10000 + len(candidates), "lineas_plan": 0, "unidades_plan": 0}
        # Conservar datos válidos ante un fallo individual; no borrar pedidos.
        orders = {pk: dict(order) for pk, order in old.items() if pk in candidates}
        for pk, meta in candidates.items():
            if pk in grouped:
                orders[pk] = self.live_order(pk, grouped[pk], meta, stamp, "Líneas de Picking")
            elif pk in orders:
                orders[pk].update(meta)
            else:
                orders[pk] = self.live_order(pk, [], meta, None, "Pendiente de consulta")
                orders[pk]["data_pending"] = True
        # Activos cada 30 s; terminados cada 5 min. Primero el menos consultado.
        now = time.time()
        due = []
        for pk, order in orders.items():
            previous = old.get(pk, {})
            last = previous.get("detail_updated_at")
            order["detail_updated_at"] = last
            order["detail_attempted_at"] = previous.get("detail_attempted_at")
            last_ts = timestamp({"updated_at": last})
            ttl = 30 if order.get("pendientes", 0) or order.get("data_pending") else 300
            attempt = max(self.detail_attempts.get(pk, 0), timestamp({"updated_at": previous.get("detail_attempted_at")}), last_ts)
            if now - max(last_ts, attempt) >= ttl:
                due.append((attempt, pk))
        selected = [pk for _, pk in sorted(due)[:self.detail_limit]]
        def detail(pk):
            payload = self.fetcher(BASE + "dwh_picking/picking?" + urllib.parse.urlencode({"pickingint": pk}), timeout=12)
            return rows(payload), iso_now()
        failures = 0
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {}
            for pk in selected:
                self.detail_attempts[pk] = now
                orders[pk]["detail_attempted_at"] = iso_now()
                futures[pool.submit(detail, pk)] = pk
            for future in as_completed(futures):
                pk = futures[future]
                try:
                    rr, detail_stamp = future.result()
                    if not rr:
                        raise ValueError("Detalle vacío")
                    order = self.live_order(pk, rr, candidates[pk], detail_stamp, "Copernico dwh_picking/picking")
                    order["detail_updated_at"] = detail_stamp
                    order["detail_attempted_at"] = detail_stamp
                    orders[pk] = order
                except Exception:
                    failures += 1
                    orders[pk]["detail_error"] = True
        picker_by_pk = {}
        for row in prod:
            process = sval(row, "Proceso").upper()
            if process and "PICK" not in process:
                continue
            pk, z = sval(row, "Picking", "NumPicking"), zone(row)
            if not pk or not z:
                continue
            hour = sval(row, "horaRegistro")
            ts = self.parse_date(sval(row, "fecharegistro") + " " + hour)
            if pk not in picker_by_pk or ts >= picker_by_pk[pk][0]:
                picker_by_pk[pk] = (ts, {"nombre": sval(row, "Nombres", "NombreEmpleado", "Empleado"), "zona": z, "hora": hour})
        for pk, order in orders.items():
            order["picker_actual"] = picker_by_pk.get(pk, (None, old.get(pk, {}).get("picker_actual")))[1]
        result = sorted(orders.values(), key=lambda o: (o.get("orden_plan", 99999), o.get("pedido", "")))
        self.write("picking-en-curso.json", {
            "updated_at": stamp, "fecha": label, "fecha_query": self.day,
            "source": "Copernico Líneas de Picking + detalle incremental + ProductividadPIK",
            "orders_count": len(result), "orders": result,
            "details_requested": len(selected), "details_failed": failures,
        })
        self.publish(("picking-en-curso.json",))

    def tick(self):
        current = datetime.now(timezone(timedelta(hours=-3)))
        day, label = current.strftime("%Y%m%d"), current.strftime("%d/%m/%Y")
        if self.day != day:
            self.pick_rows, self.prod_rows, self.detail_attempts = [], [], {}
            saved = self.read("picking-sync-status.json")
            self.status = saved.get("sources", {}) if saved.get("fecha_query") == day else {}
        self.day = day
        self.pick_ok = self.prod_ok = False
        stamp = None
        try:
            pick = rows(self.fetcher(BASE + "pasillos/lineas/picking?fecha=" + day, timeout=45))
            stamp = iso_now()
            payload = self.progress(pick, stamp, label)
            names = ("avance-pedidos.json", f"datos/avance/{day}.json", f"datos/lineas-picking/{day}.json")
            for name in names[:2]:
                self.write(name, payload)
            self.write(names[2], {"updated_at": stamp, "fecha": label, "fecha_query": day, "source": "Copernico Líneas de Picking", "row_count": len(pick), "rows": pick})
            self.pick_rows, self.pick_ok = pick, True
            self.record_status("lineas", True, stamp)
            self.publish((*names, "picking-sync-status.json"))
        except Exception as error:
            self.record_status("lineas", False)
            print("PICKING: líneas no renovadas (" + type(error).__name__ + ")", flush=True)
        try:
            prod = rows(self.fetcher(BASE + "kpi/productividad/empleados?fecha=" + day + "&tipo_productividad=ProductividadPIK", timeout=45))
            prod_stamp = iso_now()
            name = f"datos/productividad/{day}.json"
            self.write(name, {"updated_at": prod_stamp, "fecha": label, "fecha_query": day, "source": "Copernico ProductividadPIK", "row_count": len(prod), "rows": prod})
            self.prod_rows, self.prod_ok = prod, True
            names = [name]
            if self.pick_ok:
                summary_name = f"datos/productividad-resumen/{day}.json"
                summary = self.build_summary(prod, self.pick_rows, day, label, prod_stamp)
                summary["picking_updated_at"] = stamp
                self.write(summary_name, summary)
                names.append(summary_name)
            self.record_status("productividad", True, prod_stamp)
            self.publish((*names, "picking-sync-status.json"))
        except Exception as error:
            self.record_status("productividad", False)
            print("PICKING: productividad no renovada (" + type(error).__name__ + ")", flush=True)
        if self.pick_ok:
            try:
                self.live(self.pick_rows, self.prod_rows, stamp, label)
            except Exception as error:
                print("PICKING: detalle no renovado (" + type(error).__name__ + ")", flush=True)
        self.publish(("picking-sync-status.json",))
        return self.pick_ok and self.prod_ok

    def start(self):
        if self.thread is not None:
            return
        def run():
            delay = self.interval
            while not self.stop_event.wait(delay):
                started = time.monotonic()
                try:
                    self.tick()
                except Exception as error:
                    print("PICKING: ciclo interrumpido (" + type(error).__name__ + ")", flush=True)
                # Nunca superponer ciclos ni disparar reintentos sin espera.
                delay = max(5, self.interval - (time.monotonic() - started))
        self.thread = threading.Thread(target=run, name="ubicaciones-picking", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join()  # Terminar consultas antes de cerrar la sesión WMS.
