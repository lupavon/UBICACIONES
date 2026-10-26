/* Transforma el payload crudo guardado por workers/sync al JSON que ya consume el dashboard.
   Solo corre si el fetch recibió X-Ubic-Raw: 1. GitHub Pages sigue sirviendo el JSON final. */
(function (root) {
  function normKey(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  }

  function field(row, names) {
    if (!row || typeof row !== "object") return "";
    const indexed = {};
    for (const [key, value] of Object.entries(row)) indexed[normKey(key)] = value;
    for (const name of names) {
      const key = normKey(name);
      if (Object.prototype.hasOwnProperty.call(indexed, key) && indexed[key] != null) return indexed[key];
    }
    return "";
  }

  function sval(row, names) {
    return String(field(row, names) ?? "").trim();
  }

  function nkey(value) {
    return String(value ?? "").trim().toUpperCase();
  }

  function extractRows(payload) {
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

  function stampOf(payload, ctx) {
    return payload?.updated_at || ctx?.updatedAt || new Date().toISOString();
  }

  function datasetName(path) {
    const clean = String(path || "").split("?")[0];
    const match = clean.match(/datos\/([a-z-]+)\/\d{8}\.json$/);
    if (match) return match[1];
    const file = clean.slice(clean.lastIndexOf("/") + 1);
    if (file === "pallets-proceso.json") return "pallets-proceso";
    if (file === "en-recibo.json") return "en-recibo";
    if (file === "trazabilidad-cajas.json") return "trazabilidad";
    if (file === "avance-pedidos.json") return "avance";
    return file.replace(/\.json$/, "");
  }

  function parseDate(value) {
    if (value == null || value === "") return Number.NEGATIVE_INFINITY;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return Number.NEGATIVE_INFINITY;
    const text = String(value).trim();
    const dmy = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (dmy) return Date.parse(`${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4] || "00"}:${dmy[5] || "00"}:${dmy[6] || "00"}`) / 1000;
    const parsed = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
    return Number.isFinite(parsed) ? parsed / 1000 : Number.NEGATIVE_INFINITY;
  }

  function asNumber(value) {
    const number = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(number) ? number : null;
  }

  function transformStock(payload, ctx) {
    const body = payload && payload.raw && "body" in payload ? payload.body : payload;
    const rows = extractRows(body);
    return {
      updated_at: stampOf(payload, ctx),
      source: "Copernico WMS · bodega 47 · GitHub Actions",
      row_count: rows.length,
      rows
    };
  }

  const PROCESS_DEST = ["UbicacionFinal", "ubicacion_final", "ubicacionfinal", "UbicacionDestino", "ubicacion_destino", "ubicaciondestino", "Destino", "destino", "PosicionFinal", "posicion_final", "PosicionDestino", "posicion_destino", "UbicacionNueva", "ubicacion_nueva"];
  const PROCESS_ORIGIN = ["UbicacionInicial", "ubicacion_inicial", "ubicacioninicial", "UbicacionOrigen", "ubicacion_origen", "ubicacionorigen", "PosicionOrigen", "posicion_origen", "posicionorigen", "PosicionInicial", "posicion_inicial", "UbicacionAnterior", "ubicacion_anterior", "ubicacionanterior"];
  const GENERIC_LOCATION = ["Ubicacion", "ubicacion", "Location", "Posicion", "posicion"];
  const EMPLOYEES = ["Nombre_empleado", "Nombre empleado", "NombreEmpleado", "nombreEmpleado", "Maquinista", "maquinista", "Nombre_maquinista", "Empleado", "Operario", "Usuario"];
  const EMPLOYEE_IDS = ["Id_empleado", "IdEmpleado", "idEmpleado", "ID empleado", "Id_maquinista", "id_maquinista", "IdMaquinista", "IdUsuario", "id_usuario", "Legajo"];
  const DATES = ["fecha", "Fecha", "FechaMovimiento", "fecha_movimiento", "FechaHora", "Fecha Hora", "FechaRegistro", "fecharegistro", "FechaIngresoProceso", "fecha_ingreso_proceso"];
  const CAJAS = ["Caja", "caja", "numeroCaja", "NroCaja"];

  function normLocation(value) {
    return String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  }

  function isProcessLocation(value) {
    return normLocation(value) === "ENPROCESO";
  }

  function cajaKey(value) {
    const text = String(value ?? "").trim();
    const digits = text.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    return digits || text;
  }

  function moveDestination(move) {
    const dest = field(move, PROCESS_DEST);
    if (isProcessLocation(dest)) return dest;
    const generic = field(move, GENERIC_LOCATION);
    const origin = field(move, PROCESS_ORIGIN);
    if (isProcessLocation(generic) && origin && !isProcessLocation(origin)) return generic;
    return "";
  }

  function latestMove(moves, accept) {
    const candidates = [];
    for (const move of moves || []) {
      if (move && typeof move === "object" && accept(move)) candidates.push(move);
    }
    if (!candidates.length) return null;
    return candidates.reduce((best, move) => parseDate(field(move, DATES)) >= parseDate(field(best, DATES)) ? move : best);
  }

  function applyPrevious(row, previous) {
    row.PosicionOrigen = previous?.PosicionOrigen || "";
    row.Maquinista = previous?.Maquinista || "";
    row.Id_maquinista = previous?.Id_maquinista || "";
    row.FechaIngresoProceso = previous?.FechaIngresoProceso || "";
    row.Prioridad = previous?.Prioridad || "";
    row.Trazabilidad = "OK · traza previa";
    return row;
  }

  function transformPallets(payload) {
    const stockRows = (payload?.stock_rows || []).filter(row => row && typeof row === "object" && isProcessLocation(field(row, ["Ubicacion", "ubicacion", "Location"])));
    const ubicaciones = payload?.ubicaciones || {};
    const errors = payload?.errors || {};
    const previousExact = new Map();
    const previousCaja = new Map();
    for (const previous of payload?.previous_rows || []) {
      if (!previous?.PosicionOrigen || !previous?.Maquinista) continue;
      const key = [cajaKey(previous.Caja), String(previous.EAN ?? "").trim(), String(previous.Referencia ?? "").trim()].join("|");
      previousExact.set(key, previous);
      const caja = cajaKey(previous.Caja);
      if (caja && !previousCaja.has(caja)) previousCaja.set(caja, previous);
    }
    const rows = stockRows.map(stockRow => {
      const caja = cajaKey(field(stockRow, CAJAS));
      const error = errors[caja] || "";
      const moves = error ? [] : extractRows(ubicaciones[caja]);
      const move = error ? null : latestMove(moves, item => moveDestination(item));
      const row = {
        Caja: field(stockRow, CAJAS),
        EAN: field(stockRow, ["EAN", "ean"]),
        Referencia: field(stockRow, ["referencia", "Referencia", "ref"]),
        Descripcion: field(stockRow, ["Descripcion", "descripcion", "Descripción"]),
        Saldo: field(stockRow, ["Saldo", "saldo", "Cantidad", "cantidad"]),
        Unidad: field(stockRow, ["UnidadMedida", "unidadMedida", "Unidad"]),
        FV: field(stockRow, ["FV", "fv", "FechaVencimiento"]),
        Ubicacion: field(stockRow, ["Ubicacion", "ubicacion", "Location"]) || "EN_PROCESO",
        PosicionOrigen: move ? field(move, PROCESS_ORIGIN) : "",
        Maquinista: move ? field(move, EMPLOYEES) : "",
        Id_maquinista: move ? field(move, EMPLOYEE_IDS) : "",
        FechaIngresoProceso: move ? field(move, DATES) : "",
        Prioridad: move ? field(move, ["Prioridad", "prioridad"]) : "",
        Trazabilidad: move ? "OK" : (error || "Sin movimiento a EN_PROCESO identificado")
      };
      if (!move && error) {
        const previous = previousExact.get([caja, String(row.EAN ?? "").trim(), String(row.Referencia ?? "").trim()].join("|")) || previousCaja.get(caja);
        if (previous) applyPrevious(row, previous);
      }
      return row;
    });
    const boxes = new Set(rows.map(row => cajaKey(row.Caja)).filter(Boolean));
    return {
      updated_at: stampOf(payload),
      source: "Copernico WMS · EN_PROCESO · trazabilidad de ubicaciones",
      total_lineas: rows.length,
      total_pallets: boxes.size,
      identificados: rows.filter(row => row.PosicionOrigen && row.Maquinista).length,
      rows
    };
  }

  function looksLikeReceipt(value) {
    const text = String(value || "").trim().toUpperCase();
    if (!text) return false;
    return text === "RECIBO" || text.includes("RECIB") || text.includes("RECEPC");
  }

  function rowIsReceipt(row) {
    return ["Ubicacion", "ubicacion", "Location", "Area", "area", "Área", "Zona", "zona", "Sector", "sector", "Estado", "estado", "Estatus", "estatus", "TipoUbicacion", "tipo_ubicacion", "tipoUbicacion", "NombreUbicacion", "nombre_ubicacion", "nombreUbicacion"]
      .some(name => looksLikeReceipt(field(row, [name])));
  }

  function employeeTeam(move) {
    if (!move) return "Sin clasificar";
    const direct = sval(move, ["Equipo", "equipo", "Puesto", "puesto", "Rol", "rol", "Perfil", "perfil", "Sector", "sector"]);
    return direct || "Sin clasificar";
  }

  function transformReceipt(payload) {
    const stockRows = (payload?.stock_rows || []).filter(rowIsReceipt);
    const ubicaciones = payload?.ubicaciones || {};
    const errors = payload?.errors || {};
    const rows = stockRows.map(stockRow => {
      const caja = String(field(stockRow, CAJAS) ?? "").trim();
      const error = errors[caja] || errors[cajaKey(caja)] || "";
      const moves = error ? [] : extractRows(ubicaciones[caja] || ubicaciones[cajaKey(caja)]);
      const move = error ? null : latestMove(moves, item => [
        field(item, PROCESS_DEST),
        field(item, ["Ubicacion", "ubicacion", "Location"]),
        field(item, ["AreaFinal", "area_final", "areaFinal"]),
        field(item, ["ZonaFinal", "zona_final", "zonaFinal"]),
        field(item, ["SectorFinal", "sector_final", "sectorFinal"])
      ].some(looksLikeReceipt));
      return {
        Caja: field(stockRow, CAJAS),
        EAN: field(stockRow, ["EAN", "ean"]),
        Referencia: field(stockRow, ["referencia", "Referencia", "ref"]),
        Descripcion: field(stockRow, ["Descripcion", "descripcion", "Descripción"]),
        Saldo: field(stockRow, ["Saldo", "saldo", "Cantidad", "cantidad"]),
        Unidad: field(stockRow, ["UnidadMedida", "unidadMedida", "Unidad"]),
        FV: field(stockRow, ["FV", "fv", "FechaVencimiento"]),
        Ubicacion: field(stockRow, ["Ubicacion", "ubicacion"]) || "RECIBO",
        PosicionOrigen: move ? field(move, ["UbicacionInicial", "ubicacion_inicial", "ubicacionInicial"]) : "",
        Responsable: move ? field(move, ["Nombre_empleado", "NombreEmpleado", "nombreEmpleado", "Empleado"]) : "",
        Id_empleado: move ? field(move, ["Id_empleado", "IdEmpleado", "idEmpleado"]) : "",
        Equipo: employeeTeam(move),
        FechaIngresoRecibo: move ? field(move, ["fecha", "Fecha", "FechaMovimiento", "fecha_movimiento"]) : "",
        Trazabilidad: move ? "OK" : (error || "Sin movimiento a RECIBO identificado")
      };
    });
    const boxes = new Set(rows.map(row => String(row.Caja ?? "").trim()).filter(Boolean));
    return {
      updated_at: stampOf(payload),
      source: "Copernico WMS · RECIBO · trazabilidad de ubicaciones",
      total_lineas: rows.length,
      total_cajas: boxes.size,
      identificados: rows.filter(row => row.Responsable).length,
      rows
    };
  }

  function skuKeys(row, source) {
    const names = source === "prod"
      ? [["ean", "EAN"], ["ref", "Ref", "Referencia"], ["barcode", "Barcode"]]
      : [["ean", "EAN"], ["product", "Product", "producto", "Producto"]];
    const out = [];
    for (const group of names) {
      const value = nkey(sval(row, group));
      if (value && !out.includes(value)) out.push(value);
    }
    return out;
  }

  function indexPicking(pickRows) {
    const exact = new Map();
    const pickSku = new Map();
    const pickOrder = new Map();
    const pick = new Map();
    const push = (map, key, row) => {
      const list = map.get(key) || [];
      list.push(row);
      map.set(key, list);
    };
    for (const line of pickRows) {
      const picking = nkey(sval(line, ["NumPicking", "Picking", "picking"]));
      const order = nkey(sval(line, ["pedido", "Pedido", "NumPedido"]));
      if (!picking) continue;
      push(pick, picking, line);
      if (order) push(pickOrder, `${picking}|${order}`, line);
      for (const sku of skuKeys(line, "pick")) {
        push(pickSku, `${picking}|${sku}`, line);
        if (order) push(exact, `${picking}|${order}|${sku}`, line);
      }
    }
    return { exact, pickSku, pickOrder, pick };
  }

  function choosePickingLine(row, index) {
    const picking = nkey(sval(row, ["Picking", "picking", "NumPicking"]));
    const order = nkey(sval(row, ["NumPedido", "pedido", "Pedido"]));
    for (const sku of skuKeys(row, "prod")) {
      const found = index.exact.get(`${picking}|${order}|${sku}`);
      if (found?.length) return [found[0], "Picking+Pedido+SKU"];
    }
    for (const sku of skuKeys(row, "prod")) {
      const found = index.pickSku.get(`${picking}|${sku}`);
      if (found?.length) return [found[0], "Picking+SKU"];
    }
    const byOrder = index.pickOrder.get(`${picking}|${order}`) || [];
    if (byOrder.length === 1) return [byOrder[0], "Picking+Pedido"];
    const byPick = index.pick.get(picking) || [];
    if (byPick.length === 1) return [byPick[0], "Picking"];
    return [null, "Sin cruce"];
  }

  function productivityIsNegated(row) {
    const names = ["EstadoLineaEtsscc", "estadoLineaEtsscc", "EstadoLineaETSSCC", "EstadoDeLinea", "estadoDeLinea", "EstadoLinea", "estadolinea", "EstadoLineaTsscc", "ConfirmacionLinea", "confirmacionLinea", "ConfirmacionDeLinea", "Estado", "estado"];
    for (const name of names) if (nkey(sval(row, [name])).includes("NEGAD")) return true;
    for (const [key, value] of Object.entries(row || {})) {
      const folded = nkey(key).replaceAll("Ó", "O").replaceAll("Í", "I");
      if ((folded.includes("ESTADO") || folded.includes("CONFIRM")) && nkey(value).includes("NEGAD")) return true;
    }
    return false;
  }

  function reasonIndex(reasonRows) {
    const exact = new Map();
    const pickSku = new Map();
    const orderSku = new Map();
    for (const row of reasonRows || []) {
      const picking = nkey(sval(row, ["picking", "Picking", "NumPicking"]));
      const order = nkey(sval(row, ["Pedido", "pedido", "NumPedido"]));
      const sku = nkey(sval(row, ["productoean", "ProductoEAN", "ean", "EAN", "producto", "Producto"]));
      const reason = sval(row, ["cod_motivo_niega", "CodMotivoNiega", "motivo", "Motivo"]);
      if (!reason) continue;
      if (picking && order && sku && !exact.has(`${picking}|${order}|${sku}`)) exact.set(`${picking}|${order}|${sku}`, reason);
      if (picking && sku && !pickSku.has(`${picking}|${sku}`)) pickSku.set(`${picking}|${sku}`, reason);
      if (order && sku && !orderSku.has(`${order}|${sku}`)) orderSku.set(`${order}|${sku}`, reason);
    }
    return { exact, pickSku, orderSku };
  }

  function reasonFor(row, index) {
    const picking = nkey(sval(row, ["Picking", "picking", "NumPicking"]));
    const order = nkey(sval(row, ["Pedido", "pedido", "NumPedido"]));
    const skus = [];
    for (const name of ["SKU", "EAN", "Producto", "Referencia", "ean", "ref"]) {
      const value = nkey(sval(row, [name]));
      if (value && !skus.includes(value)) skus.push(value);
    }
    for (const sku of skus) if (index.exact.has(`${picking}|${order}|${sku}`)) return index.exact.get(`${picking}|${order}|${sku}`);
    for (const sku of skus) if (index.pickSku.has(`${picking}|${sku}`)) return index.pickSku.get(`${picking}|${sku}`);
    for (const sku of skus) if (index.orderSku.has(`${order}|${sku}`)) return index.orderSku.get(`${order}|${sku}`);
    return "";
  }

  function negationRows(prodRows, pickRows, reasonRows) {
    const index = indexPicking(pickRows);
    const reasons = reasonIndex(reasonRows);
    const rows = [];
    for (const prod of prodRows) {
      if (!productivityIsNegated(prod)) continue;
      const [line, match] = choosePickingLine(prod, index);
      const sku = (line ? sval(line, ["ean", "EAN"]) : "") || (line ? sval(line, ["product", "Product", "producto"]) : "") || sval(prod, ["ean", "EAN"]) || sval(prod, ["ref", "Ref", "Referencia"]);
      const zone = (line ? sval(line, ["zonapiso", "ZonaPiso", "zona", "Zona"]) : "") || sval(prod, ["ZonaPiso", "zonapiso", "Zona", "zona"]);
      let qty = line ? field(line, ["Cant", "cant", "Cantidad", "cantidad"]) : null;
      if (qty == null || qty === "") qty = field(prod, ["Cantidad", "cantidad", "Unidades", "unidades"]) || 0;
      const picking = sval(prod, ["Picking", "picking", "NumPicking"]) || (line ? sval(line, ["NumPicking", "Picking", "picking"]) : "");
      const pedido = (line ? sval(line, ["pedido", "Pedido", "NumPedido"]) : "") || sval(prod, ["NumPedido", "pedido", "Pedido"]);
      rows.push({
        Hora: sval(prod, ["fecharegistro", "FechaRegistro"]) || sval(prod, ["hora", "Hora"]) || (line ? sval(line, ["hora", "Hora"]) : ""),
        Pedido: pedido,
        Picking: picking,
        SKU: sku,
        EAN: (line ? sval(line, ["ean", "EAN"]) : "") || sval(prod, ["ean", "EAN"]),
        Producto: (line ? sval(line, ["product", "Product"]) : "") || sval(prod, ["ref", "Ref", "Referencia"]),
        Referencia: sval(prod, ["ref", "Ref", "Referencia"]) || (line ? sval(line, ["product", "Product", "producto", "Producto"]) : ""),
        Descripcion: sval(prod, ["Descripcion", "descripcion", "Descripción"]) || (line ? sval(line, ["descripcion", "Descripcion", "Descripción"]) : ""),
        CantidadNegada: qty,
        Unidad: (line ? sval(line, ["unidad", "Unidad"]) : "") || "UN",
        Ubicacion: line ? sval(line, ["ubicacion_asig", "Ubicacion_asig", "ubicacion", "Ubicacion"]) : "",
        Zona: nkey(zone),
        EstadoDeLinea: "Negada",
        Proceso: (line ? sval(line, ["Proceso", "proceso", "TipoProceso", "tipoProceso"]) : "") || sval(prod, ["Proceso", "proceso", "TipoProceso", "tipoProceso"]),
        Picker: sval(prod, ["Nombres", "nombres", "NombreEmpleado", "nombreEmpleado"]),
        IdEmpleado: sval(prod, ["Empleado", "empleado", "IdEmpleado", "idEmpleado"]),
        Caja: sval(prod, ["Caja", "caja"]),
        FechaRegistro: sval(prod, ["fecharegistro", "FechaRegistro"]),
        Cruce: match,
        MotivoNegacion: reasonFor({ Picking: picking, Pedido: pedido, SKU: sku, EAN: (line ? sval(line, ["ean", "EAN"]) : "") || sval(prod, ["ean", "EAN"]), Referencia: sval(prod, ["ref", "Ref", "Referencia"]) }, reasons)
      });
    }
    return rows;
  }

  function transformNegations(payload) {
    const prodRows = extractRows(payload?.productividad);
    const pickRows = extractRows(payload?.lineas_picking);
    const reasonRows = extractRows(payload?.lineas_negadas);
    const rows = negationRows(prodRows, pickRows, reasonRows);
    return {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source: "Copernico ProductividadPIK · Negada + Líneas de Picking para enriquecimiento",
      productividad_http: payload?.productividad_http ?? null,
      lineas_picking_http: payload?.lineas_picking_http ?? null,
      productividad_count: prodRows.length,
      lineas_picking_count: pickRows.length,
      negaciones_count: rows.length,
      matched_count: rows.filter(row => row.Cruce !== "Sin cruce").length,
      motivos_http: payload?.motivos_http ?? null,
      motivos_count: reasonRows.length,
      motivos_matched_count: rows.filter(row => row.MotivoNegacion).length,
      rows
    };
  }

  function transformNegatedLines(payload) {
    const rows = extractRows(payload?.lineas_negadas ?? payload?.body ?? payload);
    return {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source: "Copernico Dashboard > Líneas Negadas (raw)",
      row_count: rows.length,
      rows
    };
  }

  function prodHour(row) {
    const raw = field(row, ["hora", "Hora"]);
    const numeric = Number(raw);
    if (raw !== "" && raw != null && Number.isFinite(numeric)) return Math.trunc(numeric);
    const hour = sval(row, ["horaregistro", "HoraRegistro", "horaRegistro"]);
    const parsed = Number(hour.slice(0, 2));
    return Number.isFinite(parsed) && hour ? parsed : -1;
  }

  function prodState(row) {
    const names = ["EstadoLineaEtsscc", "estadoLineaEtsscc", "EstadoLineaETSSCC", "EstadoDeLinea", "estadoDeLinea", "EstadoLinea", "estadolinea", "EstadoLineaTsscc", "ConfirmacionLinea", "confirmacionLinea", "ConfirmacionDeLinea", "Estado", "estado"];
    for (const name of names) {
      const value = nkey(sval(row, [name]));
      if (value.includes("NEGAD")) return "Negada";
      if (value.includes("CONFIRM")) return "Confirmada";
    }
    return "";
  }

  function chooseTimeLine(row, index) {
    const picking = nkey(sval(row, ["Picking", "picking", "NumPicking"]));
    const order = nkey(sval(row, ["NumPedido", "pedido", "Pedido"]));
    const skus = [nkey(sval(row, ["ean", "EAN"])), nkey(sval(row, ["ref", "Ref", "Referencia"])), nkey(sval(row, ["barcode", "Barcode"]))].filter(Boolean);
    for (const sku of skus) {
      const found = index.exact.get(`${picking}|${order}|${sku}`);
      if (found?.length) return found[0];
    }
    for (const sku of skus) {
      const found = index.pickSku.get(`${picking}|${sku}`);
      if (found?.length) return found[0];
    }
    const byOrder = index.pickOrder.get(`${picking}|${order}`) || [];
    if (byOrder.length === 1) return byOrder[0];
    const byPick = index.pick.get(picking) || [];
    return byPick.length === 1 ? byPick[0] : null;
  }

  function transformTimes(payload) {
    const prodRows = extractRows(payload?.productividad);
    const pickRows = extractRows(payload?.lineas_picking);
    const index = indexPicking(pickRows);
    const rows = [];
    for (const prod of prodRows) {
      const process = nkey(sval(prod, ["Proceso", "proceso", "TipoProceso", "tipoProceso"]));
      if (process && !process.includes("PICK")) continue;
      const hour = prodHour(prod);
      if (hour < 6 || hour >= 14) continue;
      let zone = sval(prod, ["ZonaPiso", "zonapiso", "Zona", "zona"]);
      if (!zone) {
        const line = chooseTimeLine(prod, index);
        if (line) zone = sval(line, ["zonapiso", "ZonaPiso", "zona", "Zona"]);
      }
      rows.push({
        Empleado: sval(prod, ["Empleado", "empleado", "IdEmpleado", "idEmpleado"]),
        Nombres: sval(prod, ["Nombres", "nombres", "NombreEmpleado", "nombreEmpleado"]),
        Hora: hour,
        FechaRegistro: sval(prod, ["fecharegistro", "FechaRegistro", "fechaRegistro"]),
        HoraRegistro: sval(prod, ["horaregistro", "HoraRegistro", "horaRegistro"]),
        Estado: prodState(prod) || sval(prod, ["EstadoLineaEtsscc", "EstadoDeLinea", "EstadoLinea", "Estado"]),
        Proceso: sval(prod, ["Proceso", "proceso", "TipoProceso", "tipoProceso"]) || "Picking",
        Picking: sval(prod, ["Picking", "picking", "NumPicking"]),
        Pedido: sval(prod, ["NumPedido", "Pedido", "pedido"]),
        SKU: sval(prod, ["ean", "EAN", "ref", "Ref", "barcode", "Barcode"]),
        Zona: nkey(zone)
      });
    }
    return {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source: "Copernico ProductividadPIK · Picking · Confirmadas + Negadas",
      turno: "Mañana",
      desde: "06:00",
      hasta: "14:00",
      referencia_minutos: 390,
      rows
    };
  }

  function isAvanceExecuted(row) {
    const state = sval(row, ["describeestadolinea", "descripcionlinea", "EstadoDeLinea", "EstadoLinea", "Estado"]).toUpperCase();
    return ["EJECUT", "CONFIRM", "NEGAD"].some(word => state.includes(word));
  }

  function transformAvance(payload) {
    const pickRows = extractRows(payload?.lineas_picking ?? payload?.body ?? payload);
    const rows = [];
    const units = {};
    const counts = {};
    for (const row of pickRows) {
      const sku = sval(row, ["ean", "EAN", "product", "Product"]);
      const quantity = field(row, ["Cant", "Cantidad", "unidad"]) || 0;
      rows.push({
        Pedido: sval(row, ["pedido", "NumPedido"]),
        Picking: sval(row, ["NumPicking", "Picking"]),
        Zona: sval(row, ["zonapiso", "zona"]).toUpperCase(),
        Estado: sval(row, ["EstadoDeLinea", "EstadoLinea", "Estado"]),
        SKU: sku,
        Descripcion: sval(row, ["descripcion", "Descripción"]),
        Ubicacion: sval(row, ["ubicacion_asig", "ubicacion"]),
        Cantidad: quantity
      });
      if (isAvanceExecuted(row) && sku) {
        const qty = Number(quantity);
        const key = sku.toUpperCase();
        units[key] = (units[key] || 0) + Math.max(0, Number.isFinite(qty) ? qty : 0);
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source: "Copernico Líneas de Picking",
      lineas_count: rows.length,
      processed_units_by_sku: units,
      processed_lines_by_sku: counts,
      processed_sku_source: "Líneas de Picking · Cant de Confirmadas + Negadas · global por SKU",
      rows
    };
  }

  function wrapLines(payload, source) {
    const rows = extractRows(payload?.body ?? payload?.rows ?? payload);
    return {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source,
      row_count: rows.length,
      rows
    };
  }

  function transformSummary(payload) {
    const prodRows = extractRows(payload?.productividad);
    const pickRows = extractRows(payload?.lineas_picking);
    const byExact = new Map();
    const byPickSku = new Map();
    const push = (map, key, row) => {
      const list = map.get(key) || [];
      list.push(row);
      map.set(key, list);
    };
    for (const line of pickRows) {
      const picking = nkey(sval(line, ["NumPicking", "Picking", "picking"]));
      const order = nkey(sval(line, ["pedido", "Pedido", "NumPedido"]));
      if (!picking) continue;
      for (const sku of skuKeys(line, "pick")) {
        push(byPickSku, `${picking}|${sku}`, line);
        if (order) push(byExact, `${picking}|${order}|${sku}`, line);
      }
    }
    function choose(prod) {
      const picking = nkey(sval(prod, ["Picking", "picking", "NumPicking"]));
      const order = nkey(sval(prod, ["NumPedido", "Pedido", "pedido"]));
      for (const sku of skuKeys(prod, "prod")) {
        const rows = byExact.get(`${picking}|${order}|${sku}`) || [];
        if (rows.length === 1) return [rows[0], "Picking+Pedido+SKU"];
        if (rows.length > 1) {
          const zones = new Set(rows.map(row => nkey(sval(row, ["zonapiso", "ZonaPiso", "zona", "Zona"]))).filter(Boolean));
          if (zones.size === 1) return [rows[0], "Picking+Pedido+SKU (misma zona)"];
        }
      }
      for (const sku of skuKeys(prod, "prod")) {
        const rows = byPickSku.get(`${picking}|${sku}`) || [];
        const zones = new Set(rows.map(row => nkey(sval(row, ["zonapiso", "ZonaPiso", "zona", "Zona"]))).filter(Boolean));
        if (rows.length && (rows.length === 1 || zones.size === 1)) return [rows[0], "Picking+SKU"];
      }
      return [null, "Sin cruce seguro"];
    }
    const detail = [];
    const grouped = new Map();
    for (const prod of prodRows) {
      const process = nkey(sval(prod, ["Proceso", "proceso", "TipoProceso", "tipoProceso"]));
      if (process && !process.includes("PICK")) continue;
      const hour = prodHour(prod);
      if (hour < 6 || hour >= 14) continue;
      const employee = sval(prod, ["Empleado", "empleado", "IdEmpleado", "idEmpleado"]);
      let picker = sval(prod, ["Nombres", "nombres", "NombreEmpleado", "nombreEmpleado"]);
      if (!picker) picker = employee || "Sin nombre";
      const [line, match] = choose(prod);
      const zone = line ? nkey(sval(line, ["zonapiso", "ZonaPiso", "zona", "Zona"])) : "";
      detail.push({
        Fecha: payload?.fecha || "",
        Picker: picker,
        IdEmpleado: employee,
        Picking: sval(prod, ["Picking", "picking", "NumPicking"]),
        Pedido: sval(prod, ["NumPedido", "Pedido", "pedido"]),
        SKU: sval(prod, ["ean", "EAN", "ref", "Ref", "barcode", "Barcode"]),
        FechaRegistro: sval(prod, ["fecharegistro", "FechaRegistro", "fechaRegistro"]),
        Hora: hour,
        ZonaLineaPicking: zone,
        CruceZona: match
      });
      const key = `${employee}|${picker}`;
      if (!grouped.has(key)) grouped.set(key, { Fecha: payload?.fecha || "", FechaQuery: payload?.fecha_query || "", IdEmpleado: employee, Picker: picker, Lineas: 0, Zonas: {}, SinCruceZona: 0 });
      const group = grouped.get(key);
      group.Lineas += 1;
      if (zone) group.Zonas[zone] = (group.Zonas[zone] || 0) + 1;
      else group.SinCruceZona += 1;
    }
    const pickers = [...grouped.values()].map(group => {
      const zonas = Object.fromEntries(Object.entries(group.Zonas).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
      return {
        Fecha: group.Fecha,
        FechaQuery: group.FechaQuery,
        IdEmpleado: group.IdEmpleado,
        Picker: group.Picker,
        Lineas: group.Lineas,
        PromedioLineasHora: Math.round((group.Lineas / 6.5) * 100) / 100,
        ZonaPrincipal: Object.keys(zonas)[0] || "",
        Zonas: zonas,
        SinCruceZona: group.SinCruceZona
      };
    }).sort((a, b) => b.Lineas - a.Lineas || a.Picker.toUpperCase().localeCompare(b.Picker.toUpperCase()));
    const summary = {
      updated_at: stampOf(payload),
      fecha: payload?.fecha || "",
      fecha_query: payload?.fecha_query || "",
      source: "Cruce ProductividadPIK + Líneas de Picking; zona exclusivamente desde Líneas de Picking",
      referencia_minutos: 390,
      productividad_raw_count: prodRows.length,
      lineas_picking_raw_count: pickRows.length,
      lineas_productividad_06_14: detail.length,
      pickers_count: pickers.length,
      pickers,
      rows: detail
    };
    if (payload?.picking_updated_at) summary.picking_updated_at = payload.picking_updated_at;
    return summary;
  }

  function movementSku(move) {
    return String(field(move, ["EAN", "ean"]) ?? "").trim();
  }

  function compactTraceForSku(moves, sku) {
    const skuRows = extractRows(moves).filter(move => movementSku(move) === sku);
    skuRows.sort((a, b) => parseDate(field(a, ["Fecha", "fecha", "FechaHora", "Fecha Hora", "FechaMovimiento", "Fecha Mov"])) - parseDate(field(b, ["Fecha", "fecha", "FechaHora", "Fecha Hora", "FechaMovimiento", "Fecha Mov"])));
    if (!skuRows.length) return null;
    const withSaldo = skuRows.map(move => [move, asNumber(field(move, ["Saldo", "saldo"]))]).filter(([, saldo]) => saldo != null);
    let start = null;
    if (withSaldo.length) {
      if (withSaldo[withSaldo.length - 1][1] <= 0) return null;
      let lastZero = -1;
      for (let i = withSaldo.length - 2; i >= 0; i -= 1) {
        if (withSaldo[i][1] <= 0) { lastZero = i; break; }
      }
      start = withSaldo[lastZero + 1][0];
    }
    if (!start) {
      const positives = skuRows.filter(move => {
        const mov = asNumber(field(move, ["Movimiento", "movimiento"]));
        const estado = String(field(move, ["Estado", "estado"]) ?? "").trim().toUpperCase();
        return (mov != null && mov > 0) || estado === "ENTRADA";
      });
      start = positives.length ? positives[positives.length - 1] : skuRows[0];
    }
    return {
      Fecha: field(start, ["Fecha", "fecha", "FechaHora", "Fecha Hora", "FechaMovimiento", "Fecha Mov"]),
      EAN: field(start, ["EAN", "ean"]),
      Estado: field(start, ["Estado", "estado"]),
      Movimiento: field(start, ["Movimiento", "movimiento"]),
      Saldo: field(start, ["Saldo", "saldo"]),
      Transaccion: field(start, ["Transaccion", "Transacción", "transaccion"]),
      Nombre_empleado: field(start, ["Nombre_empleado", "Nombre empleado", "NombreEmpleado"]),
      Id_empleado: field(start, ["Id_empleado", "ID empleado", "IdEmpleado"]),
      NoControl: field(start, ["NoControl", "No Control", "nocontrol"])
    };
  }

  function planFromStock(stockRows) {
    const byLocation = new Map();
    for (const row of stockRows || []) {
      const ubic = String(field(row, ["Ubicacion", "ubicacion"]) ?? "").trim();
      if (!ubic) continue;
      const saldo = asNumber(field(row, ["Saldo", "saldo"]));
      if (saldo == null || saldo <= 0) continue;
      const list = byLocation.get(ubic) || [];
      list.push(row);
      byLocation.set(ubic, list);
    }
    const locations = {};
    const boxSkus = {};
    for (const [ubic, locRows] of byLocation) {
      const skus = new Set(locRows.map(row => String(field(row, ["EAN", "ean", "referencia", "Referencia"]) ?? "").trim()).filter(Boolean));
      if (skus.size < 2) continue;
      const boxes = new Set();
      for (const row of locRows) {
        const caja = String(field(row, CAJAS) ?? "").trim();
        if (!caja) continue;
        boxes.add(caja);
        const sku = String(field(row, ["EAN", "ean"]) ?? "").trim() || String(field(row, ["referencia", "Referencia"]) ?? "").trim();
        if (!sku) continue;
        boxSkus[caja] = boxSkus[caja] || new Set();
        boxSkus[caja].add(sku);
      }
      locations[ubic] = { sku_count: skus.size, boxes: [...boxes].sort() };
    }
    const normalized = {};
    for (const [caja, skus] of Object.entries(boxSkus)) normalized[caja] = [...skus].sort();
    return { locations, box_skus: normalized };
  }

  async function transformTrace(payload, ctx) {
    const stockRows = payload?.stock_rows || [];
    const planned = payload?.locations && payload?.box_skus
      ? { locations: payload.locations, box_skus: payload.box_skus }
      : planFromStock(stockRows);
    const movimientos = { ...(payload?.movimientos || {}) };
    const cajas = payload?.cajas || Object.keys(planned.box_skus);
    if (typeof ctx?.load === "function") {
      for (const caja of cajas) {
        if (movimientos[caja] != null) continue;
        const loaded = await ctx.load(`trace:caja:${caja}`);
        if (loaded != null) movimientos[caja] = loaded;
      }
    }
    const boxes = {};
    let queried = Array.isArray(payload?.queried_this_cycle) ? payload.queried_this_cycle.length : 0;
    for (const caja of cajas) {
      const requested = planned.box_skus[caja] || [];
      const rawMoves = movimientos[caja];
      const error = payload?.errors?.[caja] || "";
      if (rawMoves == null) {
        boxes[caja] = {
          ok: false,
          caja: String(caja),
          error: error || "Pendiente de trazabilidad; se reintentará automáticamente",
          movimientos: [],
          ubicaciones: [],
          inventario: [],
          compact: true,
          requested_skus: requested
        };
        continue;
      }
      const compact = [];
      for (const sku of [...requested].sort()) {
        const item = compactTraceForSku(rawMoves, sku);
        if (item) compact.push(item);
      }
      boxes[caja] = {
        ok: true,
        caja: String(caja),
        movimientos: compact,
        ubicaciones: [],
        inventario: [],
        compact: true,
        requested_skus: [...requested].sort(),
        trace_resolved_at: stampOf(payload, ctx)
      };
    }
    const values = Object.values(boxes);
    return {
      schema_version: 15,
      updated_at: stampOf(payload, ctx),
      source: "Copernico WMS · trazabilidad compacta de mezclas",
      criterion: "Por caja y SKU actual se publica únicamente el movimiento que inicia la racha de saldo positivo vigente.",
      mixed_location_count: Object.keys(planned.locations).length,
      pending_box_count: values.filter(box => !box.ok).length,
      queried_this_cycle: queried,
      box_count: values.length,
      box_ok_count: values.filter(box => box.ok).length,
      box_error_count: values.filter(box => !box.ok).length,
      locations: planned.locations,
      boxes
    };
  }

  async function transformRaw(path, payload, ctx) {
    const name = datasetName(path);
    if (name === "stock") return transformStock(payload, ctx);
    if (name === "pallets-proceso") return transformPallets(payload, ctx);
    if (name === "en-recibo") return transformReceipt(payload, ctx);
    if (name === "trazabilidad") return transformTrace(payload, ctx);
    if (name === "negaciones") return transformNegations(payload, ctx);
    if (name === "lineas-negadas") return transformNegatedLines(payload, ctx);
    if (name === "tiempos") return transformTimes(payload, ctx);
    if (name === "avance") return transformAvance(payload, ctx);
    if (name === "lineas-picking") return wrapLines(payload, "Copernico Líneas de Picking");
    if (name === "productividad") return wrapLines(payload, "Copernico ProductividadPIK");
    if (name === "productividad-resumen") return transformSummary(payload, ctx);
    return payload;
  }

  root.ubicTransformRaw = transformRaw;
  root.ubicTransforms = {
    transformRaw,
    transformStock,
    transformPallets,
    transformReceipt,
    transformNegations,
    transformNegatedLines,
    transformTimes,
    transformAvance,
    transformSummary,
    transformTrace
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
