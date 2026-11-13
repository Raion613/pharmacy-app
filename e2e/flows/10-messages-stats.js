// つながる薬局・薬局の数字
import assert from "node:assert/strict";
import { start, BASE, text, step } from "../lib.js";

const page = await start();

// 20. つながる薬局：受信（デモ）→ 返信 → 薬歴の要点に出る
step("つながる薬局：受信と返信");
await page.goto(`${BASE}/messages?patient=2`);
await page.waitForSelector("#chat-log li");
assert.match(await text("#chat-log"), /前にもらった薬の名前を教えてください[\s\S]*ロキソニン錠60mgをお渡ししています/);
await page.fill("#reply-body", "受け取りは何時ごろになりますか");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelectorAll("#chat-log li").length === 3);
await page.fill("#receive-q", "おの");
// 「おの」で絞り込んだ結果が届くまで待つ（候補の欄は検索が届くまで空か、前の候補のまま）
await page.waitForFunction(() => {
  const options = [...document.querySelector("#receive-patient").options];
  return options.length > 0 && options.every((o) => o.text.includes("小野寺"));
});
await page.fill("#receive-body", "血圧の薬を1日飲み忘れました");
await page.click("#receive-form button[type=submit]");
await page.waitForFunction(() => document.querySelector("#chat-head").textContent.includes("小野寺"));

// 21. 薬局の数字
step("薬局の数字（処方箋単価・後発医薬品の使用割合）");
await page.goto(`${BASE}/stats`);
await page.waitForSelector(".chart svg");
assert.equal(await page.locator(".chart").count(), 3);
assert.match(await text("#table"), /2026年10月\s*4\s*[\d,]+円[\s\S]*\d+\.\d%/);
