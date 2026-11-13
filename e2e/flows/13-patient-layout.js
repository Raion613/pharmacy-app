// 薬歴の配置・メモ帳
import assert from "node:assert/strict";
import { start, BASE, selectedCard, text, step } from "../lib.js";

const page = await start();

// ---------- 薬歴の配置を変える ----------
step("薬歴：配置を変える（ほかの箱の上へ動かすと割り込んで押し出す・角で幅を変える・保存 → 開き直しても同じ・初期に戻す）。経過・処方の推移の並べ方");
await page.goto(`${BASE}/patient?id=1`);
await page.waitForSelector(selectedCard);
// どの箱も中身が切れていない（箱の中で縦にスクロールさせない）
assert.equal(await page.evaluate(() => [...document.querySelectorAll(".pbox")].every((b) => b.scrollHeight <= b.clientHeight + 1)), true);
const order = () => page.evaluate(() => [...document.querySelectorAll("[data-box]")].sort((a, b) => a.style.order - b.style.order).map((el) => el.dataset.box));
assert.deepEqual(await order(), ["patient", "cautions", "next", "meds", "labs", "memo", "other", "matrix", "history"]);
await page.click("#layout-edit");
// 「今の処方」の見出しを「患者」の左半分へ → 先頭に割り込み、患者以降が後ろへ押し出される
const medsHead = await page.locator('[data-box="meds"] .pbox-head').boundingBox();
const patientBox = await page.locator('[data-box="patient"]').boundingBox();
await page.mouse.move(medsHead.x + 20, medsHead.y + medsHead.height / 2);
await page.mouse.down();
await page.mouse.move(patientBox.x + 10, patientBox.y + patientBox.height / 2); // 途中の箱に割り込まないよう、まっすぐ動かす
await page.mouse.up();
assert.deepEqual(await order(), ["meds", "patient", "cautions", "next", "labs", "memo", "other", "matrix", "history"]);
// 右下の角で「患者」を3列に広げる
const handle = await page.locator('[data-box="patient"] .pbox-resize').boundingBox();
const colWidth = (await page.locator("#pt-grid").boundingBox()).width / 12;
await page.mouse.move(handle.x + 11, handle.y + 11);
await page.mouse.down();
await page.mouse.move(handle.x + 11 + colWidth, handle.y + 11, { steps: 6 });
await page.mouse.up();
assert.equal(await page.locator('[data-box="patient"]').evaluate((el) => el.style.gridColumn), "span 3");
await page.click("#layout-edit"); // 完了で保存
await page.waitForFunction(() => document.querySelector(".toasts")?.textContent.includes("配置を保存しました"));
// 経過の並べ方：2段の帯（列の数 ＝ 来局の数 ÷ 2 の切り上げ）
await page.click('#history-shape [data-rows="2"]');
const visits = await page.locator("#timeline .visit-card").count();
assert.equal(await page.locator("#timeline").evaluate((el) => el.classList.contains("band") && el.style.gridTemplateColumns), `repeat(${Math.ceil(visits / 2)}, 340px)`);
// 処方の推移の並べ方：初めは折り返し（表を分けても横にはみ出さない）。「横に送る」に切り替えられる
await page.waitForSelector("#matrix-view.folded .matrix-part");
assert.equal(await page.locator("#matrix-view").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
const layoutSaved = () => page.waitForResponse((r) => r.url().includes("/api/layouts/") && r.request().method() === "PUT");
await Promise.all([layoutSaved(), page.click('#matrix-shape [data-fold="0"]')]); // 押した時点で保存する。保存が届く前に読み直さない
await page.waitForFunction(() => !document.querySelector("#matrix-view").classList.contains("folded"));
await page.reload();
await page.waitForSelector(selectedCard);
await page.waitForFunction(() => document.querySelector('[data-box="meds"]').style.order === "0");
assert.equal(await page.locator('[data-box="patient"]').evaluate((el) => el.style.gridColumn), "span 3");
assert.equal(await page.getAttribute('#history-shape [data-rows="2"]', "aria-checked"), "true");
assert.equal(await page.getAttribute('#matrix-shape [data-fold="0"]', "aria-checked"), "true");
await page.click("#layout-edit");
await page.click("#layout-reset");
await page.waitForFunction(() => document.querySelector('[data-box="patient"]').style.order === "0");
assert.equal(await page.getAttribute('#history-shape [data-rows="0"]', "aria-checked"), "true");
assert.equal(await page.getAttribute('#matrix-shape [data-fold="1"]', "aria-checked"), "true");

step("メモ帳：薬歴で Alt+E で書く → 開き直しても残る → 処方入力の画面でも同じものが開く");
await page.locator("#timeline").focus();
await page.keyboard.press("Alt+E");
await page.waitForSelector(".memo-dialog[open]");
await page.keyboard.type("妻と二人暮らし。娘さんが月1回来る");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(".memo-dialog:not([open])", { state: "attached" });
assert.match(await text("#memo"), /妻と二人暮らし。娘さんが月1回来る/);
assert.match(await text("#memo-meta"), /デモ 薬剤師/);
await page.goto(`${BASE}/rx?patient=1`);
await page.waitForSelector('[data-field="drug"]');
await page.keyboard.press("Alt+E");
await page.waitForSelector(".memo-dialog[open]");
assert.equal(await page.inputValue(".memo-dialog textarea"), "妻と二人暮らし。娘さんが月1回来る");
await page.keyboard.press("Escape");
