import { readJson, json, HttpError } from "../../src/server/http.js";
import { verifyPassword } from "../../src/server/password.js";
import { createSession } from "../../src/server/session.js";
import { auditStatement } from "../../src/server/audit.js";
import { startChallenge } from "../../src/server/mfa.js";
import { assertNotThrottled, recordFailure, clientIp } from "../../src/server/throttle.js";

export async function onRequestPost({ request, env }) {
  const { loginId, password } = await readJson(request);
  if (typeof loginId !== "string" || typeof password !== "string") throw new HttpError(400, "ログインIDとパスワードを入力してください");
  const keys = { id: loginId, ip: clientIp(request) };
  await assertNotThrottled(env.DB, keys);
  const user = await env.DB.prepare("SELECT * FROM users WHERE login_id = ?1").bind(loginId).first();
  // ID が無い場合とパスワード違いを同じ文言にする（どの ID が存在するかを教えない）
  if (!user || !(await verifyPassword(password, user))) {
    await recordFailure(env.DB, keys);
    throw new HttpError(401, "ログインIDまたはパスワードが違います");
  }
  // 多要素認証を設定した人は、ここではまだセッションを作らない。6桁を待つ札だけ渡す（/api/login/mfa で確かめる）
  if (user.totp_secret !== null) return json({ mfa: true }, 200, { "set-cookie": await startChallenge(env.DB, user.id) });
  const setCookie = await createSession(env.DB, user.id);
  await auditStatement(env.DB, user.id, "login").run();
  return json({ displayName: user.display_name }, 200, { "set-cookie": setCookie });
}
