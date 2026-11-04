// アクセスログの閲覧。患者を指定すると、その患者の情報に誰がいつ触れたかに絞る。
import { json, HttpError } from "../../src/server/http.js";

export async function onRequestGet({ request, env }) {
  const patient = new URL(request.url).searchParams.get("patient");
  const where = patient ? "WHERE l.patient_id = ?1" : "";
  if (patient && !/^\d+$/.test(patient)) throw new HttpError(400, "患者の指定が不正です");
  let stmt = env.DB.prepare(
    `SELECT l.id, l.at, l.action, l.detail, u.display_name AS user_name, u.login_id,
            pa.id AS patient_id, pa.patient_no, pa.name AS patient_name
       FROM access_logs l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN patients pa ON pa.id = l.patient_id
       ${where}
      ORDER BY l.id DESC LIMIT 300`,
  );
  if (patient) stmt = stmt.bind(Number(patient));
  const { results } = await stmt.all();
  return json(results.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    detail: r.detail,
    userName: r.user_name,
    loginId: r.login_id,
    patient: r.patient_id === null ? null : { id: r.patient_id, patientNo: r.patient_no, name: r.patient_name },
  })));
}
