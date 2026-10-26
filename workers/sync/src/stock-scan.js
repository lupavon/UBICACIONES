/**
 * Recortes baratos sobre el texto crudo de stock. No arma el JSON del dashboard:
 * solo elige filas y avanza un índice de mezclas para no parsear las ~12 mil líneas.
 */

function objectSlice(text, valueAt) {
  const start = text.lastIndexOf("{", valueAt);
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  const limit = Math.min(text.length, start + 12000);
  for (let j = start; j < limit; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return "";
}

function isLocationValue(text, valueAt) {
  const back = text.slice(Math.max(0, valueAt - 48), valueAt);
  return /(?:Ubicacion|ubicacion|Location)"\s*:\s*"$/.test(back);
}

export function extractMarkedRows(text, marker) {
  const rows = [];
  const source = String(text || "");
  let i = 0;
  while ((i = source.indexOf(marker, i)) !== -1) {
    if (isLocationValue(source, i)) {
      const slice = objectSlice(source, i);
      if (slice) {
        try {
          rows.push(JSON.parse(slice));
        } catch {
          /* fila ilegible: se omite */
        }
      }
    }
    i += marker.length;
  }
  return rows;
}

export function cajaKey(value) {
  const text = String(value ?? "").trim();
  const digits = text.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits || text;
}

function grab(slice, key) {
  const needle = `"${key}"`;
  const at = slice.indexOf(needle);
  if (at < 0) return "";
  let i = slice.indexOf(":", at + needle.length) + 1;
  while (slice[i] === " ") i += 1;
  if (slice[i] === '"') {
    const end = slice.indexOf('"', i + 1);
    return end < 0 ? "" : slice.slice(i + 1, end);
  }
  let j = i;
  while (j < slice.length && slice[j] !== "," && slice[j] !== "}") j += 1;
  return slice.slice(i, j).trim();
}

export function emptyMixedState() {
  return { offset: 0, done: false, locations: {}, fingerprint: "" };
}

export function stockFingerprint(text) {
  const source = String(text || "");
  return `${source.length}:${source.slice(0, 160)}:${source.slice(-160)}`;
}

/**
 * Avanza el índice de mezclas como máximo `budget` objetos.
 * El estado es JSON puro para guardarlo gzip en D1 entre corridas.
 * No reinicia solo: el cron decide cuándo empezar de cero.
 */
export function advanceMixedIndex(text, state, budget = 800) {
  const source = String(text || "");
  const next = {
    offset: Number(state?.offset) || 0,
    done: false,
    locations: state?.locations ? { ...state.locations } : {},
    fingerprint: state?.fingerprint || ""
  };
  if (next.offset < 0 || next.offset > source.length) next.offset = 0;
  if (next.offset >= source.length) {
    next.done = true;
    return next;
  }
  let start = source.indexOf("{", next.offset);
  let seen = 0;
  while (start >= 0 && seen < budget) {
    const slice = objectSlice(source, start + 1);
    if (!slice) break;
    const end = start + slice.length - 1;
    const ubic = grab(slice, "Ubicacion") || grab(slice, "ubicacion");
    if (ubic) {
      const saldo = Number(String(grab(slice, "Saldo") || grab(slice, "saldo")).replace(",", "."));
      const sku = String(grab(slice, "EAN") || grab(slice, "ean") || grab(slice, "referencia") || grab(slice, "Referencia")).trim();
      const caja = cajaKey(grab(slice, "Caja") || grab(slice, "caja") || grab(slice, "numeroCaja") || grab(slice, "NroCaja"));
      if (saldo > 0 && sku) {
        const entry = next.locations[ubic] || { skus: {}, boxes: {} };
        entry.skus[sku] = 1;
        if (caja) {
          const box = entry.boxes[caja] || {};
          box[sku] = 1;
          entry.boxes[caja] = box;
        }
        next.locations[ubic] = entry;
      }
    }
    seen += 1;
    next.offset = end + 1;
    start = source.indexOf("{", next.offset);
  }
  if (start < 0) next.done = true;
  return next;
}

export function mixedPlan(state) {
  const locations = {};
  const boxSkus = {};
  for (const [ubic, entry] of Object.entries(state?.locations || {})) {
    const skus = Object.keys(entry.skus || {});
    if (skus.length < 2) continue;
    const boxes = Object.keys(entry.boxes || {}).sort();
    locations[ubic] = { sku_count: skus.length, boxes };
    for (const caja of boxes) {
      const set = boxSkus[caja] || {};
      for (const sku of Object.keys(entry.boxes[caja] || {})) set[sku] = 1;
      boxSkus[caja] = set;
    }
  }
  const normalized = {};
  for (const [caja, skus] of Object.entries(boxSkus)) normalized[caja] = Object.keys(skus).sort();
  return { locations, box_skus: normalized, cajas: Object.keys(normalized).sort() };
}
