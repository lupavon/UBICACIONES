import assert from "node:assert/strict";
import { handleCaja, resetCajaSession, routeOperacion } from "../workers/operacion/src/caja.js";

const password = "clave-que-no-puede-salir";
const dashboard = "Bearer dashboard-token-de-prueba";
const jwt = "jwt-tecnico-de-prueba";
const calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  const body = options.body ? String(options.body) : "";
  calls.push({ href, body, authorization: options.headers?.authorization || "" });
  if (href.endsWith("/session")) {
    if ((options.headers?.authorization || "") !== dashboard) return json({ error: "No autenticado" }, 401);
    return json({ user: { username: "operador" } });
  }
  if (href.endsWith("/logout")) return json({ ok: true });
  if (href.endsWith("/login")) {
    if (globalThis.__cajaLoginStatus) return json({ error: "sesion activa" }, globalThis.__cajaLoginStatus);
    return json({ jwt, id: 11257 });
  }
  if (href.includes("getmovimientos")) {
    if (globalThis.__cajaMovements401 && !globalThis.__cajaMovementsRetried) {
      globalThis.__cajaMovementsRetried = true;
      return json({ error: "unauthorized" }, 401);
    }
    return json([{ Fecha: "2026-10-02T10:00:00", EAN: "77", Estado: "Salida", Movimiento: -3, Transaccion: "SALE HACIA Nw: 204400", Nombre_empleado: "Luis" }]);
  }
  return json({ ok: false }, 500);
};

function cajaRequest(numero = "591435") {
  return new Request("https://ubicaciones-operacion.pavonlucas-m.workers.dev/caja?numero=" + numero, {
    headers: { origin: "https://lupavon.github.io", authorization: dashboard }
  });
}

const env = { COPERNICO_EMAIL: "tech@example.com", COPERNICO_PASSWORD: password };

resetCajaSession();
calls.length = 0;
const first = await handleCaja(cajaRequest(), env);
const firstBody = await first.json();
assert.equal(first.status, 200);
assert.equal(firstBody.movimientos[0].Transaccion, "SALE HACIA Nw: 204400");
assert.equal(JSON.stringify(firstBody).includes(password), false);
assert.equal(JSON.stringify(firstBody).includes(jwt), false);
assert.equal(calls.filter(call => call.href.endsWith("/login")).length, 1);
assert.equal(calls.some(call => call.href.includes("/logout")), false);

calls.length = 0;
const second = await handleCaja(cajaRequest("100200"), env);
assert.equal(second.status, 200);
assert.equal(calls.some(call => call.href.endsWith("/login")), false);
assert.equal(calls.some(call => call.href.includes("getmovimientos") && call.authorization === jwt), true);

resetCajaSession();
globalThis.__cajaLoginStatus = 418;
calls.length = 0;
const busy = await handleCaja(cajaRequest(), env);
const busyBody = await busy.json();
assert.equal(busy.status, 503);
assert.equal(busyBody.error.includes("Picking"), true);
assert.equal(calls.some(call => call.href.includes("/logout")), false);
assert.equal(calls.filter(call => call.href.endsWith("/login")).length, 1);
globalThis.__cajaLoginStatus = 0;

resetCajaSession();
const puts = [];
const kv = {
  async get(key) { return key === "jwt" ? "jwt-desde-kv-de-picking" : null; },
  async put(...args) { puts.push(args); }
};
calls.length = 0;
const reused = await handleCaja(cajaRequest(), { ...env, SESSION: kv });
assert.equal(reused.status, 200);
assert.equal(calls.some(call => call.href.endsWith("/login")), false);
assert.equal(calls.some(call => call.authorization === "jwt-desde-kv-de-picking"), true);
assert.equal(puts.length, 0);

resetCajaSession();
globalThis.__cajaMovements401 = true;
globalThis.__cajaMovementsRetried = false;
calls.length = 0;
const refreshed = await handleCaja(cajaRequest("300300"), { ...env, SESSION: kv });
assert.equal(refreshed.status, 200);
assert.equal(calls.filter(call => call.href.endsWith("/login")).length, 1);
assert.equal(calls.some(call => call.href.includes("/logout")), false);
assert.equal(puts.length, 0);

const pickingCalls = [];
const pickingFetch = async () => {
  pickingCalls.push("picking");
  return new Response("picking-ok", { status: 200 });
};
const picking = await routeOperacion(new Request("https://worker.test/pickings?numeros=77257"), env, pickingFetch);
assert.equal(await picking.text(), "picking-ok");
assert.equal(pickingCalls.length, 1);
const cajaViaRoute = await routeOperacion(cajaRequest("400400"), env, pickingFetch);
assert.equal(cajaViaRoute.status, 200);
assert.equal(pickingCalls.length, 1);

console.log("test_operacion_caja ok");
