// 全リクエストの入口。ログインしていなければ、ログイン画面と画面部品（CSS・JS・アイコン）以外は何も返さない。
import { getSessionUser } from "../src/server/session.js";
import { HttpError, json } from "../src/server/http.js";

const PUBLIC_PATHS = new Set(["/login", "/login.html", "/api/login"]);

export async function onRequest(context) {
  const { request, env, data, next } = context;
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");

  if (!PUBLIC_PATHS.has(url.pathname) && !url.pathname.startsWith("/assets/")) {
    const user = await getSessionUser(env.DB, request);
    if (!user) {
      if (isApi) return json({ error: "ログインが必要です" }, 401);
      return Response.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url), 302);
    }
    data.user = user;
  }

  // 書き込みは JSON だけを受け付ける。他サイトのフォームから勝手に送らせる攻撃（CSRF）は JSON を送れない
  if (isApi && request.method !== "GET" && !(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json({ error: "JSON で送信してください" }, 415);
  }

  try {
    return await next();
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status);
    throw e;
  }
}
