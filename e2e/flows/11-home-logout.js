// 回覧板・ログアウト
import assert from "node:assert/strict";
import { start, BASE, text, step } from "../lib.js";

const page = await start();

await page.goto(`${BASE}/patients`);
await page.waitForSelector("#patients tbody tr");

// 回覧板：左上の「薬」（Alt+0）。まだ確認していない投稿に印。書く（種類は←→）→ Ctrl+Enter。確認したら印が消える
step("回覧板：Alt+0 で開く → 申し送りを書く → 確認した → 左上の印が消える");
await page.waitForSelector("#unread-dot:not([hidden])");
await Promise.all([page.waitForURL(/\/home$/), page.keyboard.press("Alt+0")]);
await page.waitForSelector("#feed .post");
assert.equal(await page.locator(".sidebar a.mark").getAttribute("aria-current"), "page");
assert.equal(await page.locator("#feed .post.unread").count(), 2); // 広報（本部）と、佐藤さんの相談
assert.match(await text("#hello-sub"), /まだ確認していない回覧が 2件/);
await page.locator("#compose-body").focus();
await page.keyboard.type("午後の方へ：分包紙を補充しました");
await page.keyboard.press("Tab");
await page.keyboard.press("ArrowRight"); // 申し送り → 報告
assert.equal(await page.locator('#compose-kinds [aria-checked="true"]').innerText(), "報告");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#feed .post.arrive");
assert.match(await text("#feed .post:first-child"), /デモ 薬剤師[\s\S]*報告[\s\S]*午後の方へ：分包紙を補充しました[\s\S]*デモが確認[\s\S]*1\/2[\s\S]*確認済み/);
assert.equal(await page.inputValue("#compose-body"), "");
for (let i = 0; i < 2; i++) {
  await page.locator("#feed .read-btn[data-read]").first().focus();
  await page.keyboard.press("Enter");
}
await page.waitForSelector("#unread-dot[hidden]", { state: "attached" });
assert.match(await text("#hello-sub"), /ぜんぶ確認済み/);
await page.reload();
await page.waitForSelector("#feed .post");
assert.equal(await page.locator("#feed .post.unread").count(), 0, "確認したことが保存されている");
assert.equal(await page.locator("#unread-dot").isHidden(), true);

// 12. ログアウトしたら API も画面も見えない
step("ログアウト");
await page.click("#logout");
await page.waitForURL(/\/login$/);
const res = await page.request.get(`${BASE}/api/patients`);
assert.equal(res.status(), 401);
