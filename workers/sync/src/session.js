import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_TECH_USER_ID,
  LOGIN_PATH,
  LOGOUT_PATH,
  copernicoBase,
  copernicoEnabled,
  copernicoHeaders,
  loginBody,
  loginFailureIsRecoverable,
  parseJson,
  userIdFromLogin
} from "./copernico.js";

/**
 * Una sola sesión técnica para los crons y para /caja y /pickings.
 * No llama a Copérnico si COPERNICO_ENABLED no es "1".
 * Ante HTTP 401 tira el JWT y vuelve a loguearse una vez.
 */
export class CopernicoSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.jwt = "";
    this.userId = DEFAULT_TECH_USER_ID;
    this.cookie = "";
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("session");
      if (saved && typeof saved === "object" && saved.jwt) {
        this.jwt = String(saved.jwt);
        this.userId = Number(saved.userId) || DEFAULT_TECH_USER_ID;
        this.cookie = String(saved.cookie || "");
      }
    });
  }

  async requestMany(paths) {
    if (!copernicoEnabled(this.env)) return { disabled: true, results: [] };
    await this.loaded;
    const base = copernicoBase(this.env);
    if (!base || !this.env.COPERNICO_EMAIL || !this.env.COPERNICO_PASSWORD) {
      return { disabled: true, results: [], error: "Faltan COPERNICO_BASE, COPERNICO_EMAIL o COPERNICO_PASSWORD" };
    }
    const results = [];
    for (const path of paths || []) {
      results.push(await this.#fetchPath(base, path));
    }
    return { disabled: false, results };
  }

  async #fetchPath(base, path) {
    let result = await this.#raw(base, path, Boolean(this.jwt));
    if (result.status === 401) {
      this.jwt = "";
      await this.#login(base);
      result = await this.#raw(base, path, true);
    }
    return { path, status: result.status, body: result.body };
  }

  async #login(base) {
    const first = await this.#postLogin(base);
    if (first.ok) return true;
    if (loginFailureIsRecoverable(first.status, first.body)) {
      await this.#postLogout(base, this.userId || DEFAULT_TECH_USER_ID);
      await scheduler.wait(2000);
      const second = await this.#postLogin(base);
      return second.ok;
    }
    console.error(JSON.stringify({
      message: "login copernico rechazado",
      status: first.status
    }));
    return false;
  }

  async #postLogin(base) {
    const response = await this.#send(base + LOGIN_PATH, {
      method: "POST",
      headers: { ...copernicoHeaders(""), "content-type": "application/json" },
      body: JSON.stringify(loginBody(this.env.COPERNICO_EMAIL, this.env.COPERNICO_PASSWORD))
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 700) };
    const data = parseJson(text) || {};
    if (!data.jwt) return { ok: false, status: response.status, body: text.slice(0, 700) };
    this.jwt = String(data.jwt);
    this.userId = userIdFromLogin(data, this.jwt, DEFAULT_TECH_USER_ID);
    this.#captureCookies(response);
    await this.ctx.storage.put("session", { jwt: this.jwt, userId: this.userId, cookie: this.cookie });
    return { ok: true, status: response.status, body: "" };
  }

  async #postLogout(base, userId) {
    try {
      await this.#send(base + LOGOUT_PATH, {
        method: "POST",
        headers: { ...copernicoHeaders(""), "content-type": "application/json" },
        body: JSON.stringify({ id: Number(userId) })
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "logout de contingencia fallo",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async #raw(base, path, withJwt) {
    if (withJwt && !this.jwt) await this.#login(base);
    const headers = copernicoHeaders(this.jwt);
    if (this.cookie) headers.cookie = this.cookie;
    const response = await this.#send(base + path, { method: "GET", headers });
    this.#captureCookies(response);
    const body = await response.text();
    return { status: response.status, body };
  }

  #captureCookies(response) {
    const list = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    if (!list.length) return;
    const jar = new Map(this.cookie.split("; ").filter(Boolean).map(part => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq), part.slice(eq + 1)];
    }));
    for (const cookie of list) {
      const pair = String(cookie).split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    this.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  #send(url, init) {
    return fetch(url, { ...init, redirect: "manual" });
  }
}
