// 画面の通し確認。
//   前半：マウスを使わず、キーボードだけでログイン → 患者検索 → 薬歴（メモ・指導記録）→ 処方入力 → 保存 まで進める。
//   後半：チュートリアル（初回だけ出る・クリックで送る・対象の部品を囲う・ボタンで再生）を確かめる。
// 使い方：別のターミナルで npm run dev を起動しておき、npm run e2e
// ブラウザは PC に入っている Edge を使う（Playwright のブラウザのダウンロードは不要）。
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:8788";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
async function newPage({ toursSeen }) {
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 1366, height: 768 } });
  // 前半は業務の流れを確かめるので、チュートリアルは見終わった状態にしておく
  if (toursSeen) {
    await context.addInitScript(() => {
      for (const k of ["login", "patients", "patient", "rx", "drugs", "logs", "master"]) localStorage.setItem(`tour:${k}`, "2"); // tour.js の VERSION と揃える
    });
  }
  const p = await context.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept()); // 保存していない入力があるときの「このページを離れますか」
  // 422 は入力の誤りを確かめる手順で意図して出すので除く
  p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("status of 422")) errors.push(m.text()); });
  return p;
}
let page = await newPage({ toursSeen: true });

const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return { id: el.id, field: el.dataset.field ?? null, r: el.dataset.r ?? null, i: el.dataset.i ?? null, tag: el.tagName };
});
const text = (sel) => page.locator(sel).innerText();
const step = (name) => console.log(`- ${name}`);

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
assert.match(await text("#band-alerts"), /副作用歴\s*アムロジピン10mgで下肢のむくみ/);
assert.match(await text("#last-plan"), /前回の留意点（P）[\s\S]*2026\/05\/14[\s\S]*減煙を続けられるよう/);
assert.match(await text("#current-meds"), /ノルバスク錠５ｍｇ[\s\S]*2026\/02\/19（木）から（4回）[\s\S]*アトルバスタチン[\s\S]*2026\/04\/16（木）から（2回）/);
assert.match(await text('.note-group[data-category="handover"]'), /家庭血圧の手帳を毎回持参/);

step("薬歴：処方の推移（薬 × 来局日）");
await page.click("#tab-matrix");
assert.equal(await page.locator("#timeline").isHidden(), true);
const cells = (code) => page.locator(`.matrix tr[data-code="${code}"] td`).evaluateAll((tds) => tds.map((td) => td.className || "-"));
assert.deepEqual(await cells("620000094"), ["start", "on", "on", "stop"]);  // ビオフェルミン：5/14 に中止
assert.deepEqual(await cells("622098501"), ["-", "-", "start", "on"]);     // アトルバスタチン：4/16 に追加
await page.keyboard.press("ArrowLeft");
assert.equal(await page.locator("#timeline").isVisible(), true);
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
assert.match(await text("#band-alerts"), /アレルギー歴\s*ペニシリン系で発疹（本人申告）[\s\S]*副作用歴/);
assert.match(await text('.note-group[data-category="allergy"]'), /ペニシリン系で発疹（本人申告）[\s\S]*デモ 薬剤師/);
await page.locator("#timeline").focus();

// 4. Alt+N で処方入力。薬名 → Enter → 1日量 → Enter → 次の薬 …
step("Alt+N で処方入力へ");
await Promise.all([page.waitForURL(/\/rx\?patient=1$/), page.keyboard.press("Alt+N")]);
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
await Promise.all([page.waitForURL(/\/rx\?patient=1&from=/), page.keyboard.press("Alt+D")]);
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
assert.match(await text("#band"), /シケン　ジロウ[\s\S]*試験　次郎[\s\S]*000007/);

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
await page.goto(`${BASE}/patient?id=6`);
await page.waitForSelector(selectedCard);
// ロキソニン（選）10.65円 × 3 + ムコスタ 10.80円 × 3 = 64.35円 → 6点 × 14日 = 84点。
// 特別の料金：価格差 0.15円 × 3 = 0.45円 → 1点 × 14日 = 14点 → 140円 + 消費税 = 154円
assert.match(await text(selectedCard), /2026\/10\/22[\s\S]*薬剤料 84点[\s\S]*特別の料金 154円[\s\S]*ロキソニン錠６０ｍｇ（選）/);
await Promise.all([page.waitForURL(/\/rx\?patient=6&from=/), page.keyboard.press("Alt+D")]);
await page.waitForSelector("#special-fee:not([hidden])");
assert.equal(await text("#total"), "84点");
assert.equal(await text("#special-fee-yen"), "154円");
assert.match(await text("#special-fee-how"), /14点 × 10円 = 140円 ＋ 消費税/);
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
await page.goto(`${BASE}/patient?id=6`);
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

assert.deepEqual(errors, [], "ブラウザのエラー");
await browser.close();
console.log("すべて通りました");
