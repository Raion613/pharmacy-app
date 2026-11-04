// 患者情報・患者メモ・薬歴（指導記録を含む）。患者の情報を返すたびにアクセスログを残す。
import { json, HttpError } from "../../../src/server/http.js";
import { getPatient } from "../../../src/server/patients.js";
import { prescriptionsOf } from "../../../src/server/prescriptions.js";
import { auditStatement } from "../../../src/server/audit.js";
import { notesOf } from "../../../src/server/records.js";

export async function onRequestGet({ params, request, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  const patient = await getPatient(env.DB, id);
  const purpose = new URL(request.url).searchParams.get("purpose") === "rx" ? "処方入力" : "薬歴";
  await auditStatement(env.DB, data.user.id, "patient.view", id, purpose).run();
  return json({ patient, notes: await notesOf(env.DB, id), prescriptions: await prescriptionsOf(env.DB, id) });
}
