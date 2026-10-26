import json
import unittest
from pathlib import Path

from scripts.pallets_proceso import (
    build_payload,
    caja_key,
    is_process_location,
    latest_move_to_process,
    write_pallets_proceso,
)


ROOT = Path(__file__).resolve().parents[1]


def stock_line(caja, ean, referencia, descripcion="Item"):
    return {
        "Caja": caja,
        "EAN": ean,
        "referencia": referencia,
        "Descripcion": descripcion,
        "Saldo": "10.0000",
        "UnidadMedida": "UN",
        "FV": "01/01/2027",
        "Ubicacion": "EN_PROCESO",
        "Origen": "Propios",
    }


def move(dest, origin, nombre, empleado_id, fecha, **extra):
    row = {
        "UbicacionFinal": dest,
        "UbicacionInicial": origin,
        "Nombre_empleado": nombre,
        "Id_empleado": empleado_id,
        "fecha": fecha,
        "Prioridad": "Picking",
    }
    row.update(extra)
    return row


class PalletsProcesoTest(unittest.TestCase):
    def test_normaliza_caja_y_destino(self):
        self.assertEqual(caja_key(634144), "634144")
        self.assertEqual(caja_key("0634144"), "634144")
        self.assertEqual(caja_key("Nw: 634144"), "634144")
        self.assertTrue(is_process_location("EN_PROCESO"))
        self.assertTrue(is_process_location("En proceso"))
        self.assertTrue(is_process_location("EN-PROCESO"))
        self.assertFalse(is_process_location("Propios"))

    def test_elige_el_ingreso_mas_reciente_con_alias(self):
        moves = [
            move("EN_PROCESO", "A010101", "Viejo", 1, "2026-10-20T08:00:00"),
            {
                "Ubicacion Final": "EN PROCESO",
                "Posicion Origen": "D660302",
                "Nombre empleado": "Jesuan Bustamante",
                "ID empleado": 3905,
                "Fecha Hora": "2026-10-26T07:43:55.373",
            },
            move("PICK01", "D660302", "Otro", 2, "2026-10-26T09:00:00"),
        ]
        chosen = latest_move_to_process(moves)
        self.assertEqual(chosen["Nombre empleado"], "Jesuan Bustamante")
        self.assertEqual(chosen["Posicion Origen"], "D660302")

    def test_ubicacion_generica_exige_origen_real(self):
        moves = [
            {"Ubicacion": "EN_PROCESO", "Origen": "Propios", "Nombre_empleado": "Nadie", "fecha": "2026-10-26T01:00:00"},
            {"Ubicacion": "EN_PROCESO", "UbicacionInicial": "G850113", "Nombre_empleado": "Victor Oviedo", "Id_empleado": 3770, "fecha": "2026-10-26T06:05:21"},
        ]
        chosen = latest_move_to_process(moves)
        self.assertEqual(chosen["Nombre_empleado"], "Victor Oviedo")
        self.assertEqual(chosen["UbicacionInicial"], "G850113")

    def test_linea_de_la_misma_caja_comparte_traza_aunque_el_id_traiga_ceros(self):
        rows = [
            stock_line(634144, 14525, "2851405216026", "TF - Roast Beef"),
            stock_line("0634144", "14513", "2851405219027", "TF - Tira"),
            stock_line(601121, 8248, "7798169802674", "LASFOR"),
        ]
        calls = []

        def fetch(caja):
            calls.append(caja)
            if caja == "634144":
                return {"ubicaciones": [move("EN_PROCESO", "D660302", "Jesuan Bustamante", 3905, "2026-10-26T07:01:18")]}
            if caja == "601121":
                return []
            raise AssertionError(caja)

        payload = build_payload(rows, fetch, "2026-10-26T10:01:18+00:00")
        self.assertEqual(sorted(calls), ["601121", "634144"])
        self.assertEqual(payload["total_lineas"], 3)
        self.assertEqual(payload["total_pallets"], 2)
        self.assertEqual(payload["identificados"], 2)
        identified = [row for row in payload["rows"] if row["Maquinista"]]
        self.assertEqual({row["PosicionOrigen"] for row in identified}, {"D660302"})
        self.assertEqual({row["Id_maquinista"] for row in identified}, {3905})
        self.assertTrue(all(row["FechaIngresoProceso"] == "2026-10-26T07:01:18" for row in identified))
        missing = [row for row in payload["rows"] if row["Caja"] == 601121][0]
        self.assertEqual(missing["Trazabilidad"], "Sin movimiento a EN_PROCESO identificado")
        self.assertEqual(missing["PosicionOrigen"], "")

    def test_un_error_de_red_no_borra_la_traza_previa(self):
        previous = {
            "updated_at": "2026-10-26T09:00:00+00:00",
            "rows": [{
                "Caja": 630775,
                "EAN": 6653,
                "Referencia": "7797906054925",
                "PosicionOrigen": "H420101",
                "Maquinista": "Jose Bretz",
                "Id_maquinista": 3894,
                "FechaIngresoProceso": "2026-10-22T03:26:57.007",
                "Prioridad": "Picking",
                "Trazabilidad": "OK",
            }],
        }
        path = ROOT / "tests" / "_pallets_prev.json"
        path.write_text(json.dumps(previous), encoding="utf-8")
        self.addCleanup(lambda: path.unlink(missing_ok=True))

        def fetch(_caja):
            raise RuntimeError("HTTP 401: Invalid token")

        payload = write_pallets_proceso(
            [stock_line(630775, 6653, "7797906054925", "McCain")],
            fetch,
            "2026-10-26T10:07:38+00:00",
            path,
        )
        self.assertEqual(payload["identificados"], 1)
        row = payload["rows"][0]
        self.assertEqual(row["PosicionOrigen"], "H420101")
        self.assertEqual(row["Maquinista"], "Jose Bretz")
        self.assertEqual(row["Id_maquinista"], 3894)
        self.assertEqual(row["Trazabilidad"], "OK · traza previa")
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["identificados"], 1)

    def test_workflows_publican_la_traza_en_el_ciclo_que_si_termina(self):
        stock = (ROOT / ".github/workflows/actualizar-stock-rapido.yml").read_text(encoding="utf-8")
        oper = (ROOT / ".github/workflows/actualizar-operacion.yml").read_text(encoding="utf-8")
        heavy = (ROOT / ".github/workflows/actualizar-datos-pesados.yml").read_text(encoding="utf-8")
        fast_at = stock.find('print("MODO FAST:')
        oper_at = oper.find('print("MODO OPERATIONAL:')
        heavy_at = heavy.find('print("=== 3. PALLETS EN PROCESO ===")')
        self.assertIn("write_pallets_proceso", stock[:fast_at])
        self.assertIn('extra_files=("sync-status.json", "pallets-proceso.json")', stock)
        self.assertIn("write_pallets_proceso", oper[:oper_at])
        self.assertIn("'pallets-proceso.json'", oper[oper.find("Publicar datos operational"):])
        self.assertIn("write_pallets_proceso", heavy[heavy_at:heavy_at + 900])
        self.assertNotIn("as_completed(futures, timeout=35)", heavy[heavy_at:heavy_at + 900])


if __name__ == "__main__":
    unittest.main()
