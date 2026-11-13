// 受付状況：受付 → 処方入力 → 監査 → 投薬 → 会計 → 処方の訂正（宇野さん）
import assert from "node:assert/strict";
import { start, BASE, viaOverlay, text, step } from "../lib.js";

const page = await start();

// 18. 受付状況：受付 → 処方入力 → 調剤監査（バーコード）→ 投薬 → 会計
step("受付状況：受付（Alt+U）→ 処方入力 → 監査 → 投薬 → 会計");
await page.goto(`${BASE}/board`);
await page.waitForFunction(() => document.activeElement?.id === "reception-q");
await page.keyboard.type("うの");
await page.waitForSelector('#reception-suggest:not([hidden]) li[aria-selected="true"]');
await page.keyboard.press("Enter");
await page.waitForSelector(".col-received .board-card");
assert.match(await text(".col-received .board-card"), /宇野　健太[\s\S]*受付 \d\d:\d\d[\s\S]*0分待ち/);
assert.match(await page.evaluate(() => document.activeElement.textContent), /処方を入力/);
await viaOverlay("Enter", /^\/rx\?patient=5&reception=\d+$/);
await page.waitForSelector('[data-field="drug"]');
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#suggest:not([hidden]) li[aria-selected=true]");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("14");
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-entered .board-card");
await viaOverlay(() => page.click(".col-entered .board-card .btn-primary"), /^\/inspect\?id=/);
await page.waitForFunction(() => document.activeElement?.id === "scan-input");
assert.match(await text("#check-items"), /ノルバスク錠５ｍｇ[\s\S]*総量 14錠[\s\S]*まだ読んでいません/);
assert.equal(await page.locator("#save").isDisabled(), true);
// 監査の画面では負担割合・公費を変えられないので、帯は文字だけ
assert.equal(await page.locator("#band button").count(), 0);
// デモの「違う薬」は成分の違う薬（ノルバスク＝アムロジピンに対して、アムロジピンの別の銘柄を出さない）
assert.doesNotMatch(await page.locator("#demo-wrong button:has-text('違う薬')").innerText(), /アムロジピン|ノルバスク/);
// 違う薬の箱 → 赤。期限切れ → 赤。正しい箱 → チェック。読み取り機は文字と Enter を送る
await page.click("#demo-scan button:has-text('違う薬')");
await page.waitForSelector("#scan-log li.r-wrong");
await page.click("#demo-scan button:has-text('期限切れ')");
await page.waitForSelector("#scan-log li.r-expired");
await page.keyboard.type("(01)14987114335002(17)301231(10)E2E01"); // ノルバスク錠５ｍｇ ＰＴＰ 100錠（HOTコードマスター）
await page.keyboard.press("Enter");
await page.waitForSelector("#check-items li.done");
assert.match(await text("#check-items li.done"), /ＰＴＰ 100錠（10錠×10）・期限 2030-12-31・ロット E2E01/);
await page.keyboard.type("(01)14987114335003");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector("#scan-error").textContent.includes("チェックデジット"));
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-audited .board-card");
assert.match(await text(".toasts"), /調剤監査を保存しました（合わない読み取り 2件も記録）/);
// 投薬待ちの札：指導記録がまだなら「投薬した」は無く、「薬歴・指導記録」でこの来局を選んだ薬歴を開く（患者一覧から探さない）
assert.match(await text(".col-audited .board-card .bc-actions"), /お薬手帳[\s\S]*薬歴・指導記録/);
assert.equal(await page.locator(".col-audited .board-card [data-step]").count(), 0);
await viaOverlay(() => page.click(".col-audited .board-card .btn-primary"), /^\/patient\?id=\d+&rx=[^&]+&reception=\d+$/);
// 受付から開くと、いちばん新しい来局ではなく、その受付の来局が選ばれている
await page.waitForSelector('.visit-card[aria-selected="true"]');
await page.keyboard.press("Alt+K");
await page.waitForSelector("#record-dialog[open]");
const [ty, tm, td] = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).split("-");
assert.match(await text("#record-dialog-title"), new RegExp(`${ty}/${tm}/${td}`)); // 今日の来局
await page.keyboard.type("飲み忘れなし");
await page.locator('#record-form input[name="leftover"][value="none"]').check();
await page.locator("#soap-subjective").focus();
// 保存すると受付状況のその札へ戻り、「投薬した」にカーソルがある
await Promise.all([page.waitForURL(/\/board\?focus=\d+$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-audited .board-card [data-step=handed]");
assert.match(await text(".col-audited .board-card .bc-actions"), /薬歴[\s\S]*お薬手帳[\s\S]*投薬した/);
await page.waitForFunction(() => document.activeElement?.dataset.step === "handed");
await page.click(".col-audited .board-card .btn-primary");
await page.waitForSelector(".col-handed .board-card");
assert.match(await text(".col-handed .board-card .bc-actions"), /領収証・明細書[\s\S]*会計した/);
assert.equal(await page.evaluate(() => document.activeElement.textContent), "会計した");
await page.keyboard.press("Enter");
await page.waitForSelector(".col-paid .board-card");
assert.match(await text(".col-paid .board-card"), /入力 \d\d:\d\d → 監査 \d\d:\d\d → 投薬 \d\d:\d\d → 会計 \d\d:\d\d/);
assert.match(await text(".col-paid .board-card .bc-actions"), /薬歴[\s\S]*お薬手帳[\s\S]*領収証・明細書/); // 会計済みからも開き直せる
// 会計の後でも処方を直せる：1日量を変えると、札は監査待ちに戻り、受け取った額との差が出る。直す前の内容は薬歴の来局カードに残る
await viaOverlay(() => page.click(".col-paid .board-card a:has-text('処方を確認')"), /^\/rx\?patient=5&edit=[^&]+&reception=\d+$/);
await page.waitForFunction(() => document.activeElement?.dataset.field === "qty");
assert.match(await text("#do-note"), /変えると「直して保存」が押せます/);
assert.equal(await page.inputValue('[data-field="qty"]'), "1");
assert.equal(await page.locator("#save").isDisabled(), true); // 確かめるだけなら押せない
await page.keyboard.press("Control+a");
await page.keyboard.type("2");
assert.equal(await page.locator("#save").isDisabled(), false); // 変えたら押せる
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-entered .board-card .bc-settle");
assert.match(await text(".toasts"), /処方を直しました[\s\S]*窓口で追加 [\d,]+円を受け取る[\s\S]*調剤監査からやり直し/);
assert.match(await text(".col-entered .board-card .bc-settle"), /受け取り済み [\d,]+円 → 追加で [\d,]+円/);
await page.goto(`${BASE}/patient?id=5`);
await page.waitForSelector(".visit-card .vc-revisions");
assert.match(await text(".visit-card .vc-revisions"), /訂正[\s\S]*ノルバスク錠５ｍｇ 1日量 1 → 2[\s\S]*窓口 [\d,]+円 → [\d,]+円/);
await page.goto(`${BASE}/board`);
await page.waitForSelector(".col-entered .board-card");
// 受付の記録を消す：2回確かめる。2回目でやめれば消えない
const askOk = () => page.click("dialog.ask-dialog[open] button[type=submit]");
const cardCount = () => page.locator(".board-card").count();
const before = await cardCount();
await page.click(".col-entered .board-card .bc-delete");
await page.waitForSelector("dialog.ask-dialog[open]");
assert.match(await text("dialog.ask-dialog[open]"), /受付を削除しますか[\s\S]*処方・調剤監査・指導記録/);
await askOk();
await page.waitForFunction(() => document.querySelector("dialog.ask-dialog[open] .panel-head")?.textContent.includes("2回目"));
await page.click("dialog.ask-dialog[open] [data-cancel]");
await page.waitForSelector("dialog.ask-dialog[open]", { state: "detached" });
assert.equal(await cardCount(), before);
await page.click(".col-entered .board-card .bc-delete");
await askOk();
await page.waitForFunction(() => document.querySelector("dialog.ask-dialog[open] .panel-head")?.textContent.includes("2回目"));
await askOk();
await page.waitForFunction((n) => document.querySelectorAll(".board-card").length === n - 1, before);
assert.match(await text(".toasts"), /受付を削除しました/);
