// トレーシングレポート1件（印刷用）。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { getTracing } from "../../../src/server/tracing.js";
import { getPatient } from "../../../src/server/patients.js";
import { auditStatement } from "../../../src/server/audit.js";

export async function onRequestGet({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "トレーシングレポートが見つかりません");
  const report = await getTracing(env.DB, id);
  const [patient, pharmacy] = await Promise.all([
    getPatient(env.DB, report.patientId),
    env.DB.prepare("SELECT name, address, phone FROM pharmacy_profile WHERE id = 1").first(),
  ]);
  await auditStatement(env.DB, data.user.id, "patient.view", report.patientId, "トレーシングレポート").run();
  return json({ report, patient, pharmacy });
}
