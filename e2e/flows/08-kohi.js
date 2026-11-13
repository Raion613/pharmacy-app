// 公費・引き継ぎのチェックリスト（佐藤さん）
import assert from "node:assert/strict";
import { start, BASE, selectedCard, text, step } from "../lib.js";

const page = await start();

// 18-2. 公費：帯の「公費」から受給者証を足す → 処方入力の会計に公費の行が出て、管理票の累計で月の上限まで止まる → 領収証と管理票
step("公費：受給者証を足す → 会計で月の上限まで → 領収証・管理票。薬歴の引き継ぎのチェックリスト");
await page.goto(`${BASE}/patient?id=2`);
await page.waitForSelector("#band [data-kohi]");
assert.equal(await text("#band [data-kohi]"), "なし");
await page.click("#band [data-kohi]");
await page.waitForSelector("#kohi-dialog[open]");
await page.selectOption("#k-kind", "nanbyo");
await page.fill("#k-payer", "54200012");
await page.fill("#k-recipient", "7654321");
await page.fill("#k-from", "2026-04-01");
await page.fill("#k-until", "2027-03-31");
await page.fill("#k-cap", "10000");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelectorAll(".kohi-list tbody tr").length === 1);
assert.match(await text(".kohi-list tbody"), /指定難病[\s\S]*54200012[\s\S]*2割・月 10,000円 まで/);
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.querySelector("#band [data-kohi]").textContent === "難病");
await page.goto(`${BASE}/rx?patient=2`);
await page.waitForSelector("#bill-kohi .kohi-row");
await page.waitForFunction(() => document.activeElement?.dataset.field === "drug");
await page.keyboard.press("Alt+D");
await page.waitForURL(/from=/);
await page.waitForFunction(() => document.querySelector("#bill-charge").textContent !== "—");
const copay = Number((await text("#bill-copay")).replace(/[^\d]/g, ""));
const kohiPay = Number((await text('#bill-kohi [data-kohi-pay]')).replace(/（.*$/, "").replace(/[^\d]/g, ""));
assert.ok(kohiPay < copay, `難病の2割（${kohiPay}円）が3割の一部負担金（${copay}円）より少ない`);
await page.fill("#bill-kohi [data-kohi-prior]", "9950");
await page.waitForFunction(() => document.querySelector("#bill-kohi [data-kohi-pay]").textContent.startsWith("50円（今月の累計 10,000円）"));
assert.match(await text("#bill-charge"), /^50円$/);
await Promise.all([page.waitForURL(/\/patient\?id=2/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(selectedCard);
assert.match(await text(selectedCard), /窓口 50円/);
// 引き継ぎのチェックリスト：どの項目も押して付ける
assert.match(await text("#handover"), /引き継ぎ 0\/\d/);
await page.click('#handover [data-check="cautions"]');
await page.waitForSelector('#handover [data-check="cautions"][aria-pressed="true"]');
assert.match(await text("#handover"), /引き継ぎ 1\/\d/);
await page.click('#handover [data-check="soa"]');
await page.waitForSelector('#handover [data-check="soa"][aria-pressed="true"]');
assert.match(await text("#handover"), /引き継ぎ 2\/\d/);
const rxId2 = await page.evaluate(async () => (await (await fetch("/api/patients/2")).json()).prescriptions[0].id);
await page.goto(`${BASE}/receipt?id=${rxId2}`);
await page.waitForSelector(".kanrihyo");
assert.match(await text(".r-money"), /指定難病の後の負担額[\s\S]*50円[\s\S]*領収額 合計[\s\S]*50円/);
assert.match(await text(".kanrihyo"), /指定難病[\s\S]*7654321[\s\S]*50円[\s\S]*10,000円[\s\S]*10,000円/);
