// 薬局の数字（月ごと）
import { json, todayJst } from "../../src/server/http.js";
import { monthlyStats } from "../../src/server/stats.js";

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const to = q.get("to") ?? todayJst().slice(0, 7);
  return json(await monthlyStats(env.DB, { from: q.get("from") ?? to, to }));
}
