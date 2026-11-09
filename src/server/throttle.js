// ログインの試行回数の制限。パスワードや6桁を総当たりで試させない。
//   ログインID ごと：15分に5回失敗したら、その ID は15分止める（デモ用アカウントのパスワードは面接官に渡すので、知らない人に試させない）
//   接続元 IP ごと：15分に20回失敗したら、その IP からのログインを15分止める（ID を変えながら試す相手を止める）
//   6桁（多要素認証）：ユーザーごとに15分に5回まで
// 失敗だけを数える。成功しても消さない（数え直しは時間が過ぎるのを待つ）。
import { HttpError, nowIso } from "./http.js";

const WINDOW_MINUTES = 15;
const LIMITS = { id: 5, ip: 20, mfa: 5 };

const since = () => new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
export const clientIp = (request) => request.headers.get("cf-connecting-ip") ?? "local";

// keys：{ id?, ip?, mfa? }。どれかが上限に達していれば 429
export async function assertNotThrottled(db, keys) {
  for (const [kind, value] of Object.entries(keys)) {
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE kind = ?1 AND key = ?2 AND at > ?3")
      .bind(kind, String(value), since()).first();
    if (n >= LIMITS[kind]) throw new HttpError(429, `失敗が続いたため、${WINDOW_MINUTES}分ほど止めています。時間をおいてから入れてください`);
  }
}

export async function recordFailure(db, keys) {
  const at = nowIso();
  await db.batch(Object.entries(keys).map(([kind, value]) =>
    db.prepare("INSERT INTO login_failures (kind, key, at) VALUES (?1, ?2, ?3)").bind(kind, String(value), at)));
}
