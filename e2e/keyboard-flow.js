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
async function newPage({ toursSeen }) {
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1366, height: 768 } });
  // 前半は業務の流れを確かめるので、チュートリアルは見終わった状態にしておく
  if (toursSeen) {
    await context.addInitScript(() => {
      for (const k of ["login", "patients", "patient", "rx", "drugs", "logs", "master", "board", "inspect", "homecare", "tracing", "stats", "messages", "account"]) localStorage.setItem(`tour:${k}`, "3"); // tour.js の VERSION と揃える
    });
  }
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept()); // 保存していない入力があるときの「このページを離れますか」
  // 422（入力の誤り）と 401（多要素認証で違う6桁を入れる）は、確かめる手順で意図して出すので除く
  p.on("console", (m) => { if (m.type() === "error" && !/status of (422|401)/.test(m.text())) errors.push(m.text()); });
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

const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return { id: el.id, field: el.dataset.field ?? null, r: el.dataset.r ?? null, i: el.dataset.i ?? null, tag: el.tagName };
});
const text = (sel) => page.locator(sel).innerText();
const step = (name) => console.log(`- ${name}`);

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
assert.match(await text(selectedCard), /S\s*薬は飲めている[\s\S]*P\s*次回、家庭血圧の手帳を確認[\s\S]*残薬なし[\s\S]*手帳未確認[\s\S]*デモ 薬剤師/);
assert.doesNotMatch(await text(selectedCard), /指導記録 未記載/);
// 前回の留意点は「いちばん新しい来局」の P のまま（古い来局に書き足しても替わらない）
assert.match(await text("#last-plan"), /減煙を続けられるよう/);

// 3-3. Alt+M で患者メモ。アレルギー歴を足すと、上の帯に赤い札が増える
step("Alt+M で患者メモを追加（アレルギー歴は帯に出る）");
await page.keyboard.press("Alt+M");
await page.waitForSelector("#note-dialog[open]");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => document.querySelector('#note-form [data-error="category"]').textContent !== "");
assert.equal(await text('#note-form [data-error="body"]'), "内容を入力してください");
await page.locator('#note-form input[name="category"][value="allergy"]').check();
await page.fill("#note-body", "ペニシリン系で発疹（本人申告）");
await page.locator("#note-body").focus();
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#note-dialog:not([open])", { state: "attached" });
assert.match(await text("#cautions"), /アレルギー[\s\S]*ペニシリン系で発疹（本人申告）[\s\S]*副作用/);
assert.match(await text('[data-category="allergy"]'), /ペニシリン系で発疹（本人申告）[\s\S]*デモ 薬剤師/);
await page.locator("#timeline").focus();

// 4. Alt+N で処方入力。薬名 → Enter → 1日量 → Enter → 次の薬 …
step("Alt+N で処方入力へ");
await viaOverlay("Alt+N", /^\/rx\?patient=1$/);
await page.waitForSelector('[data-field="drug"]');
assert.deepEqual(await focused(), { id: "", field: "drug", r: "0", i: "0", tag: "INPUT" });

step("薬を2つ入れる");
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#suggest li[aria-selected=true]");
assert.match(await text("#suggest li[aria-selected=true]"), /ノルバスク錠５ｍｇ/);
await page.keyboard.press("Enter");
assert.equal((await focused()).field, "qty");
await page.keyboard.type("1");
await page.keyboard.press("Enter");
assert.deepEqual(await focused(), { id: "", field: "drug", r: "0", i: "1", tag: "INPUT" });
await page.keyboard.type("2189015F2054"); // アトルバスタチン錠１０ｍｇ「サワイ」を薬価基準収載医薬品コードで
await page.waitForSelector("#suggest li[aria-selected=true]");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
await page.keyboard.press("Enter");

step("空欄で Enter → 用法 → 日数 → 次の剤");
await page.keyboard.press("Enter");
assert.equal((await focused()).field, "usage");
await page.keyboard.type("1日1回朝食後");
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

// 6. 改定をまたいで比べる：比較日は自動で、選んだ薬の薬価が次に変わる日（2026-04-01）
step("Alt+C で改定後と比べる");
await page.keyboard.press("Alt+C");
await page.waitForFunction(() => document.querySelector("#compare-diff").textContent !== "—");
assert.equal(await page.inputValue("#compare-on"), "2026-04-01");
assert.equal(await text("#compare-total"), "56点");
assert.equal(await text("#compare-diff"), "+28点");
assert.equal(await page.locator("tr.item.changed").count(), 2);

// 6-2. 会計：保存する前に、調剤報酬の合計と窓口で受け取る額が出る
step("会計：調剤技術料・薬学管理料・薬剤料と一部負担金");
assert.equal(await text("#bill-total"), "281点");
assert.equal(await text("#bill-copay"), "840円");
assert.equal(await text("#bill-charge"), "840円");

// 7. 用法を空にして保存 → サーバーの検証で止まり、用法の欄にフォーカスが戻る
step("用法が空なら保存できない（サーバーの検証）");
await page.fill("#usage-0", "");
await page.locator("#usage-0").dispatchEvent("input");
await page.keyboard.press("Control+Enter");
await page.waitForSelector("#errors:not([hidden])");
assert.match(await text("#error-list"), /Rp1：用法を入力してください/);
assert.equal((await focused()).id, "usage-0");

step("用法を戻して Ctrl+Enter で保存");
await page.keyboard.type("1日1回朝食後");
await Promise.all([page.waitForURL(/\/patient\?id=1&saved=/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector('#timeline .visit-card.saved[aria-selected="true"]');
assert.match(await text(selectedCard), /2026\/03\/31[\s\S]*薬剤料 84点/);
// 3/31 は令和6年度の点数表：調剤基本料1 45＋連携強化 5＋後発医薬品調剤体制2 28＋薬剤調製料 24＋調剤管理料 50＋服薬管理指導料 45 ＋ 薬剤料 84 = 281点
// （医療ＤＸ推進体制整備加算は3/19に算定済みで月1回、医療情報取得加算は2/19に算定済みで12月に1回）。3割で 843円 → 840円
assert.match(await text(".toasts"), /処方を保存しました（合計 281点・窓口で 840円）/);

// 8. 前回Do：選んだ処方を複写。薬価は今日の日付で引き直す
step("Alt+D で前回Do");
await viaOverlay("Alt+D", /^\/rx\?patient=1&from=/);
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
await page.keyboard.press("Alt+N");
await page.keyboard.type("試験　次郎");
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

// 11-2. 長期収載品の選定療養：（選）のコードの薬は、保険の薬剤料とは別に特別の料金が出る
step("選定療養：薬歴に特別の料金、前回Do で入力中にも特別の料金");
await page.goto(`${BASE}/patient?id=7`);
await page.waitForSelector(selectedCard);
// ロキソニン（選）10.65円 × 3 + ムコスタ 10.80円 × 3 = 64.35円 → 6点 × 14日 = 84点。
// 特別の料金：価格差 0.15円 × 3 = 0.45円 → 1点 × 14日 = 14点 → 140円 + 消費税 = 154円
assert.match(await text(selectedCard), /2026\/10\/22[\s\S]*薬剤料 84点[\s\S]*特別の料金 154円[\s\S]*ロキソニン錠６０ｍｇ（選）/);
await viaOverlay("Alt+D", /^\/rx\?patient=7&from=/);
await page.waitForFunction(() => document.querySelector("#bill-special").textContent === "154円");
assert.equal(await text("#total"), "84点");
assert.match(await text('tr.item[data-r="0"][data-i="0"] .drug-meta'), /選定療養（患者希望）[\s\S]*価格差 0\.15円\/錠/);
// 11-2-2. 残薬調整：調剤した日数を減らし、Alt+Q で疑義照会を書くと、加算が会計に入る。Alt+H で処方箋の記載を別に書ける
step("残薬調整（日数を減らす・Alt+Q で疑義照会）と、処方箋と違う薬（Alt+H）");
await page.fill("#disp-days-0", "7");
await page.locator("#disp-days-0").dispatchEvent("input");
await page.waitForSelector("#days-change-0:not([hidden])");
await page.keyboard.press("Alt+Q");
await page.waitForSelector('#inquiries [data-qf="content"]');
assert.equal(await page.evaluate(() => document.activeElement.dataset.qf), "content");
await page.keyboard.type("ロキソニンが7日分残っている。14日分を7日分に減らしてよいか");
await page.fill('#inquiries [data-qf="answer"]', "7日分で可");
await page.locator('#inquiries [data-qf="answer"]').dispatchEvent("input");
await page.waitForFunction(() => document.querySelector("#bill-lines").textContent.includes("調剤時残薬調整加算ニ"));
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
await page.keyboard.press("Escape");

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
await viaOverlay("Alt+D", /^\/rx\?patient=4&from=/);
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
await page.waitForSelector('#reception-suggest li[aria-selected="true"]');
await page.keyboard.press("Enter");
await page.waitForSelector(".col-received .board-card");
assert.match(await text(".col-received .board-card"), /宇野　健太[\s\S]*受付 \d\d:\d\d[\s\S]*0分待ち/);
assert.match(await page.evaluate(() => document.activeElement.textContent), /処方を入力/);
await viaOverlay("Enter", /^\/rx\?patient=5&reception=\d+$/);
await page.waitForSelector('[data-field="drug"]');
await page.keyboard.type("のるばすく錠５");
await page.waitForSelector("#suggest li[aria-selected=true]");
await page.keyboard.press("Enter");
await page.keyboard.type("1");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("1日1回朝食後");
await page.keyboard.press("Enter");
await page.keyboard.type("14");
await Promise.all([page.waitForURL(/\/board$/), page.keyboard.press("Control+Enter")]);
await page.waitForSelector(".col-entered .board-card");
await viaOverlay(() => page.click(".col-entered .board-card .btn"), /^\/inspect\?id=/);
await page.waitForFunction(() => document.activeElement?.id === "scan-input");
assert.match(await text("#check-items"), /ノルバスク錠５ｍｇ[\s\S]*総量 14錠[\s\S]*まだ読んでいません/);
assert.equal(await page.locator("#save").isDisabled(), true);
// 違う薬の箱 → 赤。期限切れ → 赤。正しい箱 → チェック。読み取り機は文字と Enter を送る
await page.click("#demo-scan button:has-text('違う薬の箱')");
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
await page.click(".col-audited .board-card .btn");
await page.waitForSelector(".col-handed .board-card");
assert.equal(await page.evaluate(() => document.activeElement.textContent), "会計した");
await page.keyboard.press("Enter");
await page.waitForSelector(".col-paid .board-card");
assert.match(await text(".col-paid .board-card"), /入力 \d\d:\d\d → 監査 \d\d:\d\d → 投薬 \d\d:\d\d → 会計 \d\d:\d\d/);

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
await page.waitForFunction(() => document.querySelector("#receive-patient").options.length > 0);
await page.fill("#receive-body", "血圧の薬を1日飲み忘れました");
await page.click("#receive-form button[type=submit]");
await page.waitForFunction(() => document.querySelector("#chat-head").textContent.includes("小野寺"));

// 21. 薬局の数字
step("薬局の数字（処方箋単価・後発医薬品の使用割合）");
await page.goto(`${BASE}/stats`);
await page.waitForSelector(".chart svg");
assert.equal(await page.locator(".chart").count(), 3);
assert.match(await text("#table"), /2026年10月\s*4\s*[\d,]+円[\s\S]*\d+\.\d%/);

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
assert.equal(await tourCount(), "1 / 3");
assert.match(await text("#tour-title"), /ようこそ/);
assert.equal(await page.locator(".tour-hint").count(), 0, "「どこをクリックしても」の案内は出さない");
await page.mouse.click(30, 30);           // 暗い所をクリックしても
await page.keyboard.press("ArrowRight");  // → を押しても
await page.waitForTimeout(400);
assert.equal(await tourCount(), "1 / 3", "ボタン以外で進んだ");
await nextStep("2 / 3");
assert.ok(await holeCovers(".demo-note"), "穴がデモ用アカウントの枠を囲っていない");
await page.click(".tour-prev");
assert.equal(await tourCount(), "1 / 3");
await page.keyboard.press("Escape");
await waitTourClosed();
await page.reload();
await page.waitForSelector("#login-form");
await page.waitForTimeout(300);
assert.equal(await tourOpen(), false, "一度見たら、もう自動では出ない");
await page.click("#tour-button");
await page.waitForSelector(".tour.open");
// 「次へ」にフォーカスがあるので、Enter はそのボタンを押したことになる
for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
await waitTourClosed();
assert.equal((await focused()).id, "tour-button", "閉じたらフォーカスを元の場所に戻す");

step("チュートリアル：患者一覧（表示中は画面のショートカットが効かない）");
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
// 処方の推移の並べ方：折り返し（表を分けても、開始・中止の印は1つ前の来局と比べたまま）
await page.click('#matrix-shape [data-fold="1"]');
await page.waitForSelector("#matrix-view.folded .matrix-part");
assert.equal(await page.locator("#matrix-view").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
await page.reload();
await page.waitForSelector(selectedCard);
await page.waitForFunction(() => document.querySelector('[data-box="meds"]').style.order === "0");
assert.equal(await page.locator('[data-box="patient"]').evaluate((el) => el.style.gridColumn), "span 3");
assert.equal(await page.getAttribute('#history-shape [data-rows="2"]', "aria-checked"), "true");
assert.equal(await page.getAttribute('#matrix-shape [data-fold="1"]', "aria-checked"), "true");
await page.click("#layout-edit");
await page.click("#layout-reset");
await page.waitForFunction(() => document.querySelector('[data-box="patient"]').style.order === "0");
assert.equal(await page.getAttribute('#history-shape [data-rows="0"]', "aria-checked"), "true");
assert.equal(await page.getAttribute('#matrix-shape [data-fold="0"]', "aria-checked"), "true");

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
await page.click("#open-handbook");
await page.waitForFunction(() => document.querySelector("#overlay-title").textContent === "お薬手帳");
await page.click(".overlay-close");
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.goForward();                                             // 進むで、閉じた窓がまた開く
await page.waitForSelector("dialog.overlay[open]");
await page.goBack();                                                // 戻るで閉じる
await page.waitForSelector("dialog.overlay:not([open])", { state: "attached" });
await page.keyboard.press("Alt+D");
await page.waitForSelector("dialog.overlay[open]");
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
await page.fill("#code", await code(0));
await page.click("#confirm-form button");
await page.waitForFunction(() => document.querySelector("#mfa-state").textContent === "有効");
await page.click("#logout");
await page.waitForURL(/\/login$/);
await page.fill("#login-id", "demo");
await page.fill("#password", "pharmacy-demo");
await page.click("#login-form button[type=submit]");
await page.waitForSelector("#mfa-form:not([hidden])");
assert.equal((await page.request.get(`${BASE}/api/patients`)).status(), 401, "6桁を入れる前に入れてしまう");
await page.fill("#mfa-code", await code(0)); // 設定で使った数字は使い回せない
await page.click("#mfa-form button");
await page.waitForSelector("#mfa-error:not([hidden])");
await Promise.all([page.waitForURL(/\/patients$/), (async () => { await page.fill("#mfa-code", await code(1)); await page.click("#mfa-form button"); })()]);
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
