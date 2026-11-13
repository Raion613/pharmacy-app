// 回覧板：薬局の中の伝達。本部からの通知（pharmacy_id が NULL の行。全部の薬局に出る）と、薬局の人の投稿（その薬局だけ）。
// 追記だけで、直さない・消さない。読んだ人は「確認した」を押す（紙の回覧板の判子）。書いた人は自分の投稿を確認済みにする
import { HttpError, nowIso } from "./http.js";
import { auditStatement } from "./audit.js";

export const NOTICE_MAX = 1000;
// 薬局の人が書ける種類（本部・日報月報・広報は本部の投稿だけ）
export const POSTABLE_KINDS = ["handover", "report", "contact", "consult"];

const VISIBLE = "(n.pharmacy_id IS NULL OR n.pharmacy_id = ?1)";

export async function listNotices(db, user) {
  const [{ results: rows }, { results: reads }, staff] = await Promise.all([
    db.prepare(
      `SELECT n.id, n.kind, n.body, n.sender, n.created_at, n.created_by, u.display_name AS author
         FROM notices n LEFT JOIN users u ON u.id = n.created_by
        WHERE ${VISIBLE} ORDER BY n.id DESC LIMIT 100`,
    ).bind(user.pharmacy_id).all(),
    // 確認したのは、この薬局の人の分だけ（本部の投稿は、他の薬局の人の判子を見せない）
    db.prepare(
      `SELECT r.notice_id, u.id AS user_id, u.display_name FROM notice_reads r JOIN users u ON u.id = r.user_id
        WHERE u.pharmacy_id = ?1 ORDER BY r.read_at`,
    ).bind(user.pharmacy_id).all(),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE pharmacy_id = ?1").bind(user.pharmacy_id).first(),
  ]);
  const readers = new Map();
  for (const r of reads) {
    if (!readers.has(r.notice_id)) readers.set(r.notice_id, []);
    readers.get(r.notice_id).push({ id: r.user_id, name: r.display_name });
  }
  return {
    staff: staff.n,
    notices: rows.map((n) => {
      const readBy = readers.get(n.id) ?? [];
      return {
        id: n.id, kind: n.kind, body: n.body, createdAt: n.created_at,
        author: n.author ?? n.sender, fromHq: n.created_by === null, mine: n.created_by === user.id,
        readBy: readBy.map((r) => r.name), read: readBy.some((r) => r.id === user.id),
      };
    }),
  };
}

export async function unreadCount(db, user) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM notices n
      WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?2)`,
  ).bind(user.pharmacy_id, user.id).first();
  return row.n;
}

export async function createNotice(db, user, input) {
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim();
  const errors = [];
  if (!POSTABLE_KINDS.includes(input.kind)) errors.push({ path: "kind", message: "種類を選んでください" });
  if (body === "") errors.push({ path: "body", message: "伝えることを書いてください" });
  if (body.length > NOTICE_MAX) errors.push({ path: "body", message: `${NOTICE_MAX}文字までです` });
  if (errors.length) throw new HttpError(422, "入力に誤りがあります", errors);
  const at = nowIso();
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO notices (pharmacy_id, kind, body, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id")
      .bind(user.pharmacy_id, input.kind, body, at, user.id),
    db.prepare("INSERT INTO notice_reads (notice_id, user_id, read_at) SELECT MAX(id), ?1, ?2 FROM notices WHERE created_by = ?1").bind(user.id, at),
    auditStatement(db, user.id, "notice.create", null, null),
  ]);
  return inserted.results[0].id;
}

export async function markRead(db, user, noticeId) {
  const n = await db.prepare(`SELECT n.id FROM notices n WHERE n.id = ?2 AND ${VISIBLE}`).bind(user.pharmacy_id, noticeId).first();
  if (!n) throw new HttpError(404, "投稿が見つかりません");
  await db.prepare("INSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES (?1, ?2, ?3)").bind(noticeId, user.id, nowIso()).run();
}
