// 支払基金の基本マスター（医薬品マスター・調剤行為マスター）の取り込み。
//
// 流れ（無料プランの CPU 時間 10ms に収めるため、重い処理はブラウザと SQL に置く）
//   1. ブラウザがファイルを読み、取り込む行に直す（public/assets/js/master-file.js）
//   2. start    … 取り込みの作業を作る（pending_imports）
//   3. addRows  … 行を2,000行ずつ受け取り、そのまま staging_rows（調剤行為マスターは staging_fee_rows）に入れる
//                 （Worker は JSON を解釈せず SQL に渡すだけ）
//   4. preview  … 反映すると何が変わるかを SQL で数える
//   5. commit   … 1回の batch（1つのトランザクション）で drugs / drug_prices（fee_items / fee_points）に反映し、作業を消す
//   途中で失敗・中止したら discard で作業を消す。マスターの表は commit が成功するまで一切変わらない。
//
// 反映の決まり（マスターファイル仕様説明書 令和8年度版「医薬品マスター」）
//   - 1行は「変更年月日から、この金額・経過措置」。その日に効いている薬価と違うときだけ、変更年月日の行を足す
//     （同じ日の行があれば置き換える）。それより後の日付の行には触れない
//   - 改定分の行は変わった項目しか入っていない。空の項目は今の値のまま
//   - 廃止年月日（使用できる最終日）があれば、翌日から使えなくする。変更区分 1（抹消）は変更年月日から使えなくする
//   - 全件ファイルに無くなったコードは、廃止の行を取り込めていない（改定分を飛ばした）もの。
//     経過措置の期限があればその翌日、無ければ公表日から使えなくする。取り込み済みより古い公表日の全件ファイルではこれをしない
//   - 名称などは、公表日がいちばん新しいマスターのものにする
//   - 調剤行為マスターも同じ決まり（点数と点数識別が「金額・経過措置」に当たる）
import { HttpError, isDate, nowIso, todayJst } from "./http.js";
import { auditStatement } from "./audit.js";

const MAX_ROWS = 50000;
const STALE_MINUTES = 60;

// その行が全項目そろった行か（全件ファイルの行、改定分の新規の行）
const COMPLETE = "(s.change_kind = '3' OR (SELECT kind FROM pending_imports WHERE id = ?1) = 'full')";

// マスターの各行について、変更年月日に効いている薬価（c）と、反映後の値（new_*）を並べる
const PLAN = `
  SELECT s.code, COALESCE(s.name, d.name) AS name, s.change_date AS valid_from, s.change_kind,
         c.valid_from AS cur_from, c.price_sen AS cur_price, c.transitional_until AS cur_trans,
         CASE WHEN s.change_kind = '1' THEN NULL ELSE COALESCE(s.price_sen, c.price_sen) END AS new_price,
         CASE WHEN s.transitional_until IS NULL THEN c.transitional_until ELSE NULLIF(s.transitional_until, '') END AS new_trans
    FROM staging_rows s
    LEFT JOIN drugs d ON d.code = s.code
    LEFT JOIN drug_prices c ON c.drug_code = s.code
          AND c.valid_from = (SELECT MAX(x.valid_from) FROM drug_prices x WHERE x.drug_code = s.code AND x.valid_from <= s.change_date)
   WHERE s.pending_id = ?1 AND (d.code IS NOT NULL OR ${COMPLETE})`;

// 薬価の履歴に書く行（その日に効いている値と違うもの）
const WRITES = `
  SELECT * FROM (${PLAN})
   WHERE (cur_from IS NULL AND new_price IS NOT NULL)
      OR (cur_from IS NOT NULL AND (new_price IS NOT cur_price OR new_trans IS NOT cur_trans))`;

// 改定分の行のうち、取り込み済みの薬に無いコード（内用薬以外の変更）
const IGNORED = `
  SELECT COUNT(*) AS n FROM staging_rows s
   WHERE s.pending_id = ?1 AND NOT ${COMPLETE} AND NOT EXISTS (SELECT 1 FROM drugs d WHERE d.code = s.code)`;

// 全件ファイルに無くなったコード。?2 は公表日。公表日がいちばん新しい全件ファイルのときだけ
const DISAPPEARED = `
  SELECT p.drug_code AS code, d.name,
         MAX(COALESCE(date(p.transitional_until, '+1 day'), ?2), date(p.valid_from, '+1 day')) AS valid_from
    FROM drug_prices p JOIN drugs d ON d.code = p.drug_code
   WHERE p.valid_from = (SELECT MAX(x.valid_from) FROM drug_prices x WHERE x.drug_code = p.drug_code)
     AND p.price_sen IS NOT NULL
     AND (SELECT kind FROM pending_imports WHERE id = ?1) = 'full'
     AND ?2 >= COALESCE((SELECT MAX(published_on) FROM master_imports WHERE master = 'drug' AND pending_id <> ?1), '')
     AND NOT EXISTS (SELECT 1 FROM staging_rows s WHERE s.pending_id = ?1 AND s.code = p.drug_code)`;

// ---------- 調剤行為マスター ----------

const FEE_PLAN = `
  SELECT s.code, s.name, s.change_date AS valid_from, s.point_kind, s.points_x100,
         c.valid_from AS cur_from, c.point_kind AS cur_kind, c.points_x100 AS cur_points, c.name AS cur_name
    FROM staging_fee_rows s
    LEFT JOIN fee_points c ON c.code = s.code
          AND c.valid_from = (SELECT MAX(x.valid_from) FROM fee_points x WHERE x.code = s.code AND x.valid_from <= s.change_date)
   WHERE s.pending_id = ?1`;

const FEE_WRITES = `
  SELECT * FROM (${FEE_PLAN})
   WHERE cur_from IS NULL OR points_x100 IS NOT cur_points OR point_kind IS NOT cur_kind OR name IS NOT cur_name`;

const FEE_DISAPPEARED = `
  SELECT p.code AS code, f.name AS name, MAX(?2, date(p.valid_from, '+1 day')) AS valid_from
    FROM fee_points p JOIN fee_items f ON f.code = p.code
   WHERE p.valid_from = (SELECT MAX(x.valid_from) FROM fee_points x WHERE x.code = p.code)
     AND p.points_x100 IS NOT NULL
     AND ?2 >= COALESCE((SELECT MAX(published_on) FROM master_imports WHERE master = 'fee' AND pending_id <> ?1), '')
     AND NOT EXISTS (SELECT 1 FROM staging_fee_rows s WHERE s.pending_id = ?1 AND s.code = p.code)`;

export async function startImport(db, userId, { master, kind, publishedOn, fileName, expectedRows }) {
  if (master !== "drug" && master !== "fee") throw new HttpError(400, "マスターの種類が不正です");
  if (kind !== "full" && kind !== "diff") throw new HttpError(400, "ファイルの種類が不正です");
  if (master === "fee" && kind !== "full") throw new HttpError(400, "調剤行為マスターは全件ファイルだけを取り込めます");
  if (!isDate(publishedOn)) throw new HttpError(400, "公表日を入力してください");
  if (typeof fileName !== "string" || fileName === "" || fileName.length > 200) throw new HttpError(400, "ファイル名が不正です");
  if (!Number.isInteger(expectedRows) || expectedRows < 1 || expectedRows > MAX_ROWS) throw new HttpError(400, "行数が不正です");

  const id = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
  // 前の取り込みを途中で閉じた作業が残っていれば消す（本人のもの、または1時間以上前のもの）
  const stale = "SELECT id FROM pending_imports WHERE created_by IS ?1 OR created_at < ?2";
  await db.batch([
    db.prepare(`DELETE FROM staging_rows WHERE pending_id IN (${stale})`).bind(userId, staleBefore),
    db.prepare(`DELETE FROM staging_fee_rows WHERE pending_id IN (${stale})`).bind(userId, staleBefore),
    db.prepare(`DELETE FROM pending_imports WHERE id IN (${stale})`).bind(userId, staleBefore),
    db.prepare(`INSERT INTO pending_imports (id, master, kind, published_on, file_name, expected_rows, created_by, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(id, master, kind, publishedOn, fileName, expectedRows, userId, nowIso()),
  ]);
  return id;
}

// rowsJson はブラウザが送った JSON の配列（1行は master-file.js の ROW_COLUMNS / FEE_ROW_COLUMNS の並び）。解釈は SQL に任せる
export async function addRows(db, userId, id, rowsJson) {
  const pending = await pendingOf(db, userId, id);
  if (pending.master === "fee") {
    await db.prepare(`
      INSERT INTO staging_fee_rows (pending_id, line_no, change_kind, code, name, point_kind, points_x100, change_date, end_date)
      SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6, j.value ->> 7
        FROM json_each(?2) j`).bind(id, rowsJson).run();
    return;
  }
  await db.prepare(`
    INSERT INTO staging_rows (pending_id, line_no, change_kind, code, yj_code, name, unit, generic, general_name, general_key,
                              name_key, sentei, pair_code, price_sen, change_date, end_date, transitional_until, narcotic)
    SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3, j.value ->> 4, j.value ->> 5, j.value ->> 6,
           j.value ->> 7, j.value ->> 8, j.value ->> 9, j.value ->> 10, j.value ->> 11, j.value ->> 12, j.value ->> 13,
           j.value ->> 14, j.value ->> 15, j.value ->> 16
      FROM json_each(?2) j`).bind(id, rowsJson).run();
}

export async function previewImport(db, userId, id, today = todayJst()) {
  const pending = await completePendingOf(db, userId, id);
  if (pending.master === "fee") return previewFee(db, pending, id, today);
  const p = pending.published_on;
  const [writes, scheduled, examples, ends, disappeared, newCodes, ignored, missingBase, later, latest] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${WRITES})`).bind(id),
    db.prepare(`SELECT valid_from, COUNT(*) AS n FROM (${WRITES}) WHERE valid_from > ?2 GROUP BY valid_from ORDER BY valid_from`).bind(id, today),
    db.prepare(`SELECT code, name, valid_from, cur_price, new_price, cur_trans, new_trans FROM (${WRITES})
                 WHERE cur_from IS NOT NULL ORDER BY valid_from DESC, code LIMIT 8`).bind(id),
    db.prepare(`SELECT s.code, COALESCE(s.name, d.name) AS name, s.end_date FROM staging_rows s LEFT JOIN drugs d ON d.code = s.code
                 WHERE s.pending_id = ?1 AND s.end_date <> '' AND (d.code IS NOT NULL OR ${COMPLETE}) ORDER BY s.end_date, s.code`).bind(id),
    db.prepare(`${DISAPPEARED} ORDER BY valid_from, code`).bind(id, p),
    db.prepare(`SELECT s.code, s.name, s.change_date, s.price_sen FROM staging_rows s
                 WHERE s.pending_id = ?1 AND ${COMPLETE} AND NOT EXISTS (SELECT 1 FROM drugs d WHERE d.code = s.code)
                 ORDER BY s.change_date DESC, s.code`).bind(id),
    db.prepare(IGNORED).bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM (${PLAN}) WHERE cur_from IS NULL AND new_price IS NULL AND change_kind <> '1'`).bind(id),
    db.prepare(`SELECT COUNT(*) AS n FROM (${WRITES}) w
                 WHERE EXISTS (SELECT 1 FROM drug_prices y WHERE y.drug_code = w.code AND y.valid_from > w.valid_from)`).bind(id),
    db.prepare("SELECT MAX(published_on) AS published_on FROM master_imports WHERE master = 'drug'"),
  ]);
  const list = (r, f, n = 5) => r.results.slice(0, n).map(f);
  return {
    master: "drug",
    kind: pending.kind,
    publishedOn: p,
    fileName: pending.file_name,
    rowCount: pending.expected_rows,
    olderThan: latest.results[0].published_on !== null && p < latest.results[0].published_on ? latest.results[0].published_on : null,
    counts: {
      priceWrites: writes.results[0].n,
      scheduled: scheduled.results.reduce((sum, r) => sum + r.n, 0),
      newCodes: newCodes.results.length,
      ends: ends.results.length,
      disappeared: disappeared.results.length,
      ignored: ignored.results[0].n,
      missingBase: missingBase.results[0].n,
      laterExists: later.results[0].n,
    },
    scheduled: scheduled.results.map((r) => ({ date: r.valid_from, count: r.n })),
    examples: {
      changes: examples.results.map((r) => ({
        code: r.code, name: r.name, validFrom: r.valid_from,
        before: r.cur_price, after: r.new_price, transitionalBefore: r.cur_trans, transitionalAfter: r.new_trans,
      })),
      newCodes: list(newCodes, (r) => ({ code: r.code, name: r.name, validFrom: r.change_date, after: r.price_sen })),
      ends: list(ends, (r) => ({ code: r.code, name: r.name, lastDay: r.end_date })),
      disappeared: list(disappeared, (r) => ({ code: r.code, name: r.name, validFrom: r.valid_from })),
    },
  };
}

export async function commitImport(db, userId, id) {
  const pending = await completePendingOf(db, userId, id);
  if (pending.master === "fee") return commitFee(db, userId, pending, id);
  const p = pending.published_on;
  const importId = "(SELECT id FROM master_imports WHERE pending_id = ?1)";
  const results = await db.batch([
    insertImportStatement(db, userId, pending, id),
    // 名称など。公表日が取り込み済みより古いマスターでは上書きしない
    db.prepare(`
      INSERT INTO drugs (code, yj_code, name, unit, generic, general_name, sentei, pair_code, narcotic, name_key, general_key, attrs_published_on)
      SELECT s.code, s.yj_code, s.name, s.unit, s.generic, NULLIF(s.general_name, ''), s.sentei, NULLIF(s.pair_code, ''),
             s.narcotic, s.name_key, s.general_key, ?2
        FROM staging_rows s WHERE s.pending_id = ?1 AND ${COMPLETE}
      ON CONFLICT (code) DO UPDATE SET
        yj_code = excluded.yj_code, name = excluded.name, unit = excluded.unit, generic = excluded.generic,
        general_name = excluded.general_name, sentei = excluded.sentei, pair_code = excluded.pair_code, narcotic = excluded.narcotic,
        name_key = excluded.name_key, general_key = excluded.general_key, attrs_published_on = excluded.attrs_published_on
      WHERE excluded.attrs_published_on >= drugs.attrs_published_on`).bind(id, p),
    // 改定分の変更行：入っている項目だけ書き換える
    db.prepare(`
      UPDATE drugs SET
        yj_code = COALESCE(s.yj_code, drugs.yj_code),
        name = COALESCE(s.name, drugs.name),
        name_key = COALESCE(s.name_key, drugs.name_key),
        unit = COALESCE(s.unit, drugs.unit),
        generic = COALESCE(s.generic, drugs.generic),
        general_name = CASE WHEN s.general_name IS NULL THEN drugs.general_name ELSE NULLIF(s.general_name, '') END,
        general_key = COALESCE(s.general_key, drugs.general_key),
        sentei = COALESCE(s.sentei, drugs.sentei),
        pair_code = CASE WHEN s.pair_code IS NULL THEN drugs.pair_code ELSE NULLIF(s.pair_code, '') END,
        narcotic = COALESCE(s.narcotic, drugs.narcotic),
        attrs_published_on = ?2
        FROM staging_rows s
       WHERE s.pending_id = ?1 AND s.code = drugs.code AND NOT ${COMPLETE} AND ?2 >= drugs.attrs_published_on`).bind(id, p),
    db.prepare(`
      INSERT INTO drug_prices (drug_code, valid_from, import_id, price_sen, transitional_until)
      SELECT code, valid_from, ${importId}, new_price, new_trans FROM (${WRITES}) WHERE true -- ON CONFLICT を JOIN の ON と読ませないため
      ON CONFLICT (drug_code, valid_from) DO UPDATE SET
        import_id = excluded.import_id, price_sen = excluded.price_sen, transitional_until = excluded.transitional_until`).bind(id),
    // 廃止：使用できる最終日の翌日から使えない
    db.prepare(`
      INSERT INTO drug_prices (drug_code, valid_from, import_id, price_sen, transitional_until)
      SELECT s.code, date(s.end_date, '+1 day'), ${importId}, NULL, NULL
        FROM staging_rows s
        JOIN drug_prices c ON c.drug_code = s.code
         AND c.valid_from = (SELECT MAX(x.valid_from) FROM drug_prices x WHERE x.drug_code = s.code AND x.valid_from <= date(s.end_date, '+1 day'))
       WHERE s.pending_id = ?1 AND s.end_date <> '' AND c.price_sen IS NOT NULL
      ON CONFLICT (drug_code, valid_from) DO UPDATE SET
        import_id = excluded.import_id, price_sen = NULL, transitional_until = NULL`).bind(id),
    db.prepare(`
      INSERT INTO drug_prices (drug_code, valid_from, import_id, price_sen, transitional_until)
      SELECT code, valid_from, ${importId}, NULL, NULL FROM (${DISAPPEARED})`).bind(id, p),
    db.prepare(`UPDATE master_imports SET changed_count = (SELECT COUNT(*) FROM drug_prices WHERE import_id = master_imports.id)
                 WHERE pending_id = ?1`).bind(id),
    db.prepare("DELETE FROM staging_rows WHERE pending_id = ?1").bind(id),
    db.prepare("DELETE FROM pending_imports WHERE id = ?1").bind(id),
    ...auditStatements(db, userId, pending),
  ]);
  return { changedCount: results[3].meta.changes + results[4].meta.changes + results[5].meta.changes };
}

async function previewFee(db, pending, id, today) {
  const p = pending.published_on;
  const [writes, scheduled, examples, ends, disappeared, newCodes, latest] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM (${FEE_WRITES})`).bind(id),
    db.prepare(`SELECT valid_from, COUNT(*) AS n FROM (${FEE_WRITES}) WHERE valid_from > ?2 GROUP BY valid_from ORDER BY valid_from`).bind(id, today),
    db.prepare(`SELECT code, name, valid_from, cur_points, points_x100 FROM (${FEE_WRITES})
                 WHERE cur_from IS NOT NULL ORDER BY valid_from DESC, code LIMIT 8`).bind(id),
    db.prepare(`SELECT code, name, end_date FROM staging_fee_rows WHERE pending_id = ?1 AND end_date <> '' ORDER BY end_date, code`).bind(id),
    db.prepare(`${FEE_DISAPPEARED} ORDER BY valid_from, code`).bind(id, p),
    db.prepare(`SELECT s.code, s.name, s.change_date, s.points_x100 FROM staging_fee_rows s
                 WHERE s.pending_id = ?1 AND NOT EXISTS (SELECT 1 FROM fee_items f WHERE f.code = s.code) ORDER BY s.change_date DESC, s.code`).bind(id),
    db.prepare("SELECT MAX(published_on) AS published_on FROM master_imports WHERE master = 'fee'"),
  ]);
  const list = (r, f, n = 5) => r.results.slice(0, n).map(f);
  const newest = latest.results[0].published_on;
  return {
    master: "fee",
    kind: pending.kind,
    publishedOn: p,
    fileName: pending.file_name,
    rowCount: pending.expected_rows,
    olderThan: newest !== null && p < newest ? newest : null,
    counts: {
      priceWrites: writes.results[0].n,
      scheduled: scheduled.results.reduce((sum, r) => sum + r.n, 0),
      newCodes: newCodes.results.length,
      ends: ends.results.length,
      disappeared: disappeared.results.length,
      ignored: 0,
      missingBase: 0,
      laterExists: 0,
    },
    scheduled: scheduled.results.map((r) => ({ date: r.valid_from, count: r.n })),
    examples: {
      changes: examples.results.map((r) => ({ code: r.code, name: r.name, validFrom: r.valid_from, beforePoints: r.cur_points, afterPoints: r.points_x100 })),
      newCodes: list(newCodes, (r) => ({ code: r.code, name: r.name, validFrom: r.change_date, afterPoints: r.points_x100 })),
      ends: list(ends, (r) => ({ code: r.code, name: r.name, lastDay: r.end_date })),
      disappeared: list(disappeared, (r) => ({ code: r.code, name: r.name, validFrom: r.valid_from })),
    },
  };
}

async function commitFee(db, userId, pending, id) {
  const p = pending.published_on;
  const importId = "(SELECT id FROM master_imports WHERE pending_id = ?1)";
  const results = await db.batch([
    insertImportStatement(db, userId, pending, id),
    db.prepare(`
      INSERT INTO fee_items (code, name, attrs_published_on)
      SELECT code, name, ?2 FROM staging_fee_rows WHERE pending_id = ?1
      ON CONFLICT (code) DO UPDATE SET name = excluded.name, attrs_published_on = excluded.attrs_published_on
      WHERE excluded.attrs_published_on >= fee_items.attrs_published_on`).bind(id, p),
    db.prepare(`
      INSERT INTO fee_points (code, valid_from, import_id, name, point_kind, points_x100)
      SELECT code, valid_from, ${importId}, name, point_kind, points_x100 FROM (${FEE_WRITES}) WHERE true -- ON CONFLICT を JOIN の ON と読ませないため
      ON CONFLICT (code, valid_from) DO UPDATE SET
        import_id = excluded.import_id, name = excluded.name, point_kind = excluded.point_kind, points_x100 = excluded.points_x100`).bind(id),
    db.prepare(`
      INSERT INTO fee_points (code, valid_from, import_id, name, point_kind, points_x100)
      SELECT s.code, date(s.end_date, '+1 day'), ${importId}, NULL, NULL, NULL
        FROM staging_fee_rows s
        JOIN fee_points c ON c.code = s.code
         AND c.valid_from = (SELECT MAX(x.valid_from) FROM fee_points x WHERE x.code = s.code AND x.valid_from <= date(s.end_date, '+1 day'))
       WHERE s.pending_id = ?1 AND s.end_date <> '' AND c.points_x100 IS NOT NULL
      ON CONFLICT (code, valid_from) DO UPDATE SET import_id = excluded.import_id, name = NULL, point_kind = NULL, points_x100 = NULL`).bind(id),
    db.prepare(`
      INSERT INTO fee_points (code, valid_from, import_id, name, point_kind, points_x100)
      SELECT code, valid_from, ${importId}, NULL, NULL, NULL FROM (${FEE_DISAPPEARED})`).bind(id, p),
    db.prepare(`UPDATE master_imports SET changed_count = (SELECT COUNT(*) FROM fee_points WHERE import_id = master_imports.id)
                 WHERE pending_id = ?1`).bind(id),
    db.prepare("DELETE FROM staging_fee_rows WHERE pending_id = ?1").bind(id),
    db.prepare("DELETE FROM pending_imports WHERE id = ?1").bind(id),
    ...auditStatements(db, userId, pending),
  ]);
  return { changedCount: results[2].meta.changes + results[3].meta.changes + results[4].meta.changes };
}

function insertImportStatement(db, userId, pending, id) {
  return db.prepare(`
    INSERT INTO master_imports (master, kind, published_on, file_name, row_count, changed_count, imported_at, imported_by, pending_id)
    VALUES (?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?1)`)
    .bind(id, pending.master, pending.kind, pending.published_on, pending.file_name, pending.expected_rows, nowIso(), userId);
}

function auditStatements(db, userId, pending) {
  if (userId === null) return []; // 初期データの作成
  const name = pending.master === "fee" ? "調剤行為マスター" : "医薬品マスター";
  return [auditStatement(db, userId, "master.import", null,
    `${name}（${pending.kind === "full" ? "全件" : "改定分"}）${pending.published_on} 公表 ${pending.file_name}（${pending.expected_rows.toLocaleString()}行）`)];
}

export async function discardImport(db, userId, id) {
  await pendingOf(db, userId, id);
  await db.batch([
    db.prepare("DELETE FROM staging_rows WHERE pending_id = ?1").bind(id),
    db.prepare("DELETE FROM staging_fee_rows WHERE pending_id = ?1").bind(id),
    db.prepare("DELETE FROM pending_imports WHERE id = ?1").bind(id),
  ]);
}

// 取り込み済みのマスターと、これから効く薬価の変更（調剤日がその日以降になると使われる）
export async function importHistory(db, today = todayJst()) {
  const [imports, upcoming, feeUpcoming] = await db.batch([
    db.prepare(`SELECT m.*, u.display_name FROM master_imports m LEFT JOIN users u ON u.id = m.imported_by ORDER BY m.id DESC`),
    db.prepare(`SELECT valid_from, COUNT(*) AS n, SUM(price_sen IS NULL) AS ended FROM drug_prices
                 WHERE valid_from > ?1 GROUP BY valid_from ORDER BY valid_from`).bind(today),
    db.prepare(`SELECT valid_from, COUNT(*) AS n, SUM(points_x100 IS NULL) AS ended FROM fee_points
                 WHERE valid_from > ?1 GROUP BY valid_from ORDER BY valid_from`).bind(today),
  ]);
  const toUpcoming = (r) => ({ date: r.valid_from, count: r.n, ended: r.ended });
  return {
    imports: imports.results.map((m) => ({
      master: m.master, kind: m.kind, publishedOn: m.published_on, fileName: m.file_name, rowCount: m.row_count, changedCount: m.changed_count,
      importedAt: m.imported_at, importedBy: m.display_name,
    })),
    upcoming: upcoming.results.map(toUpcoming),
    feeUpcoming: feeUpcoming.results.map(toUpcoming),
  };
}

async function pendingOf(db, userId, id) {
  const pending = await db.prepare("SELECT * FROM pending_imports WHERE id = ?1 AND created_by IS ?2").bind(id, userId).first();
  if (!pending) throw new HttpError(404, "取り込みの作業が見つかりません。最初からやり直してください");
  return pending;
}

// 送るはずの行が全部届いているか
async function completePendingOf(db, userId, id) {
  const pending = await pendingOf(db, userId, id);
  const table = pending.master === "fee" ? "staging_fee_rows" : "staging_rows";
  const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE pending_id = ?1`).bind(id).first();
  if (n !== pending.expected_rows) throw new HttpError(409, `行が揃っていません（${n} / ${pending.expected_rows}行）。最初からやり直してください`);
  return pending;
}
