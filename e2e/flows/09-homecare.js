// 在宅
import assert from "node:assert/strict";
import { start, BASE, text, step } from "../lib.js";

const page = await start();

// 19. 在宅：予定（回数の上限）→ 記録（薬歴から報告書の形）→ 報告書の印刷
step("在宅：訪問の予定（週1回まで）・記録・報告書");
await page.goto(`${BASE}/homecare?month=2026-11`);
await page.waitForSelector("#home-list li");
assert.match(await text("#home-list"), /遠藤　和子[\s\S]*2 \/ 4回[\s\S]*計画書 2026\/10\/01/);
await page.keyboard.press("Alt+V");
await page.waitForSelector("#visit-dialog[open]");
assert.match(await text("#v-limit"), /月4回・週1回まで/);
await page.fill("#v-date", "2026-11-06"); // 11/5 と同じ週
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#visit-form [data-error="visitOn"]').textContent.includes("同じ週"));
await page.fill("#v-date", "2026-11-12");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#visit-dialog:not([open])", { state: "attached" });
await page.waitForFunction(() => /3 \/ 4回/.test(document.querySelector("#home-list").textContent)); // 保存の後、一覧を読み直すまで待つ
await page.click('.cal-day[data-date="2026-11-05"] .cal-visit');
await page.waitForSelector("#record-dialog[open]");
await page.fill("#r-storage", "カレンダーで管理");
await page.fill("#r-adherence", "飲み忘れなし");
await page.fill("#r-leftover", "なし");
await page.fill("#r-guidance", "便通の確認");
await page.locator("#r-guidance").focus();
await page.keyboard.press("Alt+G");
await page.waitForFunction(() => document.querySelector("#r-report").value.includes("【今後の方針・提案】"));
assert.match(await page.inputValue("#r-report"), /【服薬状況】飲み忘れなし[\s\S]*【患者・家族の訴え】/);
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#record-dialog:not([open])", { state: "attached" });
await page.waitForSelector('.cal-day[data-date="2026-11-05"] .cal-visit.done');
await page.goto(`${BASE}/homecare-print?kind=reports&month=2026-11&facility=home`);
await page.waitForSelector(".home-sheet");
assert.match(await text("#sheet"), /○○内科クリニック（架空）　山田　先生　御侍史[\s\S]*写し：介護支援専門員 佐々木 様[\s\S]*訪問薬剤管理指導 報告書[\s\S]*2026\/11\/05[\s\S]*【服薬状況】飲み忘れなし/);
