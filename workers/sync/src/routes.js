import {
  aggregatePicking,
  copernicoEnabled,
  extractRows,
  movimientosPath,
  normalizeCaja,
  normalizeMovimientos,
  parseJson,
  pickingDetailPath
} from "./copernico.js";
import { readGzip, readJson } from "./store.js";
import { argentinaDay } from "./copernico.js";

const PICKINGS_PER_REQUEST = 20;

function allowOrigin(origin) {
  if (!origin) return "*";
  if (origin === "https://lupavon.github.io") return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

function jsonResponse(body, status, origin, extra = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra
  };
  const allowed = allowOrigin(origin);
  if (allowed) {
    headers["access-control-allow-origin"] = allowed;
    headers["access-control-allow-headers"] = "authorization, content-type, accept";
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers.vary = "Origin";
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export function pathToDatasetKey(pathname, now = new Date()) {
  const path = String(pathname || "").replace(/^\/+/, "");
  const today = argentinaDay(now).day;
  if (path === "stock.json") return "stock";
  if (path === "pallets-proceso.json") return "pallets-proceso";
  if (path === "en-recibo.json") return "en-recibo";
  if (path === "trazabilidad-cajas.json") return "trazabilidad";
  if (path === "negaciones.json" || path === "tiempos.json" || path === "avance-pedidos.json") return `operacion:${today}`;
  const match = path.match(/^datos\/([a-z-]+)\/(\d{8})\.json$/);
  if (!match) return "";
  const [, kind, day] = match;
  if (kind === "negaciones" || kind === "tiempos" || kind === "avance" || kind === "lineas-negadas") return `operacion:${day}`;
  if (kind === "lineas-picking") return `lineas-picking:${day}`;
  if (kind === "productividad") return `productividad:${day}`;
  if (kind === "productividad-resumen") return `productividad-resumen:${day}`;
  return "";
}

async function serveDataset(env, key, origin) {
  const stored = await readGzip(env, key);
  if (!stored) return jsonResponse({ ok: false, error: "Dataset todavía no sincronizado" }, 404, origin);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
    "cache-control": "no-store",
    "x-ubic-raw": "1",
    "x-ubic-updated-at": stored.updated_at || ""
  });
  const allowed = allowOrigin(origin);
  if (allowed) {
    headers.set("access-control-allow-origin", allowed);
    headers.set("access-control-expose-headers", "X-Ubic-Raw, X-Ubic-Updated-At");
    headers.set("vary", "Origin");
  }
  return new Response(stored.gzip, { status: 200, headers });
}

async function serveRaw(env, key, origin) {
  const stored = await readJson(env, key);
  if (!stored) return jsonResponse({ ok: false, error: "Sin datos" }, 404, origin);
  const parsed = stored.json;
  return jsonResponse(parsed, 200, origin);
}

function disabled(origin) {
  return jsonResponse({ ok: false, error: "Copérnico está deshabilitado" }, 503, origin);
}

async function handleCaja(request, env, origin) {
  if (!copernicoEnabled(env)) return disabled(origin);
  if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "Método no permitido" }, 405, origin);
  const caja = normalizeCaja(new URL(request.url).searchParams.get("numero") || new URL(request.url).searchParams.get("caja") || "");
  if (!caja) return jsonResponse({ ok: false, error: "Número de caja inválido" }, 400, origin);
  const started = Date.now();
  const result = await env.SESSION.getByName("copernico").requestMany([movimientosPath(caja)]);
  if (result.disabled) return disabled(origin);
  const fetched = result.results[0] || { status: 0, body: "" };
  if (fetched.status === 404) {
    return jsonResponse({
      ok: true, caja, source: "Copernico WMS · getmovimientos", fetched_at: new Date().toISOString(),
      elapsed_ms: Date.now() - started, movimientos_count: 0,
      warning: "Copérnico no tiene movimientos para esta caja.", movimientos: []
    }, 200, origin);
  }
  const data = parseJson(fetched.body);
  if (fetched.status !== 200 || !data) {
    return jsonResponse({ ok: false, error: "Copérnico no devolvió los movimientos de la caja" }, 502, origin);
  }
  const movimientos = normalizeMovimientos(data);
  return jsonResponse({
    ok: true,
    caja,
    source: "Copernico WMS · getmovimientos",
    fetched_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    movimientos_count: movimientos.length,
    warning: "",
    movimientos
  }, 200, origin);
}

async function handlePickings(request, env, origin) {
  if (!copernicoEnabled(env)) return disabled(origin);
  if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "Método no permitido" }, 405, origin);
  const numeros = [...new Set(String(new URL(request.url).searchParams.get("numeros") || "")
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(item => /^\d+$/.test(item)))];
  if (!numeros.length) return jsonResponse({ ok: false, error: "Faltan números de picking" }, 400, origin);
  const selected = numeros.slice(0, PICKINGS_PER_REQUEST);
  const result = await env.SESSION.getByName("copernico").requestMany(selected.map(picking => pickingDetailPath(picking)));
  if (result.disabled) return disabled(origin);
  const pickings = selected.map((picking, index) => {
    const fetched = result.results[index] || { status: 0, body: "" };
    const data = parseJson(fetched.body);
    if (fetched.status !== 200 || !data) {
      return { ok: false, picking, error: `HTTP ${fetched.status || 0}` };
    }
    try {
      return aggregatePicking(picking, extractRows(data));
    } catch (error) {
      return { ok: false, picking, error: error instanceof Error ? error.message : "Detalle inválido" };
    }
  });
  for (const picking of numeros.slice(PICKINGS_PER_REQUEST)) {
    pickings.push({ ok: false, picking, error: "Cupo de subrequests del plan gratuito; reintentá el resto" });
  }
  return jsonResponse({ ok: true, updated_at: new Date().toISOString(), pickings }, 200, origin);
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin") || "";
  if (url.pathname === "/health" || url.pathname === "/") {
    return jsonResponse({
      ok: true,
      service: "ubicaciones-sync",
      copernico_enabled: copernicoEnabled(env),
      crons: {
        "* * * * *": ["stock", "en-recibo", "pallets-proceso"],
        "*/3 * * * *": ["negaciones", "lineas-negadas", "tiempos", "avance"],
        "*/10 * * * *": ["lineas-picking", "productividad", "productividad-resumen", "trazabilidad"]
      }
    }, 200, origin);
  }
  if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
  if (url.pathname === "/caja") return handleCaja(request, env, origin);
  if (url.pathname === "/pickings" || url.pathname === "/picking") return handlePickings(request, env, origin);
  if (url.pathname.startsWith("/api/raw/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/raw/".length));
    if (!key || key.includes("..")) return jsonResponse({ ok: false, error: "Clave inválida" }, 400, origin);
    return serveRaw(env, key, origin);
  }
  const key = pathToDatasetKey(url.pathname);
  if (key) return serveDataset(env, key, origin);
  return jsonResponse({ ok: false, error: "Endpoint no encontrado" }, 404, origin);
}
