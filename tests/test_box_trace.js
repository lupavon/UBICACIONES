const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.match(/\/\* BOX_TRACE_LOGIC_START \*\/([\s\S]*?)\/\* BOX_TRACE_LOGIC_END \*\//);
assert.ok(block, 'Falta el bloque de lógica de Trazabilidades');
const api = new Function(
  block[1] +
  '\nreturn {boxTraceBuildIndex, boxTraceQueryKey, boxTraceSelect, boxTraceSummary, boxTraceFmtFecha, boxTraceClassify, boxTraceEvent, boxTraceMergeLive};'
)();

assert.strictEqual(api.boxTraceQueryKey('221210'), '221210');
assert.strictEqual(api.boxTraceQueryKey('  0221210 '), '221210');
assert.strictEqual(api.boxTraceQueryKey('Nw: 221210'), '221210');
assert.strictEqual(api.boxTraceQueryKey('caja 221210'), '221210');
assert.strictEqual(api.boxTraceFmtFecha('2026-10-21T10:32:02.217'), '21/10/2026 10:32:02');

const trace = JSON.parse(fs.readFileSync(path.join(root, 'trazabilidad-cajas.json'), 'utf8'));
const ghost = JSON.parse(fs.readFileSync(path.join(root, 'cajas-fantasma-movimientos.json'), 'utf8'));
const index = api.boxTraceBuildIndex(trace, ghost);
assert.ok(index.events.length > 6000, 'el índice debería conservar los movimientos publicados');

const out = api.boxTraceSelect(index.events, '221210', 'hacia');
const summary = api.boxTraceSummary(out.all);
const dests = new Set(summary.destinos.map(d => d.caja));
assert.ok(dests.has('204400'), '221210 debería descontar hacia 204400');
assert.strictEqual(summary.destinos.length, 9);
assert.ok(out.visible.every(row => row.kind === 'hacia' && row.origin === '221210' && row.dest));
assert.ok(out.visible.every(row => /RECIBE DESDE Nw:\s*221210/i.test(row.tx)));

const inbound = api.boxTraceSelect(index.events, '201420', 'recibido');
assert.ok(inbound.visible.some(row => row.origin === '596528' && row.sku === '13347' && row.dest === '201420'));

const ghostOut = api.boxTraceSelect(index.events, '420117', 'hacia');
assert.ok(ghostOut.visible.some(row => row.dest === '283705' && row.source === 'fantasma' && row.sku === '2657'));
assert.ok(ghostOut.visible.some(row => /SALE HACIA Nw:\s*283705/.test(row.tx)));

const missing = api.boxTraceSelect(index.events, '999999999', 'todos');
assert.strictEqual(missing.all.length, 0);

const elimina = index.events.find(row => row.holder === '410928' && row.dest === '260871');
assert.ok(elimina, 'ELIMINA LINEA POR SALE HACIA debe contar como descuento hacia la caja destino');
assert.strictEqual(api.boxTraceClassify(elimina, '410928'), 'hacia');

const published = [
  api.boxTraceEvent('591435', { Fecha: '2026-01-01T00:00:00', EAN: '9', Estado: 'Entrada', Movimiento: 1, Transaccion: 'CREACION CAJA', Nombre_empleado: 'A' }, 'vigente'),
  api.boxTraceEvent('204400', { Fecha: '2026-02-01T00:00:00', EAN: '111', Estado: 'Entrada', Movimiento: 5, Transaccion: 'RECIBE DESDE Nw: 591435', Nombre_empleado: 'B' }, 'vigente'),
  api.boxTraceEvent('320631', { Fecha: '2026-02-02T00:00:00', EAN: '222', Estado: 'Entrada', Movimiento: 3, Transaccion: 'RECIBE DESDE Nw: 591435', Nombre_empleado: 'C' }, 'vigente')
];
const merged = api.boxTraceMergeLive(published, '591435', [
  { Fecha: '2026-02-01T00:00:01', EAN: '111', Estado: 'Salida', Movimiento: -5, Transaccion: 'SALE HACIA Nw: 204400', Nombre_empleado: 'B' },
  { Fecha: '2026-03-01T00:00:00', EAN: '333', Estado: 'Entrada', Movimiento: 1, Transaccion: 'UBICA MUELLE', Nombre_empleado: 'D' }
]);
assert.ok(!merged.some(row => row.holder === '591435' && row.source === 'vigente'));
assert.ok(merged.some(row => row.source === 'vivo' && row.dest === '204400' && row.sku === '111' && row.kind === undefined && row.sentido === 'hacia'));
assert.ok(!merged.some(row => row.source === 'vigente' && row.dest === '204400' && row.sku === '111'));
assert.ok(merged.some(row => row.source === 'vigente' && row.dest === '320631' && row.sku === '222'));
assert.ok(merged.some(row => row.source === 'vivo' && row.sku === '333' && row.tx === 'UBICA MUELLE'));
const mergedView = api.boxTraceSelect(merged, '591435', 'hacia');
assert.ok(mergedView.visible.some(row => row.dest === '204400' && row.source === 'vivo'));
assert.ok(mergedView.visible.some(row => row.dest === '320631' && row.source === 'vigente'));

console.log('test_box_trace ok', {
  events: index.events.length,
  destinos221210: summary.destinos.length,
  unidades221210: summary.unidades
});
