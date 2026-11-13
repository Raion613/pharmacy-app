// e2e の各手順（e2e/flows/*.js）が使う共通の部品。流し方は e2e/run.js
// ブラウザは PC に入っている Edge を使う（Playwright のブラウザのダウンロードは不要）。
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

export const BASE = process.env.BASE_URL ?? "http://localhost:8789";
export const selectedCard = '#timeline .visit-card[aria-selected="true"]';
export const errors = [];
let browser;
let context;
let currentStep = ""; // いま流している手順（エラーに付ける）
export let page;

export async function launch() {
  browser = await chromium.launch({ channel: "msedge", headless: true });
}
export async function closeBrowser() {
  await browser.close();
}

export async function newPage({ toursSeen }) {
  if (context) await context.close();
  context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1366, height: 768 } });
  // 初回だけの紹介の PV（login-intro.js）は見終わった状態にしておく。起動の錠剤の演出は毎回出る（入力は妨げない）
  await context.addInitScript(() => localStorage.setItem("pv-seen", "1"));
  // 業務の流れを確かめる手順では、チュートリアルは見終わった状態にしておく
  if (toursSeen) {
    await context.addInitScript(() => {
      for (const k of ["login", "home", "patients", "patient", "rx", "drugs", "logs", "master", "board", "inspect", "homecare", "tracing", "stats", "messages", "account"]) localStorage.setItem(`tour:${k}`, "3"); // tour.js の VERSION と揃える
    });
  }
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${currentStep}：${e.message}`)); // どの手順で出たかを付けて集める
  page.on("dialog", (d) => d.accept()); // 保存していない入力があるときの「このページを離れますか」
  // 422（入力の誤り）と 401（多要素認証で違う6桁を入れる）は、確かめる手順で意図して出すので除く
  page.on("console", (m) => { if (m.type() === "error" && !/status of (422|401)/.test(m.text())) errors.push(`${currentStep}：${m.text()}`); });
  return page;
}

// 各手順の始まり。新しいブラウザの状態で開き、ログインしておく（ログインの画面の操作は 01 の手順で確かめる）
export async function start({ toursSeen = true, login = true } = {}) {
  await newPage({ toursSeen });
  if (login) {
    const res = await page.request.post(`${BASE}/api/login`, { data: { loginId: "demo", password: "pharmacy-demo" } });
    assert.equal(res.status(), 200, "ログインできない");
  }
  return page;
}

// 薬歴の操作（処方入力・トレーシングレポートなど）は、薬歴の上に重なる窓で開く。
// 窓に読み込んだ画面の URL を確かめ、続きはその画面を直接開いて操作する（窓そのものの動きは 14 の手順で確かめる）
export async function viaOverlay(action, pattern) {
  if (typeof action === "string") await page.keyboard.press(action);
  else await action();
  await page.waitForFunction(() => document.querySelector("dialog.overlay[open] iframe")?.src.includes("embed=1"));
  const src = new URL(await page.locator("dialog.overlay iframe").evaluate((f) => f.src));
  src.searchParams.delete("embed");
  assert.match(src.pathname + src.search, pattern);
  await page.goto(src.href);
}

// 前回の処方を写す：薬歴から処方入力を開き（Alt+N）、処方入力で Alt+D（いちばん新しい来局の処方を写す）
export async function doFromPatient(id) {
  await viaOverlay("Alt+N", new RegExp(`^/rx\\?patient=${id}$`));
  await page.waitForFunction(() => document.activeElement?.dataset.field === "drug");
  await Promise.all([page.waitForURL(/from=/), page.keyboard.press("Alt+D")]);
}

export const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return { id: el.id, field: el.dataset.field ?? null, r: el.dataset.r ?? null, i: el.dataset.i ?? null, tag: el.tagName };
});
// 処方入力の点数・会計はサーバーが計算して返す（入力から結果が届くまで body[data-calc="pending"]）。読む前に届くのを待つ
export const settled = () => page.waitForFunction(() => document.body.dataset.calc !== "pending");
export const text = async (sel) => {
  await settled();
  return page.locator(sel).innerText();
};
export const step = (name) => { currentStep = name; console.log(`  - ${name}`); };

// 無音の WAV（録音ファイルの読み込みを試す。長さだけが使われる）
export function silentWav(seconds) {
  const rate = 8000;
  const data = rate * seconds * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}
