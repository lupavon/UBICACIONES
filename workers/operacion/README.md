# ubicaciones-operacion

El script completo del worker desplegado no está en este repositorio. En su `fetch()`, `/caja` es la primera decisión, antes del `OPTIONS` global, y le pasa a `handleCaja` el login, el logout y los helpers de headers y cookies de ese mismo worker:

```js
if (new URL(request.url).pathname === "/caja") {
  return handleCaja(request, env, {
    login: loginCopernico,
    logout: logoutFinal,
    headers: session => copernicoHeaders(session.jar, { Authorization: String(session.jwt) }),
    capture: (session, response) => session.jar.capture(response)
  });
}
```

`loginCopernico`, `logoutFinal`, `copernicoHeaders` y `session.jar.capture` viven en el worker ya desplegado. Esta ruta no agrega secrets.
