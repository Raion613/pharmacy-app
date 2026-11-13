// 薬価照会・採用薬・マスター取込の一覧
import assert from "node:assert/strict";
import { start, BASE, focused, text, step } from "../lib.js";

const page = await start();

// 11. 薬価照会：基準日に効いている薬価の行を強調する
step("薬価照会");
await page.goto(`${BASE}/drugs`);
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#drugs tbody tr");
await page.keyboard.press("Enter");
await page.waitForSelector(".history tr.current");
assert.match(await text(".history tr.current"), /2026\/04\/01/);
assert.match(await text(".history"), /−2\.90円/);
// 採用薬は、同じ成分の銘柄の中で一番上に出る。Alt+A で外す・付ける
await page.keyboard.press("/");
await page.keyboard.type("ろすばすたちん");
await page.waitForFunction(() => /ロスバスタチン錠２．５ｍｇ「サワイ」/.test(document.querySelector("#drugs tbody tr")?.textContent ?? ""));
assert.match(await text("#drugs tbody tr:first-child"), /採用/);
await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => /ロスバスタチン錠２．５ｍｇ「サワイ」/.test(document.querySelector(".drug-title")?.textContent ?? ""));
await page.keyboard.press("Alt+A");
await page.waitForFunction(() => /採用薬にする/.test(document.querySelector("#adopt")?.textContent ?? ""));
assert.doesNotMatch(await text("#drugs tbody tr:first-child"), /採用/);
await page.keyboard.press("Alt+A");
await page.waitForFunction(() => /採用薬から外す/.test(document.querySelector("#adopt")?.textContent ?? ""));

await page.goto(`${BASE}/master`);
// 11-3. マスター取込の画面：取り込み済みのマスターと、これから効く変更（11月1日から）
step("マスター取込：取り込み済みの一覧");
await page.waitForSelector("#import-rows tr");
assert.match(await text("#import-rows tr:first-child"), /2026\/09\/11[\s\S]*調剤行為 全件[\s\S]*m20260911\.csv[\s\S]*初期データ/);
assert.match(await text("#import-rows"), /2026\/10\/13[\s\S]*医薬品 全件[\s\S]*y_ALL20261013\.zip/);
assert.equal((await focused()).id, "pick");
