import { json } from "../../src/server/http.js";

export function onRequestGet({ data }) {
  return json({ loginId: data.user.login_id, displayName: data.user.display_name });
}
