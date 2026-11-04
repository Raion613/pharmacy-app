import { randomHex, sha256Hex } from "./password.js";
import { nowIso } from "./http.js";

const COOKIE = "sid";
const TTL_HOURS = 8; // 1勤務分

// Cookie からログイン中のユーザーを引く。無効なら null。
export async function getSessionUser(db, request) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  return db
    .prepare(
      `SELECT u.id, u.login_id, u.display_name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(await sha256Hex(token), nowIso())
    .first();
}

// 新しいセッションを作り、Set-Cookie ヘッダの値を返す
export async function createSession(db, userId) {
  const token = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_HOURS * 3600 * 1000);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now.toISOString()), // 期限切れを掃除する
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(await sha256Hex(token), userId, now.toISOString(), expires.toISOString()),
  ]);
  return cookie(token, TTL_HOURS * 3600);
}

export async function destroySession(db, request) {
  const token = readCookie(request, COOKIE);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  return cookie("", 0);
}

// HttpOnly：JavaScript から読めない。SameSite=Lax：他サイトからの POST に Cookie を付けない。
function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
