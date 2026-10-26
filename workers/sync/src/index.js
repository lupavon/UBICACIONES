import { CopernicoSession } from "./session.js";
import { handleFetch } from "./routes.js";
import { runScheduled } from "./jobs.js";

export { CopernicoSession };

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: "fetch fallo",
        error: error instanceof Error ? error.message : String(error)
      }));
      return new Response(JSON.stringify({ ok: false, error: "Error interno" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await runScheduled(controller, env);
      } catch (error) {
        console.error(JSON.stringify({
          message: "cron fallo",
          cron: controller.cron,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    })());
  }
};
