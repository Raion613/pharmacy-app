// トップ（/）は受付状況へ送る（1日の仕事は処方箋の受付から始まる）。ログイン確認は _middleware.js が先に済ませている。
// public/_redirects では、Functions が受けるリクエストに効かないため、ここで返す。
export function onRequestGet({ request }) {
  return Response.redirect(new URL("/board", request.url), 302);
}
