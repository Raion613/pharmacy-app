// 画面の箱の配置：利用者ごとに保存し、格子（12列 × 12行）の外にはみ出す配置は受け付けない
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { getLayout, saveLayout, deleteLayout } from "../src/server/layouts.js";

let db;
beforeEach(() => {
  db = openD1("db/schema.sql");
  db.exec(`
    INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'A薬局', '13', '9999999', '100-0000', '架空', '000');
    INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES
      (1, 1, 'a', 'A', 'x', 'x', 1), (2, 1, 'b', 'B', 'x', 'x', 1);`);
});

const A = { id: 1, pharmacy_id: 1 };
const B = { id: 2, pharmacy_id: 1 };
const LAYOUT = { patient: { c: 1, r: 1, w: 3, h: 2 }, history: { c: 1, r: 3, w: 12, h: 10 } };

test("保存した配置は本人にだけ効き、消すと初期（null）に戻る", async () => {
  assert.equal(await getLayout(db, A, "patient"), null);
  await saveLayout(db, A, "patient", LAYOUT);
  assert.deepEqual(await getLayout(db, A, "patient"), LAYOUT);
  assert.equal(await getLayout(db, B, "patient"), null);
  await saveLayout(db, A, "patient", { ...LAYOUT, patient: { c: 2, r: 1, w: 2, h: 2 } }); // 上書き
  assert.deepEqual((await getLayout(db, A, "patient")).patient, { c: 2, r: 1, w: 2, h: 2 });
  await deleteLayout(db, A, "patient");
  assert.equal(await getLayout(db, A, "patient"), null);
});

test("格子からはみ出す・数でない・知らない画面は受け付けない", async () => {
  const bad = (layout) => assert.rejects(saveLayout(db, A, "patient", layout), (e) => e.status === 422);
  await bad({ patient: { c: 11, r: 1, w: 3, h: 2 } }); // 13列目まで出る
  await bad({ patient: { c: 1, r: 12, w: 2, h: 2 } }); // 13行目まで出る
  await bad({ patient: { c: 1, r: 1, w: 0, h: 2 } });
  await bad({ patient: { c: "1", r: 1, w: 2, h: 2 } });
  await bad({});
  await assert.rejects(saveLayout(db, A, "rx", LAYOUT), (e) => e.status === 404);
});
