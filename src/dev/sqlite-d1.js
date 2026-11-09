// Node 標準の SQLite（node:sqlite）を、Cloudflare D1 と同じ呼び出し方で使えるようにする薄い包み。
// テストとデモデータの作成で、本番と同じ SQL・同じ保存処理をそのまま通すためだけに使う。
// D1 の API のうち、このアプリが使う分（prepare / bind / first / all / run / batch）だけを実装する。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function openD1(...sqlFiles) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;"); // D1 は外部キー制約が常に有効
  for (const f of sqlFiles) raw.exec(readFileSync(f, "utf8"));
  return new D1Database(raw);
}

class D1Database {
  constructor(raw) {
    this.raw = raw;
  }

  prepare(sql) {
    return new D1Statement(this.raw, sql, []);
  }

  // D1 と同じく、全文を1つのトランザクションで実行する。1文でも失敗したら全部取り消して例外を投げる
  async batch(statements) {
    this.raw.exec("BEGIN");
    try {
      const results = statements.map((s) => s.execute());
      this.raw.exec("COMMIT");
      return results;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  exec(sql) {
    this.raw.exec(sql);
  }
}

class D1Statement {
  constructor(raw, sql, params) {
    this.raw = raw;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.raw, this.sql, params);
  }

  execute() {
    const stmt = this.raw.prepare(this.sql);
    if (stmt.columns().length > 0) return { results: stmt.all(...this.params).map(plain), success: true };
    const info = stmt.run(...this.params);
    return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }

  async first() {
    return this.execute().results[0] ?? null;
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }
}

// node:sqlite の行は null プロトタイプのオブジェクトなので、普通のオブジェクトに直す
function plain(row) {
  return { ...row };
}
