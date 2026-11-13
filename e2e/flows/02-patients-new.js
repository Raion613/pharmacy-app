// 新規患者登録
import assert from "node:assert/strict";
import { start, BASE, text, step } from "../lib.js";

const page = await start();

// 10. 新規患者登録（Alt+N）→ 誤りは項目ごとに出る → 直して登録
step("新規患者登録");
await page.goto(`${BASE}/patients`);
await page.waitForSelector("#patients tbody tr");
// 打つたびに登録済みの患者を探す（ひらがなのカナでも当たる）。生年月日まで同じなら赤で示す
await page.keyboard.press("Alt+N");
await page.keyboard.press("Tab");
await page.keyboard.type("あおき");
await page.waitForFunction(() => /名前の近い人が1人/.test(document.querySelector("#same-head").textContent));
assert.match(await text("#same-list"), /アオキ　マコト[\s\S]*青木　誠/);
await page.fill("#p-birth", "1958-06-14");
await page.waitForFunction(() => /生年月日も同じ 1人/.test(document.querySelector("#same-head").textContent));
await page.keyboard.press("Escape");
await page.waitForSelector("#patient-dialog:not([open])", { state: "attached" });
await page.keyboard.press("Alt+N");
await page.keyboard.type("試験　次郎");
await page.waitForFunction(() => /この名前の人はいません/.test(document.querySelector("#same-head").textContent));
await page.keyboard.press("Tab");
await page.keyboard.type("しけん　じろう");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector('[data-error="birthDate"]').textContent !== "");
assert.equal(await text('[data-error="sex"]'), "性別を選んでください");
await page.fill("#p-birth", "1980-02-29");
await page.locator('input[name="sex"][value="M"]').check();
await page.locator('input[name="burdenPercent"][value="30"]').check();
await Promise.all([page.waitForURL(/\/patient\?id=\d+$/), page.keyboard.press("Enter")]);
await page.waitForSelector("#band .name");
assert.match(await text("#band"), /シケン　ジロウ[\s\S]*試験　次郎[\s\S]*000008/);
