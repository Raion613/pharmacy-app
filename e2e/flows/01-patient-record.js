// 薬歴と処方入力：ログイン（キーボードだけ）→ 患者検索 → 薬歴（指導記録・患者メモ）→ 処方入力 → 保存 → 改定比較 → 前回Do → 閲覧記録 → 在庫
import assert from "node:assert/strict";
import { start, BASE, selectedCard, viaOverlay, doFromPatient, focused, text, step } from "../lib.js";

const page = await start({ login: false });

step("ログイン");
await page.goto(`${BASE}/patients`);
assert.match(page.url(), /\/login\?next=%2Fpatients$/);
await page.waitForFunction(() => document.activeElement?.id === "login-id"); // 読み込み前に打つと最初の文字が落ちる
await page.keyboard.type("demo");
await page.keyboard.press("Tab");
await page.keyboard.type("pharmacy-demo");
await Promise.all([page.waitForURL(/\/patients$/), page.keyboard.press("Enter")]);

// 2. ひらがなで患者を探し、1件なら Enter でそのまま開く
step("患者をひらがなで検索して開く");
await page.waitForSelector("#patients tbody tr");
await page.keyboard.type("あおき");
await page.waitForFunction(() => document.querySelectorAll("#patients tbody tr").length === 1);
await Promise.all([page.waitForURL(/\/patient\?id=1$/), page.keyboard.press("Enter")]);

// 3. 薬歴：経過は新しい順のカード。↓で前の来局へ。処方の変化（追加・中止）と点数が見える
step("薬歴：経過を↓で辿る（処方の変化と、改定の前後の点数）");
await page.waitForSelector(selectedCard);
assert.equal(await page.locator("#timeline .visit-card").count(), 4);
assert.match(await text(selectedCard), /2026\/05\/14[\s\S]*薬剤料 56点[\s\S]*−中止\s*ビオフェルミン錠剤[\s\S]*P\s*減煙を続けられるよう/);
await page.keyboard.press("ArrowDown");
assert.match(await text(selectedCard), /2026\/04\/16[\s\S]*薬剤料 112点[\s\S]*＋追加\s*アトルバスタチン錠１０ｍｇ「サワイ」 1錠・28日分/);
await page.keyboard.press("ArrowDown");
assert.match(await text(selectedCard), /2026\/03\/19[\s\S]*薬剤料 84点[\s\S]*前回と同じ処方[\s\S]*指導記録 未記載/);

step("薬歴：この患者の要点（前回の留意点・今の処方とその開始日・申し送り）");
assert.match(await text("#cautions"), /副作用\s*アムロジピン10mgで下肢のむくみ/);
assert.match(await text("#last-plan"), /前回の留意点（P）[\s\S]*2026\/05\/14[\s\S]*減煙を続けられるよう/);
assert.match(await text("#current-meds"), /ノルバスク錠５ｍｇ[\s\S]*2026\/02\/19（木）から（4回）[\s\S]*アトルバスタチン[\s\S]*2026\/04\/16（木）から（2回）/);
assert.match(await text('[data-category="handover"]'), /家庭血圧の手帳を毎回持参/);

step("薬歴：処方の推移（薬 × 来局日）");
const cells = (code) => page.locator(`.matrix tr[data-code="${code}"] td`).evaluateAll((tds) => tds.map((td) => td.className || "-"));
assert.deepEqual(await cells("620000094"), ["start", "on", "on", "stop"]);  // ビオフェルミン：5/14 に中止
assert.deepEqual(await cells("622098501"), ["-", "-", "start", "on"]);     // アトルバスタチン：4/16 に追加
await page.locator("#timeline").focus();

// 3-2. Alt+K で、選んでいる来局（3/19）の指導記録を書く。空のままだと保存できない
step("Alt+K で指導記録を記載（書く画面に処方の変化とそれまでの留意点）");
await page.keyboard.press("Alt+K");
await page.waitForSelector("#record-dialog[open]");
assert.match(await text("#record-dialog-title"), /2026\/03\/19（木）の来局/);
assert.match(await text("#record-context"), /前回と同じ処方[\s\S]*それまでの留意点（P）\s*家庭血圧の記録を続ける/);
assert.equal((await focused()).id, "soap-subjective");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#record-form [data-error="subjective"]').textContent !== "");
await page.keyboard.type("薬は飲めている");
await page.fill("#soap-plan", "次回、家庭血圧の手帳を確認");
await page.locator('#record-form input[name="leftover"][value="none"]').check();
await page.locator("#soap-plan").focus();
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#record-dialog:not([open])", { state: "attached" });
await page.waitForSelector(".record.new");
assert.match(await text(selectedCard), /S\s*薬は飲めている[\s\S]*P\s*次回、家庭血圧の手帳を確認[\s\S]*残薬なし[\s\S]*デモ 薬剤師/);
assert.doesNotMatch(await text(selectedCard), /指導記録 未記載/);
// 前回の留意点は「いちばん新しい来局」の P のまま（古い来局に書き足しても替わらない）
assert.match(await text("#last-plan"), /減煙を続けられるよう/);

// 3-3. Alt+M で患者メモ。分類ごとに大きな欄が1つ。アレルギー歴を書くと、上の帯に赤い札が増える
step("Alt+M で患者メモを書く（分類ごとに1つの欄。アレルギー歴は帯に出る）");
await page.keyboard.press("Alt+M");
await page.waitForSelector("#note-dialog[open]");
// 注意点で書けるのはアレルギー歴・副作用歴・疾患・併用薬だけ（生活・意向・申し送りはそれぞれの箱で）
assert.deepEqual(await page.$$eval('#note-categories input[name="category"]', (rs) => rs.map((r) => r.value)), ["allergy", "adverse", "disease", "concomitant"]);
assert.equal(await page.locator("#note-body").isDisabled(), true); // 分類を選ぶまで書けない
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#note-form [data-error="category"]').textContent !== "");
await page.locator('#note-form input[name="category"][value="allergy"]').check();
// Enter は改行。何行書いても1つの欄
await page.locator("#note-body").focus();
await page.keyboard.press("Control+End");
await page.keyboard.type("ペニシリン系で発疹（本人申告）");
await page.keyboard.press("Enter");
await page.keyboard.type("卵");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });
assert.match(await text("#cautions"), /アレルギー[\s\S]*ペニシリン系で発疹（本人申告）[\s\S]*卵[\s\S]*副作用/);
assert.match(await text('[data-category="allergy"]'), /ペニシリン系で発疹（本人申告）\n卵[\s\S]*デモ 薬剤師/);
assert.equal(await page.locator('[data-category="allergy"] .note-text').count(), 1);

step("箱を押すと、その箱の入力が開く（次に確認すること → 申し送り）");
await page.click('[data-box="next"] .pbox-head');
await page.waitForSelector("#note-dialog[open]");
assert.equal(await text("#note-dialog-title"), "患者メモ（申し送り）");
assert.deepEqual(await page.$$eval('#note-categories input[name="category"]', (rs) => rs.map((r) => [r.value, r.checked])), [["handover", true]]);
await page.keyboard.press("Escape");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });

step("分類の行を押すと、その分類にチェックが入った同じ窓が開く（直す前の内容は欄の下に残る）");
await page.click('[data-category="allergy"] th');
await page.waitForSelector("#note-dialog[open]");
assert.equal(await page.$eval('#note-form input[name="category"]:checked', (r) => r.value), "allergy");
assert.equal(await page.evaluate(() => document.activeElement.id), "note-body");
await page.fill("#note-body", (await page.inputValue("#note-body")).replace("卵", "卵（加熱したものは食べられる）"));
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });
assert.match(await text('[data-category="allergy"]'), /卵（加熱したものは食べられる）[\s\S]*（修正）/);
// キーボードでも：疾患の行にフォーカスして Enter → 疾患にチェックが入って開く
await page.locator('[data-category="disease"]').focus();
await page.keyboard.press("Enter");
await page.waitForSelector("#note-dialog[open]");
assert.equal(await page.$eval('#note-form input[name="category"]:checked', (r) => r.value), "disease");
// 分類を切り替えると、その分類の今の内容と前の内容が出る
await page.locator('#note-form input[name="category"][value="allergy"]').check();
assert.match(await page.inputValue("#note-body"), /卵（加熱したものは食べられる）/);
assert.match(await page.locator("#note-history").innerText(), /^ペニシリン系で発疹（本人申告）\n卵/);
await page.keyboard.press("Escape");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });
await page.locator("#timeline").focus();

// 4. Alt+N で処方入力。薬名 → Enter → 1日量 → Enter → 次の薬 …
step("Alt+N で処方入力へ");
await viaOverlay("Alt+N", /^\/rx\?patient=1$/);
await page.waitForSelector('[data-field="drug"]');
assert.deepEqual(await focused(), { id: "", field: "drug", r: "0", i: "0", tag: "INPUT" });

step("薬を2つ入れる");
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#suggest:not([hidden]) li[aria-selected=true]");
assert.match(await text("#suggest:not([hidden]) li[aria-selected=true]"), /ノルバスク錠５ｍｇ[\s\S]*在庫 100錠/); // デモの在庫は全部 100 から
// 薬の名前は、パとバの見分けやすい書体（M PLUS Rounded 1c）で描いている（書体が届いている）
assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector("#suggest .s-name")).fontFamily.startsWith('"M PLUS Rounded 1c"')
  && document.fonts.check("700 14px 'M PLUS Rounded 1c'", "パバ")), "薬の名前が M PLUS Rounded 1c で描かれていない");
await page.keyboard.press("Enter");
assert.equal((await focused()).field, "qty");
await page.keyboard.type("1");
await page.keyboard.press("Enter");
assert.deepEqual(await focused(), { id: "", field: "drug", r: "0", i: "1", tag: "INPUT" });
await page.keyboard.type("2189015F2054"); // アトルバスタチン錠１０ｍｇ「サワイ」を薬価基準収載医薬品コードで
await page.waitForSelector("#suggest:not([hidden]) li[aria-selected=true]");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
await page.keyboard.press("Enter");

step("空欄で Enter → 用法 → 日数 → 次の剤");
await page.keyboard.press("Enter");
assert.equal((await focused()).field, "usage");
assert.equal(await page.inputValue("#usage-0"), "1日1回朝食後"); // 用法は1日量（1錠）から選ばれている（打たない）
await page.keyboard.press("Enter");
assert.equal((await focused()).field, "days");
await page.keyboard.type("28");
await page.keyboard.press("Enter");
assert.deepEqual(await focused(), { id: "", field: "drug", r: "1", i: "0", tag: "INPUT" });
// 今日（令和8年度改定）の薬価：10.80 + 11.50 = 22.30円 → 2点 × 28日 = 56点
assert.match(await text('.rp-edit[data-r="0"] .rp-calc'), /22\.30円 → 2点 × 28日 = 56点/);
assert.equal(await text("#total"), "56点");

step("空の剤で Enter → 保存ボタン");
await page.keyboard.press("Enter");
assert.equal((await focused()).id, "save");

// 5. 調剤日を改定前に変えると、薬価を引き直して点数が変わる
step("調剤日を改定前（2026-03-31）に変える");
await page.fill("#prescribed-on", "2026-03-30");
await page.locator("#prescribed-on").dispatchEvent("change");
await page.fill("#dispensed-on", "2026-03-31");
await page.locator("#dispensed-on").dispatchEvent("change");
await page.waitForFunction(() => document.querySelector("#total").textContent === "84点");
// 選んだ薬の薬価が、調剤日より後の 4月1日に変わることを知らせる
assert.match(await text("#revision-tag"), /2026\/04\/01（水）から薬価が変わる薬があります/);
assert.match(await text('.rp-edit[data-r="0"] .rp-calc'), /27\.60円 → 3点 × 28日 = 84点/);

// 6-2. 会計：保存する前に、調剤報酬の合計と窓口で受け取る額が出る
step("会計：調剤技術料・薬学管理料・薬剤料と一部負担金");
assert.equal(await text("#bill-total"), "281点");
assert.equal(await text("#bill-copay"), "840円");
assert.equal(await text("#bill-charge"), "840円");

// 7. 用法を空にして保存 → サーバーの検証で止まり、用法の欄にフォーカスが戻る
step("用法が空なら保存できない（サーバーの検証）");
await page.selectOption("#usage-0", ""); // 「（選ぶ）」に戻す
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#errors:not([hidden])");
assert.match(await text("#error-list"), /Rp1：用法を入力してください/);
assert.equal((await focused()).id, "usage-0");

step("用法を戻して Ctrl+Enter で保存");
await page.keyboard.press("ArrowDown"); // 用法は選ぶだけ（↓で「1日1回朝食後」）
await Promise.all([page.waitForURL(/\/patient\?id=1&saved=/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector('#timeline .visit-card.saved[aria-selected="true"]');
assert.match(await text(selectedCard), /2026\/03\/31[\s\S]*薬剤料 84点/);
// 3/31 は令和6年度の点数表：調剤基本料1 45＋連携強化 5＋後発医薬品調剤体制2 28＋薬剤調製料 24＋調剤管理料 50＋服薬管理指導料 45 ＋ 薬剤料 84 = 281点
// （医療ＤＸ推進体制整備加算は3/19に算定済みで月1回、医療情報取得加算は2/19に算定済みで12月に1回）。3割で 843円 → 840円
assert.match(await text(".toasts"), /処方を保存しました（合計 281点・窓口で 840円）/);

// 7-2. 改定をまたいで比べる（薬歴の来局カードの計算の内訳）：比べる日付は自動で、薬の薬価が次に変わる日（2026-04-01）
step("薬歴で Alt+C：保存した処方を改定後の薬価と比べる");
await page.keyboard.press("Alt+C");
await page.waitForFunction((sel) => document.querySelector(`${sel} .compare-diff`)?.textContent.includes("点"), selectedCard);
assert.equal(await page.inputValue(`${selectedCard} [data-compare-date]`), "2026-04-01");
assert.equal(await page.evaluate(() => document.activeElement.matches("[data-compare-date]")), true);
assert.match(await text(`${selectedCard} .compare-table tfoot`), /薬剤料\s*84点\s*56点/);
assert.match(await text(`${selectedCard} .compare-diff`), /2026\/04\/01（水）の薬価で計算すると\s*−28点/);
assert.equal(await page.locator(`${selectedCard} .compare-table tr.changed`).count(), 2);

// 8. 前回Do：選んだ処方を複写。薬価は今日の日付で引き直す
step("処方入力で Alt+D：前回の処方を写す");
await doFromPatient(1);
await page.waitForSelector("#do-note:not([hidden])");
assert.equal((await focused()).field, "qty");
assert.equal(await text("#total"), "56点");
await page.goto(`${BASE}/logs?patient=1`);

// 9. 閲覧記録に、今の操作が残っている
step("閲覧記録");
await page.waitForSelector("#rows tr");
const logs = await text("#rows");
assert.match(logs, /処方を保存[\s\S]*調剤日 2026-03-31 \/ 合計 281点（薬剤料 84点）\/ 一部負担金 840円/);
assert.match(logs, /患者メモを追加[\s\S]*アレルギー歴/);
assert.match(logs, /指導記録を記載[\s\S]*調剤日 2026-03-19 の指導記録/);
assert.match(logs, /患者情報を表示/);

step("在庫：保存した処方で、ノルバスクは渡した分だけ減っている");
await page.goto(`${BASE}/drugs`);
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#drugs tbody tr");
await page.keyboard.press("Enter");
await page.waitForSelector(".history tr.current");
// 在庫：ここまでに保存した処方で、ノルバスクは渡した分だけ減っている
const norvasc = Number((await text(".drug-props")).match(/在庫 (\d+)錠/)[1]);
assert.ok(norvasc < 100, `ノルバスクの在庫が減っていない：${norvasc}`);
