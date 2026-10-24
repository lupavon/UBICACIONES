/**
 * Consulta getmovimientos de una caja sin entregar la clave al navegador.
 * Verifica la sesión del dashboard y usa COPERNICO_EMAIL / COPERNICO_PASSWORD.
 * Pensado para publicarse como ubicaciones-trazabilidad.<cuenta>.workers.dev
 * o para copiar el handler /caja dentro de ubicaciones-operacion, que ya
 * tiene esos secrets y la sesión técnica.
 */

const LOGIN_URL = "https://services.copernicowms.com/users/api/login";
const LOGOUT_URL = "https://services.copernicowms.com/users/api/logout";
const MOVEMENTS_URL = "https://services.copernicowms.com/backweb25/caja/getmovimientos";
const DASHBOARD_SESSION_URL = "https://ubicaciones-auth.pavonlucas-m.workers.dev/session";
const DEFAULT_TECH_USER_ID = 11257;
const SESSION_TTL_MS = 8 * 60 * 1000;
const MAX_MOVEMENTS = 2500;
const RATE_LIMIT = 20;

const sessionCache = { jwt: "", userId: 0, exp: 0 };
const rateBuckets = new Map();

const FIELD_ALIASES = {
  Fecha: ["Fecha", "fecha", "FechaHora", "Fecha Hora", "FechaMovimiento", "Fecha Mov"],
  EAN: ["EAN", "ean"],
  Estado: ["Estado", "estado"],
  Movimiento: ["Movimiento", "movimiento"],
  Saldo: ["Saldo", "saldo"],
  Transaccion: ["Transaccion", "Transacción", "transaccion"],
  Nombre_empleado: ["Nombre_empleado", "Nombre empleado", "NombreEmpleado"],
  Id_empleado: ["Id_empleado", "ID empleado", "IdEmpleado"],
  NoControl: ["NoControl", "No Control", "nocontrol"]
};

export function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function normalizeCaja(value) {
  const text = String(value ?? "").trim();
  const labeled = text.match(/Nw:\s*(\d+)/i);
  const digits = (labeled ? labeled[1] : text).replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return /^\d{3,12}$/.test(digits) ? digits : "";
}

export function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["rows", "data", "items", "result", "results", "movimientos", "stock", "inventario"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const sub of ["rows", "data", "items", "results"]) {
        if (Array.isArray(value[sub])) return value[sub];
      }
    }
  }
  return [];
}

function pickField(row, names) {
  if (!row || typeof row !== "object") return "";
  const indexed = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const name of names) {
    if (!indexed.has(normalizeKey(name))) continue;
    const value = indexed.get(normalizeKey(name));
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

export function normalizeMovimientos(payload) {
  const rows = extractRows(payload).slice(0, MAX_MOVEMENTS);
  return rows.map(row => {
    const out = {};
    for (const [name, aliases] of Object.entries(FIELD_ALIASES)) out[name] = pickField(row, aliases);
    return out;
  });
}

function allowOrigin(origin) {
  if (!origin) return "*";
  if (origin === "https://lupavon.github.io") return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

function jsonResponse(body, status, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  const allowed = allowOrigin(origin);
  if (allowed) {
    headers["access-control-allow-origin"] = allowed;
    headers["access-control-allow-headers"] = "authorization, content-type, accept";
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers.vary = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function clientKey(request, username) {
  return (username || "anon") + "|" + (request.headers.get("cf-connecting-ip") || "local");
}

function withinRate(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60000;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return bucket.count <= RATE_LIMIT;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 180) };
  }
}

function copernicoHeaders(jwt) {
  const headers = {
    accept: "application/json, text/plain, */*",
    origin: "https://copernicowms.com",
    referer: "https://copernicowms.com/",
    "user-agent": "Mozilla/5.0"
  };
  if (jwt) headers.authorization = jwt;
  return headers;
}

async function dashboardUser(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length < 16) return null;
  const response = await fetch(DASHBOARD_SESSION_URL, {
    headers: { authorization: auth, accept: "application/json" }
  });
  if (!response.ok) return null;
  const data = await readJson(response);
  const username = data?.user?.username;
  return typeof username === "string" && username ? data.user : null;
}

function userIdFrom(login, jwt) {
  const direct = Number(login?.id || login?.user?.id || login?.usuario?.id);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    const part = String(jwt || "").split(".")[1] || "";
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    const claim = Number(claims.id || claims.user_id || claims.sub);
    if (Number.isInteger(claim) && claim > 0) return claim;
  } catch {
    /* El id técnico configurado cubre el logout de contingencia. */
  }
  return 0;
}

async function forceLogout(userId) {
  await fetch(LOGOUT_URL, {
    method: "POST",
    headers: { ...copernicoHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ id: Number(userId) })
  });
}

async function login(env) {
  const email = env.COPERNICO_EMAIL;
  const password = env.COPERNICO_PASSWORD;
  if (!email || !password) {
    const error = new Error("Faltan los secrets COPERNICO_EMAIL y COPERNICO_PASSWORD en el worker");
    error.status = 503;
    throw error;
  }
  const techId = Number(env.COPERNICO_USER_ID) || DEFAULT_TECH_USER_ID;
  let response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { ...copernicoHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ email, password, plataforma: "Copernico WMS" })
  });
  if (response.status === 403 || response.status === 418) {
    await forceLogout(techId);
    response = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { ...copernicoHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ email, password, plataforma: "Copernico WMS" })
    });
  }
  const data = await readJson(response);
  if (!response.ok || !data?.jwt) {
    const error = new Error("No se pudo abrir la sesión técnica de Copérnico");
    error.status = 502;
    throw error;
  }
  return { jwt: data.jwt, userId: userIdFrom(data, data.jwt) || techId };
}

async function ensureSession(env, force) {
  if (!force && sessionCache.jwt && Date.now() < sessionCache.exp) return sessionCache;
  const fresh = await login(env);
  sessionCache.jwt = fresh.jwt;
  sessionCache.userId = fresh.userId;
  sessionCache.exp = Date.now() + SESSION_TTL_MS;
  return sessionCache;
}

async function loadMovements(env, caja) {
  const ask = async () => {
    const current = await ensureSession(env, false);
    const started = Date.now();
    const response = await fetch(MOVEMENTS_URL + "?caja=" + encodeURIComponent(caja), {
      headers: copernicoHeaders(current.jwt)
    });
    return { response, started };
  };
  let result = await ask();
  if (result.response.status === 401) {
    sessionCache.jwt = "";
    sessionCache.exp = 0;
    await ensureSession(env, true);
    result = await ask();
  }
  if (result.response.status === 404) {
    return { movimientos: [], elapsedMs: Date.now() - result.started, warning: "Copérnico no tiene movimientos para esta caja." };
  }
  const data = await readJson(result.response);
  if (!result.response.ok) {
    const error = new Error("Copérnico no devolvió los movimientos de la caja");
    error.status = 502;
    throw error;
  }
  return { movimientos: normalizeMovimientos(data), elapsedMs: Date.now() - result.started, warning: "" };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    if (origin && !allowOrigin(origin)) return jsonResponse({ ok: false, error: "Origen no permitido" }, 403, origin);
    if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: "UBICACIONES Trazabilidad",
        endpoint: "/caja?numero=591435",
        secrets: { email: Boolean(env.COPERNICO_EMAIL), password: Boolean(env.COPERNICO_PASSWORD) }
      }, 200, origin);
    }
    if (request.method !== "GET" || url.pathname !== "/caja") {
      return jsonResponse({ ok: false, error: "Endpoint no encontrado" }, 404, origin);
    }
    const caja = normalizeCaja(url.searchParams.get("numero") || url.searchParams.get("caja") || "");
    if (!caja) return jsonResponse({ ok: false, error: "Número de caja inválido" }, 400, origin);
    try {
      const user = await dashboardUser(request);
      if (!user) return jsonResponse({ ok: false, error: "Tenés que ingresar al dashboard para consultar Copérnico" }, 401, origin);
      if (!withinRate(clientKey(request, user.username))) {
        return jsonResponse({ ok: false, error: "Demasiadas consultas. Esperá un minuto." }, 429, origin);
      }
      const loaded = await loadMovements(env, caja);
      return jsonResponse({
        ok: true,
        caja,
        source: "Copernico WMS · getmovimientos",
        fetched_at: new Date().toISOString(),
        elapsed_ms: loaded.elapsedMs,
        movimientos_count: loaded.movimientos.length,
        warning: loaded.warning,
        movimientos: loaded.movimientos
      }, 200, origin);
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || "No se pudo consultar la caja" }, error.status || 502, origin);
    }
  }
};
