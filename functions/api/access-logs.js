// アクセスログの閲覧（自分の薬局の利用者の操作だけ）。患者を指定すると、その患者の情報に誰がいつ触れたかに絞る。
import { json, HttpError } from "../../src/server/http.js";

export async function onRequestGet({ request, env, data }) {
  const patient = new URL(request.url).searchParams.get("patient");
  const where = patient ? "AND l.patient_id = ?2" : "";
  if (patient && !/^\d+$/.test(patient)) throw new HttpError(400, "患者の指定が不正です");
  let stmt = env.DB.prepare(
    `SELECT l.id, l.at, l.action, l.detail, u.display_name AS user_name, u.login_id,
            pa.id AS patient_id, pa.patient_no, pa.name AS patient_name
       FROM access_logs l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN patients pa ON pa.id = l.patient_id
      WHERE u.pharmacy_id = ?1 ${where}
      ORDER BY l.id DESC LIMIT 300`,
  );
  stmt = patient ? stmt.bind(data.user.pharmacy_id, Number(patient)) : stmt.bind(data.user.pharmacy_id);
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
