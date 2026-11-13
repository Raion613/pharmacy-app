// 画面の通し確認。
//   前半：マウスを使わず、キーボードだけでログイン → 患者検索 → 薬歴（メモ・指導記録）→ 処方入力 → 保存 まで進める。
//   後半：チュートリアル（初回だけ出る・クリックで送る・対象の部品を囲う・ボタンで再生）を確かめる。
// 使い方：別のターミナルで npm run dev を起動しておき、npm run e2e
// ブラウザは PC に入っている Edge を使う（Playwright のブラウザのダウンロードは不要）。
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { hotp, stepOf } from "../src/server/totp.js";

const BASE = process.env.BASE_URL ?? "http://localhost:8788";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
let currentStep = ""; // いま流している手順（エラーに付ける）
async function newPage({ toursSeen }) {
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1366, height: 768 } });
  // 初回だけの紹介の PV（login-intro.js）は見終わった状態にしておく。起動の錠剤の演出は毎回出る（入力は妨げない）
  await context.addInitScript(() => localStorage.setItem("pv-seen", "1"));
  // 前半は業務の流れを確かめるので、チュートリアルは見終わった状態にしておく
  if (toursSeen) {
    await context.addInitScript(() => {
      for (const k of ["login", "home", "patients", "patient", "rx", "drugs", "logs", "master", "board", "inspect", "homecare", "tracing", "stats", "messages", "account"]) localStorage.setItem(`tour:${k}`, "3"); // tour.js の VERSION と揃える
    });
  }
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(`${currentStep}：${e.message}`)); // どの手順で出たかを付けて集める
  p.on("dialog", (d) => d.accept()); // 保存していない入力があるときの「このページを離れますか」
  // 422（入力の誤り）と 401（多要素認証で違う6桁を入れる）は、確かめる手順で意図して出すので除く
  p.on("console", (m) => { if (m.type() === "error" && !/status of (422|401)/.test(m.text())) errors.push(`${currentStep}：${m.text()}`); });
  return p;
}
let page = await newPage({ toursSeen: true });
// 薬歴の操作（処方入力・トレーシングレポートなど）は、薬歴の上に重なる窓で開く。
// 窓に読み込んだ画面の URL を確かめ、続きはその画面を直接開いて操作する（窓そのものの動きは「重なる窓」の手順で確かめる）
async function viaOverlay(action, pattern) {
  if (typeof action === "string") await page.keyboard.press(action);
  else await action();
  await page.waitForFunction(() => document.querySelector("dialog.overlay[open] iframe")?.src.includes("embed=1"));
  const src = new URL(await page.locator("dialog.overlay iframe").evaluate((f) => f.src));
  src.searchParams.delete("embed");
  assert.match(src.pathname + src.search, pattern);
  await page.goto(src.href);
}

// 前回の処方を写す：薬歴から処方入力を開き（Alt+N）、処方入力で Alt+D（いちばん新しい来局の処方を写す）
async function doFromPatient(id) {
  await viaOverlay("Alt+N", new RegExp(`^/rx\\?patient=${id}$`));
  await page.waitForFunction(() => document.activeElement?.dataset.field === "drug");
  await Promise.all([page.waitForURL(/from=/), page.keyboard.press("Alt+D")]);
}

const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return { id: el.id, field: el.dataset.field ?? null, r: el.dataset.r ?? null, i: el.dataset.i ?? null, tag: el.tagName };
});
// 処方入力の点数・会計はサーバーが計算して返す（入力から結果が届くまで body[data-calc="pending"]）。読む前に届くのを待つ
const settled = () => page.waitForFunction(() => document.body.dataset.calc !== "pending");
const text = async (sel) => {
  await settled();
  return page.locator(sel).innerText();
};
const step = (name) => { currentStep = name; console.log(`- ${name}`); };

// 無音の WAV（録音ファイルの読み込みを試す。長さだけが使われる）
function silentWav(seconds) {
  const rate = 8000;
  const data = rate * seconds * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}

// 1. 未ログインならログイン画面へ。ID → Tab → パスワード → Enter
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
const selectedCard = '#timeline .visit-card[aria-selected="true"]';
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

// 3-3. Alt+M で患者メモ。アレルギー歴を足すと、上の帯に赤い札が増える
step("Alt+M で患者メモを追加（アレルギー歴は帯に出る）");
await page.keyboard.press("Alt+M");
await page.waitForSelector("#note-dialog[open]");
// 注意点で書けるのはアレルギー歴・副作用歴・疾患・併用薬だけ（生活・意向・申し送りはそれぞれの箱で）
assert.deepEqual(await page.$$eval('#note-categories input[name="category"]', (rs) => rs.map((r) => r.value)), ["allergy", "adverse", "disease", "concomitant"]);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#note-form [data-error="category"]').textContent !== "");
assert.equal(await text('#note-form [data-error="body"]'), "内容を入力してください");
await page.locator('#note-form input[name="category"][value="allergy"]').check();
// 1行に1件。Enter で次の行が増え、2件が別々のメモになる
await page.locator("#note-rows input").first().focus();
await page.keyboard.type("ペニシリン系で発疹（本人申告）");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelectorAll("#note-rows input").length === 2 && document.activeElement === document.querySelectorAll("#note-rows input")[1]);
await page.keyboard.type("卵");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });
assert.match(await text("#cautions"), /アレルギー[\s\S]*ペニシリン系で発疹（本人申告）[\s\S]*卵[\s\S]*副作用/);
assert.match(await text('[data-category="allergy"]'), /ペニシリン系で発疹（本人申告）[\s\S]*デモ 薬剤師/);
assert.equal(await page.locator('[data-category="allergy"] li').count() >= 2, true);

step("箱を押すと、その箱の入力が開く（次に確認すること → 申し送り）");
await page.click('[data-box="next"] .pbox-head');
await page.waitForSelector("#note-dialog[open]");
assert.equal(await text("#note-dialog-title"), "患者メモを追加（申し送り）");
assert.deepEqual(await page.$$eval('#note-categories input[name="category"]', (rs) => rs.map((r) => [r.value, r.checked])), [["handover", true]]);
await page.keyboard.press("Escape");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });

step("患者メモを直す（行を押すとその場に小さな窓。Enter で保存、Esc でやめる。直す前の内容は残る）");
await page.locator('[data-category="allergy"] li[data-edit-note]', { hasText: "卵" }).click();
await page.waitForSelector("#note-pop[open]");
assert.equal(await page.inputValue("#note-pop input"), "卵");
await page.fill("#note-pop input", "卵（加熱したものは食べられる）");
await page.keyboard.press("Enter");
await page.waitForSelector("#note-pop:not([open])", { state: "attached" });
assert.match(await text('[data-category="allergy"]'), /卵（加熱したものは食べられる）[\s\S]*（修正）/);
// キーボードでも：行にフォーカスして Enter
await page.locator('[data-category="allergy"] li[data-edit-note]', { hasText: "加熱" }).focus();
await page.keyboard.press("Enter");
await page.waitForSelector("#note-pop[open]");
assert.match(await page.locator(".note-pop-history").innerText(), /^卵/);
await page.keyboard.press("Escape");
await page.waitForSelector("#note-pop:not([open])", { state: "attached" });
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

// 10. 新規患者登録（Alt+N）→ 誤りは項目ごとに出る → 直して登録
step("新規患者登録");
await page.goto(`${BASE}/patients`);
await page.waitForSelector("#patients tbody tr");
// 打つたびに登録済みの患者を探す（ひらがなのカナでも当たる）。生年月日まで同じなら赤で示す
await page.keyboard.press("Alt+N");
await page.keyboard.press("Tab");
await page.keyboard.type("あおき");
await page.waitForFunction(() => /名前の近い人が1人/.test(document.querySelector("#same-head").textContent));
assert.match(await text("#same-list"), /アオキ　マコト[\s\S]*青木　誠/);
await page.fill("#p-birth", "1958-06-14");
await page.waitForFunction(() => /生年月日も同じ 1人/.test(document.querySelector("#same-head").textContent));
await page.keyboard.press("Escape");
await page.waitForSelector("#patient-dialog:not([open])", { state: "attached" });
await page.keyboard.press("Alt+N");
await page.keyboard.type("試験　次郎");
await page.waitForFunction(() => /この名前の人はいません/.test(document.querySelector("#same-head").textContent));
await page.keyboard.press("Tab");
await page.keyboard.type("しけん　じろう");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector('[data-error="birthDate"]').textContent !== "");
assert.equal(await text('[data-error="sex"]'), "性別を選んでください");
await page.fill("#p-birth", "1980-02-29");
await page.locator('input[name="sex"][value="M"]').check();
await page.locator('input[name="burdenPercent"][value="30"]').check();
await Promise.all([page.waitForURL(/\/patient\?id=\d+$/), page.keyboard.press("Enter")]);
await page.waitForSelector("#band .name");
assert.match(await text("#band"), /シケン　ジロウ[\s\S]*試験　次郎[\s\S]*000008/);

// 11. 薬価照会：基準日に効いている薬価の行を強調する
step("薬価照会");
await page.goto(`${BASE}/drugs`);
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#drugs tbody tr");
await page.keyboard.press("Enter");
await page.waitForSelector(".history tr.current");
assert.match(await text(".history tr.current"), /2026\/04\/01/);
assert.match(await text(".history"), /−2\.90円/);
// 在庫：ここまでに保存した処方で、ノルバスクは渡した分だけ減っている
const norvasc = Number((await text(".drug-props")).match(/在庫 (\d+)錠/)[1]);
assert.ok(norvasc < 100, `ノルバスクの在庫が減っていない：${norvasc}`);
// 採用薬は、同じ成分の銘柄の中で一番上に出る。Alt+A で外す・付ける
await page.keyboard.press("/");
await page.keyboard.type("ろすばすたちん");
await page.waitForFunction(() => /ロスバスタチン錠２．５ｍｇ「サワイ」/.test(document.querySelector("#drugs tbody tr")?.textContent ?? ""));
assert.match(await text("#drugs tbody tr:first-child"), /採用/);
await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => /ロスバスタチン錠２．５ｍｇ「サワイ」/.test(document.querySelector(".drug-title")?.textContent ?? ""));
await page.keyboard.press("Alt+A");
await page.waitForFunction(() => /採用薬にする/.test(document.querySelector("#adopt")?.textContent ?? ""));
assert.doesNotMatch(await text("#drugs tbody tr:first-child"), /採用/);
await page.keyboard.press("Alt+A");
await page.waitForFunction(() => /採用薬から外す/.test(document.querySelector("#adopt")?.textContent ?? ""));

// 11-2. 長期収載品の選定療養：（選）のコードの薬は、保険の薬剤料とは別に特別の料金が出る
step("選定療養：薬歴に特別の料金、前回Do で入力中にも特別の料金");
await page.goto(`${BASE}/patient?id=7`);
await page.waitForSelector(selectedCard);
// ロキソニン（選）10.65円 × 3 + ムコスタ 10.80円 × 3 = 64.35円 → 6点 × 14日 = 84点。
// 特別の料金：価格差 0.15円 × 3 = 0.45円 → 1点 × 14日 = 14点 → 140円 + 消費税 = 154円
assert.match(await text(selectedCard), /2026\/10\/22[\s\S]*薬剤料 84点[\s\S]*特別の料金 154円[\s\S]*ロキソニン錠６０ｍｇ（選）/);
await doFromPatient(7);
await page.waitForFunction(() => document.querySelector("#bill-special").textContent === "154円");
assert.equal(await text("#total"), "84点");
assert.match(await text('tr.item[data-r="0"][data-i="0"] .drug-meta'), /選定療養（患者希望）[\s\S]*価格差 0\.15円\/錠/);
// 11-2-2. 残薬調整：調剤した日数を減らし、Alt+Q で疑義照会の窓を開いて書くと、その剤の下に1行出て、加算が会計に入る。Alt+H で処方箋の記載を別に書ける
step("残薬調整（日数を減らす・Alt+Q で疑義照会の窓）と、処方箋と違う薬（Alt+H）");
await page.fill("#disp-days-0", "7");
await page.locator("#disp-days-0").dispatchEvent("input");
await page.waitForSelector("#days-change-0:not([hidden])");
await page.locator("#disp-days-0").focus();
await page.keyboard.press("Alt+Q"); // カーソルのある剤（Rp1）について
await page.waitForSelector("#inquiry-dialog[open]");
await page.waitForFunction(() => document.activeElement.id === "inq-content");
assert.match(await page.locator("#inq-target option:checked").textContent(), /^Rp1 全体/);
await page.keyboard.type("ロキソニンが7日分残っている。14日分を7日分に減らしてよいか");
await page.keyboard.press("Tab");
await page.keyboard.type("7日分で可");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#inquiry-dialog:not([open])", { state: "attached" });
await page.waitForFunction(() => document.activeElement.id === "disp-days-0"); // 窓を閉じたら元の欄へ戻る
const inqLine = '.rp-edit[data-r="0"] .inq-line';
assert.match(await text(inqLine), /残薬調整[\s\S]*Rp1 全体[\s\S]*14日分を7日分に減らしてよいか[\s\S]*7日分で可[\s\S]*処方変更あり/);
await page.waitForFunction(() => document.querySelector("#bill-lines").textContent.includes("調剤時残薬調整加算ニ"));
// 行を押すと直せる：対象を剤の中の薬に変える
await page.click(inqLine);
await page.waitForSelector("#inquiry-dialog[open]");
assert.equal(await text("#inquiry-title"), "疑義照会を直す");
await page.selectOption("#inq-target", "0-0");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#inquiry-dialog:not([open])", { state: "attached" });
assert.match(await text(inqLine), /ロキソニン錠６０ｍｇ（選）/);
await page.locator('[data-field="drug"][data-r="0"][data-i="0"]').focus();
await page.keyboard.press("Alt+H");
await page.waitForSelector('.rx-row [data-field="rxName"]');
assert.equal(await page.inputValue('.rx-row [data-field="rxName"]'), "【般】ロキソプロフェンＮａ錠６０ｍｇ");
await page.goto(`${BASE}/patient?id=7`);
await page.waitForSelector(selectedCard);

// 11-2-3. 領収証・明細書とお薬手帳（紙に貼る内容と、電子版の QR コード）
step("領収証・明細書、お薬手帳（JAHIS の QR コード）");
const rxId = await page.locator(selectedCard).getAttribute("data-id");
await page.goto(`${BASE}/receipt?id=${rxId}`);
await page.waitForSelector(".receipt");
const receipt = await text(".receipt");
assert.match(receipt, /領　収　証[\s\S]*加藤　真一 様[\s\S]*269点/);
assert.match(receipt, /保険　負担額\s*810円/);
assert.match(receipt, /長期収載品の選定療養に係る特別の料金\s*154円（うち消費税 14円）/);
assert.match(receipt, /領収額 合計\s*964円/);
assert.match(await text(".statement"), /調剤基本料１[\s\S]*服薬管理指導料２（ロ）[\s\S]*ロキソニン錠６０ｍｇ（選）[\s\S]*調剤物価対応料/);
await page.goto(`${BASE}/handbook?id=${rxId}`);
await page.waitForSelector(".qr svg");
assert.match(await text(".sticker"), /2026\/10\/22[\s\S]*ロキソニン錠６０ｍｇ（選）\s*3錠[\s\S]*【1日3回毎食後】 14日分/);
assert.match(await page.locator(".raw pre").textContent(), /^JAHISTC03,1\r?\n[\s\S]*201,1,ロキソニン錠６０ｍｇ（選）,3,錠,2,670098801,1/);
await page.goto(`${BASE}/master`);

// 11-3. マスター取込の画面：取り込み済みのマスターと、これから効く変更（11月1日から）
step("マスター取込：取り込み済みの一覧");
await page.waitForSelector("#import-rows tr");
assert.match(await text("#import-rows tr:first-child"), /2026\/09\/11[\s\S]*調剤行為 全件[\s\S]*m20260911\.csv[\s\S]*初期データ/);
assert.match(await text("#import-rows"), /2026\/10\/13[\s\S]*医薬品 全件[\s\S]*y_ALL20261013\.zip/);
assert.equal((await focused()).id, "pick");

// ---------- 追加した機能（kusudamaクラウド薬歴・ホルトノキの機能） ----------

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

// 保存していない入力がある処方入力から移るときは、アプリの窓で確かめる（ブラウザの confirm は使わない）
step("処方入力：保存していない入力があるまま移ると確かめる");
await page.goto(`${BASE}/rx?patient=1`);
await page.waitForSelector('[data-field="drug"]:focus');
await page.keyboard.type("のるはすく錠"); // 濁点を落としても候補に出る
await page.waitForFunction(() => /ノルバスク錠/.test(document.querySelector("#suggest:not([hidden]) li[aria-selected=true]")?.textContent ?? ""));
await page.keyboard.press("Enter");
await page.keyboard.type("3");
assert.equal(await page.inputValue("#usage-0"), "1日3回毎食後"); // 3錠 → 1日3回毎食後
await page.keyboard.press("Alt+2");
await page.waitForSelector(".ask-dialog[open]");
assert.match(await text(".ask-dialog"), /保存していない入力があります[\s\S]*この画面に残る[\s\S]*移る（入力を消す）/);
await page.keyboard.press("Escape");
await page.waitForSelector(".ask-dialog", { state: "detached" });
assert.match(page.url(), /\/rx\?patient=1$/);
await page.keyboard.press("Alt+2");
await page.waitForSelector(".ask-dialog[open]");
await Promise.all([page.waitForURL(/\/patients$/, { waitUntil: "commit" }), page.keyboard.press("Enter")]);
await page.waitForSelector("#patients tbody tr");
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

// 17. 小児の分量：上田さん（4歳・18kg）の処方を Do すると、3つとも通常量の範囲内。量を増やすと上限超え
step("処方入力：小児の分量（体重当たり）");
await page.goto(`${BASE}/patient?id=4`);
await page.waitForSelector(selectedCard);
await doFromPatient(4);
await page.waitForSelector("#peds:not([hidden]) #peds-list li");
assert.match(await text("#peds-weight"), /5歳・体重 18\.0kg/);
assert.equal(await page.locator("#peds-list li.peds-ok").count(), 3);
assert.match(await text("#peds-list"), /カロナール細粒２０％[\s\S]*10mg\/kg\/回。通常量の範囲内/);
await page.fill('[data-field="qty"][data-r="1"][data-i="0"]', "9");
await page.locator('[data-field="qty"][data-r="1"][data-i="0"]').dispatchEvent("input");
await page.waitForSelector("#peds-list li.peds-over");
assert.match(await text("#peds-list li.peds-over"), /ワイドシリン細粒２０％[\s\S]*1日 100mg\/kg。上限の 90mg\/kg を超えています/);

// 18. 受付状況：受付 → 処方入力 → 調剤監査（バーコード）→ 投薬 → 会計
step("受付状況：受付（Alt+U）→ 処方入力 → 監査 → 投薬 → 会計");
await page.goto(`${BASE}/board`);
await page.waitForFunction(() => document.activeElement?.id === "reception-q");
await page.keyboard.type("うの");
await page.waitForSelector('#reception-suggest:not([hidden]) li[aria-selected="true"]');
await page.keyboard.press("Enter");
await page.waitForSelector(".col-received .board-card");
assert.match(await text(".col-received .board-card"), /宇野　健太[\s\S]*受付 \d\d:\d\d[\s\S]*0分待ち/);
assert.match(await page.evaluate(() => document.activeElement.textContent), /処方を入力/);
await viaOverlay("Enter", /^\/rx\?patient=5&reception=\d+$/);
await page.waitForSelector('[data-field="drug"]');
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#suggest:not([hidden]) li[aria-selected=true]");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("14");
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-entered .board-card");
await viaOverlay(() => page.click(".col-entered .board-card .btn-primary"), /^\/inspect\?id=/);
await page.waitForFunction(() => document.activeElement?.id === "scan-input");
assert.match(await text("#check-items"), /ノルバスク錠５ｍｇ[\s\S]*総量 14錠[\s\S]*まだ読んでいません/);
assert.equal(await page.locator("#save").isDisabled(), true);
// 監査の画面では負担割合・公費を変えられないので、帯は文字だけ
assert.equal(await page.locator("#band button").count(), 0);
// デモの「違う薬」は成分の違う薬（ノルバスク＝アムロジピンに対して、アムロジピンの別の銘柄を出さない）
assert.doesNotMatch(await page.locator("#demo-wrong button:has-text('違う薬')").innerText(), /アムロジピン|ノルバスク/);
// 違う薬の箱 → 赤。期限切れ → 赤。正しい箱 → チェック。読み取り機は文字と Enter を送る
await page.click("#demo-scan button:has-text('違う薬')");
await page.waitForSelector("#scan-log li.r-wrong");
await page.click("#demo-scan button:has-text('期限切れ')");
await page.waitForSelector("#scan-log li.r-expired");
await page.keyboard.type("(01)14987114335002(17)301231(10)E2E01"); // ノルバスク錠５ｍｇ ＰＴＰ 100錠（HOTコードマスター）
await page.keyboard.press("Enter");
await page.waitForSelector("#check-items li.done");
assert.match(await text("#check-items li.done"), /ＰＴＰ 100錠（10錠×10）・期限 2030-12-31・ロット E2E01/);
await page.keyboard.type("(01)14987114335003");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector("#scan-error").textContent.includes("チェックデジット"));
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-audited .board-card");
assert.match(await text(".toasts"), /調剤監査を保存しました（合わない読み取り 2件も記録）/);
// 投薬待ちの札：指導記録がまだなら「投薬した」は無く、「薬歴・指導記録」でこの来局を選んだ薬歴を開く（患者一覧から探さない）
assert.match(await text(".col-audited .board-card .bc-actions"), /お薬手帳[\s\S]*薬歴・指導記録/);
assert.equal(await page.locator(".col-audited .board-card [data-step]").count(), 0);
await viaOverlay(() => page.click(".col-audited .board-card .btn-primary"), /^\/patient\?id=\d+&rx=[^&]+&reception=\d+$/);
// 受付から開くと、いちばん新しい来局ではなく、その受付の来局が選ばれている
await page.waitForSelector('.visit-card[aria-selected="true"]');
await page.keyboard.press("Alt+K");
await page.waitForSelector("#record-dialog[open]");
const [ty, tm, td] = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).split("-");
assert.match(await text("#record-dialog-title"), new RegExp(`${ty}/${tm}/${td}`)); // 今日の来局
await page.keyboard.type("飲み忘れなし");
await page.locator('#record-form input[name="leftover"][value="none"]').check();
await page.locator("#soap-subjective").focus();
// 保存すると受付状況のその札へ戻り、「投薬した」にカーソルがある
await Promise.all([page.waitForURL(/\/board\?focus=\d+$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-audited .board-card [data-step=handed]");
assert.match(await text(".col-audited .board-card .bc-actions"), /薬歴[\s\S]*お薬手帳[\s\S]*投薬した/);
await page.waitForFunction(() => document.activeElement?.dataset.step === "handed");
await page.click(".col-audited .board-card .btn-primary");
await page.waitForSelector(".col-handed .board-card");
assert.match(await text(".col-handed .board-card .bc-actions"), /領収証・明細書[\s\S]*会計した/);
assert.equal(await page.evaluate(() => document.activeElement.textContent), "会計した");
await page.keyboard.press("Enter");
await page.waitForSelector(".col-paid .board-card");
assert.match(await text(".col-paid .board-card"), /入力 \d\d:\d\d → 監査 \d\d:\d\d → 投薬 \d\d:\d\d → 会計 \d\d:\d\d/);
assert.match(await text(".col-paid .board-card .bc-actions"), /薬歴[\s\S]*お薬手帳[\s\S]*領収証・明細書/); // 会計済みからも開き直せる
// 会計の後でも処方を直せる：1日量を変えると、札は監査待ちに戻り、受け取った額との差が出る。直す前の内容は薬歴の来局カードに残る
await viaOverlay(() => page.click(".col-paid .board-card a:has-text('処方を直す')"), /^\/rx\?patient=5&edit=[^&]+&reception=\d+$/);
await page.waitForFunction(() => document.activeElement?.dataset.field === "qty");
assert.match(await text("#do-note"), /処方を直しています/);
assert.equal(await page.inputValue('[data-field="qty"]'), "1");
await page.keyboard.press("Control+a");
await page.keyboard.type("2");
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-entered .board-card .bc-settle");
assert.match(await text(".toasts"), /処方を直しました[\s\S]*窓口で追加 [\d,]+円を受け取る[\s\S]*調剤監査からやり直し/);
assert.match(await text(".col-entered .board-card .bc-settle"), /受け取り済み [\d,]+円 → 追加で [\d,]+円/);
await page.goto(`${BASE}/patient?id=5`);
await page.waitForSelector(".visit-card .vc-revisions");
assert.match(await text(".visit-card .vc-revisions"), /訂正[\s\S]*ノルバスク錠５ｍｇ 1日量 1 → 2[\s\S]*窓口 [\d,]+円 → [\d,]+円/);
await page.goto(`${BASE}/board`);
await page.waitForSelector(".col-entered .board-card");

// 18-2. 公費：帯の「公費」から受給者証を足す → 処方入力の会計に公費の行が出て、管理票の累計で月の上限まで止まる → 領収証と管理票
step("公費：受給者証を足す → 会計で月の上限まで → 領収証・管理票。薬歴の引き継ぎのチェックリスト");
await page.goto(`${BASE}/patient?id=2`);
await page.waitForSelector("#band [data-kohi]");
assert.equal(await text("#band [data-kohi]"), "なし");
await page.click("#band [data-kohi]");
await page.waitForSelector("#kohi-dialog[open]");
await page.selectOption("#k-kind", "nanbyo");
await page.fill("#k-payer", "54200012");
await page.fill("#k-recipient", "7654321");
await page.fill("#k-from", "2026-04-01");
await page.fill("#k-until", "2027-03-31");
await page.fill("#k-cap", "10000");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelectorAll(".kohi-list tbody tr").length === 1);
assert.match(await text(".kohi-list tbody"), /指定難病[\s\S]*54200012[\s\S]*2割・月 10,000円 まで/);
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.querySelector("#band [data-kohi]").textContent === "難病");
await page.goto(`${BASE}/rx?patient=2`);
await page.waitForSelector("#bill-kohi .kohi-row");
await page.waitForFunction(() => document.activeElement?.dataset.field === "drug");
await page.keyboard.press("Alt+D");
await page.waitForURL(/from=/);
await page.waitForFunction(() => document.querySelector("#bill-charge").textContent !== "—");
const copay = Number((await text("#bill-copay")).replace(/[^\d]/g, ""));
const kohiPay = Number((await text('#bill-kohi [data-kohi-pay]')).replace(/（.*$/, "").replace(/[^\d]/g, ""));
assert.ok(kohiPay < copay, `難病の2割（${kohiPay}円）が3割の一部負担金（${copay}円）より少ない`);
await page.fill("#bill-kohi [data-kohi-prior]", "9950");
await page.waitForFunction(() => document.querySelector("#bill-kohi [data-kohi-pay]").textContent.startsWith("50円（今月の累計 10,000円）"));
assert.match(await text("#bill-charge"), /^50円$/);
await Promise.all([page.waitForURL(/\/patient\?id=2/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(selectedCard);
assert.match(await text(selectedCard), /窓口 50円/);
// 引き継ぎのチェックリスト：押して付ける項目と、指導記録を書くと付く項目
assert.match(await text("#handover"), /引き継ぎ 0\/\d/);
await page.click('#handover [data-check="cautions"]');
await page.waitForSelector('#handover [data-check="cautions"][aria-pressed="true"]');
assert.match(await text("#handover"), /引き継ぎ 1\/\d/);
const rxId2 = await page.evaluate(async () => (await (await fetch("/api/patients/2")).json()).prescriptions[0].id);
await page.goto(`${BASE}/receipt?id=${rxId2}`);
await page.waitForSelector(".kanrihyo");
assert.match(await text(".r-money"), /指定難病の後の負担額[\s\S]*50円[\s\S]*領収額 合計[\s\S]*50円/);
assert.match(await text(".kanrihyo"), /指定難病[\s\S]*7654321[\s\S]*50円[\s\S]*10,000円[\s\S]*10,000円/);

// 19. 在宅：予定（回数の上限）→ 記録（薬歴から報告書の形）→ 報告書の印刷
step("在宅：訪問の予定（週1回まで）・記録・報告書");
await page.goto(`${BASE}/homecare?month=2026-11`);
await page.waitForSelector("#home-list li");
assert.match(await text("#home-list"), /遠藤　和子[\s\S]*2 \/ 4回[\s\S]*計画書 2026\/10\/01/);
await page.keyboard.press("Alt+V");
await page.waitForSelector("#visit-dialog[open]");
assert.match(await text("#v-limit"), /月4回・週1回まで/);
await page.fill("#v-date", "2026-11-06"); // 11/5 と同じ週
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#visit-form [data-error="visitOn"]').textContent.includes("同じ週"));
await page.fill("#v-date", "2026-11-12");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#visit-dialog:not([open])", { state: "attached" });
await page.waitForFunction(() => /3 \/ 4回/.test(document.querySelector("#home-list").textContent)); // 保存の後、一覧を読み直すまで待つ
await page.click('.cal-day[data-date="2026-11-05"] .cal-visit');
await page.waitForSelector("#record-dialog[open]");
await page.fill("#r-storage", "カレンダーで管理");
await page.fill("#r-adherence", "飲み忘れなし");
await page.fill("#r-leftover", "なし");
await page.fill("#r-guidance", "便通の確認");
await page.locator("#r-guidance").focus();
await page.keyboard.press("Alt+G");
await page.waitForFunction(() => document.querySelector("#r-report").value.includes("【今後の方針・提案】"));
assert.match(await page.inputValue("#r-report"), /【服薬状況】飲み忘れなし[\s\S]*【患者・家族の訴え】/);
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#record-dialog:not([open])", { state: "attached" });
await page.waitForSelector('.cal-day[data-date="2026-11-05"] .cal-visit.done');
await page.goto(`${BASE}/homecare-print?kind=reports&month=2026-11&facility=home`);
await page.waitForSelector(".home-sheet");
assert.match(await text("#sheet"), /○○内科クリニック（架空）　山田　先生　御侍史[\s\S]*写し：介護支援専門員 佐々木 様[\s\S]*訪問薬剤管理指導 報告書[\s\S]*2026\/11\/05[\s\S]*【服薬状況】飲み忘れなし/);

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

// ---------- チュートリアル ----------
// 新しいブラウザ（何も見ていない状態）で、各画面を初めて開いたときに一度だけ出ることを確かめる
page = await newPage({ toursSeen: false });
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

// ---------- 多要素認証（最後に。終わったら無効に戻す） ----------
step("多要素認証：設定 → ログインで6桁を求める → 無効にする");
await page.goto(`${BASE}/account`);
await page.waitForSelector(".tour.open");
await page.keyboard.press("Escape");
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

assert.deepEqual(errors, [], "ブラウザのエラー");
await browser.close();
console.log("すべて通りました");
