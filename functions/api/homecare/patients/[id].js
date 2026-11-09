// 在宅の患者1人分（計画書の履歴・全訪問）。患者の情報を返すのでアクセスログを残す
import { json, HttpError } from "../../../../src/server/http.js";
import { homeDetail } from "../../../../src/server/homecare.js";
import { auditStatement } from "../../../../src/server/audit.js";
import { assertPatient } from "../../../../src/server/tenant.js";

export async function onRequestGet({ params, env, data }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "患者が見つかりません");
  await assertPatient(env.DB, data.user, id);
  const detail = await homeDetail(env.DB, id);
  await auditStatement(env.DB, data.user.id, "patient.view", id, "在宅").run();
  return json(detail);
}
