// 重なる窓
import assert from "node:assert/strict";
import { start, BASE, selectedCard, text, step } from "../lib.js";

const page = await start();

step("重なる窓：Esc・×・ブラウザの戻る/進むで閉じたり開いたりする。窓の中で処方を保存すると、薬歴が保存した来局を選んで開き直す");
await page.goto(`${BASE}/patient?id=1`);
await page.waitForSelector(selectedCard);
assert.match(await text("#subject"), /青木　誠/);
await page.locator("#timeline").focus();
await page.keyboard.press("Alt+N");
await page.waitForSelector("dialog.overlay[open]");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent === "処方入力");
const inFrame = page.frameLocator("dialog.overlay iframe");
await inFrame.locator('[data-field="drug"]').first().waitFor();
assert.equal(await inFrame.locator(".sidebar").isHidden(), true); // 窓の中では左のメニューを出さない
await page.keyboard.press("Escape");                               // 窓の中にフォーカスがあっても Esc で閉じる
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
assert.match(page.url(), /\/patient\?id=1$/);
// 選んだ来局の領収証・お薬手帳・調剤監査も薬歴から開き直せる
await page.click("#to-receipt");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent.startsWith("領収証"));
await page.click(".overlay-close");
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.click("#to-handbook");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent.startsWith("お薬手帳"));
await page.click(".overlay-close");
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.click("#to-inspect");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent.startsWith("調剤監査"));
await page.click(".overlay-close");
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.click("#to-tracing");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent === "トレーシングレポート");
await page.click(".overlay-close");
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.goForward();                                             // 進むで、閉じた窓がまた開く
await page.waitForSelector("dialog.overlay[open]");
await page.goBack();                                                // 戻るで閉じる
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.keyboard.press("Alt+N");
await page.waitForSelector("dialog.overlay[open]");
await inFrame.locator('[data-field="drug"]').first().waitFor();
await page.waitForFunction(() => document.querySelector("dialog.overlay iframe").contentDocument.activeElement?.dataset.field === "drug");
await page.keyboard.press("Alt+D");
await page.waitForFunction(() => document.querySelector("dialog.overlay iframe").contentWindow.location.search.includes("from="));
await inFrame.locator('[data-field="drug"]').first().waitFor();
await page.waitForFunction(() => document.querySelector("dialog.overlay iframe").contentDocument.querySelector("#total").textContent !== "—");
await Promise.all([page.waitForURL(/\/patient\?id=1&saved=/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector('#timeline .visit-card.saved[aria-selected="true"]');
assert.equal(await page.locator("dialog.overlay[open]").count(), 0);
