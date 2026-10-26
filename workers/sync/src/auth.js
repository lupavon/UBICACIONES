const DASHBOARD_SESSION_URL = "https://ubicaciones-auth.pavonlucas-m.workers.dev/session";
export async function dashboardUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length < 16) return null;
  const headers = { authorization: auth, accept: "application/json" };
  const o = request.headers.get("origin"); if (o) headers.origin = o;
  const ua = request.headers.get("user-agent"); if (ua) headers["user-agent"] = ua;
  if (!env?.AUTH || typeof env.AUTH.fetch !== "function") { const e = new Error("Falta el service binding AUTH"); e.status = 503; throw e; }
  const r = await env.AUTH.fetch(DASHBOARD_SESSION_URL, { method: "GET", headers });
  const text = await r.text(); let d = {}; try { d = text ? JSON.parse(text) : {}; } catch {}
  if (r.status === 401 || d?.error === "No autenticado") return null;
  if (!r.ok) { const e = new Error("No se pudo verificar la sesión del dashboard"); e.status = 503; throw e; }
  const u = d?.user?.username; return typeof u === "string" && u ? d.user : null;
}
