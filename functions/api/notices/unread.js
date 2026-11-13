// 回覧板のまだ確認していない投稿の数（左上のボタンの印）
import { json } from "../../../src/server/http.js";
import { unreadCount } from "../../../src/server/notices.js";

export async function onRequestGet({ env, data }) {
  return json({ count: await unreadCount(env.DB, data.user) });
}
