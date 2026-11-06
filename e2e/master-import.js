// マスター取込の画面の通し確認。npm run dev を起動した状態で npm run e2e:master（BROWSER=chrome で Chrome でも確かめる）
//   - 壊れたファイル・医薬品マスターでないファイルは、理由を出して最初の状態に戻る
//   - 送っている途中で通信が切れたら、作業を消して最初の状態に戻り、薬価マスタは変わらない
//   - 改定分を入れると、確認に変わる行が出て、反映すると「これから効く変更」に載り、その日から薬価が変わる
//   - 同じ内容をもう一度入れると「同じです」。Esc で中止できる
// 取り込むと手元の DB の薬価が変わるので、終わったら npm run db:reset で戻す（続けて流してもよい。毎回、今の金額 + 0.10円 にする）
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8788";
const CHANNEL = process.env.BROWSER === "chrome" ? "chrome" : "msedge";
const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1366, height: 768 } });
await context.addInitScript(() => {
  for (const k of ["login", "patients", "master"]) localStorage.setItem(`tour:${k}`, "3"); // tour.js の VERSION と揃える
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// 通信を切る確認で、わざと失敗させた要求のエラーは除く
page.on("console", (m) => { if (m.type() === "error" && !/ERR_FAILED|Failed to fetch|TypeError/.test(m.text())) errors.push(m.text()); });
const text = (sel) => page.locator(sel).innerText();
const step = (name) => console.log(`- ${name}`);
const imports = async () => (await (await page.request.get(`${BASE}/api/imports`)).json()).imports.length;
const price = async (date) => (await (await page.request.get(`${BASE}/api/prices?date=${date}&codes=612170710`)).json())["612170710"].priceSen;

// ファイルをドロップ先に落とす（画面の操作と同じ dragenter → dragover → drop）
async function dropFile(name, bytes) {
  await page.evaluate(([name, b64]) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([data], name));
    const drop = document.querySelector("#drop");
    for (const t of ["dragenter", "dragover", "drop"]) drop.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [name, Buffer.from(bytes).toString("base64")]);
}
// 改定分の変更行（42項目）。ノルバスク錠５ｍｇ（612170710）の金額を 12月1日から変える。ASCII だけなので Shift_JIS と同じバイト
const diffRow = (price) => ["5", "Y", "612170710", ...Array(8).fill(""), price, ...Array(17).fill(""), "20261201", ...Array(12).fill("")].join(",");

step(`ログイン（${CHANNEL}）`);
await page.goto(`${BASE}/login`);
await page.fill("#login-id", "demo");
await page.fill("#password", "pharmacy-demo");
await Promise.all([page.waitForURL(/\/patients$/), page.click("#login-form button[type=submit]")]);
await page.goto(`${BASE}/master`);
await page.waitForSelector("#import-rows tr");
const before = await imports();
const newSen = (await price("2026-12-01")) + 10;
const NEW_PRICE = `${Math.floor(newSen / 100)}.${String(newSen % 100).padStart(2, "0")}`;

step("壊れた ZIP は、理由を出して元に戻る");
const zip = new Uint8Array(readFileSync("data/raw/master/y_ALL20261013.zip"));
const broken = zip.slice();
broken.fill(0, 2000, 3000);
await dropFile("y_ALL20261013.zip", broken);
await page.waitForSelector("#file-status .notice-ng");
assert.match(await text("#file-status"), /ZIP ファイルが壊れています[\s\S]*薬価マスタは元のままです/);
assert.equal(await page.locator("#drop.loaded").count(), 0);

step("医薬品マスターでない CSV は、行番号付きで止める");
await dropFile("y_20261201.csv", new TextEncoder().encode("a,b,c\r\n"));
await page.waitForSelector("#file-status .notice-ng");
assert.match(await text("#file-status"), /1行目：項目が3個あります/);

step("送っている途中で通信が切れたら、作業を消して最初の状態に戻る");
let rowPosts = 0;
let deleted = false;
await page.route("**/api/imports/*/rows", (route) => (++rowPosts === 2 ? route.abort() : route.continue()));
page.on("request", (r) => { if (r.method() === "DELETE" && r.url().includes("/api/imports/")) deleted = true; });
await dropFile("y_ALL20261013.zip", zip);
await page.waitForSelector("#file-status .notice-ng", { timeout: 60000 });
assert.match(await text("#file-status"), /通信またはサーバーでエラーが発生しました[\s\S]*薬価マスタは元のままです/);
assert.equal(deleted, true, "送った分を消していない");
assert.equal(await page.locator("#preview .tiles").count(), 0);
assert.equal(await page.isDisabled("#commit"), true);
assert.equal(await imports(), before);
await page.unroute("**/api/imports/*/rows");

step("改定分を入れる → 確認に変わる行 → Ctrl+Enter で反映 → これから効く変更に載る");
await dropFile("y_20261201.csv", new TextEncoder().encode(`${diffRow(NEW_PRICE)}\r\n`));
await page.waitForSelector("#preview .tiles");
assert.equal(await page.inputValue("#published-on"), "2026-12-01");
assert.match(await text("#preview"), /履歴に書く行\s*1[\s\S]*うち、これから効く\s*1[\s\S]*2026\/12\/01（火）から 1品目[\s\S]*ノルバスク錠５ｍｇ/);
assert.equal(await page.evaluate(() => document.activeElement.id), "commit");
await page.keyboard.press("Control+Enter");
await page.waitForFunction((n) => document.querySelectorAll("#import-rows tr").length === n, before + 1);
assert.match(await text(".toasts"), /y_20261201\.csv を反映しました（薬価の履歴 1行）/);
assert.match(await text("#import-rows tr:first-child"), /2026\/12\/01[\s\S]*改定分[\s\S]*y_20261201\.csv[\s\S]*デモ 薬剤師/);
assert.match(await text("#upcoming-list"), /2026\/12\/01（火）から 薬価 1品目/);
assert.equal(await price("2026-11-30"), 1080);
assert.equal(await price("2026-12-01"), newSen);

step("同じ内容をもう一度入れると「同じです」。Esc で中止");
await dropFile("y_20261201.csv", new TextEncoder().encode(`${diffRow(NEW_PRICE)}\r\n`));
await page.waitForSelector("#preview .notice-ok");
deleted = false;
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.querySelector("#preview").children.length === 0);
assert.equal(deleted, true, "中止で作業を消していない");
assert.equal(await imports(), before + 1);

step("全件を入れ直しても、後から入れた12月1日の薬価は残る");
await dropFile("y_ALL20261013.zip", zip);
await page.waitForSelector("#preview .tiles", { timeout: 60000 });
assert.match(await text("#preview"), /取り込み済み（2026\/12\/01（火））より古い公表日[\s\S]*取り込み済みの内容と同じです/);
await page.keyboard.press("Control+Enter");
await page.waitForFunction((n) => document.querySelectorAll("#import-rows tr").length === n, before + 2);
await page.waitForFunction(() => document.activeElement.id === "pick"); // 反映の後始末が終わると「ファイルを選ぶ」に戻る
assert.equal(await price("2026-12-01"), newSen);

step("ドロップ以外に、ファイル選択（キーボード）でも読める");
await page.locator("#pick").focus();
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
await chooser.setFiles("data/raw/master/y_20261013.csv");
await page.waitForSelector("#preview .tiles");
assert.match(await text("#file-status"), /y_20261013\.csv[\s\S]*改定分/);
await page.keyboard.press("Escape");

assert.deepEqual(errors, [], "ブラウザのエラー");
await browser.close();
console.log("すべて通りました");
