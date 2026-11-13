// 検査値・指導記録（録音・下書き・テンプレート）・トレーシングレポート（遠藤さん）
import assert from "node:assert/strict";
import { start, BASE, selectedCard, viaOverlay, focused, text, step, silentWav } from "../lib.js";

const page = await start();

// 13. 検査値：用紙を撮影 → 項目に値が入る → 確かめて保存 → 要点に出る
step("検査値：用紙の写真から読み取って保存（Alt+L）");
await page.goto(`${BASE}/patient?id=3`); // 遠藤さん（eGFR 48・マグミット）
await page.waitForSelector(selectedCard);
assert.match(await text("#labs"), /eGFR\s*48mL[\s\S]*2026\/06\/05[\s\S]*マグネシウム（Mg）\s*2\.4/);
await page.locator("#timeline").focus();
await page.keyboard.press("Alt+L");
await page.waitForSelector("#lab-dialog[open]");
assert.equal((await focused()).id, "lab-date");
await page.setInputFiles("#lab-photo", { name: "検査結果.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
await page.waitForSelector("#lab-photo-tag:not([hidden])");
assert.equal(await page.inputValue("#lab-egfr"), "64");
await page.fill("#lab-egfr", "4.5"); // 小数を許さない項目
await page.locator("#lab-egfr").focus();
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#lab-form [data-error="values.1.value"]').textContent !== "");
await page.fill("#lab-egfr", "52");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#lab-dialog:not([open])", { state: "attached" });
assert.match(await text("#labs"), /eGFR\s*52mL[\s\S]*↑[\s\S]*用紙から/);

// 14. 指導記録：録音ファイルを読み込む → 文字起こし → 会話から拾ったメモ → 下書き（Alt+G）→ 提案を P に → 保存
step("指導記録：録音ファイルの文字起こし・会話から拾ったメモ・下書き・提案");
await page.locator("#timeline").focus();
await page.keyboard.press("Alt+K"); // 選んでいるのは最新の来局（9/17）
await page.waitForSelector("#record-dialog[open]");
assert.match(await text("#suggestions"), /マグミット錠３３０ｍｇ[\s\S]*高マグネシウム血症[\s\S]*腎機能が低下している[\s\S]*eGFR 48（2026-06-05）/); // その来局（9/17）の時点の検査値
await page.setInputFiles("#rec-file", { name: "指導_0917.wav", mimeType: "audio/wav", buffer: silentWav(3) });
await page.waitForSelector("#transcript:not([hidden])");
assert.match(await text("#transcript"), /3秒[\s\S]*薬剤師\s*今日はマグミット錠３３０ｍｇが出ています/);
assert.match(await text("#extracted"), /併用薬（OTC・健康食品を含む）\s*ドラッグストアで買った胃腸薬[\s\S]*疾患（既往歴・合併症・他科）\s*去年から整形外科で腰痛/);
await page.locator("#soap-subjective").focus();
await page.keyboard.press("Alt+G");
await page.waitForFunction(() => document.querySelector("#soap-subjective").value !== ""); // 下書きはサーバーが組み立てて返す
assert.match(await page.inputValue("#soap-subjective"), /朝に少し胃がもたれます/);
assert.match(await page.inputValue("#soap-objective"), /マグネシウム（Mg） 2\.4mg\/dL（08\/20）[\s\S]*残薬：「昼の分をたまに飲み忘れます。」「2回分くらい残っています。」/);
assert.match(await page.inputValue("#soap-plan"), /高マグネシウム血症/);
assert.equal(await page.locator('#record-form input[name="leftover"]:checked').getAttribute("value"), "some");
await page.locator('#extracted [data-extract="0"]').check();
await page.locator("#soap-plan").focus();
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#record-dialog:not([open])", { state: "attached" });
await page.waitForSelector(".record.new");
assert.match(await text(selectedCard), /服薬指導の会話（3秒・ファイル 指導_0917\.wav）[\s\S]*下書きから/);
assert.match(await text('[data-category="concomitant"]'), /ドラッグストアで買った胃腸薬[\s\S]*服薬指導の会話より/);
assert.match(await text(".toasts"), /患者メモ 1件も追加/);

// 15. テンプレート：選んで写す
step("指導記録のテンプレートを写す");
await page.keyboard.press("Alt+K");
await page.waitForSelector("#record-dialog[open]");
await page.selectOption("#template-select", { label: "残薬あり" });
await page.click("#apply-template");
assert.match(await page.inputValue("#soap-plan"), /お薬カレンダーの利用を提案/);
// 今の内容をテンプレートに：名前はアプリの窓で聞く（ブラウザの prompt は使わない）
await page.click("#save-template");
await page.waitForSelector(".ask-dialog[open] input[name=text]");
await page.keyboard.type("e2eの型");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /テンプレート「e2eの型」を保存しました/.test(document.querySelector(".toasts")?.textContent ?? ""));
await page.waitForSelector(".ask-dialog", { state: "detached" });
await page.keyboard.press("Escape");

await page.goto(`${BASE}/patient?id=3`); // 次の手順は遠藤さんの薬歴から
await page.waitForSelector(selectedCard);

// 16. トレーシングレポート：薬歴から写す → 保存 → 印刷の画面
step("トレーシングレポート（Alt+T → Alt+W で薬歴から写す → 保存 → 印刷）");
await page.locator("#timeline").focus();
await viaOverlay("Alt+T", /^\/tracing\?patient=3&rx=/);
await page.waitForFunction(() => document.activeElement?.id === "t-institution");
await page.keyboard.press("Alt+W");
assert.match(await page.inputValue("#t-leftover"), /マグミット錠が7日分残っている[\s\S]*回答：21日分で可/);
assert.match(await page.inputValue("#t-concomitant"), /ロキソプロフェンのテープ剤/);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('[data-error="institution"]').textContent !== "");
assert.equal(await text('[data-error="consent"]'), "患者の同意を選んでください");
await page.fill("#t-institution", "○○内科クリニック（架空）");
await page.fill("#t-department", "内科");
await page.fill("#t-doctor", "山田");
await page.locator('input[name="consent"][value="agreed"]').check();
await Promise.all([page.waitForURL(/\/tracing\?id=\d+$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".tracing-sheet");
assert.match(await text(".tracing-sheet"), /○○内科クリニック（架空）　御中[\s\S]*服薬情報提供書（トレーシングレポート）[\s\S]*山田　先生[\s\S]*遠藤　和子[\s\S]*■ 患者の同意のもと報告します[\s\S]*1-1\. 残薬調整の報告\s*マグミット錠が7日分/);
