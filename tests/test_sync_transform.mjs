import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TECH_USER_ID,
  STOCK_PATH,
  aggregatePicking,
  argentinaDay,
  copernicoEnabled,
  copernicoHeaders,
  embedJson,
  loginBody,
  loginFailureIsRecoverable,
  movimientosPath,
  negatedLinesPath,
  normalizeCaja,
  normalizeMovimientos,
  pickingDetailPath,
  pickingLinesPath,
  productivityPath,
  ubicacionesPath,
  userIdFromLogin
} from "../workers/sync/src/copernico.js";
import { CRON_JOBS, runScheduled } from "../workers/sync/src/jobs.js";
import { pathToDatasetKey } from "../workers/sync/src/routes.js";
import { advanceMixedIndex, emptyMixedState, extractMarkedRows, mixedPlan } from "../workers/sync/src/stock-scan.js";
import { gzipBytes, gunzipBytes, joinChunks, putIfChanged, readGzip, sha256Hex, splitChunks } from "../workers/sync/src/store.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function loadJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url)));
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertSameKeys(actual, expected, label) {
  assert.deepEqual(sortedKeys(actual), sortedKeys(expected), label);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../workers/sync/browser-transform.js", import.meta.url), "utf8"), sandbox);
const { ubicTransforms, ubicTransformRaw } = sandbox;

const stockFile = loadJson("../stock.json");
const palletsFile = loadJson("../pallets-proceso.json");
const receiptFile = loadJson("../en-recibo.json");
const negationsFile = loadJson("../negaciones.json");
const timesFile = loadJson("../tiempos.json");
const avanceFile = loadJson("../avance-pedidos.json");
const traceFile = loadJson("../trazabilidad-cajas.json");
const negatedLinesFile = loadJson("../datos/lineas-negadas/20261026.json");
const pickingFile = loadJson("../datos/lineas-picking/20261026.json");
const productivityFile = loadJson("../datos/productividad/20261026.json");
const summaryFile = loadJson("../datos/productividad-resumen/20261026.json");

test("el login de Copérnico sale del Python, no de un Bearer inventado", () => {
  assert.deepEqual(loginBody("a@b.c", "secreto"), {
    email: "a@b.c",
    password: "secreto",
    plataforma: "Copernico WMS"
  });
  const headers = copernicoHeaders("jwt-crudo");
  assert.equal(headers.authorization, "jwt-crudo");
  assert.equal(headers.origin, "https://copernicowms.com");
  assert.equal(headers.accept, "application/json, text/plain, */*");
  assert.equal("bearer" in headers, false);
  assert.equal(copernicoEnabled({ COPERNICO_ENABLED: "1" }), true);
  assert.equal(copernicoEnabled({ COPERNICO_ENABLED: "0" }), false);
  assert.equal(copernicoEnabled({}), false);
  assert.equal(loginFailureIsRecoverable(403, "Hay una Sesión activa"), true);
  assert.equal(loginFailureIsRecoverable(418, "sin cupo de licencias"), true);
  assert.equal(loginFailureIsRecoverable(403, "forbidden"), false);
  assert.equal(loginFailureIsRecoverable(401, "sesión activa"), false);
  const token = `h.${Buffer.from(JSON.stringify({ user: { id_usuario: "15" } })).toString("base64url")}.s`;
  assert.equal(userIdFromLogin({ data: { usuario_id: "7" } }, token), 7);
  assert.equal(userIdFromLogin({}, token), 15);
  assert.equal(userIdFromLogin({}, "no-es-jwt"), DEFAULT_TECH_USER_ID);
  assert.equal(STOCK_PATH, "/backweb25/inventario/obtenerrefsxcaja?bodega=47");
  assert.equal(pickingLinesPath("20261026"), "/backweb25/pasillos/lineas/picking?fecha=20261026");
  assert.equal(
    productivityPath("20261026"),
    "/backweb25/kpi/productividad/empleados?fecha=20261026&tipo_productividad=ProductividadPIK"
  );
  const reasons = negatedLinesPath("20261026");
  assert.match(reasons, /fechainicial=20261026/);
  assert.match(reasons, /fechafinal=20261026/);
  assert.match(reasons, /topRanking=10/);
  assert.match(reasons, /opcion=RS8/);
  assert.equal(ubicacionesPath("00123"), "/backweb25/caja/getubicaciones?caja=00123");
  assert.equal(movimientosPath("99"), "/backweb25/caja/getmovimientos?caja=99");
  assert.equal(pickingDetailPath("555"), "/backweb25/dwh_picking/picking?pickingint=555");
  assert.equal(normalizeCaja("Nw: 00123"), "123");
  assert.equal(normalizeCaja("12"), "");
  assert.equal(embedJson("  [1,2] "), "[1,2]");
  assert.equal(embedJson("texto"), "null");
  const dayBefore = argentinaDay(new Date("2026-10-26T02:30:00Z"));
  assert.equal(dayBefore.day, "20261025");
  assert.equal(dayBefore.label, "25/10/2026");
  assert.equal(argentinaDay(new Date("2026-10-26T03:00:00Z")).day, "20261026");
});

test("aggregatePicking arma el contrato de /pickings", () => {
  const aggregated = aggregatePicking("900", [
    { pedido: "P1", zonapiso: "MFCA 01", EstadoDeLinea: "Confirmada", Cant: "2" },
    { pedido: "P1", zonapiso: "AR", EstadoDeLinea: "Pendiente", Cant: 3 }
  ]);
  assert.equal(aggregated.ok, true);
  assert.equal(aggregated.estado, "INICIADO");
  assert.equal(aggregated.ejecutadas, 1);
  assert.equal(aggregated.pendientes, 1);
  assert.equal(aggregated.unidades, 5);
  assert.equal(aggregated.zonas.MFCA.ejecutadas, 1);
  assert.equal(aggregated.zonas.AR.pendientes, 1);
  assert.equal(aggregated.zonas.BR.total, 0);
  const done = aggregatePicking("1", [{ EstadoDeLinea: "Ejecutada", Cant: 1 }]);
  assert.equal(done.estado, "FINALIZADO");
  const moves = normalizeMovimientos({
    movimientos: [{ "Fecha Hora": "01/10/2026 10:00:00", "Nombre empleado": "Ana", Saldo: 4 }]
  });
  assert.equal(moves[0].Fecha, "01/10/2026 10:00:00");
  assert.equal(moves[0].Nombre_empleado, "Ana");
  assert.equal(moves[0].Saldo, 4);
});

test("el cron apagado no llama a Copérnico", async () => {
  const calls = [];
  const env = {
    COPERNICO_ENABLED: "0",
    SESSION: { getByName() { calls.push("session"); return {}; } }
  };
  const result = await runScheduled({ cron: "* * * * *" }, env);
  assert.equal(result.skipped, "disabled");
  assert.deepEqual(calls, []);
  assert.deepEqual(CRON_JOBS["* * * * *"], ["stock", "en-recibo", "pallets-proceso"]);
  assert.deepEqual(CRON_JOBS["*/3 * * * *"], ["negaciones", "lineas-negadas", "tiempos", "avance"]);
  assert.deepEqual(CRON_JOBS["*/10 * * * *"], ["lineas-picking", "productividad", "productividad-resumen", "trazabilidad"]);
  const now = new Date("2026-10-26T15:00:00Z");
  assert.equal(pathToDatasetKey("/stock.json", now), "stock");
  assert.equal(pathToDatasetKey("/negaciones.json", now), "operacion:20261026");
  assert.equal(pathToDatasetKey("/datos/tiempos/20261025.json", now), "operacion:20261025");
  assert.equal(pathToDatasetKey("/datos/lineas-picking/20261026.json", now), "lineas-picking:20261026");
  assert.equal(pathToDatasetKey("/datos/productividad-resumen/20261026.json", now), "productividad-resumen:20261026");
  assert.equal(pathToDatasetKey("/datos/avance/20261026.json", now), "operacion:20261026");
  assert.equal(pathToDatasetKey("/no-existe.json", now), "");
});

test("D1 guarda gzip por hash y no reescribe si no cambió", async () => {
  const parts = splitChunks(new Uint8Array([1, 2, 3, 4, 5]), 2);
  assert.equal(parts.length, 3);
  assert.deepEqual([...joinChunks(parts)], [1, 2, 3, 4, 5]);
  const raw = "stock-raw-payload";
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const zipped = await gzipBytes(new TextEncoder().encode(raw));
  assert.equal(new TextDecoder().decode(await gunzipBytes(zipped)), raw);

  const heads = new Map();
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql,
            args,
            async first() {
              return heads.get(args[0]) || null;
            },
            async all() {
              return {
                results: rows
                  .filter(row => row.key === args[0] && row.generation === args[1])
                  .sort((a, b) => a.part - b.part)
              };
            }
          };
        }
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        const text = statement.sql.replace(/\s+/g, " ");
        if (text.includes("INSERT INTO dataset_parts")) {
          const blob = statement.args[3];
          rows.push({
            key: statement.args[0],
            generation: statement.args[1],
            part: statement.args[2],
            gzip: blob instanceof Uint8Array ? blob : new Uint8Array(blob)
          });
        } else if (text.includes("INSERT INTO dataset_heads")) {
          heads.set(statement.args[0], {
            generation: statement.args[1],
            sha256: statement.args[2],
            updated_at: statement.args[3],
            parts: statement.args[4],
            raw_bytes: statement.args[5]
          });
        } else if (text.includes("DELETE FROM dataset_parts")) {
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (rows[index].key === statement.args[0] && rows[index].generation !== statement.args[1]) rows.splice(index, 1);
          }
        } else {
          throw new Error(text);
        }
      }
    }
  };
  const env = { DB: db };
  const first = await putIfChanged(env, "stock", raw, "2026-10-26T00:00:00+00:00");
  assert.equal(first.skipped, false);
  const second = await putIfChanged(env, "stock", raw, "2026-10-26T00:01:00+00:00");
  assert.equal(second.skipped, true);
  assert.equal(second.updated_at, "2026-10-26T00:00:00+00:00");
  const changed = await putIfChanged(env, "stock", `${raw}-2`, "2026-10-26T00:02:00+00:00");
  assert.equal(changed.skipped, false);
  assert.equal(heads.get("stock").generation, 2);
  assert.equal(rows.every(row => row.generation === 2), true);
  const blob = await readGzip(env, "stock");
  assert.equal(new TextDecoder().decode(await gunzipBytes(blob.gzip)), `${raw}-2`);
});

test("el recorte de stock marca EN_PROCESO y RECIBO sin parsear el archivo", () => {
  const text = JSON.stringify([
    { Ubicacion: "EN_PROCESO", Caja: "00010", EAN: "111", referencia: "R1", Saldo: "3", Descripcion: "dice EN_PROCESO en el texto" },
    { Ubicacion: "MFCA010101", Caja: "20", EAN: "222", Saldo: 1, Descripcion: "RECIBO no es la ubicación" },
    { Ubicacion: "RECIBO_47", Caja: "30", EAN: "333", Saldo: 2 }
  ]);
  const processRows = extractMarkedRows(text, "EN_PROCESO");
  const receiptRows = extractMarkedRows(text, "RECIBO");
  assert.equal(processRows.length, 1);
  assert.equal(processRows[0].Caja, "00010");
  assert.equal(receiptRows.length, 1);
  assert.equal(receiptRows[0].Caja, "30");
  let state = emptyMixedState();
  state = advanceMixedIndex(text, state, 1);
  assert.equal(state.done, false);
  state = advanceMixedIndex(text, state, 10);
  assert.equal(state.done, true);
  const plan = mixedPlan(state);
  assert.equal(plan.locations.EN_PROCESO, undefined);
  assert.deepEqual(sortedKeys(plan.locations), []);
  const mixed = JSON.stringify([
    { Ubicacion: "A01", Caja: "1", EAN: "111", Saldo: 2 },
    { Ubicacion: "A01", Caja: "2", EAN: "222", Saldo: 4 },
    { Ubicacion: "B01", Caja: "3", EAN: "111", Saldo: 0 }
  ]);
  const full = advanceMixedIndex(mixed, emptyMixedState(), 20);
  const mixedPlanResult = mixedPlan(full);
  assert.deepEqual(mixedPlanResult.locations.A01, { sku_count: 2, boxes: ["1", "2"] });
  assert.deepEqual(mixedPlanResult.box_skus["1"], ["111"]);
  assert.equal(mixedPlanResult.cajas.includes("3"), false);
});

test("stock crudo conserva las claves del stock.json publicado", async () => {
  const sample = stockFile.rows[0];
  const shaped = ubicTransforms.transformStock([sample], { updatedAt: "stamp" });
  assertSameKeys(shaped, stockFile, "stock");
  assertSameKeys(shaped.rows[0], stockFile.rows[0], "fila de stock");
  assert.equal(shaped.source, stockFile.source);
  assert.equal(shaped.row_count, 1);
  assert.equal(shaped.rows[0].Ubicacion, sample.Ubicacion);
  const wrapped = await ubicTransformRaw("/stock.json", { raw: true, body: [sample], updated_at: "2026-10-26T00:00:00+00:00" });
  assert.equal(wrapped.updated_at, "2026-10-26T00:00:00+00:00");
  assert.equal(wrapped.row_count, 1);
});

test("pallets y recibo salen con la misma forma que los JSON de main", () => {
  const pallets = ubicTransforms.transformPallets({
    updated_at: "2026-10-26T12:00:00+00:00",
    stock_rows: [
      { Caja: "00077", EAN: 111, referencia: "R1", Descripcion: "Caja A", Saldo: 4, UnidadMedida: "UN", FV: "01/12/2026", Ubicacion: "EN_PROCESO" },
      { Caja: "88", EAN: 222, referencia: "R2", Descripcion: "Caja B", Saldo: 1, UnidadMedida: "UN", Ubicacion: "EN_PROCESO" }
    ],
    ubicaciones: {
      77: {
        ubicaciones: [
          { UbicacionFinal: "EN_PROCESO", PosicionOrigen: "MFCA010101", Nombre_empleado: "Viejo", Id_empleado: 1, fecha: "01/10/2026 08:00:00" },
          { UbicacionFinal: "EN_PROCESO", PosicionOrigen: "MFCA020202", Nombre_empleado: "Nuevo", Id_empleado: 9, fecha: "02/10/2026 09:30:00", Prioridad: "Alta" }
        ]
      }
    },
    errors: { 88: "HTTP 500" },
    previous_rows: [
      { Caja: "88", EAN: 222, Referencia: "R2", PosicionOrigen: "A010101", Maquinista: "Ana", Id_maquinista: 4, FechaIngresoProceso: "01/10/2026", Prioridad: "Media" }
    ]
  });
  assertSameKeys(pallets, palletsFile, "pallets");
  assertSameKeys(pallets.rows[0], palletsFile.rows[0], "fila de pallet");
  assert.equal(pallets.source, palletsFile.source);
  assert.equal(pallets.total_lineas, 2);
  assert.equal(pallets.total_pallets, 2);
  assert.equal(pallets.rows[0].PosicionOrigen, "MFCA020202");
  assert.equal(pallets.rows[0].Maquinista, "Nuevo");
  assert.equal(pallets.rows[0].Trazabilidad, "OK");
  assert.equal(pallets.rows[1].Trazabilidad, "OK · traza previa");
  assert.equal(pallets.rows[1].Maquinista, "Ana");

  const receipt = ubicTransforms.transformReceipt({
    updated_at: "2026-10-26T12:00:00+00:00",
    stock_rows: [
      { Caja: "30", EAN: 333, referencia: "RR", Descripcion: "Ingreso", Saldo: 2, UnidadMedida: "UN", Ubicacion: "RECIBO_47" },
      { Caja: "31", EAN: 334, referencia: "RR2", Descripcion: "Solo stock", Saldo: 1, Unidad: "UN", Ubicacion: "RECEPCION" }
    ],
    ubicaciones: {
      30: [{ Ubicacion: "RECIBO", UbicacionInicial: "MUELLE", Nombre_empleado: "Luis", Id_empleado: 3, Equipo: "Descarga", fecha: "03/10/2026 07:00:00" }]
    }
  });
  assertSameKeys(receipt, receiptFile, "recibo");
  assertSameKeys(receipt.rows[0], receiptFile.rows[0], "fila de recibo");
  assert.equal(receipt.source, receiptFile.source);
  assert.equal(receipt.rows[0].Responsable, "Luis");
  assert.equal(receipt.rows[0].Equipo, "Descarga");
  assert.equal(receipt.rows[0].Trazabilidad, "OK");
  assert.equal(receipt.rows[1].Equipo, "Sin clasificar");
  assert.equal(receipt.rows[1].Trazabilidad, "Sin movimiento a RECIBO identificado");
  assert.equal(receipt.total_cajas, 2);
});

test("negaciones, tiempos, avance y resumen coinciden con los JSON de main", async () => {
  const stamp = {
    updated_at: "2026-10-26T12:00:00+00:00",
    fecha: "26/10/2026",
    fecha_query: "20261026",
    productividad_http: 200,
    lineas_picking_http: 200,
    motivos_http: 200,
    picking_updated_at: "2026-10-26T12:00:00+00:00"
  };
  const picking = [
    {
      zonapiso: "mfca",
      ubicacion_asig: "MFCA010101",
      NumPicking: "500",
      product: "ABC",
      descripcion: "Producto",
      Cant: 4,
      bode: 47,
      pedido: "PED1",
      hora: "07:10",
      estadolinea: "Negada",
      ean: "779",
      unidad: "CJ",
      EstadoDeLinea: "Confirmada",
      PorcentajeLineas: 10,
      Proceso: "Picking"
    },
    {
      zonapiso: "MFCB",
      ubicacion_asig: "MFCB010101",
      NumPicking: "501",
      product: "ZZ",
      descripcion: "Otro",
      Cant: 1,
      pedido: "PED2",
      ean: "780",
      unidad: 1,
      EstadoDeLinea: "Pendiente",
      Proceso: "Picking"
    }
  ];
  const productividad = [
    {
      hora: 6,
      Empleado: 12,
      Nombres: "Ana",
      Descripcion: "Producto",
      ref: "ABC",
      ean: "779",
      Caja: "10",
      Picking: "500",
      NumPedido: "PED1",
      EstadoLineaTsscc: "Negada",
      ZonaPiso: "",
      Cantidad: 4,
      Proceso: "Picking",
      fecharegistro: "26/10/2026 06:10:00",
      horaRegistro: "06:10:00"
    },
    {
      hora: 15,
      Empleado: 12,
      Nombres: "Ana",
      ean: "779",
      Picking: "500",
      NumPedido: "PED1",
      EstadoLineaTsscc: "Confirmada",
      Proceso: "Picking",
      fecharegistro: "26/10/2026 15:00:00",
      horaRegistro: "15:00:00"
    },
    {
      hora: 9,
      Empleado: 13,
      Nombres: "Beto",
      ean: "780",
      Picking: "501",
      NumPedido: "PED2",
      EstadoLineaTsscc: "Confirmada",
      ZonaPiso: "MFCA",
      Proceso: "Packing",
      fecharegistro: "26/10/2026 09:00:00",
      horaRegistro: "09:00:00"
    }
  ];
  const reasons = [{
    picking: "500",
    Pedido: "PED1",
    productoean: "779",
    cod_motivo_niega: "SIN STOCK",
    Caja: "10",
    Zona: "MFCA",
    idempleadoniega: 12,
    Empleado: "Ana",
    descripcion: "Producto",
    total_negaciones: 1,
    tipotransaccion: "RS8",
    FechaRegistro: "26/10/2026"
  }];
  const payload = { ...stamp, productividad, lineas_picking: picking, lineas_negadas: { rows: reasons } };

  const negations = ubicTransforms.transformNegations(payload);
  assertSameKeys(negations, negationsFile, "negaciones");
  assertSameKeys(negations.rows[0], negationsFile.rows[0], "fila de negación");
  assert.equal(negations.source, negationsFile.source);
  assert.equal(negations.negaciones_count, 1);
  assert.equal(negations.rows[0].MotivoNegacion, "SIN STOCK");
  assert.equal(negations.rows[0].Cruce, "Picking+Pedido+SKU");
  assert.equal(negations.rows[0].Zona, "MFCA");
  assert.equal(negations.rows[0].Unidad, "CJ");
  assert.equal(negations.rows[0].EstadoDeLinea, "Negada");
  assert.equal(negations.motivos_matched_count, 1);

  const negated = await ubicTransformRaw("/datos/lineas-negadas/20261026.json", payload);
  assertSameKeys(negated, negatedLinesFile, "lineas negadas");
  assertSameKeys(negated.rows[0], negatedLinesFile.rows[0], "fila cruda de motivo");
  assert.equal(negated.source, negatedLinesFile.source);
  assert.equal(negated.row_count, 1);

  const times = ubicTransforms.transformTimes(payload);
  assertSameKeys(times, timesFile, "tiempos");
  assertSameKeys(times.rows[0], timesFile.rows[0], "fila de tiempo");
  assert.equal(times.source, timesFile.source);
  assert.equal(times.turno, "Mañana");
  assert.equal(times.desde, "06:00");
  assert.equal(times.hasta, "14:00");
  assert.equal(times.referencia_minutos, 390);
  assert.equal(times.rows.length, 1);
  assert.equal(times.rows[0].Hora, 6);
  assert.equal(times.rows[0].Estado, "Negada");
  assert.equal(times.rows[0].Zona, "MFCA");

  const avance = await ubicTransformRaw("avance-pedidos.json", { ...stamp, lineas_picking: picking });
  assertSameKeys(avance, avanceFile, "avance");
  assertSameKeys(avance.rows[0], avanceFile.rows[0], "fila de avance");
  assert.equal(avance.source, avanceFile.source);
  assert.equal(avance.lineas_count, 2);
  assert.equal(avance.processed_units_by_sku["779"], 4);
  assert.equal(avance.processed_lines_by_sku["779"], 1);
  assert.equal(avance.processed_units_by_sku["780"], undefined);
  assert.equal(avance.rows[0].Ubicacion, "MFCA010101");

  const pickingWrap = await ubicTransformRaw("/datos/lineas-picking/20261026.json", { ...stamp, body: [pickingFile.rows[0]] });
  assertSameKeys(pickingWrap, pickingFile, "lineas picking");
  assertSameKeys(pickingWrap.rows[0], pickingFile.rows[0], "fila picking");
  assert.equal(pickingWrap.source, pickingFile.source);

  const prodWrap = await ubicTransformRaw("/datos/productividad/20261026.json", { ...stamp, body: [productivityFile.rows[0]] });
  assertSameKeys(prodWrap, productivityFile, "productividad");
  assertSameKeys(prodWrap.rows[0], productivityFile.rows[0], "fila productividad");
  assert.equal(prodWrap.source, productivityFile.source);

  const summary = ubicTransforms.transformSummary(payload);
  assertSameKeys(summary, summaryFile, "resumen");
  assertSameKeys(summary.rows[0], summaryFile.rows[0], "fila resumen");
  assertSameKeys(summary.pickers[0], summaryFile.pickers[0], "picker");
  assert.equal(summary.source, summaryFile.source);
  assert.equal(summary.referencia_minutos, 390);
  assert.equal(summary.lineas_productividad_06_14, 1);
  assert.equal(summary.rows[0].ZonaLineaPicking, "MFCA");
  assert.equal(summary.rows[0].CruceZona, "Picking+Pedido+SKU");
  assert.equal(summary.pickers[0].ZonaPrincipal, "MFCA");
  assert.equal(summary.pickers[0].PromedioLineasHora, Math.round((1 / 6.5) * 100) / 100);
  assert.equal(summary.picking_updated_at, stamp.picking_updated_at);
});

test("trazabilidad compacta conserva el esquema 15 publicado", async () => {
  const trace = await ubicTransforms.transformTrace({
    updated_at: "2026-10-26T12:00:00+00:00",
    locations: { A01: { sku_count: 2, boxes: ["10", "11"] } },
    box_skus: { 10: ["111", "222"], 11: ["333"] },
    cajas: ["10", "11"],
    queried_this_cycle: ["10"],
    movimientos: {
      10: [
        { Fecha: "01/10/2026 08:00:00", EAN: "111", Estado: "SALIDA", Movimiento: -1, Saldo: 0, Transaccion: "SALE", Nombre_empleado: "Ana", Id_empleado: 1, NoControl: "N1" },
        { Fecha: "02/10/2026 09:00:00", EAN: "111", Estado: "ENTRADA", Movimiento: 4, Saldo: 4, Transaccion: "ENTRA", Nombre_empleado: "Luis", Id_empleado: 2, NoControl: "N2" },
        { Fecha: "03/10/2026 10:00:00", EAN: "111", Estado: "ENTRADA", Movimiento: 5, Saldo: 9, Transaccion: "SUMA", Nombre_empleado: "Luis", Id_empleado: 2, NoControl: "N3" },
        { Fecha: "03/10/2026 11:00:00", EAN: "222", Estado: "SALIDA", Movimiento: -2, Saldo: 0, Transaccion: "SALE", Nombre_empleado: "Ana", Id_empleado: 1, NoControl: "N4" }
      ]
    }
  });
  const publishedBox = Object.values(traceFile.boxes).find(box => box.ok);
  assertSameKeys(trace, traceFile, "trazabilidad");
  assert.equal(trace.schema_version, 15);
  assert.equal(trace.source, traceFile.source);
  assert.equal(trace.criterion, traceFile.criterion);
  assert.deepEqual(sortedKeys(trace.locations.A01), sortedKeys(Object.values(traceFile.locations)[0]));
  assertSameKeys(trace.boxes["10"], publishedBox, "caja ok");
  assertSameKeys(trace.boxes["10"].movimientos[0], publishedBox.movimientos[0], "movimiento");
  assert.equal(trace.boxes["10"].movimientos.length, 1);
  assert.equal(trace.boxes["10"].movimientos[0].NoControl, "N2");
  assert.equal(trace.boxes["10"].movimientos[0].Saldo, 4);
  assert.deepEqual([...trace.boxes["10"].requested_skus], ["111", "222"]);
  assert.equal(trace.boxes["11"].ok, false);
  assert.equal(trace.boxes["11"].error, "Pendiente de trazabilidad; se reintentará automáticamente");
  assert.equal(trace.pending_box_count, 1);
  assert.equal(trace.box_ok_count, 1);
  assert.equal(trace.queried_this_cycle, 1);

  const loaded = await ubicTransformRaw("/trazabilidad-cajas.json", {
    updated_at: "stamp",
    locations: {},
    box_skus: { 12: ["5"] },
    cajas: ["12"],
    queried_this_cycle: []
  }, {
    load: async key => key === "trace:caja:12"
      ? [{ Fecha: "04/10/2026", EAN: "5", Estado: "ENTRADA", Movimiento: 1, Saldo: 1, Transaccion: "T", Nombre_empleado: "Ana", Id_empleado: 1, NoControl: "Z" }]
      : null
  });
  assert.equal(loaded.boxes["12"].ok, true);
  assert.equal(loaded.boxes["12"].movimientos[0].NoControl, "Z");
});

test("GitHub Pages sigue apuntando a main y el transform queda detrás del header", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /workers\/sync\/browser-transform\.js/);
  assert.match(html, /https:\/\/raw\.githubusercontent\.com\/lupavon\/UBICACIONES\/main\//);
  assert.match(html, /original\(remote,\{cache:'no-store'\}\)/);
  assert.match(html, /X-Ubic-Raw/);
  assert.match(html, /\.workers\.dev/);
  assert.equal(typeof ubicTransformRaw, "function");
  assert.equal(html.includes("export "), false);
  const transform = readFileSync(new URL("../workers/sync/browser-transform.js", import.meta.url), "utf8");
  assert.equal(transform.includes("export "), false);
});
