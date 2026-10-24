/**
 * Ruta /caja?numero= para el worker YA desplegado ubicaciones-operacion.
 *
 * Ese script no vive en este repositorio (versión en producción:
 * session-per-picking-v1). No hay workflow que lo publique. Para activar
 * la ruta, en el proyecto que ya despliega ese worker:
 *   1. Copiar este archivo.
 *   2. En fetch(), como PRIMERA decisión, antes del OPTIONS global
 *      (hoy ese OPTIONS solo permite Content-Type; si responde primero,
 *      el browser no puede mandar el Bearer del dashboard), pasar login,
 *      logout, headers y cookies del propio worker:
 *        if (new URL(request.url).pathname === "/caja") {
 *          return handleCaja(request, env, {
 *            login: loginCopernico,
 *            logout: logoutFinal,
 *            headers: session => copernicoHeaders(session.jar, { Authorization: String(session.jwt) }),
 *            capture: (session, response) => session.jar.capture(response)
 *          });
 *        }
 *   3. npx wrangler deploy
 * No desplegar este archivo como script completo: /picking dejaría de existir.
 * No hace falta un secret nuevo; el worker ya tiene COPERNICO_EMAIL y COPERNICO_PASSWORD.
 * Para validar la sesión del dashboard hace falta un service binding:
 *   variable AUTH, servicio ubicaciones-auth.
 * Un fetch() a https://ubicaciones-auth...workers.dev desde este worker
 * cae en el error 1042 de Cloudflare (misma zona) y no llega a /session.
 *
 * La sesión técnica es una sola. Esta ruta lee el JWT que ya esté en memoria
 * o en KV y no llama a logout. Si Copérnico responde 403/418, no se fuerza
 * otro login: Picking en curso sigue con la sesión que tiene.
 */

const LOGIN_URL = "https://services.copernicowms.com/users/api/login";
const MOVEMENTS_URL = "https://services.copernicowms.com/backweb25/caja/getmovimientos";
const DASHBOARD_SESSION_URL = "https://ubicaciones-auth.pavonlucas-m.workers.dev/session";
const SESSION_TTL_MS = 8 * 60 * 1000;
const MAX_MOVEMENTS = 2500;
const RATE_LIMIT = 20;
const JWT_KEYS = ["jwt", "copernico_jwt", "session", "copernico_session", "auth"];

const memory = { jwt: "", exp: 0, skipKv: false };
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

export function resetCajaSession() {
  memory.jwt = "";
  memory.exp = 0;
  memory.skipKv = false;
  rateBuckets.clear();
}

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
  return extractRows(payload).slice(0, MAX_MOVEMENTS).map(row => {
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
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
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
    return {};
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

function jwtFrom(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if (text.startsWith("{")) {
      try {
        return jwtFrom(JSON.parse(text));
      } catch {
        return "";
      }
    }
    return text.length >= 8 ? text : "";
  }
  if (typeof value === "object") return jwtFrom(value.jwt || value.token || value.access_token || "");
  return "";
}

async function readKvJwt(env) {
  if (memory.skipKv || !env) return "";
  // Solo el KV real. Iterar env tocaba el service binding AUTH: stub.get() es una llamada RPC que colgaba ubicaciones-auth.
  const kv = env.COPERNICO_STATE;
  if (!kv || typeof kv.get !== "function") return "";
  for (const key of JWT_KEYS) {
    try {
      const jwt = jwtFrom(await kv.get(key));
      if (jwt) return jwt;
    } catch {
      /* sin sesión en KV */
    }
  }
  return "";
}

function sessionUnreachable() {
  const error = new Error("No se pudo verificar la sesión del dashboard. Volvé a publicar ubicaciones-operacion con el service binding AUTH hacia ubicaciones-auth.");
  error.status = 503;
  return error;
}

async function fetchDashboardSession(request, env, auth) {
  const headers = { authorization: auth, accept: "application/json" };
  const origin = request.headers.get("origin");
  if (origin) headers.origin = origin;
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;
  const init = { method: "GET", headers };
  // El fetch público a otro workers.dev de la misma cuenta responde 1042.
  if (env?.AUTH && typeof env.AUTH.fetch === "function") return env.AUTH.fetch(DASHBOARD_SESSION_URL, init);
  return fetch(DASHBOARD_SESSION_URL, init);
}

async function dashboardUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length < 16) return null;
  const response = await fetchDashboardSession(request, env, auth);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (response.status === 401 || data?.error === "No autenticado") return null;
  if (!response.ok || text.includes("1042")) throw sessionUnreachable();
  const username = data?.user?.username;
  return typeof username === "string" && username ? data.user : null;
}

function sessionBusy() {
  const error = new Error("La sesión técnica de Copérnico está en uso. No se forzó otro login para no cortar Picking en curso.");
  error.status = 503;
  return error;
}

async function login(env) {
  const email = env?.COPERNICO_EMAIL;
  const password = env?.COPERNICO_PASSWORD;
  if (!email || !password) {
    const error = new Error("Faltan los secrets COPERNICO_EMAIL y COPERNICO_PASSWORD en el worker");
    error.status = 503;
    throw error;
  }
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { ...copernicoHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ email, password, plataforma: "Copernico WMS" })
  });
  if (response.status === 403 || response.status === 418) throw sessionBusy();
  const data = await readJson(response);
  if (!response.ok || !data?.jwt) {
    const error = new Error("No se pudo abrir la sesión técnica de Copérnico");
    error.status = 502;
    throw error;
  }
  memory.jwt = data.jwt;
  memory.exp = Date.now() + SESSION_TTL_MS;
  memory.skipKv = true;
  return memory.jwt;
}

async function ensureJwt(env) {
  if (memory.jwt && Date.now() < memory.exp) return memory.jwt;
  memory.jwt = "";
  const cached = await readKvJwt(env);
  if (cached) {
    memory.jwt = cached;
    memory.exp = Date.now() + SESSION_TTL_MS;
    return cached;
  }
  return login(env);
}

async function loadMovements(env, caja) {
  const ask = async () => {
    const jwt = await ensureJwt(env);
    const started = Date.now();
    const response = await fetch(MOVEMENTS_URL + "?caja=" + encodeURIComponent(caja), {
      headers: copernicoHeaders(jwt)
    });
    return { response, started };
  };
  let result = await ask();
  if (result.response.status === 401) {
    memory.jwt = "";
    memory.exp = 0;
    memory.skipKv = true;
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


async function loadMovementsWithSession(env, caja, deps) {
  let session = null;
  try {
    session = await deps.login(env);
    const ask = async () => {
      const started = Date.now();
      const response = await fetch(MOVEMENTS_URL + "?caja=" + encodeURIComponent(caja), {
        method: "GET",
        headers: deps.headers(session)
      });
      if (deps.capture) deps.capture(session, response);
      return { response, started };
    };
    let result = await ask();
    if (result.response.status === 401) {
      try { await deps.logout(session); } catch (_) {}
      session = await deps.login(env);
      result = await ask();
    }
    if (result.response.status === 404) {
      return { movimientos: [], elapsedMs: Date.now() - result.started, warning: "Copérnico no tiene movimientos para esta caja." };
    }
    const data = await readJson(result.response);
    if (!result.response.ok) {
      console.log("CAJA GETMOVIMIENTOS", caja, result.response.status);
      const error = new Error("Copérnico no devolvió los movimientos de la caja (HTTP " + result.response.status + ")");
      error.status = 502;
      throw error;
    }
    return { movimientos: normalizeMovimientos(data), elapsedMs: Date.now() - result.started, warning: "" };
  } finally {
    if (session) {
      try { await deps.logout(session); } catch (e) { console.log("CAJA LOGOUT ERROR", e?.message || e); }
    }
  }
}

export async function handleCaja(request, env, deps) {
  try {
    return await handleCajaInner(request, env, deps);
  } catch (error) {
    console.error("CAJA ERROR", error?.stack || error?.message || error);
    let origin = "";
    try { origin = request.headers.get("origin") || ""; } catch (_) {}
    return jsonResponse({ ok: false, error: (error && error.message) || "Error interno consultando la caja" }, 502, origin);
  }
}

async function handleCajaInner(request, env, deps) {
  const origin = request.headers.get("origin") || "";
  if (origin && !allowOrigin(origin)) return jsonResponse({ ok: false, error: "Origen no permitido" }, 403, origin);
  if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "Método no permitido" }, 405, origin);
  const url = new URL(request.url);
  const caja = normalizeCaja(url.searchParams.get("numero") || url.searchParams.get("caja") || "");
  if (!caja) return jsonResponse({ ok: false, error: "Número de caja inválido" }, 400, origin);
  try {
    const user = await dashboardUser(request, env);
    if (!user) return jsonResponse({ ok: false, error: "Tenés que ingresar al dashboard para consultar Copérnico" }, 401, origin);
    if (!withinRate(clientKey(request, user.username))) {
      return jsonResponse({ ok: false, error: "Demasiadas consultas. Esperá un minuto." }, 429, origin);
    }
    const loaded = deps && typeof deps.login === "function"
      ? await loadMovementsWithSession(env, caja, deps)
      : await loadMovements(env, caja);
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
    console.error("CAJA FALLO", caja, error?.status || 502, error?.message || error);
    return jsonResponse({ ok: false, error: error.message || "No se pudo consultar la caja" }, error.status || 502, origin);
  }
}

/** Delega /picking y /pickings al fetch que ya tiene el worker. */
export async function routeOperacion(request, env, pickingFetch) {
  const url = new URL(request.url);
  if (url.pathname === "/caja") return handleCaja(request, env);
  if (typeof pickingFetch !== "function") {
    return jsonResponse({ ok: false, error: "Endpoint no encontrado" }, 404, request.headers.get("origin") || "");
  }
  return pickingFetch(request, env);
}
