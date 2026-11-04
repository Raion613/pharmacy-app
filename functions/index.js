// トップ（/）は患者一覧へ送る。ログイン確認は _middleware.js が先に済ませている。
// public/_redirects では、Functions が受けるリクエストに効かないため、ここで返す。
export function onRequestGet({ request }) {
  return Response.redirect(new URL("/patients", request.url), 302);
}
