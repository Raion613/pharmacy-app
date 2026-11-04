import { readJson, json, HttpError } from "../../src/server/http.js";
import { verifyPassword } from "../../src/server/password.js";
import { createSession } from "../../src/server/session.js";
import { auditStatement } from "../../src/server/audit.js";

export async function onRequestPost({ request, env }) {
  const { loginId, password } = await readJson(request);
  if (typeof loginId !== "string" || typeof password !== "string") throw new HttpError(400, "ログインIDとパスワードを入力してください");
  const user = await env.DB.prepare("SELECT * FROM users WHERE login_id = ?1").bind(loginId).first();
  // ID が無い場合とパスワード違いを同じ文言にする（どの ID が存在するかを教えない）
  if (!user || !(await verifyPassword(password, user))) throw new HttpError(401, "ログインIDまたはパスワードが違います");
  const setCookie = await createSession(env.DB, user.id);
  await auditStatement(env.DB, user.id, "login").run();
  return json({ displayName: user.display_name }, 200, { "set-cookie": setCookie });
}
