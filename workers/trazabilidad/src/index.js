/**
 * Respaldo si /caja todavía no está en ubicaciones-operacion.
 * Usa el mismo handler: reutiliza el JWT y no fuerza logout.
 * No desplegar este worker con el nombre ubicaciones-operacion.
 */
import { handleCaja, normalizeCaja, normalizeMovimientos } from "../../operacion/src/caja.js";

export { normalizeCaja, normalizeMovimientos };

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/caja") return handleCaja(request, env);
    const origin = request.headers.get("origin") || "";
    if (origin && !allowOrigin(origin)) return jsonResponse({ ok: false, error: "Origen no permitido" }, 403, origin);
    if (request.method === "OPTIONS") return jsonResponse({ ok: true }, 204, origin);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        service: "UBICACIONES Trazabilidad",
        endpoint: "/caja?numero=591435",
        secrets: { email: Boolean(env.COPERNICO_EMAIL), password: Boolean(env.COPERNICO_PASSWORD) }
      }, 200, origin);
    }
    return jsonResponse({ ok: false, error: "Endpoint no encontrado" }, 404, origin);
  }
};
