// ログインの2段目（多要素認証）と、その設定。
//   設定：秘密を作って「設定の途中」に置く → QR を認証アプリで読む → アプリの6桁を入れて合えば有効にする
//   ログイン：パスワードが合ったら、有効な人には「6桁待ち」の札（Cookie、5分）を渡す → 6桁が合ったらセッションを作る
import { HttpError, nowIso } from "./http.js";
import { randomHex, sha256Hex } from "./password.js";
import { newSecret, verifyTotp, otpauthUri } from "./totp.js";
import { auditStatement } from "./audit.js";
import { readCookie } from "./session.js";

const COOKIE = "mfa";
const TTL_MINUTES = 5;
export const ISSUER = "薬剤料計算・薬歴";

export async function startChallenge(db, userId) {
  const token = randomHex(32);
  const now = new Date();
  await db.batch([
    db.prepare("DELETE FROM mfa_challenges WHERE expires_at <= ?1 OR user_id = ?2").bind(now.toISOString(), userId),
    db.prepare("INSERT INTO mfa_challenges (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)")
      .bind(await sha256Hex(token), userId, new Date(now.getTime() + TTL_MINUTES * 60000).toISOString()),
  ]);
  return `${COOKIE}=${token}; Path=/api/login; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_MINUTES * 60}`;
}

export const clearChallengeCookie = `${COOKIE}=; Path=/api/login; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// 6桁を確かめる。合えばユーザーを返す（札は消す）
export async function finishChallenge(db, request, code) {
  const token = readCookie(request, COOKIE);
  if (!token) throw new HttpError(401, "もう一度パスワードから入れてください");
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT u.* FROM mfa_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = ?1 AND c.expires_at > ?2`,
  ).bind(hash, nowIso()).first();
  if (!row) throw new HttpError(401, "時間が過ぎました。もう一度パスワードから入れてください");
  const step = await verifyTotp(row.totp_secret, String(code ?? ""), { lastStep: row.totp_last_step });
  if (step === null) throw new HttpError(401, "6桁の数字が違います");
  await db.batch([
    db.prepare("UPDATE users SET totp_last_step = ?1 WHERE id = ?2").bind(step, row.id),
    db.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?1").bind(hash),
  ]);
  return row;
}

// ---------- 設定 ----------

export async function mfaStatus(db, user) {
  const row = await db.prepare("SELECT totp_secret FROM users WHERE id = ?1").bind(user.id).first();
  return { enabled: row.totp_secret !== null };
}

// 設定を始める：新しい秘密を「設定の途中」に置き、認証アプリに読ませる URI を返す
export async function beginSetup(db, user) {
  const secret = newSecret();
  await db.prepare("UPDATE users SET totp_pending_secret = ?1 WHERE id = ?2").bind(secret, user.id).run();
  return { secret, uri: otpauthUri({ secret, account: user.login_id, issuer: ISSUER }) };
}

export async function confirmSetup(db, user, code) {
  const row = await db.prepare("SELECT totp_pending_secret FROM users WHERE id = ?1").bind(user.id).first();
  if (row.totp_pending_secret === null) throw new HttpError(422, "先に「設定を始める」を押してください");
  const step = await verifyTotp(row.totp_pending_secret, String(code ?? ""));
  if (step === null) throw new HttpError(422, "6桁の数字が違います", [{ path: "code", message: "認証アプリに出ている6桁を入れてください" }]);
  await db.batch([
    db.prepare("UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ?1 WHERE id = ?2").bind(step, user.id),
    auditStatement(db, user.id, "mfa.enable"),
  ]);
}

// 無効にするのにも、今の6桁を求める（パソコンを離れた隙に外されないように）
export async function disable(db, user, code) {
  const row = await db.prepare("SELECT totp_secret, totp_last_step FROM users WHERE id = ?1").bind(user.id).first();
  if (row.totp_secret === null) throw new HttpError(422, "多要素認証は設定されていません");
  const step = await verifyTotp(row.totp_secret, String(code ?? ""), { lastStep: row.totp_last_step });
  if (step === null) throw new HttpError(422, "6桁の数字が違います", [{ path: "code", message: "認証アプリに出ている6桁を入れてください" }]);
  await db.batch([
    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL WHERE id = ?1").bind(user.id),
    auditStatement(db, user.id, "mfa.disable"),
  ]);
}
