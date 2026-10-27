const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.match(/\/\* LOGISTIC_GROUPS_START \*\/([\s\S]*?)\/\* LOGISTIC_GROUPS_END \*\//);
assert.ok(block, 'Falta el bloque de grupos logísticos');
const api = new Function(
  block[1] +
  '\nreturn {LOGISTIC_GROUP_RANGES, LOGISTIC_GROUP_PARENTS, LOCATION_GROUP, logisticRangeModules, logisticGroupsMatch, isRetiredCalleB, isActiveLayoutModule};'
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
assert.strictEqual(api.LOCATION_GROUP.A64, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A66, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A80, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A96, 'FMFCUP2');
assert.strictEqual(api.LOCATION_GROUP.A41, undefined);
assert.strictEqual(api.LOCATION_GROUP.A98, undefined);
assert.strictEqual(api.LOCATION_GROUP.B8, undefined);
assert.strictEqual(api.LOCATION_GROUP.B38, undefined);

const up2 = api.logisticRangeModules(api.LOGISTIC_GROUP_RANGES.find(r => r.group === 'FMFCUP2'));
const up2nums = up2.map(k => Number(k.slice(1)));
assert.deepStrictEqual(up2nums.filter(n => n <= 64), [40,42,44,46,48,50,52,54,56,58,60,62,64]);
assert.deepStrictEqual(up2nums.filter(n => n >= 66), [66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96]);
assert.strictEqual(up2nums.filter(n => n >= 66).length, 16);
assert.ok(Object.keys(api.LOCATION_GROUP).every(k => !k.startsWith('B')));

[8,10,12,16,28,38].forEach(n => {
  assert.strictEqual(api.isRetiredCalleB('B', n), true);
  assert.strictEqual(api.isActiveLayoutModule('B', n), false);
});
assert.strictEqual(api.isActiveLayoutModule('A', 40), true);
assert.strictEqual(api.isActiveLayoutModule('A', 64), true);
assert.strictEqual(api.isActiveLayoutModule('A', 66), true);
assert.strictEqual(api.isActiveLayoutModule('A', 96), true);
assert.strictEqual(api.isActiveLayoutModule('A', 38), false);
assert.strictEqual(api.isActiveLayoutModule('A', 65), false);
assert.strictEqual(api.isActiveLayoutModule('A', 98), false);

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
assert.ok(html.includes('return isActiveLayoutModule(prefix, mod);'));
assert.ok(!html.includes("{prefix:'B',zones:['BR']"));
assert.ok(html.includes("isRetiredCalleB(s.prefix, s.modulo)"));

console.log('grupos logísticos ok', counts);
