// 全リクエストの入口。ログインしていなければ、ログイン画面とその表示に要る部品（下の一覧）以外は何も返さない。
// 他の画面の JS・CSS もログインしないと取れない（作りを外から持ち出させない）。
import { getSessionUser } from "../src/server/session.js";
import { HttpError, json } from "../src/server/http.js";

const PUBLIC_PATHS = new Set([
  "/login", "/login.html", "/api/login", "/api/login/mfa", "/robots.txt",
  // ログイン画面が読み込む部品（login.js から import でたどれるもの）
  "/assets/favicon.svg", "/assets/css/app.css", "/assets/css/tour.css", "/assets/css/login.css",
  "/assets/js/login.js", "/assets/js/app.js", "/assets/js/icons.js", "/assets/js/format.js", "/assets/js/tour.js",
  "/assets/js/record-kinds.js", "/assets/js/burden-text.js", "/assets/js/kohi-text.js",
  // 紹介の PV（1枚の HTML で完結。アプリのコードは入っていない）。URL を踏んだ人がログインせずに見られるようにする
  "/promo", "/promo.html",
]);

// すべての応答に付けるヘッダー
//   X-Robots-Tag：検索エンジンに載せない・AI の学習に使わせない（noai・noimageai は守るかどうかが相手次第の申し出）
//   X-Frame-Options・frame-ancestors：他のサイトの枠に埋め込ませない（同じサイトの重なる窓は使う）
const SECURITY_HEADERS = {
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noai, noimageai",
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export async function onRequest(context) {
  const res = await handle(context);
  const out = new Response(res.body, res); // Response.redirect などのヘッダーは書き換えられないので作り直す
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function handle(context) {
  const { request, env, data, next } = context;
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/");

  if (!PUBLIC_PATHS.has(url.pathname)) {
    const user = await getSessionUser(env.DB, request);
    if (!user) {
      if (isApi) return json({ error: "ログインが必要です" }, 401);
      if (url.pathname.startsWith("/assets/")) return new Response("ログインが必要です", { status: 401 });
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
