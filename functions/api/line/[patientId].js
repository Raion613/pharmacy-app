// つながる薬局：1人分のやり取り。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../src/server/http.js";
import { messagesOf } from "../../../src/server/line.js";
import { auditStatement } from "../../../src/server/audit.js";
import { assertPatient } from "../../../src/server/tenant.js";

export async function onRequestGet({ params, env, data }) {
  const id = Number(params.patientId);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  const messages = await messagesOf(env.DB, id);
  await auditStatement(env.DB, data.user.id, "patient.view", id, "つながる薬局").run();
  return json(messages);
}
