const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.match(/\/\* LOGISTIC_GROUPS_START \*\/([\s\S]*?)\/\* LOGISTIC_GROUPS_END \*\//);
assert.ok(block, 'Falta el bloque de grupos logísticos');
const api = new Function(
  block[1] +
  '\nreturn {LOGISTIC_GROUP_RANGES, LOGISTIC_GROUP_PARENTS, LOCATION_GROUP, logisticRangeModules, logisticGroupsMatch};'
)();

const expected = {
  FMFCUP1: 58,
  FMFCUP2: 29,
  FMFCAU: 32,
  FMFCAB: 12,
  FMFCBU: 32,
  FMFCBB: 16,
  FMFCCU1: 46,
  FMFCCU2: 58,
  FMFCCB: 52
};

assert.deepStrictEqual(api.LOGISTIC_GROUP_RANGES.map(r => r.group), Object.keys(expected));

const counts = {};
api.LOGISTIC_GROUP_RANGES.forEach(range => {
  const mods = api.logisticRangeModules(range);
  assert.strictEqual(mods.length, range.modules, range.group + ' no coincide con su conteo declarado');
  assert.strictEqual(mods.length, expected[range.group], range.group);
  counts[range.group] = mods.length;
  mods.forEach(key => assert.strictEqual(api.LOCATION_GROUP[key], range.group));
});

assert.strictEqual(Object.keys(api.LOCATION_GROUP).length, 335);
assert.deepStrictEqual([...new Set(Object.values(api.LOCATION_GROUP))].sort(), Object.keys(expected).sort());

assert.strictEqual(api.LOCATION_GROUP.MFCA11, 'FMFCAB');
assert.strictEqual(api.LOCATION_GROUP.MFCA22, 'FMFCAB');
assert.strictEqual(api.LOCATION_GROUP.MFCA23, 'FMFCBB');
assert.strictEqual(api.LOCATION_GROUP.MFCA38, 'FMFCBB');
assert.strictEqual(api.LOCATION_GROUP.MFCA39, 'FMFCCB');
assert.strictEqual(api.LOCATION_GROUP.MFCA69, 'FMFCCB');
assert.strictEqual(api.LOCATION_GROUP.MFCA71, 'FMFCCB');
assert.strictEqual(api.LOCATION_GROUP.MFCA94, 'FMFCCB');
assert.strictEqual(api.LOCATION_GROUP.MFCA70, undefined);
assert.strictEqual(api.LOCATION_GROUP.MFCA95, 'FMFCCU1');
assert.strictEqual(api.LOCATION_GROUP.MFCA140, 'FMFCCU1');
assert.strictEqual(api.LOCATION_GROUP.MFCB11, 'FMFCAU');
assert.strictEqual(api.LOCATION_GROUP.MFCB42, 'FMFCAU');
assert.strictEqual(api.LOCATION_GROUP.MFCB43, 'FMFCBU');
assert.strictEqual(api.LOCATION_GROUP.MFCB74, 'FMFCBU');
assert.strictEqual(api.LOCATION_GROUP.MFCB75, 'FMFCCU2');
assert.strictEqual(api.LOCATION_GROUP.MFCB132, 'FMFCCU2');
assert.strictEqual(api.LOCATION_GROUP.MFCC11, 'FMFCUP1');
assert.strictEqual(api.LOCATION_GROUP.MFCC125, 'FMFCUP1');
assert.strictEqual(api.LOCATION_GROUP.MFCC12, undefined);
assert.strictEqual(api.LOCATION_GROUP.A40, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A96, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A41, undefined);
assert.strictEqual(api.LOCATION_GROUP.B8, undefined);
assert.strictEqual(api.LOCATION_GROUP.B38, undefined);

['FMFCV', 'FMFCCU', 'FMFCUP'].forEach(old => {
  assert.ok(!Object.values(api.LOCATION_GROUP).includes(old), old + ' sigue asignado a un módulo');
});

assert.strictEqual(api.logisticGroupsMatch('FMFCUP', 'FMFCUP1'), true);
assert.strictEqual(api.logisticGroupsMatch('FMFCUP', 'FMFCUP2'), true);
assert.strictEqual(api.logisticGroupsMatch('FMFCCU', 'FMFCCU1'), true);
assert.strictEqual(api.logisticGroupsMatch('FMFCCU', 'FMFCCU2'), true);
assert.strictEqual(api.logisticGroupsMatch('FMFCUP1', 'FMFCUP1'), true);
assert.strictEqual(api.logisticGroupsMatch('FMFCUP1', 'FMFCUP2'), false);
assert.strictEqual(api.logisticGroupsMatch('FMFCCU1', 'FMFCCU2'), false);
assert.strictEqual(api.logisticGroupsMatch('FMFCUP', 'FMFCCU1'), false);
assert.strictEqual(api.logisticGroupsMatch('FMFCAB', 'FMFCAB'), true);
assert.strictEqual(api.logisticGroupsMatch('SIN GRUPO', 'FMFCAB'), false);
assert.strictEqual(api.logisticGroupsMatch('FMFCBU', 'FMFCUP1'), false);

assert.ok(html.includes('id="sanitationModeBtn"'));
assert.ok(html.includes('function sanitationPlanForGroup'));
assert.ok(html.includes('logisticGroupsMatch(s.grupoSku, src.locGroup)'));
assert.ok(html.includes('logisticGroupsMatch(targetGroup, dest.grupo)'));

console.log('grupos logísticos ok', counts);
