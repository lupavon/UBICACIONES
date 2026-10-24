const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.match(/\/\* PREPARED_LINES_LOGIC_START \*\/([\s\S]*?)\/\* PREPARED_LINES_LOGIC_END \*\//);
assert.ok(block, 'Falta el bloque de líneas preparadas');
const api = new Function(
  block[1] +
  '\nreturn {preparedLineIsPicked, preparedLineLocation, preparedLineModuleKey, preparedLinesAggregate, layoutCellGridStyle, layoutCellExtent, preparedLegendItems};'
)();

assert.strictEqual(api.preparedLineModuleKey('MFCA0930103'), 'MFCA93');
assert.strictEqual(api.preparedLineModuleKey('mfcc0110107'), 'MFCC11');
assert.strictEqual(api.preparedLineModuleKey('A400101'), 'A40');
assert.strictEqual(api.preparedLineModuleKey('A0660101'), 'A66');
assert.strictEqual(api.preparedLineModuleKey('B080101'), 'B08');
assert.strictEqual(api.preparedLineModuleKey('B800101'), 'B80');
assert.strictEqual(api.preparedLineModuleKey('CAR0340102'), '');
assert.strictEqual(api.preparedLineModuleKey('A40'), '');

assert.strictEqual(api.preparedLineIsPicked({EstadoDeLinea:'Confirmada'}), true);
assert.strictEqual(api.preparedLineIsPicked({EstadoDeLinea:'Negada'}), false);
assert.strictEqual(api.preparedLineIsPicked({EstadoLineaTsscc:'Confirmada', Ubicacion:'MFCA110101'}), true);
assert.strictEqual(api.preparedLineIsPicked({EstadoDeLinea:'Negada', EstadoLineaTsscc:'Confirmada'}), false);
assert.strictEqual(api.preparedLineLocation({ubicacion_asig:'A400108', Ubicacion:'MFCA110101'}), 'A400108');

const agg = api.preparedLinesAggregate([
  {EstadoDeLinea:'Confirmada', ubicacion_asig:'MFCA110103'},
  {EstadoDeLinea:'Confirmada', ubicacion_asig:'MFCA110104'},
  {EstadoDeLinea:'Confirmada', ubicacion_asig:'A400101'},
  {EstadoDeLinea:'Confirmada', ubicacion_asig:'A660102'},
  {EstadoDeLinea:'Negada', ubicacion_asig:'A400102'},
  {EstadoDeLinea:'Confirmada', ubicacion_asig:'CAR010101'}
], ['MFCA11', 'A40', 'A66']);
assert.strictEqual(agg.counts.MFCA11, 2);
assert.strictEqual(agg.counts.A40, 1);
assert.strictEqual(agg.counts.A66, 1);
assert.strictEqual(agg.inLayout, 4);
assert.strictEqual(agg.outside, 1);
assert.strictEqual(agg.ignored, 1);
assert.strictEqual(agg.prepared, 5);
assert.deepStrictEqual(agg.bins.MFCA11, {MFCA110103:1, MFCA110104:1});

assert.strictEqual(api.layoutCellGridStyle({r:1, c:10}).gridRow, '1');
assert.strictEqual(api.layoutCellGridStyle({r:1, c:10}).gridColumn, '10');
assert.strictEqual(api.layoutCellGridStyle({r:4, c:10, rowSpan:2}).gridRow, '4 / span 2');
assert.strictEqual(api.layoutCellGridStyle({r:'38 / span 2', c:10}).gridRow, '38 / span 2');
assert.strictEqual(api.layoutCellGridStyle({r:1, c:10, gridRow:'1 / span 2'}).gridRow, '1 / span 2');
const extent = api.layoutCellExtent([
  {r:1, c:1},
  {r:38, c:10, rowSpan:2}
]);
assert.deepStrictEqual(extent, {rows:39, cols:10});

const legend = api.preparedLegendItems(10);
assert.deepStrictEqual(legend.map(item => item.cls), ['zero', 'h1', 'h2', 'h3', 'h4', 'h5']);
assert.strictEqual(api.preparedLegendItems(0)[0].text, '0');

assert.ok(html.includes('id="preparedModeBtn"'), 'falta la pestaña');
assert.ok(html.includes('id="preparedLinesView"'), 'falta la vista');
assert.ok(html.includes("mode==='prepared'"), 'setDisplayMode no abre la vista');
assert.ok(html.includes('preparedLinesView'), 'la vista de usuarios no oculta el mapa');
assert.strictEqual((html.match(/const LAYOUT_CELLS=/g) || []).length, 1, 'el layout compartido no debe duplicarse');

const layoutMatch = html.match(/const LAYOUT_CELLS=(\[[\s\S]*?\]);/);
assert.ok(layoutMatch, 'no encontré LAYOUT_CELLS');
const cells = JSON.parse(layoutMatch[1]);
const labels = cells.map(cell => cell.label);
const day = JSON.parse(fs.readFileSync(path.join(root, 'datos/lineas-picking/20261023.json'), 'utf8'));
const real = api.preparedLinesAggregate(day.rows, labels);
assert.ok(real.inLayout > 2000, 'el día 23/10 debería pintar el layout de secos');
assert.ok(real.counts.A40 > 0, 'A40 debería tener líneas preparadas');
assert.ok(real.counts.MFCA11 >= 0);
assert.ok(real.outside > 0, 'hay líneas de otras zonas que no entran en esta grilla');
assert.strictEqual(real.ignored, day.rows.length - real.prepared);
const placed = cells.map(cell => api.layoutCellGridStyle(cell));
assert.ok(placed.every(style => /^\d+/.test(style.gridRow) && /^\d+/.test(style.gridColumn)));
const size = api.layoutCellExtent(cells);
assert.ok(size.cols >= 10 && size.rows >= 69);

console.log('prepared lines layout ok', {
  inLayout: real.inLayout,
  outside: real.outside,
  ignored: real.ignored,
  modules: labels.length,
  max: Math.max(...Object.values(real.counts))
});
