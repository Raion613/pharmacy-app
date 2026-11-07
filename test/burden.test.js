// 負担割合：年齢でありうる割合、割合が変わりうる日、変更と確認の記録
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedBurdens, burdenBoundaries, burdenEvents, ageParts } from "../public/assets/js/burden.js";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { updateBurden, validatePatient, getPatient } from "../src/server/patients.js";
import { HttpError } from "../src/server/http.js";

test("小学校に上がる日：6歳に達した日（誕生日の前日）以後の最初の3月31日の翌日。4月1日生まれは早生まれ", () => {
  assert.equal(burdenBoundaries("2021-05-20").school, "2028-04-01");
  assert.equal(burdenBoundaries("2021-04-02").school, "2028-04-01");
  assert.equal(burdenBoundaries("2021-04-01").school, "2027-04-01"); // 6歳に達するのが 2027-03-31
  assert.equal(burdenBoundaries("2021-03-31").school, "2027-04-01");
});

test("高齢受給者になる日：70歳に達した日の翌月1日。達した日が1日ならその月", () => {
  assert.equal(burdenBoundaries("1956-11-15").elder, "2026-12-01");
  assert.equal(burdenBoundaries("1956-11-02").elder, "2026-11-01"); // 達した日が 11/1
  assert.equal(burdenBoundaries("1956-11-01").elder, "2026-11-01"); // 達した日が 10/31 → 翌月
  assert.equal(burdenBoundaries("1951-11-15").late, "2026-11-15");   // 後期高齢者は75歳の誕生日から
});

test("年齢でありうる割合（生活保護 0 はいつでも）", () => {
  assert.deepEqual(allowedBurdens("2021-05-20", "2028-03-31"), [20, 0]);
  assert.deepEqual(allowedBurdens("2021-05-20", "2028-04-01"), [30, 0]);
  assert.deepEqual(allowedBurdens("1956-11-15", "2026-11-30"), [30, 0]);
  assert.deepEqual(allowedBurdens("1956-11-15", "2026-12-01"), [20, 30, 0]);
  assert.deepEqual(allowedBurdens("1951-11-15", "2026-11-15"), [10, 20, 30, 0]);
  assert.deepEqual(ageParts("2021-05-20", "2026-11-07"), { years: 5, months: 5 });
});

test("前回の来局より後に割合が変わりうる日：小学校・70歳・75歳・70歳以上の8月1日", () => {
  assert.deepEqual(burdenEvents("2021-05-20", "2028-03-10", "2028-04-07").map((e) => e.on), ["2028-04-01"]);
  assert.deepEqual(burdenEvents("2021-05-20", "2026-10-10", "2026-11-07"), []); // 誕生日をまたいでも割合が変わらなければ出さない
  assert.deepEqual(burdenEvents("1956-11-15", "2026-11-10", "2027-08-05").map((e) => e.on), ["2026-12-01", "2027-08-01"]);
  assert.deepEqual(burdenEvents("1980-01-01", "2026-07-01", "2026-09-01"), []); // 70歳未満の8月1日は関係ない
});

const FIXTURE = `
INSERT INTO pharmacies (id, name, prefecture_code, pharmacy_code, postal_code, address, phone) VALUES (1, 'テスト薬局', '13', '9999999', '100-0000', '架空', '000');
INSERT INTO users (id, pharmacy_id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (1, 1, 'test', 'テスト', 'x', 'x', 1);
INSERT INTO patients (id, pharmacy_id, patient_no, name, kana, birth_date, sex, burden_percent, created_at, created_by)
  VALUES (1, 1, '000001', '架空　陽向', 'カクウ　ヒナタ', '2021-05-20', 'M', 20, '2026-01-01T00:00:00Z', 1);
`;
const user = { id: 1, pharmacy_id: 1 };
const pathsOf = async (promise) => {
  try {
    await promise;
    return [];
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.details.map((d) => d.path);
  }
};

test("登録：年齢でありえない割合は保存しない", () => {
  const body = { name: "架空　陽向", kana: "カクウ　ヒナタ", birthDate: "2021-05-20", sex: "M" };
  assert.throws(() => validatePatient({ ...body, burdenPercent: 30 }, "2026-11-07"), (e) => e.details[0].path === "burdenPercent");
  assert.equal(validatePatient({ ...body, burdenPercent: 20 }, "2026-11-07").burdenPercent, 20);
  assert.equal(validatePatient({ ...body, burdenPercent: 0 }, "2026-11-07").burdenPercent, 0);
});

test("変更：ありうる割合だけ。同じ割合でも確かめた日を残し、アクセスログに残す", async () => {
  const db = openD1("db/schema.sql");
  db.exec(FIXTURE);
  assert.deepEqual(await pathsOf(updateBurden(db, user, 1, { burdenPercent: 30, date: "2026-11-07" }, "2026-11-07")), ["burdenPercent"]);
  assert.deepEqual(await pathsOf(updateBurden(db, user, 1, { burdenPercent: 20, date: "2026-11-08" }, "2026-11-07")), ["date"]);
  const same = await updateBurden(db, user, 1, { burdenPercent: 20, date: "2026-11-07" }, "2026-11-07");
  assert.deepEqual([same.burdenPercent, same.burdenCheckedOn], [20, "2026-11-07"]);
  const welfare = await updateBurden(db, user, 1, { burdenPercent: 0, date: "2026-11-07" }, "2026-11-07");
  assert.equal(welfare.burdenPercent, 0);
  assert.equal((await getPatient(db, 1)).burdenPercent, 0);
  const logs = await db.prepare("SELECT detail FROM access_logs WHERE action = 'patient.burden' ORDER BY id").all();
  assert.deepEqual(logs.results.map((l) => l.detail), ["2割のまま確認（2026-11-07）", "2割 → 生活保護（2026-11-07）"]);
});
