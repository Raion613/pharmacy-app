// トレーシングレポート1件（印刷用）。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { getTracing } from "../../../src/server/tracing.js";
import { getPatient } from "../../../src/server/patients.js";
import { auditStatement } from "../../../src/server/audit.js";
import { assertTracing } from "../../../src/server/tenant.js";

export async function onRequestGet({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "トレーシングレポートが見つかりません");
  await assertTracing(env.DB, data.user, id);
  const report = await getTracing(env.DB, id);
  const [patient, pharmacy] = await Promise.all([
    getPatient(env.DB, report.patientId),
    env.DB.prepare("SELECT name, address, phone FROM pharmacies WHERE id = ?1").bind(data.user.pharmacy_id).first(),
  ]);
  await auditStatement(env.DB, data.user.id, "patient.view", report.patientId, "トレーシングレポート").run();
  return json({ report, patient, pharmacy });
}
