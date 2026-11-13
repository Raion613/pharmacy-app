// 処方入力：保存していない入力の確認・小児の分量
import assert from "node:assert/strict";
import { start, BASE, selectedCard, doFromPatient, text, step } from "../lib.js";

const page = await start();

// 保存していない入力がある処方入力から移るときは、アプリの窓で確かめる（ブラウザの confirm は使わない）
step("処方入力：保存していない入力があるまま移ると確かめる");
await page.goto(`${BASE}/rx?patient=1`);
await page.waitForSelector('[data-field="drug"]:focus');
await page.keyboard.type("のるはすく錠"); // 濁点を落としても候補に出る
await page.waitForFunction(() => /ノルバスク錠/.test(document.querySelector("#suggest:not([hidden]) li[aria-selected=true]")?.textContent ?? ""));
await page.keyboard.press("Enter");
await page.keyboard.type("3");
assert.equal(await page.inputValue("#usage-0"), "1日3回毎食後"); // 3錠 → 1日3回毎食後
await page.keyboard.press("Alt+2");
await page.waitForSelector(".ask-dialog[open]");
assert.match(await text(".ask-dialog"), /保存していない入力があります[\s\S]*この画面に残る[\s\S]*移る（入力を消す）/);
await page.keyboard.press("Escape");
await page.waitForSelector(".ask-dialog", { state: "detached" });
assert.match(page.url(), /\/rx\?patient=1$/);
await page.keyboard.press("Alt+2");
await page.waitForSelector(".ask-dialog[open]");
await Promise.all([page.waitForURL(/\/patients$/, { waitUntil: "commit" }), page.keyboard.press("Enter")]);
await page.waitForSelector("#patients tbody tr");

// 17. 小児の分量：上田さん（4歳・18kg）の処方を Do すると、3つとも通常量の範囲内。量を増やすと上限超え
step("処方入力：小児の分量（体重当たり）");
await page.goto(`${BASE}/patient?id=4`);
await page.waitForSelector(selectedCard);
await doFromPatient(4);
await page.waitForSelector("#peds:not([hidden]) #peds-list li");
assert.match(await text("#peds-weight"), /5歳・体重 18\.0kg/);
assert.equal(await page.locator("#peds-list li.peds-ok").count(), 3);
assert.match(await text("#peds-list"), /カロナール細粒２０％[\s\S]*10mg\/kg\/回。通常量の範囲内/);
await page.fill('[data-field="qty"][data-r="1"][data-i="0"]', "9");
await page.locator('[data-field="qty"][data-r="1"][data-i="0"]').dispatchEvent("input");
await page.waitForSelector("#peds-list li.peds-over");
assert.match(await text("#peds-list li.peds-over"), /ワイドシリン細粒２０％[\s\S]*1日 100mg\/kg。上限の 90mg\/kg を超えています/);
