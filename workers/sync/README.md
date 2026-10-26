# ubicaciones-sync

Worker que reemplaza, cuando se decida cortar, la generación de datos de los workflows `actualizar-stock-rapido.yml`, `actualizar-operacion.yml` y `actualizar-datos-pesados.yml`. Este PR no despliega nada y no toca esos workflows: GitHub Actions sigue publicando el JSON que consume GitHub Pages.

El worker entra a Copérnico, guarda la respuesta cruda comprimida y el navegador la convierte al JSON que el dashboard ya usa. La conversión vive en `browser-transform.js` y solo corre si la respuesta trae `X-Ubic-Raw: 1`. En GitHub Pages el `fetch` de `index.html` sigue yendo a `raw.githubusercontent.com` y ese JSON no lleva el header, así que la página no cambia.

## Qué corre y cada cuánto

| Cron | Datasets |
| --- | --- |
| `* * * * *` | `stock.json`, `en-recibo.json`, `pallets-proceso.json` |
| `*/3 * * * *` | `negaciones.json`, `tiempos.json`, `avance-pedidos.json` y `datos/{negaciones,tiempos,avance,lineas-negadas}/YYYYMMDD.json` |
| `*/10 * * * *` | `datos/{lineas-picking,productividad,productividad-resumen}/YYYYMMDD.json` y `trazabilidad-cajas.json` |

La fecha del día es Argentina (UTC−3), igual que los scripts de Python. `/caja` y `/pickings` usan el mismo Durable Object de sesión (`SESSION`, nombre `copernico`).

## Plan gratuito

- CPU de 10 ms por invocación. El cron no arma el JSON del dashboard: baja el cuerpo, calcula SHA-256 y, si cambió, lo comprime con `CompressionStream`. El hash y el gzip de `stock` (~9 MB, gzip ~1 MB) pueden pasar ese tope cuando el stock cambia. El plan de pago sube `cpu_ms`; este archivo lo deja en 10 a propósito.
- 50 subrequests externos. Por eso cada minuto se piden como máximo 35 `getubicaciones`, y cada 10 minutos como máximo 30 `getmovimientos`. `/pickings` acepta 20 números y marca el resto para reintento.
- D1: una fila de cabecera por clave y el gzip partido en trozos de 80 KB (el statement SQL de D1 corta en 100 KB; el blob va por bind). Si el SHA-256 no cambió, no hay escritura. Tope orientativo del plan free: 100 000 filas escritas por día.
- La cuenta free admite 5 cron triggers en total. Este worker declara 3.
- Trazabilidad: hay miles de cajas mezcladas y cada ciclo mira 30. El índice de mezclas avanza de a 400 objetos de stock por minuto. Hasta que ese índice termina, el ciclo de 10 minutos no pide movimientos. El navegador completa cada caja con `GET /api/raw/trace:caja:{id}`.
- No hay backfill de días anteriores. El histórico que ya está en `main` sigue saliendo por GitHub Pages.
- `COPERNICO_ENABLED` distinto de `"1"` no hace ninguna llamada a Copérnico, ni en el cron ni en `/caja` o `/pickings`.
- `/caja` y `/pickings` no repiten el login del dashboard que tiene `workers/operacion`. Antes de dejarlos públicos hay que agregar ese control.

## Despliegue (manual, fuera de este PR)

Desde `workers/sync/`, con Wrangler autenticado en la cuenta free:

```bash
npx wrangler d1 create ubicaciones-datos
```

Copiar el `database_id` real sobre el placeholder `00000000-0000-0000-0000-000000000000` de `wrangler.toml`. Sin eso un deploy no apunta a la base.

```bash
npx wrangler d1 migrations apply ubicaciones-datos --remote
npx wrangler secret put COPERNICO_EMAIL
npx wrangler secret put COPERNICO_PASSWORD
npx wrangler secret put COPERNICO_BASE
```

`COPERNICO_BASE` es el origen, sin barra final: `https://services.copernicowms.com`. El login es `POST {base}/users/api/login` con `{email, password, plataforma: "Copernico WMS"}`. El JWT va en `Authorization` tal cual, sin el prefijo `Bearer `.

Dejar `COPERNICO_ENABLED = "0"` en `[vars]`. Recién cuando los secrets y la base estén listos, pasar esa variable a `"1"` y desplegar (cambiar un var publica una versión nueva):

```bash
npx wrangler deploy
```

No apagar los workflows de GitHub hasta comparar unos ciclos contra `stock.json`, `pallets-proceso.json`, `en-recibo.json`, `negaciones.json`, `tiempos.json`, `avance-pedidos.json` y `trazabilidad-cajas.json`.

Cron en local, sin pegarle a Copérnico mientras el flag esté en 0:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

`GET /health` dice si el flag está activo y no muestra secretos.
