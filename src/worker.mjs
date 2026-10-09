/** Worker entry: /api/* goes to the proposal API, everything else to the static site. */
import { handle } from "./api/handler.mjs";
import { D1Store } from "./api/stores.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handle(request, {
        store: env.DB ? new D1Store(env.DB) : null,
        submitToken: env.PROPOSALS_SUBMIT_TOKEN,
        adminToken: env.PROPOSALS_ADMIN_TOKEN,
      });
    } catch {
      // Never put the error text in the response: it can carry request data.
      return new Response(JSON.stringify({ ok: false, errors: ["internal error"] }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
};
