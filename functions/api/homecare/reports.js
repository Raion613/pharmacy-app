// 処方医への報告書の一括印刷用（施設と月で集める）。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { reportsFor } from "../../../src/server/homecare.js";
import { auditStatement } from "../../../src/server/audit.js";
import { assertSchedule } from "../../../src/server/tenant.js";

export async function onRequestGet({ request, env, data }) {
  const q = new URL(request.url).searchParams;
  const month = q.get("month");
  const facilityId = q.get("facility");
  const schedule = q.get("schedule");
  let reports;
  if (schedule !== null) {
    if (!/^\d+$/.test(schedule)) throw new HttpError(400, "訪問の指定が不正です");
    await assertSchedule(env.DB, data.user, Number(schedule));
    reports = await reportsFor(env.DB, data.user.pharmacy_id, { scheduleId: Number(schedule) });
  } else {
    if (!/^\d{4}-\d{2}$/.test(month ?? "")) throw new HttpError(400, "月の指定が不正です");
    if (!/^(all|home|\d+)$/.test(facilityId ?? "")) throw new HttpError(400, "施設の指定が不正です");
    reports = await reportsFor(env.DB, data.user.pharmacy_id, { month, facilityId });
  }
  const pharmacy = await env.DB.prepare("SELECT name, address, phone FROM pharmacies WHERE id = ?1").bind(data.user.pharmacy_id).first();
  if (reports.length) {
    await env.DB.batch([...new Set(reports.map((r) => r.patientId))].map((id) =>
      auditStatement(env.DB, data.user.id, "patient.view", id, `在宅の報告書${month ? `（${month}）` : ""}`)));
  }
  return json({ reports, pharmacy });
}
