import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.picking_refresh import PickingPulse, BASE, PLAN, rows
from scripts.stock_refresh import DatasetPublisher, StockPublisher


class Publisher:
    def __init__(self):
        self.events = []

    def publish_files(self, names):
        self.events.append(tuple(names))
        return True


def line(pk="1", state="Pendiente", zone="MFCA"):
    return {"NumPicking": pk, "pedido": "P" + pk, "EstadoDeLinea": state,
            "zonapiso": zone, "ean": "SKU", "Cant": 2}


class PickingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pub = Publisher()
        self.pick = [line(str(i)) for i in range(500)]
        self.details = []
        self.failure = None
        self.pulse = PickingPulse("secret-never-published", lambda p, l, d, label, stamp: {"updated_at": stamp, "rows": p},
                                  lambda _: 0, repo=self.temp.name, publisher=self.pub, fetcher=self.fetch)

    def fetch(self, url, timeout):
        if url == PLAN:
            return {"days": {}}
        if "pasillos/" in url:
            if self.failure == "lines":
                return {"error": "unavailable"}
            return self.pick
        if "productividad/" in url:
            self.assertTrue(any("avance-pedidos.json" in names for names in self.pub.events))
            if self.failure == "productivity":
                raise TimeoutError()
            return []
        if "dwh_picking/" in url:
            self.assertTrue(any(any("datos/productividad/" in n for n in names) for names in self.pub.events))
            pk = url.split("pickingint=")[1]
            self.details.append(pk)
            if self.failure == "detail":
                raise TimeoutError()
            z = "BR" if pk == "NEW" else "MFCA"
            return [line(pk, "Confirmada", z), line(pk, "Negada", z), line(pk, zone=z)]
        raise AssertionError(url)

    def read(self, name):
        return json.loads((Path(self.temp.name) / name).read_text())

    def test_publishes_bulk_before_productivity_and_limits_details(self):
        self.assertTrue(self.pulse.tick())
        self.assertEqual(len(self.details), 8)
        live = self.read("picking-en-curso.json")
        self.assertEqual(live["orders_count"], 500)
        order = next(o for o in live["orders"] if o["picking"] in self.details)
        self.assertEqual((order["lineas"], order["ejecutadas"], order["pendientes"]), (3, 2, 1))
        self.assertNotIn("secret-never-published", json.dumps(live))

    def test_next_batch_rotates_and_failed_detail_keeps_bulk(self):
        self.failure = "detail"
        self.pulse.tick()
        first = set(self.details)
        self.pulse.tick()
        self.assertTrue(first.isdisjoint(self.details[8:]))
        self.assertEqual(self.read("picking-en-curso.json")["orders_count"], 500)
        self.assertEqual(self.read("picking-en-curso.json")["details_failed"], 8)

    def test_invalid_lines_preserve_previous_snapshot(self):
        self.pulse.tick()
        previous = (Path(self.temp.name) / "avance-pedidos.json").read_bytes()
        self.failure = "lines"
        self.assertFalse(self.pulse.tick())
        self.assertEqual(previous, (Path(self.temp.name) / "avance-pedidos.json").read_bytes())
        status = self.read("picking-sync-status.json")["sources"]["lineas"]
        self.assertEqual(status["status"], "error")
        self.assertTrue(status["last_success_at"])

    def test_productivity_failure_does_not_block_progress(self):
        self.pulse.tick()
        prod_file = Path(self.temp.name) / f"datos/productividad/{self.pulse.day}.json"
        previous = prod_file.read_bytes()
        self.failure = "productivity"
        self.pick = [line("NEW", "Negada", "BR")]
        self.assertFalse(self.pulse.tick())
        self.assertEqual(self.read("avance-pedidos.json")["lineas_count"], 1)
        self.assertEqual(self.read("avance-pedidos.json")["processed_lines_by_sku"], {"SKU": 1})
        self.assertEqual(prod_file.read_bytes(), previous)
        self.assertEqual(self.read("picking-en-curso.json")["orders"][0]["zonas"]["BR"]["total"], 3)

    def test_empty_day_does_not_reuse_previous_day(self):
        self.pulse.tick()
        self.pulse.day = "20000101"
        self.pulse.prod_rows = [{"old": True}]
        self.pick = []
        self.pulse.tick()
        self.assertEqual(self.read("picking-en-curso.json")["orders_count"], 0)
        self.assertEqual(self.pulse.prod_rows, [])

    def test_unknown_response_is_not_an_empty_valid_snapshot(self):
        for invalid in ({"message": "login"}, None, [1]):
            with self.assertRaises(ValueError):
                rows(invalid)
        self.assertEqual(rows({"data": {"rows": []}}), [])

    def test_jwt_is_not_sent_to_plan(self):
        seen = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'[]'
        def open_(request, **kwargs):
            seen.append(dict(request.header_items()))
            return Response()
        with patch('urllib.request.urlopen', open_):
            self.pulse.fetch(PLAN)
            self.pulse.fetch(BASE + "pasillos/lineas/picking")
        self.assertNotIn("Authorization", seen[0])
        self.assertEqual(seen[1]["Authorization"], "secret-never-published")


class GitPublicationTests(unittest.TestCase):
    def git(self, path, *args):
        return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def test_preserves_remote_edits_and_rejects_stale_files_individually(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote, local, other = (root / n for n in ('remote', 'local', 'other'))
            subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
            subprocess.run(['git', 'clone', str(remote), str(local)], check=True, capture_output=True)
            for p in [local]:
                self.git(p, 'config', 'user.name', 'Test')
                self.git(p, 'config', 'user.email', 'test@example.com')
            (local / 'index.html').write_text('original UI')
            (local / 'stock.json').write_text('{"updated_at":"2026-10-22T12:00:00Z"}')
            self.git(local, 'add', '.')
            self.git(local, 'commit', '-m', 'initial')
            self.git(local, 'branch', '-M', 'main')
            self.git(local, 'push', '-u', 'origin', 'main')
            subprocess.run(['git', 'clone', '-b', 'main', str(remote), str(other)], check=True, capture_output=True)
            self.git(other, 'config', 'user.name', 'Test')
            self.git(other, 'config', 'user.email', 'test@example.com')
            (other / 'index.html').write_text('new UI with user changes')
            (other / 'stock.json').write_text('{"updated_at":"2026-10-22T13:00:00Z"}')
            self.git(other, 'add', '.')
            self.git(other, 'commit', '-m', 'concurrent change')
            self.git(other, 'push')
            (local / 'avance-pedidos.json').write_text('{"updated_at":"2026-10-22T14:00:00Z","rows":[]}')
            self.assertTrue(DatasetPublisher(local).publish_files(['stock.json', 'avance-pedidos.json']))
            self.assertEqual(self.git(remote, 'show', 'main:index.html'), 'new UI with user changes')
            self.assertIn('13:00', self.git(remote, 'show', 'main:stock.json'))
            self.assertIn('14:00', self.git(remote, 'show', 'main:avance-pedidos.json'))
            self.assertEqual((local / 'index.html').read_text(), 'original UI')
            self.assertFalse(DatasetPublisher(local).publish_files(['avance-pedidos.json']))
            self.assertFalse(StockPublisher(local).publish())


if __name__ == '__main__':
    unittest.main()
