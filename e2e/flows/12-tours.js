// チュートリアル（何も見ていないブラウザで）
import assert from "node:assert/strict";
import { start, BASE, focused, text, step } from "../lib.js";

const page = await start({ toursSeen: false, login: false });

// ---------- チュートリアル ----------
// 新しいブラウザ（何も見ていない状態）で、各画面を初めて開いたときに一度だけ出ることを確かめる
const tourOpen = () => page.locator(".tour.open").count().then((n) => n === 1);
const tourCount = () => text(".tour-count");
const waitTourClosed = () => page.waitForFunction(() => !document.querySelector(".tour"));
// 穴（明るく残す枠）が、説明している部品をちゃんと囲っているか（動きが止まってから測る）
async function holeCovers(selector) {
  await page.waitForTimeout(550);
  return page.evaluate((sel) => {
    const h = document.querySelector(".tour-hole").getBoundingClientRect();
    const t = document.querySelector(sel).getBoundingClientRect();
    return h.left <= t.left + 1 && h.top <= t.top + 1
      && h.right >= Math.min(t.right, innerWidth) - 1 && h.bottom >= Math.min(t.bottom, innerHeight) - 1;
  }, selector);
}
// 吹き出しが画面の外にはみ出していないか（動きが止まってから測る）
async function cardInside() {
  await page.waitForTimeout(550);
  return page.evaluate(() => {
    const c = document.querySelector(".tour-card").getBoundingClientRect();
    return c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight;
  });
}
// 「次へ」ボタンで最後まで送る。手順ごとに吹き出しが画面内にあることも確かめる
async function clickThrough() {
  for (;;) {
    const label = await tourCount();
    assert.ok(await cardInside(), `吹き出しが画面外（${label}）`);
    const [now, total] = label.split(" / ").map(Number);
    assert.equal(await text(".tour-next"), now === total ? "閉じる" : "次へ");
    await page.click(".tour-next");
    if (now === total) break;
    await page.waitForFunction((n) => document.querySelector(".tour-count").textContent.startsWith(`${n} /`), now + 1);
  }
  await waitTourClosed();
}
const nextStep = async (label) => {
  await page.click(".tour-next");
  await page.waitForFunction((l) => document.querySelector(".tour-count").textContent === l, label);
};

step("チュートリアル：ログイン画面で自動で出る・ボタン以外では進まない・戻る・Esc");
await page.goto(`${BASE}/login`);
await page.waitForSelector(".tour.open");
assert.equal(await tourCount(), "1 / 4");
assert.match(await text("#tour-title"), /ようこそ/);
assert.equal(await page.locator(".tour-hint").count(), 0, "「どこをクリックしても」の案内は出さない");
await page.mouse.click(30, 30);           // 暗い所をクリックしても
await page.keyboard.press("ArrowRight");  // → を押しても
await page.waitForTimeout(400);
assert.equal(await tourCount(), "1 / 4", "ボタン以外で進んだ");
await nextStep("2 / 4");
assert.ok(await holeCovers(".demo-note"), "穴がデモ用アカウントの枠を囲っていない");
await page.click(".tour-prev");
assert.equal(await tourCount(), "1 / 4");
await page.keyboard.press("Escape");
await waitTourClosed();
await page.reload();
await page.waitForSelector("#login-form");
await page.waitForTimeout(300);
assert.equal(await tourOpen(), false, "一度見たら、もう自動では出ない");
await page.click("#tour-button");
await page.waitForSelector(".tour.open");
// 「次へ」にフォーカスがあるので、Enter はそのボタンを押したことになる
for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");
await waitTourClosed();
assert.equal((await focused()).id, "tour-button", "閉じたらフォーカスを元の場所に戻す");
// 起動の演出をもう一度：モーションから（錠剤が入力欄の印に収まる）・PV から（スキップすると錠剤の動きからログイン画面へ）
await page.click("#replay-motion");
await page.waitForSelector(".intro-sheet");
await page.waitForFunction(() => !document.querySelector(".intro-sheet, .intro-tablet") && !document.documentElement.classList.contains("login-intro"));
await page.waitForSelector("#replay-pv:not([disabled])"); // 流している間は押せない
await page.click("#replay-pv");
await page.waitForSelector(".pv-first iframe");
await page.click(".pv-skip");
await page.waitForSelector(".intro-sheet");
await page.waitForFunction(() => !document.querySelector(".pv-first, .intro-sheet, .intro-tablet") && !document.documentElement.classList.contains("login-intro"));

step("チュートリアル：患者一覧（表示中は画面のショートカットが効かない）");
await page.goto(`${BASE}/login?next=%2Fpatients`); // ログインした後の最初の画面は受付状況なので、患者一覧を指定して入る
await page.waitForFunction(() => !document.querySelector(".pv-first, .intro-sheet, .intro-tablet") && !document.documentElement.classList.contains("login-intro"));
await page.fill("#login-id", "demo");
await page.fill("#password", "pharmacy-demo");
await Promise.all([page.waitForURL(/\/patients$/), page.click("#login-form button[type=submit]")]);
await page.waitForSelector(".tour.open");
await page.keyboard.press("Alt+N");
assert.equal(await page.locator("#patient-dialog[open]").count(), 0, "チュートリアル中に Alt+N で登録画面が開いた");
await nextStep("2 / 5");
assert.ok(await holeCovers(".sidebar"));
await clickThrough();
assert.equal((await focused()).id, "q", "閉じたら検索欄にカーソルが戻る");

step("チュートリアル：右上のボタンで再生");
await page.click("#tour-button");
await page.waitForSelector(".tour.open");
assert.equal(await tourCount(), "1 / 5");
// 「チュートリアルのボタンでもう一度見られる」という手順は、どの画面にも置かない
assert.equal(await page.locator(".tour-card").evaluate(() => document.body.innerHTML.includes("もう一度見るには")), false);
await page.keyboard.press("Escape");
await waitTourClosed();

step("チュートリアル：薬歴・処方入力・薬価照会・閲覧記録・マスター取込");
const rxId = await page.evaluate(async () => (await (await fetch("/api/patients/7")).json()).prescriptions[0].id);
for (const [url, ready, firstTarget] of [
  ["/patient?id=1", "#timeline .visit-card", "#band"],
  ["/rx?patient=1", '[data-field="drug"]', "#band-alerts"],
  ["/drugs", "#q", ".search-head"],
  ["/logs", "#rows tr", ".logs .grid thead"],
  ["/master", "#import-rows tr", "#history"],
  ["/board", "#board .board-col", ".reception-search"],
  ["/inspect?id=" + rxId, "#check-items li", ".inspect-items"],
  ["/homecare?month=2026-11", "#home-list li", "#home-patients"],
  ["/tracing?patient=3", "#t-adherence", "#fill"],
  ["/messages", "#threads li", ".threads"],
  ["/stats", ".chart svg", "#charts"],
  ["/home", "#feed .post", "#compose"],
]) {
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector(ready);
  await page.waitForSelector(".tour.open");
  await nextStep(`2 / ${(await tourCount()).split(" / ")[1]}`);
  assert.ok(await holeCovers(firstTarget), `${url}: 穴が ${firstTarget} を囲っていない`);
  await clickThrough();
  await page.reload();
  await page.waitForSelector(ready);
  await page.waitForTimeout(300);
  assert.equal(await tourOpen(), false, `${url}: 二度目も出た`);
}
