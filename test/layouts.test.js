// 画面の箱の配置：利用者ごとに「並び順・大きさ・表示の選び方」を保存する。12列を超える幅や知らない選び方は受け付けない
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
const LAYOUT = { boxes: [{ id: "meds", w: 3, h: 2 }, { id: "patient", w: 2, h: 1 }], options: { historyRows: 2 } };

test("保存した配置は本人にだけ効き、消すと初期（null）に戻る", async () => {
  assert.equal(await getLayout(db, A, "patient"), null);
  await saveLayout(db, A, "patient", LAYOUT);
  assert.deepEqual(await getLayout(db, A, "patient"), LAYOUT);
  assert.equal(await getLayout(db, B, "patient"), null);
  await saveLayout(db, A, "patient", { boxes: [{ id: "patient", w: 2, h: 1 }], options: { historyRows: 0 } }); // 上書き
  assert.deepEqual((await getLayout(db, A, "patient")).boxes, [{ id: "patient", w: 2, h: 1 }]);
  await deleteLayout(db, A, "patient");
  assert.equal(await getLayout(db, A, "patient"), null);
});

test("12列を超える幅・同じ箱の重複・知らない選び方・知らない画面は受け付けない", async () => {
  const bad = (layout) => assert.rejects(saveLayout(db, A, "patient", layout), (e) => e.status === 422);
  await bad({ boxes: [{ id: "patient", w: 13, h: 1 }] });
  await bad({ boxes: [{ id: "patient", w: 0, h: 1 }] });
  await bad({ boxes: [{ id: "patient", w: "2", h: 1 }] });
  await bad({ boxes: [{ id: "patient", w: 2, h: 1 }, { id: "patient", w: 2, h: 1 }] });
  await bad({ boxes: [{ id: "patient", w: 2, h: 1 }], options: { historyRows: 3 } });
  await bad({ boxes: [{ id: "patient", w: 2, h: 1 }], options: { other: 1 } });
  await bad({ boxes: [] });
  await assert.rejects(saveLayout(db, A, "rx", LAYOUT), (e) => e.status === 404);
});
