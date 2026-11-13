// 選定療養・残薬調整と疑義照会・領収証・お薬手帳（加藤さん）
import assert from "node:assert/strict";
import { start, BASE, selectedCard, doFromPatient, text, step } from "../lib.js";

const page = await start();

// 11-2. 長期収載品の選定療養：（選）のコードの薬は、保険の薬剤料とは別に特別の料金が出る
step("選定療養：薬歴に特別の料金、前回Do で入力中にも特別の料金");
await page.goto(`${BASE}/patient?id=7`);
await page.waitForSelector(selectedCard);
// ロキソニン（選）10.65円 × 3 + ムコスタ 10.80円 × 3 = 64.35円 → 6点 × 14日 = 84点。
// 特別の料金：価格差 0.15円 × 3 = 0.45円 → 1点 × 14日 = 14点 → 140円 + 消費税 = 154円
assert.match(await text(selectedCard), /2026\/10\/22[\s\S]*薬剤料 84点[\s\S]*特別の料金 154円[\s\S]*ロキソニン錠６０ｍｇ（選）/);
await doFromPatient(7);
await page.waitForFunction(() => document.querySelector("#bill-special").textContent === "154円");
assert.equal(await text("#total"), "84点");
assert.match(await text('tr.item[data-r="0"][data-i="0"] .drug-meta'), /選定療養（患者希望）[\s\S]*価格差 0\.15円\/錠/);
// 11-2-2. 残薬調整：調剤した日数を減らし、Alt+Q で疑義照会の窓を開いて書くと、その剤の下に1行出て、加算が会計に入る。Alt+H で処方箋の記載を別に書ける
step("残薬調整（日数を減らす・Alt+Q で疑義照会の窓）と、処方箋と違う薬（Alt+H）");
await page.fill("#disp-days-0", "7");
await page.locator("#disp-days-0").dispatchEvent("input");
await page.waitForSelector("#days-change-0:not([hidden])");
await page.locator("#disp-days-0").focus();
await page.keyboard.press("Alt+Q"); // カーソルのある剤（Rp1）について
await page.waitForSelector("#inquiry-dialog[open]");
await page.waitForFunction(() => document.activeElement.id === "inq-content");
assert.match(await page.locator("#inq-target option:checked").textContent(), /^Rp1 全体/);
await page.keyboard.type("ロキソニンが7日分残っている。14日分を7日分に減らしてよいか");
await page.keyboard.press("Tab");
await page.keyboard.type("7日分で可");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#inquiry-dialog:not([open])", { state: "attached" });
await page.waitForFunction(() => document.activeElement.id === "disp-days-0"); // 窓を閉じたら元の欄へ戻る
const inqLine = '.rp-edit[data-r="0"] .inq-line';
assert.match(await text(inqLine), /残薬調整[\s\S]*Rp1 全体[\s\S]*14日分を7日分に減らしてよいか[\s\S]*7日分で可[\s\S]*処方変更あり/);
await page.waitForFunction(() => document.querySelector("#bill-lines").textContent.includes("調剤時残薬調整加算ニ"));
// 行を押すと直せる：対象を剤の中の薬に変える
await page.click(inqLine);
await page.waitForSelector("#inquiry-dialog[open]");
assert.equal(await text("#inquiry-title"), "疑義照会を直す");
await page.selectOption("#inq-target", "0-0");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#inquiry-dialog:not([open])", { state: "attached" });
assert.match(await text(inqLine), /ロキソニン錠６０ｍｇ（選）/);
await page.locator('[data-field="drug"][data-r="0"][data-i="0"]').focus();
await page.keyboard.press("Alt+H");
await page.waitForSelector('.rx-row [data-field="rxName"]');
assert.equal(await page.inputValue('.rx-row [data-field="rxName"]'), "【般】ロキソプロフェンＮａ錠６０ｍｇ");
await page.goto(`${BASE}/patient?id=7`);
await page.waitForSelector(selectedCard);

// 11-2-3. 領収証・明細書とお薬手帳（紙に貼る内容と、電子版の QR コード）
step("領収証・明細書、お薬手帳（JAHIS の QR コード）");
const rxId = await page.locator(selectedCard).getAttribute("data-id");
await page.goto(`${BASE}/receipt?id=${rxId}`);
await page.waitForSelector(".receipt");
const receipt = await text(".receipt");
assert.match(receipt, /領　収　証[\s\S]*加藤　真一 様[\s\S]*269点/);
assert.match(receipt, /保険　負担額\s*810円/);
assert.match(receipt, /長期収載品の選定療養に係る特別の料金\s*154円（うち消費税 14円）/);
assert.match(receipt, /領収額 合計\s*964円/);
assert.match(await text(".statement"), /調剤基本料１[\s\S]*服薬管理指導料２（ロ）[\s\S]*ロキソニン錠６０ｍｇ（選）[\s\S]*調剤物価対応料/);
await page.goto(`${BASE}/handbook?id=${rxId}`);
await page.waitForSelector(".qr svg");
assert.match(await text(".sticker"), /2026\/10\/22[\s\S]*ロキソニン錠６０ｍｇ（選）\s*3錠[\s\S]*【1日3回毎食後】 14日分/);
assert.match(await page.locator(".raw pre").textContent(), /^JAHISTC03,1\r?\n[\s\S]*201,1,ロキソニン錠６０ｍｇ（選）,3,錠,2,670098801,1/);
