// 多要素認証（設定 → ログインで6桁 → 無効に戻す）
import assert from "node:assert/strict";
import { hotp, stepOf } from "../../src/server/totp.js";
import { start, BASE, text, step } from "../lib.js";

const page = await start();

// ---------- 多要素認証（最後に。終わったら無効に戻す） ----------
step("多要素認証：設定 → ログインで6桁を求める → 無効にする");
await page.goto(`${BASE}/account`);
await page.click("#begin");
await page.waitForSelector(".qr svg");
const secret = (await text(".secret")).replace(/\s/g, "");
const code = (offset) => hotp(secret, stepOf(Date.now()) + offset);
await page.fill("#code", "000000");
await page.click("#confirm-form button");
await page.waitForFunction(() => document.querySelector("#code-error").textContent !== "");
const setupCode = await code(0); // 30秒の区切りをまたいでも同じ数字を使い回せるよう、文字列で持っておく
await page.fill("#code", setupCode);
await page.click("#confirm-form button");
await page.waitForFunction(() => document.querySelector("#mfa-state").textContent === "有効");
await page.click("#logout");
await page.waitForURL(/\/login$/);
await page.fill("#login-id", "demo");
await page.fill("#password", "pharmacy-demo");
await page.click("#login-form button[type=submit]");
await page.waitForSelector("#mfa-form:not([hidden])");
assert.equal((await page.request.get(`${BASE}/api/patients`)).status(), 401, "6桁を入れる前に入れてしまう");
await page.fill("#mfa-code", setupCode); // 設定で使った数字は使い回せない
await page.click("#mfa-form button");
await page.waitForSelector("#mfa-error:not([hidden])");
await Promise.all([page.waitForURL(/\/board$/), (async () => { await page.fill("#mfa-code", await code(1)); await page.click("#mfa-form button"); })()]);
// 無効にするには、さらに次の区切りの数字が要る（同じ数字は使えない）。次の30秒になるまで待つ
await page.waitForTimeout(30000 - (Date.now() % 30000) + 500);
await page.goto(`${BASE}/account`);
await page.waitForSelector("#disable-form");
await page.fill("#code", await code(1));
await page.click("#disable-form button");
await page.waitForFunction(() => document.querySelector("#mfa-state").textContent === "未設定");
