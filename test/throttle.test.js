// ログインの試行回数の制限
import { test } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { assertNotThrottled, recordFailure } from "../src/server/throttle.js";
import { HttpError } from "../src/server/http.js";

const is429 = (e) => e instanceof HttpError && e.status === 429;

test("同じログインIDで15分に5回失敗すると止まる。別の ID は止まらない", async () => {
  const db = openD1("db/schema.sql");
  for (let i = 0; i < 4; i++) await recordFailure(db, { id: "demo", ip: "1.1.1.1" });
  await assertNotThrottled(db, { id: "demo", ip: "1.1.1.1" });
  await recordFailure(db, { id: "demo", ip: "1.1.1.1" });
  await assert.rejects(assertNotThrottled(db, { id: "demo", ip: "1.1.1.1" }), is429);
  await assertNotThrottled(db, { id: "demo2", ip: "2.2.2.2" });
});

test("同じ IP から ID を変えながら20回失敗すると、その IP は止まる", async () => {
  const db = openD1("db/schema.sql");
  for (let i = 0; i < 20; i++) await recordFailure(db, { id: `user${i}`, ip: "3.3.3.3" });
  await assert.rejects(assertNotThrottled(db, { id: "new", ip: "3.3.3.3" }), is429);
});

test("15分より前の失敗は数えない", async () => {
  const db = openD1("db/schema.sql");
  const old = new Date(Date.now() - 16 * 60000).toISOString();
  for (let i = 0; i < 5; i++) await db.prepare("INSERT INTO login_failures (kind, key, at) VALUES ('id', 'demo', ?1)").bind(old).run();
  await assertNotThrottled(db, { id: "demo" });
});

test("6桁はユーザーごとに15分に5回まで", async () => {
  const db = openD1("db/schema.sql");
  for (let i = 0; i < 5; i++) await recordFailure(db, { mfa: 1 });
  await assert.rejects(assertNotThrottled(db, { mfa: 1 }), is429);
  await assertNotThrottled(db, { mfa: 2 });
});
