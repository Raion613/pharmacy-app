// e2e 用の DB（.wrangler/e2e-state）を、表を全部消してから 定義 → 医薬品マスター → 参照データ → 種データ で作り直す。
// 手元の DB（.wrangler/state）には触らない。e2e 用のサーバー（npm run e2e:server）を動かしたままでよい。
//   npm run e2e:reset
// db/generated/*.sql が無ければ先に npm run db:reset（手元の DB を作る手順）で作っておく。
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
export const E2E_STATE = join(root, ".wrangler", "e2e-state");

export function e2eDbFile() {
  const dir = join(E2E_STATE, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (files.length !== 1) throw new Error(`e2e の DB が1つに決まりません：${files.join(", ") || "なし"}（${dir}）。先に e2e のサーバーを起動して1回アクセスする`);
  return join(dir, files[0]);
}

export function resetE2eDb() {
  const db = new DatabaseSync(e2eDbFile());
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").all();
  for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
  for (const file of ["db/schema.sql", "db/generated/master.sql", "db/generated/references.sql", "db/generated/seed.sql"]) {
    db.exec(readFileSync(join(root, file), "utf8"));
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.close();
}

if (import.meta.filename === process.argv[1]) {
  const t = Date.now();
  resetE2eDb();
  console.log(`e2e の DB を作り直しました（${Date.now() - t}ms）`);
}
