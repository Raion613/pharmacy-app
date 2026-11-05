// 患者情報・患者メモ・薬歴（指導記録・会話を含む）・検査値・つながる薬局のメッセージ・在宅の登録。患者の情報を返すたびにアクセスログを残す。
import { json, HttpError } from "../../../src/server/http.js";
import { getPatient } from "../../../src/server/patients.js";
import { prescriptionsOf } from "../../../src/server/prescriptions.js";
import { auditStatement } from "../../../src/server/audit.js";
import { notesOf } from "../../../src/server/records.js";
import { measurementsOf } from "../../../src/server/measurements.js";
import { messagesOf } from "../../../src/server/line.js";
import { tracingsOf } from "../../../src/server/tracing.js";

export async function onRequestGet({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  const patient = await getPatient(env.DB, id);
  const purpose = new URL(request.url).searchParams.get("purpose") === "rx" ? "処方入力" : "薬歴";
  await auditStatement(env.DB, data.user.id, "patient.view", id, purpose).run();
  const [notes, prescriptions, measurements, messages, tracings, home] = await Promise.all([
    notesOf(env.DB, id), prescriptionsOf(env.DB, id), measurementsOf(env.DB, id), messagesOf(env.DB, id), tracingsOf(env.DB, id),
    env.DB.prepare("SELECT patient_id FROM home_patients WHERE patient_id = ?1").bind(id).first(),
  ]);
  return json({ patient, notes, prescriptions, measurements, messages, tracings, homeCare: home !== null });
}
