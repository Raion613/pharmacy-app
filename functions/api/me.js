import { json } from "../../src/server/http.js";

export async function onRequestGet({ env, data }) {
  const pharmacy = await env.DB.prepare("SELECT name FROM pharmacies WHERE id = ?1").bind(data.user.pharmacy_id).first();
  return json({ loginId: data.user.login_id, displayName: data.user.display_name, pharmacyName: pharmacy.name });
}
