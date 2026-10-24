import json
import unittest

from scripts.consultar_caja import (
    build_document,
    extract_rows,
    normalize_caja,
    normalize_movimientos,
)


class ConsultarCajaTest(unittest.TestCase):
    def test_caja_solo_digitos(self):
        self.assertEqual(normalize_caja("591435"), "591435")
        self.assertEqual(normalize_caja("  0591435 "), "591435")
        self.assertEqual(normalize_caja("Nw: 591435"), "591435")
        self.assertEqual(normalize_caja("591435; rm -rf"), "591435")
        self.assertEqual(normalize_caja("12"), "")
        self.assertEqual(normalize_caja("caja"), "")

    def test_normaliza_alias_y_anida(self):
        payload = {"data": {"rows": [{
            "Fecha Hora": "2026-10-01T08:00:00",
            "ean": "13347",
            "estado": "Salida",
            "movimiento": -4,
            "saldo": 0,
            "Transacción": "SALE HACIA Nw: 204400",
            "Nombre empleado": "Ana",
            "ID empleado": 9,
            "No Control": "ABC",
        }]}}
        rows = normalize_movimientos(payload)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["EAN"], "13347")
        self.assertEqual(rows[0]["Transaccion"], "SALE HACIA Nw: 204400")
        self.assertEqual(rows[0]["Nombre_empleado"], "Ana")
        self.assertEqual(extract_rows(payload)[0]["ean"], "13347")

    def test_documento_sin_secreto(self):
        doc = build_document("591435", [{"EAN": "1"}], 1200, "")
        raw = json.dumps(doc)
        self.assertNotIn("password", raw.lower())
        self.assertNotIn("jwt", raw.lower())
        self.assertEqual(doc["caja"], "591435")
        self.assertTrue(doc["updated_at"])
        self.assertEqual(doc["elapsed_ms"], 1200)
        self.assertEqual(doc["movimientos_count"], 1)


if __name__ == "__main__":
    unittest.main()
