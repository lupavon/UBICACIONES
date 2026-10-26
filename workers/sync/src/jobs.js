import {
  STOCK_PATH,
  argentinaDay,
  copernicoEnabled,
  embedJson,
  movimientosPath,
  negatedLinesPath,
  pickingLinesPath,
  productivityPath,
  ubicacionesPath
} from "./copernico.js";
import { advanceMixedIndex, cajaKey, emptyMixedState, extractMarkedRows, mixedPlan, stockFingerprint } from "./stock-scan.js";
import { putIfChanged, putJsonIfChanged, readJson } from "./store.js";

const UBICACIONES_PER_RUN = 35;
const MOVIMIENTOS_PER_RUN = 30;
const MIXED_BUDGET = 400;
const MIN_STOCK_MARKERS = 100;

export const CRON_JOBS = {
  "* * * * *": ["stock", "en-recibo", "pallets-proceso"],
  "*/3 * * * *": ["negaciones", "lineas-negadas", "tiempos", "avance"],
  "*/10 * * * *": ["lineas-picking", "productividad", "productividad-resumen", "trazabilidad"]
};

function nowIso() {
  return new Date().toISOString().replace("Z", "+00:00");
}

function log(message, extra = {}) {
  console.log(JSON.stringify({ message, ...extra }));
}

async function copernicoMany(env, paths) {
  const stub = env.SESSION.getByName("copernico");
  return stub.requestMany(paths);
}

function fieldLoose(row, names) {
  const indexed = {};
  for (const [key, value] of Object.entries(row || {})) {
    indexed[String(key).toLowerCase().replace(/[\s_-]+/g, "")] = value;
  }
  for (const name of names) {
    const key = name.toLowerCase().replace(/[\s_-]+/g, "");
    if (indexed[key] != null && String(indexed[key]).trim()) return indexed[key];
  }
  return "";
}

function uniqueCajas(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const caja = cajaKey(fieldLoose(row, ["Caja", "caja", "numeroCaja", "NroCaja"]));
    if (!caja || seen.has(caja)) continue;
    seen.add(caja);
    out.push(caja);
  }
  out.sort();
  return out;
}

async function refreshUbicaciones(env, cajas, previous) {
  const cursorRow = await readJson(env, "cursor:ubicaciones");
  const offset = Number(cursorRow?.json?.offset) || 0;
  const start = offset >= cajas.length ? 0 : offset;
  const batch = cajas.slice(start, start + UBICACIONES_PER_RUN);
  const next = start + batch.length >= cajas.length ? 0 : start + batch.length;
  const fetched = batch.length
    ? await copernicoMany(env, batch.map(caja => ubicacionesPath(caja)))
    : { disabled: false, results: [] };
  if (fetched.disabled) return { disabled: true, ubicaciones: {}, errors: {} };
  const ubicaciones = { ...(previous?.ubicaciones || {}) };
  const errors = {};
  fetched.results.forEach((result, index) => {
    const caja = batch[index];
    if (result.status === 200 && result.body) {
      try {
        ubicaciones[caja] = JSON.parse(result.body);
        delete errors[caja];
      } catch {
        errors[caja] = "Respuesta de ubicaciones ilegible";
      }
    } else if (!(caja in ubicaciones)) {
      errors[caja] = `HTTP ${result.status || 0}`;
    } else {
      errors[caja] = `HTTP ${result.status || 0}; se conserva la respuesta anterior`;
    }
  });
  await putJsonIfChanged(env, "cursor:ubicaciones", { offset: next }, nowIso());
  return { disabled: false, ubicaciones, errors, queried: batch };
}

export async function runMinute(env) {
  const stamp = nowIso();
  const fetched = await copernicoMany(env, [STOCK_PATH]);
  if (fetched.disabled) return { skipped: fetched.error || "disabled" };
  const stock = fetched.results[0];
  if (!stock || stock.status !== 200 || !stock.body) {
    log("stock no actualizado", { status: stock?.status || 0 });
    return { skipped: "stock" };
  }
  const markerHits = (stock.body.match(/"EAN"/g) || []).length;
  if (markerHits < MIN_STOCK_MARKERS) {
    log("stock sospechoso, se conserva el anterior", { markerHits });
    return { skipped: "stock-short", markerHits };
  }
  const processRows = extractMarkedRows(stock.body, "EN_PROCESO");
  const receiptRows = extractMarkedRows(stock.body, "RECIBO");
  const previousPallets = await readJson(env, "pallets-proceso");
  const previousReceipt = await readJson(env, "en-recibo");
  const cajas = uniqueCajas([...processRows, ...receiptRows]);
  const traces = await refreshUbicaciones(env, cajas, {
    ubicaciones: {
      ...(previousReceipt?.json?.ubicaciones || {}),
      ...(previousPallets?.json?.ubicaciones || {})
    }
  });
  if (!traces.disabled) {
    await putJsonIfChanged(env, "pallets-proceso", {
      raw: true,
      dataset: "pallets-proceso",
      updated_at: stamp,
      stock_rows: processRows,
      ubicaciones: pickCajas(traces.ubicaciones, uniqueCajas(processRows)),
      errors: traces.errors
    }, stamp);
    await putJsonIfChanged(env, "en-recibo", {
      raw: true,
      dataset: "en-recibo",
      updated_at: stamp,
      stock_rows: receiptRows,
      ubicaciones: pickCajas(traces.ubicaciones, uniqueCajas(receiptRows)),
      errors: traces.errors
    }, stamp);
  }
  const progress = await readJson(env, "trace:progress");
  const fingerprint = stockFingerprint(stock.body);
  let traceState = progress?.json || emptyMixedState();
  if (traceState.done && traceState.fingerprint !== fingerprint) traceState = emptyMixedState();
  if (!traceState.fingerprint) traceState.fingerprint = fingerprint;
  const advanced = advanceMixedIndex(stock.body, traceState, MIXED_BUDGET);
  advanced.fingerprint = traceState.fingerprint;
  await putJsonIfChanged(env, "trace:progress", advanced, stamp);
  const stored = await putIfChanged(env, "stock", stock.body, stamp);
  log("minuto", { stock: stored.skipped ? "igual" : "escrito", cajas: cajas.length, traceDone: advanced.done });
  return { ok: true, stock: stored, cajas: cajas.length };
}

function pickCajas(ubicaciones, cajas) {
  const out = {};
  for (const caja of cajas) if (caja in ubicaciones) out[caja] = ubicaciones[caja];
  return out;
}

export async function runOperational(env) {
  const stamp = nowIso();
  const { day, label } = argentinaDay();
  const fetched = await copernicoMany(env, [
    pickingLinesPath(day),
    productivityPath(day),
    negatedLinesPath(day)
  ]);
  if (fetched.disabled) return { skipped: fetched.error || "disabled" };
  const [picking, productivity, negated] = fetched.results;
  if (![picking, productivity, negated].every(item => item && item.status === 200 && item.body)) {
    log("operacion incompleta", {
      picking: picking?.status || 0,
      productivity: productivity?.status || 0,
      negated: negated?.status || 0
    });
    return { skipped: "incomplete" };
  }
  const body = `{"raw":true,"updated_at":${JSON.stringify(stamp)},"fecha":${JSON.stringify(label)},"fecha_query":${JSON.stringify(day)},"productividad":${embedJson(productivity.body)},"lineas_picking":${embedJson(picking.body)},"lineas_negadas":${embedJson(negated.body)},"productividad_http":${productivity.status},"lineas_picking_http":${picking.status},"motivos_http":${negated.status}}`;
  const stored = await putIfChanged(env, `operacion:${day}`, body, stamp);
  log("operacion", { day, skipped: stored.skipped });
  return { ok: true, day, stored };
}

export async function runHeavy(env) {
  const stamp = nowIso();
  const { day, label } = argentinaDay();
  const progress = await readJson(env, "trace:progress");
  const plan = progress?.json?.done ? mixedPlan(progress.json) : { locations: {}, box_skus: {}, cajas: [] };
  const known = await readJson(env, "trazabilidad");
  const previous = known?.json || {};
  const priority = traceQueue(plan, previous).slice(0, MOVIMIENTOS_PER_RUN);
  const fetched = await copernicoMany(env, [
    pickingLinesPath(day),
    productivityPath(day),
    ...priority.map(caja => movimientosPath(caja))
  ]);
  if (fetched.disabled) return { skipped: fetched.error || "disabled" };
  const [picking, productivity, ...moves] = fetched.results;
  if (picking?.status === 200 && picking.body) {
    const pickingBody = `{"raw":true,"updated_at":${JSON.stringify(stamp)},"fecha":${JSON.stringify(label)},"fecha_query":${JSON.stringify(day)},"body":${embedJson(picking.body)}}`;
    await putIfChanged(env, `lineas-picking:${day}`, pickingBody, stamp);
  }
  if (productivity?.status === 200 && productivity.body) {
    const prodBody = `{"raw":true,"updated_at":${JSON.stringify(stamp)},"fecha":${JSON.stringify(label)},"fecha_query":${JSON.stringify(day)},"body":${embedJson(productivity.body)}}`;
    await putIfChanged(env, `productividad:${day}`, prodBody, stamp);
  }
  if (picking?.status === 200 && productivity?.status === 200) {
    const summary = `{"raw":true,"updated_at":${JSON.stringify(stamp)},"fecha":${JSON.stringify(label)},"fecha_query":${JSON.stringify(day)},"picking_updated_at":${JSON.stringify(stamp)},"productividad":${embedJson(productivity.body)},"lineas_picking":${embedJson(picking.body)}}`;
    await putIfChanged(env, `productividad-resumen:${day}`, summary, stamp);
  }
  const errors = { ...(previous.errors || {}) };
  for (let index = 0; index < priority.length; index += 1) {
    const caja = priority[index];
    const result = moves[index];
    if (result?.status === 200 && result.body) {
      await putIfChanged(env, `trace:caja:${caja}`, result.body, stamp);
      delete errors[caja];
    } else {
      errors[caja] = `HTTP ${result?.status || 0}`;
    }
  }
  const index = {
    raw: true,
    dataset: "trazabilidad",
    updated_at: stamp,
    locations: plan.locations,
    box_skus: plan.box_skus,
    cajas: plan.cajas,
    errors,
    queried_this_cycle: priority,
    index_ready: Boolean(progress?.json?.done)
  };
  await putJsonIfChanged(env, "trazabilidad", index, stamp);
  log("pesado", { day, queried: priority.length, indexReady: index.index_ready });
  return { ok: true, day, queried: priority.length };
}

function traceQueue(plan, previous) {
  const unresolved = [];
  const changed = [];
  const rest = [];
  for (const caja of plan.cajas || []) {
    const signature = plan.box_skus[caja] || [];
    const old = previous.box_skus?.[caja];
    if (!old) unresolved.push(caja);
    else if (JSON.stringify(old) !== JSON.stringify(signature)) changed.push(caja);
    else rest.push(caja);
  }
  return [...unresolved, ...changed, ...rest];
}

export async function runScheduled(controller, env) {
  if (!copernicoEnabled(env)) {
    log("cron omitido", { cron: controller.cron, reason: "COPERNICO_ENABLED" });
    return { skipped: "disabled" };
  }
  const cron = controller.cron;
  if (cron === "* * * * *") return runMinute(env);
  if (cron === "*/3 * * * *") return runOperational(env);
  if (cron === "*/10 * * * *") return runHeavy(env);
  log("cron sin trabajo", { cron });
  return { skipped: cron };
}
