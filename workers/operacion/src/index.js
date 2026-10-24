/**
 * No es el script de Picking. El fetch desplegado atiende /caja antes del
 * OPTIONS y le pasa a handleCaja login, logout, headers y capture del
 * propio worker. La línea exacta está en README.md.
 * Desplegar ESTE archivo como main borraría /picking.
 */
export { handleCaja, routeOperacion, normalizeCaja, normalizeMovimientos, resetCajaSession } from "./caja.js";
