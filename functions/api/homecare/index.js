// 在宅の画面の中身（施設・在宅の患者・その月の訪問予定）
import { json, HttpError, todayJst } from "../../../src/server/http.js";
import { homeOverview } from "../../../src/server/homecare.js";

export async function onRequestGet({ request, env, data }) {
  const month = new URL(request.url).searchParams.get("month") ?? todayJst().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "月の指定が不正です");
  return json(await homeOverview(env.DB, data.user.pharmacy_id, month));
}
