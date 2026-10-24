const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.match(/\/\* BOX_TRACE_LOGIC_START \*\/([\s\S]*?)\/\* BOX_TRACE_LOGIC_END \*\//);
assert.ok(block, 'Falta el bloque de lógica de Trazabilidades');
const api = new Function(
  block[1] +
  '\nreturn {boxTraceBuildIndex, boxTraceQueryKey, boxTraceSelect, boxTraceSummary, boxTraceFmtFecha, boxTraceClassify};'
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

console.log('test_box_trace ok', {
  events: index.events.length,
  destinos221210: summary.destinos.length,
  unidades221210: summary.unidades
});
