import assert from 'node:assert/strict';
import worker, { normalizeCaja, normalizeMovimientos } from '../workers/trazabilidad/src/index.js';

const password = 'clave-que-no-puede-salir';
const dashboard = 'Bearer dashboard-token-de-prueba';
const jwt = 'jwt-tecnico-de-prueba';

assert.equal(normalizeCaja('591435'), '591435');
assert.equal(normalizeCaja('Nw: 0591435'), '591435');
assert.equal(normalizeCaja('12'), '');
assert.equal(normalizeCaja('591435;drop'), '591435');

const rows = normalizeMovimientos({ movimientos: [{ 'Fecha Hora': '2026-10-01 08:00:00', ean: '10', Transacción: 'SALE HACIA Nw: 1' }] });
assert.equal(rows[0].EAN, '10');
assert.equal(rows[0].Transaccion, 'SALE HACIA Nw: 1');
assert.equal(rows[0].Fecha, '2026-10-01 08:00:00');

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  const body = options.body ? String(options.body) : '';
  calls.push({ href, body, authorization: options.headers?.authorization || options.headers?.Authorization || '' });
  if (href.endsWith('/session')) {
    const auth = options.headers?.authorization || '';
    if (auth !== dashboard) return json({ error: 'No autenticado' }, 401);
    return json({ user: { username: 'operador' } });
  }
  if (href.endsWith('/login')) {
    assert.equal(JSON.parse(body).password, password);
    return json({ jwt, id: 11257 });
  }
  if (href.includes('getmovimientos')) {
    assert.equal(options.headers.authorization, jwt);
    assert.equal(body.includes(password), false);
    return json([{ Fecha: '2026-10-02T10:00:00', EAN: '77', Estado: 'Salida', Movimiento: -3, Transaccion: 'SALE HACIA Nw: 204400', Nombre_empleado: 'Luis' }]);
  }
  return json({ ok: false }, 500);
};

const env = { COPERNICO_EMAIL: 'tech@example.com', COPERNICO_PASSWORD: password, COPERNICO_USER_ID: '11257' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const denied = await worker.fetch(new Request('https://worker.test/caja?numero=591435', {
  headers: { origin: 'https://evil.example' }
}), env);
assert.equal(denied.status, 403);

const missing = await worker.fetch(new Request('https://worker.test/caja?numero=591435', {
  headers: { origin: 'https://lupavon.github.io' }
}), env);
assert.equal(missing.status, 401);
const missingBody = await missing.json();
assert.equal(missingBody.error.includes('ingresar'), true);
assert.equal(JSON.stringify(missingBody).includes(password), false);

const health = await worker.fetch(new Request('https://worker.test/health'), env);
const healthBody = await health.json();
assert.equal(healthBody.secrets.password, true);
assert.equal(JSON.stringify(healthBody).includes(password), false);

calls.length = 0;
const ok = await worker.fetch(new Request('https://worker.test/caja?numero=591435', {
  headers: { origin: 'https://lupavon.github.io', authorization: dashboard }
}), env);
const okBody = await ok.json();
assert.equal(ok.status, 200);
assert.equal(okBody.ok, true);
assert.equal(okBody.caja, '591435');
assert.equal(okBody.movimientos.length, 1);
assert.equal(okBody.movimientos[0].Transaccion, 'SALE HACIA Nw: 204400');
assert.equal(JSON.stringify(okBody).includes(password), false);
assert.equal(JSON.stringify(okBody).includes(jwt), false);
assert.equal(calls.some(call => call.href.includes('/login') && call.body.includes(password)), true);
assert.equal(calls.some(call => call.href.includes('getmovimientos') && call.authorization === jwt), true);

const cached = await worker.fetch(new Request('https://worker.test/caja?numero=100200', {
  headers: { origin: 'http://127.0.0.1:8765', authorization: dashboard }
}), env);
assert.equal(cached.status, 200);
assert.equal(calls.filter(call => call.href.endsWith('/login')).length, 1);

const unknown = await worker.fetch(new Request('https://worker.test/otra', {
  headers: { origin: 'https://lupavon.github.io', authorization: dashboard }
}), env);
assert.equal(unknown.status, 404);

const preflight = await worker.fetch(new Request('https://worker.test/health', {
  method: 'OPTIONS',
  headers: { origin: 'https://lupavon.github.io', 'access-control-request-method': 'GET' }
}), env);
assert.equal(preflight.status, 204);
assert.equal(preflight.body, null);
assert.equal(await preflight.text(), '');

console.log('test_trazabilidad_worker ok');
