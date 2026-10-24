/**
 * No es el script de Picking. routeOperacion agrega /caja y deja pasar
 * el resto al fetch que ya está desplegado en ubicaciones-operacion.
 * Desplegar ESTE archivo como main borraría /picking.
 */
export { handleCaja, routeOperacion, normalizeCaja, normalizeMovimientos, resetCajaSession } from "./caja.js";
