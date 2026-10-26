/**
 * Contrato HTTP de Copérnico tomado de los workflows y de scripts/*.py.
 * El JWT viaja en Authorization tal cual lo devuelve el login (sin "Bearer ").
 */

export const DEFAULT_TECH_USER_ID = 11257;
export const LOGIN_PATH = "/users/api/login";
export const LOGOUT_PATH = "/users/api/logout";
export const STOCK_PATH = "/backweb25/inventario/obtenerrefsxcaja?bodega=47";

const ID_KEYS = new Set([
  "id", "userid", "user_id", "idusuario", "id_usuario", "usuarioid", "usuario_id"
]);

export function copernicoEnabled(env) {
  return String(env?.COPERNICO_ENABLED ?? "") === "1";
}

export function copernicoBase(env) {
  return String(env?.COPERNICO_BASE || "").trim().replace(/\/+$/, "");
}

export function loginBody(email, password) {
  return { email, password, plataforma: "Copernico WMS" };
}

export function copernicoHeaders(jwt) {
  const headers = {
    accept: "application/json, text/plain, */*",
    origin: "https://copernicowms.com",
    referer: "https://copernicowms.com/",
    "user-agent": "Mozilla/5.0"
  };
  if (jwt) headers.authorization = String(jwt);
  return headers;
}

export function loginFailureIsRecoverable(status, detail) {
  if (status !== 403 && status !== 418) return false;
  const text = String(detail || "").toLowerCase();
  return text.includes("sesión activa")
    || text.includes("sesion activa")
    || text.includes("licen")
    || text.includes("cupo");
}

function asUserId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return number > 0 ? number : null;
  }
  return null;
}

export function recursiveUserId(obj) {
  if (Array.isArray(obj)) {
    for (const value of obj) {
      const found = recursiveUserId(value);
      if (found != null) return found;
    }
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  for (const [key, value] of Object.entries(obj)) {
    const normalized = String(key).toLowerCase().replace(/-/g, "_");
    if (ID_KEYS.has(normalized)) {
      const id = asUserId(value);
      if (id != null) return id;
    }
  }
  for (const value of Object.values(obj)) {
    const found = recursiveUserId(value);
    if (found != null) return found;
  }
  return null;
}

export function userIdFromJwt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(padded));
    const found = recursiveUserId(json);
    if (found != null) return found;
    return asUserId(json?.sub);
  } catch {
    return null;
  }
}

export function userIdFromLogin(login, jwt, fallback = DEFAULT_TECH_USER_ID) {
  return recursiveUserId(login) ?? userIdFromJwt(jwt) ?? fallback;
}

export function argentinaDay(now = new Date()) {
  const shifted = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return { day: `${y}${m}${d}`, label: `${d}/${m}/${y}` };
}

export function pickingLinesPath(day) {
  return `/backweb25/pasillos/lineas/picking?fecha=${encodeURIComponent(day)}`;
}

export function productivityPath(day) {
  return `/backweb25/kpi/productividad/empleados?${new URLSearchParams({
    fecha: day,
    tipo_productividad: "ProductividadPIK"
  })}`;
}

export function negatedLinesPath(day) {
  return `/backweb25/kpi/dashboard/lineas-negadas?${new URLSearchParams({
    fechainicial: day,
    fechafinal: day,
    topRanking: "10",
    tipo: "0",
    opcion: "RS8"
  })}`;
}

export function ubicacionesPath(caja) {
  return `/backweb25/caja/getubicaciones?caja=${encodeURIComponent(caja)}`;
}

export function movimientosPath(caja) {
  return `/backweb25/caja/getmovimientos?caja=${encodeURIComponent(caja)}`;
}

export function pickingDetailPath(picking) {
  return `/backweb25/dwh_picking/picking?${new URLSearchParams({ pickingint: String(picking) })}`;
}

export function normalizeCaja(value) {
  const text = String(value ?? "").trim();
  const labeled = text.match(/Nw:\s*(\d+)/i);
  const digits = (labeled ? labeled[1] : text).replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return /^\d{3,12}$/.test(digits) ? digits : "";
}

export function normKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function field(row, names) {
  if (!row || typeof row !== "object") return "";
  const indexed = new Map(Object.entries(row).map(([key, value]) => [normKey(key), value]));
  for (const name of names) {
    const key = normKey(name);
    if (!indexed.has(key)) continue;
    const value = indexed.get(key);
    if (value != null) return value;
  }
  return "";
}

export function sval(row, names) {
  return String(field(row, names) ?? "").trim();
}

export function extractRows(payload) {
  if (Array.isArray(payload)) return payload.filter(row => row && typeof row === "object");
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["rows", "data", "items", "result", "results", "movimientos", "stock", "inventario", "ubicaciones"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(row => row && typeof row === "object");
    if (value && typeof value === "object") {
      for (const sub of ["rows", "data", "items", "results", "movimientos", "ubicaciones"]) {
        if (Array.isArray(value[sub])) return value[sub].filter(row => row && typeof row === "object");
      }
    }
  }
  return [];
}

const PICKING_ZONES = ["MFCA", "MFCB", "MFCC", "AR", "BR"];

export function zoneOf(row) {
  const value = sval(row, ["zonapiso", "ZonaPiso", "zona", "Zona"]).toUpperCase();
  return PICKING_ZONES.find(zone => value === zone || value.startsWith(`${zone} `) || (zone.startsWith("MFC") && value.startsWith(zone))) || "";
}

export function isExecuted(row) {
  const state = sval(row, ["describeestadolinea", "descripcionlinea", "EstadoDeLinea", "EstadoLinea", "Estado"]).toUpperCase();
  return ["EJECUT", "CONFIRM", "NEGAD"].some(word => state.includes(word));
}

export function aggregatePicking(picking, rows) {
  const zonas = Object.fromEntries(PICKING_ZONES.map(zone => [zone, { total: 0, ejecutadas: 0, pendientes: 0 }]));
  let done = 0;
  let units = 0;
  for (const row of rows) {
    const executed = isExecuted(row);
    if (executed) done += 1;
    const zone = zoneOf(row);
    if (zone) {
      zonas[zone].total += 1;
      zonas[zone][executed ? "ejecutadas" : "pendientes"] += 1;
    }
    const qty = Number(String(field(row, ["Cant", "Cantidad", "unidad"]) ?? "").replace(",", "."));
    if (Number.isFinite(qty)) units += qty;
  }
  const total = rows.length;
  const avance = total ? Math.round((1000 * done) / total) / 10 : 0;
  let estado = "PENDIENTE";
  if (total && done >= total) estado = "FINALIZADO";
  else if (done > 0) estado = "INICIADO";
  return {
    ok: true,
    picking: String(picking),
    pedido: sval(rows[0] || {}, ["pedido", "NumPedido", "Pedido"]),
    lineas: total,
    unidades: units,
    ejecutadas: done,
    pendientes: total - done,
    avance,
    estado,
    zonas
  };
}

const MOVEMENT_FIELDS = {
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

export function normalizeMovimientos(payload) {
  return extractRows(payload).slice(0, 2500).map(row => {
    const out = {};
    for (const [name, aliases] of Object.entries(MOVEMENT_FIELDS)) out[name] = field(row, aliases);
    return out;
  });
}

export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function embedJson(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return "null";
}
