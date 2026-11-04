import { json } from "../../src/server/http.js";
import { destroySession } from "../../src/server/session.js";
import { auditStatement } from "../../src/server/audit.js";

export async function onRequestPost({ request, env, data }) {
  await auditStatement(env.DB, data.user.id, "logout").run();
  return json({ ok: true }, 200, { "set-cookie": await destroySession(env.DB, request) });
}
