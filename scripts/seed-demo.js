// デモ用の利用者・架空の患者・薬歴を作り、db/generated/seed.sql に書き出す。npm run db:seed から呼ぶ。
// 薬歴・メモ・指導記録は本番と同じ保存処理を、手元の SQLite に対して実行して作る。
// そのため点数・薬価は、画面から入力した場合と同じ計算で入る。
import { writeFileSync } from "node:fs";
import { openD1 } from "../src/dev/sqlite-d1.js";
import { hashPassword, randomHex, ITERATIONS } from "../src/server/password.js";
import { createPatient } from "../src/server/patients.js";
import { createPrescription } from "../src/server/prescriptions.js";
import { createNote, createRecord } from "../src/server/records.js";

export const DEMO_LOGIN = { loginId: "demo", password: "pharmacy-demo" };

const USERS = [
  { id: 1, loginId: DEMO_LOGIN.loginId, displayName: "デモ 薬剤師", password: DEMO_LOGIN.password },
  // 過去の薬歴の入力者。パスワードは乱数でログインには使わない
  { id: 2, loginId: "sato", displayName: "佐藤 薬剤師", password: randomHex(16) },
];

// 医薬品コード（支払基金の医薬品マスター）。金額は令和8年3月31日まで → 4月1日から
const D = {
  norvasc: "612170710",    // ノルバスク錠５ｍｇ       13.70円 → 10.80円
  atorva: "622098501",     // アトルバスタチン錠１０ｍｇ「サワイ」 13.90円 → 11.50円
  biofermin: "620000094",  // ビオフェルミン錠剤      5.90円 → 6.10円
  loxonin: "620098801",    // ロキソニン錠６０ｍｇ     10.40円 → 10.80円
  loxoninSentei: "670098801", // ロキソニン錠６０ｍｇ（選）：患者希望で先発品。6月1日から 10.65円（価格差の1/2 は 0.15円）
  mucosta: "620452801",    // ムコスタ錠１００ｍｇ     10.40円 → 10.80円
  mucodyne: "610407447",   // ムコダイン錠５００ｍｇ   10.40円 → 10.80円
  calonal: "620002023",    // カロナール錠２００       6.70円 → 6.50円
  magmitt: "610463198",    // マグミット錠３３０ｍｇ   6.30円
  kakkonto: "615101406",   // ツムラ葛根湯エキス顆粒（医療用） 13.40円（1g当たり）
};

// rx：処方箋の記載が調剤した薬と違うときだけ { name, dailyQty, reason }
const item = (drugCode, dailyQty, rx = null) => ({ drugCode, dailyQty, rx });
// 青木さんの経過：降圧剤＋整腸剤で開始 → 4月にスタチン追加 → 5月に整腸剤を中止
const norvasc = (days) => ({ usage: "1日1回朝食後", days, items: [item(D.norvasc, "1")] });
const norvascAtorva = (days) => ({ usage: "1日1回朝食後", days, items: [item(D.norvasc, "1"), item(D.atorva, "1")] });
const biofermin = (days) => ({ usage: "1日3回毎食後", days, items: [item(D.biofermin, "3")] });

// 患者・メモ・指導記録はすべて架空。来局日は令和8年4月の薬価改定をまたぎ、途中で薬の追加・中止・日数の変更が起きるようにしてある。
// 記録の内容は、処方している薬と矛盾しないようにした（例：マグミットの高齢者には腎機能と Mg 値の確認）。
const soap = (s, o, a, p, leftover = "none", notebook = "used") =>
  ({ subjective: s, objective: o, assessment: a, plan: p, leftover, notebook });

const PATIENTS = [
  {
    name: "青木　誠", kana: "アオキ　マコト", birthDate: "1958-06-14", sex: "M", burdenPercent: 30, registeredOn: "2026-02-19",
    notes: [
      { on: "2026-02-19", category: "adverse", body: "アムロジピン10mgで下肢のむくみ（2025年秋、内科で5mgに減量後は消失）" },
      { on: "2026-02-19", category: "disease", body: "高血圧症・脂質異常症（内科で治療中）" },
      { on: "2026-02-19", category: "concomitant", body: "市販の胃腸薬をときどき（銘柄は未確認。次回、現物を見せてもらう）" },
      { on: "2026-02-19", category: "lifestyle", body: "喫煙 1日10本。グレープフルーツはほとんど食べない" },
      { on: "2026-02-19", category: "generic", body: "血圧の薬は先発品のままを希望" },
      { on: "2026-02-19", category: "handover", body: "家庭血圧の手帳を毎回持参する。数値を一緒に見ると話が進む" },
    ],
    visits: [
      {
        on: "2026-02-19", by: 2, rps: [norvasc(28), biofermin(28)],
        record: soap("朝の血圧が140くらい。足のむくみはもうない。お腹がゆるい日が多い",
          "家庭血圧 朝138/86・夜128/80（手帳で確認）",
          "減量後むくみは消失。朝の値がやや高めだが服薬は良好",
          "家庭血圧の記録を続ける。次回、朝の値の推移を確認。禁煙の意向を聞く"),
      },
      // 3/19 は指導記録を書き忘れている（未記載の表示を見せるため）
      { on: "2026-03-19", by: 2, rps: [norvasc(28), biofermin(28)] },
      {
        on: "2026-04-16", by: 2, rps: [norvascAtorva(28), biofermin(28)],
        record: soap("内科で、コレステロールの薬が増えると言われた。4月から薬代が少し安くなった？",
          "LDL 168mg/dL（4月の検査結果の用紙で確認）。アトルバスタチン10mgが新しく追加。薬価改定で薬剤料は下がった",
          "スタチンの開始。筋肉痛・だるさなど初期の副作用に注意が必要",
          "筋肉の痛み・だるさ・尿の色が濃いときは連絡するよう説明。次回、副作用の有無と飲み忘れを確認"),
      },
      {
        on: "2026-05-14", by: 2, rps: [norvascAtorva(28)],
        record: soap("お腹の調子は落ち着いた。筋肉痛はない。たばこを1日5本に減らした",
          "家庭血圧 朝128/82。ビオフェルミンは内科の判断で中止",
          "スタチンの副作用は出ていない。減煙できており、血圧も目標に近づいている",
          "減煙を続けられるよう声をかける。次回、禁煙外来の案内を検討"),
      },
    ],
  },
  {
    name: "石川　美咲", kana: "イシカワ　ミサキ", birthDate: "1990-11-02", sex: "F", burdenPercent: 30, registeredOn: "2026-03-25",
    notes: [
      { on: "2026-03-25", category: "allergy", body: "セフェム系抗菌薬で発疹（2019年、他院）" },
      { on: "2026-03-25", category: "lifestyle", body: "妊娠の可能性なし（2026/03/25 本人に確認）" },
      { on: "2026-03-25", category: "generic", body: "後発品で構わない" },
      { on: "2026-03-25", category: "handover", body: "仕事帰りの受け取りが多い。説明は要点を短く" },
    ],
    visits: [
      {
        on: "2026-03-25", by: 2, handbook: "none", rps: [
          { usage: "1日3回毎食後", days: 5, items: [item(D.loxonin, "3"), item(D.mucosta, "3")] },
          { usage: "1日3回毎食後", days: 5, items: [item(D.mucodyne, "3")] },
        ],
        record: soap("のどが痛く、熱が38度ある",
          "抗菌薬の処方なし。セフェム系の発疹歴は処方医も把握済み（問診票で確認）",
          "解熱鎮痛薬と胃粘膜保護薬の組み合わせで問題なし",
          "空腹時を避けて飲む。3日たっても熱が下がらなければ再受診", "none", "not_used"),
      },
      {
        on: "2026-10-08", by: 2, rps: [
          { usage: "1日3回毎食後", days: 3, items: [item(D.calonal, "6")] },
        ],
        record: soap("頭痛がひどい日だけ飲みたい",
          "カロナール1回2錠。3月に出たロキソニンが3錠残っている",
          "ロキソニンとの重複服用に注意が必要",
          "カロナールを飲んでいる間はロキソニンを飲まない。残薬は次回持参を依頼", "some", "not_used"),
      },
    ],
  },
  {
    name: "遠藤　和子", kana: "エンドウ　カズコ", birthDate: "1945-03-08", sex: "F", burdenPercent: 10, registeredOn: "2026-06-11",
    notes: [
      { on: "2026-06-11", category: "disease", body: "慢性便秘。腎機能がやや低下（eGFR 48、2026/06 内科の検査）" },
      { on: "2026-06-11", category: "concomitant", body: "整形外科でロキソプロフェンのテープ剤" },
      { on: "2026-06-11", category: "generic", body: "後発品で可" },
      { on: "2026-06-11", category: "handover", body: "耳が遠いので正面からゆっくり話す。娘さんが付き添うことが多い" },
    ],
    visits: [
      {
        on: "2026-06-11", by: 2, rps: [
          { usage: "1日3回毎食後", days: 14, items: [item(D.magmitt, "3")] },
          { usage: "1日3回毎食前", days: 7, items: [item(D.kakkonto, "7.5")] },
        ],
        record: soap("便秘が続いている。風邪気味",
          "eGFR 48（検査結果の用紙で確認）",
          "高齢で腎機能が低下しており、マグネシウムがたまりやすい",
          "だるさ・吐き気が出たら連絡するよう説明。次回、血清 Mg 値の検査予定を確認"),
      },
      {
        // 残薬が7日分あったので、処方医に照会して28日分を21日分に減らした（調剤時残薬調整加算）
        on: "2026-09-17", by: 2, rps: [
          { usage: "1日3回毎食後", rxDays: 28, days: 21, daysChange: "inquiry", items: [item(D.magmitt, "3")] },
        ],
        inquiries: [{
          kind: "leftover",
          content: "マグミット錠が7日分残っている（本人と娘さんに確認。昼の飲み忘れ）。28日分を21日分に減らしてよいか",
          answer: "21日分で可（○○内科 医師）",
          changed: true,
        }],
        record: soap("お通じは毎日ある。昼の薬を飲み忘れることがある",
          "血清 Mg 2.4mg/dL（8月の検査）。マグミット錠の残薬 7日分（21錠）",
          "Mg 値は基準内。便秘は改善",
          "症状の聞き取りを続ける。Mg 値の定期測定を処方医に確認"),
      },
    ],
  },
  { name: "宇野　健太", kana: "ウノ　ケンタ", birthDate: "2001-08-20", sex: "M", burdenPercent: 30, registeredOn: "2026-10-30", notes: [], visits: [] },
  {
    name: "小野寺　隆", kana: "オノデラ　タカシ", birthDate: "1972-01-30", sex: "M", burdenPercent: 30, registeredOn: "2026-10-28",
    notes: [
      { on: "2026-10-28", category: "disease", body: "高血圧症・脂質異常症（2026/10 から治療開始）" },
      { on: "2026-10-28", category: "lifestyle", body: "飲酒 毎日ビール500mL" },
    ],
    // 最新の来局は指導記録が未記載のまま（薬歴画面の「未記載」の表示を見せるため）
    // 処方箋はアトルバスタチンが一般名で書かれていて、薬局で銘柄を選んだ
    visits: [{
      on: "2026-10-28", by: 2, rps: [{
        usage: "1日1回朝食後", days: 14, items: [
          item(D.norvasc, "1"),
          item(D.atorva, "1", { name: "【般】アトルバスタチン錠１０ｍｇ", dailyQty: "1", reason: "general" }),
        ],
      }],
    }],
  },
  {
    // 長期収載品の選定療養：後発品があるのに先発品を希望した患者。薬剤料は（選）の金額で、特別の料金を別に受け取る
    name: "加藤　真一", kana: "カトウ　シンイチ", birthDate: "1966-04-22", sex: "M", burdenPercent: 30, registeredOn: "2026-10-22",
    notes: [
      { on: "2026-10-22", category: "generic", body: "ロキソニンは先発品を希望。選定療養の特別の料金がかかることを説明し、了承済み（2026/10/22）" },
      { on: "2026-10-22", category: "disease", body: "腰痛症（整形外科）" },
    ],
    visits: [{
      on: "2026-10-22", by: 2, handbook: "electronic", rps: [
        { usage: "1日3回毎食後", days: 14, items: [item(D.loxoninSentei, "3"), item(D.mucosta, "3")] },
      ],
      record: soap("前に後発品で胃が荒れた気がするので、先発品にしてほしい",
        "後発品で胃の不調があったとの申告（時期・銘柄は不明）。他に飲んでいる薬はない",
        "医師の指示は後発品可。先発品は本人の希望",
        "先発品を希望する場合は特別の料金（選定療養）がかかることを説明。胃の症状が続くときは受診を勧めた"),
    }],
  },
];

// 薬局（架空）。領収証・お薬手帳に出す
const PHARMACY = {
  name: "サンプル薬局（デモ用・架空）", prefectureCode: "13", pharmacyCode: "9999999",
  postalCode: "100-0000", address: "東京都千代田区（架空の住所）", phone: "03-0000-0000",
};
// 届出（施設基準）。令和8年6月の改定で区分の名前と点数が変わるので、改定日に届け直した形にする
const FACILITY = [
  { validFrom: "2025-04-01", basicFee: "1", communitySupport: 0, renkei: 1, genericSystem: 2, iryoDx: 3, iryoJoho: 1, denshiRenkei: 0, baseUp: 0 },
  { validFrom: "2026-06-01", basicFee: "1", communitySupport: 1, renkei: 1, genericSystem: 0, iryoDx: 0, iryoJoho: 0, denshiRenkei: 1, baseUp: 1 },
];

const OUT = "db/generated/seed.sql";
const db = openD1("db/schema.sql", "db/generated/master.sql");

await db.prepare(`INSERT INTO pharmacy_profile (id, name, prefecture_code, pharmacy_code, postal_code, address, phone)
                  VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)`)
  .bind(PHARMACY.name, PHARMACY.prefectureCode, PHARMACY.pharmacyCode, PHARMACY.postalCode, PHARMACY.address, PHARMACY.phone).run();
for (const f of FACILITY) {
  await db.prepare(`INSERT INTO pharmacy_facility (valid_from, basic_fee, community_support, renkei, generic_system, iryo_dx, iryo_joho, denshi_renkei, base_up)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(f.validFrom, f.basicFee, f.communitySupport, f.renkei, f.genericSystem, f.iryoDx, f.iryoJoho, f.denshiRenkei, f.baseUp).run();
}

for (const u of USERS) {
  const salt = randomHex(16);
  await db
    .prepare("INSERT INTO users (id, login_id, display_name, password_hash, password_salt, password_iterations) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(u.id, u.loginId, u.displayName, await hashPassword(u.password, salt), salt, ITERATIONS)
    .run();
}

// 日時は来局日の日中にしておく（実行した日時のままだと、過去の薬歴として不自然になる）
const at = (date, hhmm) => `${date}T${hhmm}:00.000Z`;
for (const p of PATIENTS) {
  const { id } = await createPatient(db, { id: 2 }, p);
  await db.prepare("UPDATE patients SET created_at = ?1 WHERE id = ?2").bind(at(p.registeredOn, "01:00"), id).run();
  for (const n of p.notes) {
    const note = await createNote(db, { id: 2 }, id, n);
    await db.prepare("UPDATE patient_notes SET created_at = ?1 WHERE id = ?2").bind(at(n.on, "01:10"), note.id).run();
  }
  for (const v of p.visits) {
    const rx = await createPrescription(db, { id: v.by }, {
      patientId: id, prescribedOn: v.on, dispensedOn: v.on, handbook: v.handbook ?? "paper", inquiries: v.inquiries ?? [],
      rps: v.rps.map((rp) => ({ rxDays: rp.days, daysChange: null, ...rp })),
    });
    await db.prepare("UPDATE prescriptions SET created_at = ?1 WHERE id = ?2").bind(at(v.on, "01:30"), rx.id).run();
    await db.prepare("UPDATE inquiries SET created_at = ?1 WHERE prescription_id = ?2").bind(at(v.on, "01:20"), rx.id).run();
    if (v.record) {
      const rec = await createRecord(db, { id: v.by }, rx.id, v.record);
      await db.prepare("UPDATE guidance_records SET created_at = ?1 WHERE id = ?2").bind(at(v.on, "01:45"), rec.id).run();
    }
  }
}

// 作った行を INSERT 文にして書き出す。アクセスログは本物の操作だけを残したいので書き出さない
const TABLES = ["pharmacy_profile", "pharmacy_facility", "users", "patients", "patient_notes", "prescriptions", "prescription_rps",
  "prescription_items", "inquiries", "prescription_fees", "guidance_records"];
const lines = ["DELETE FROM access_logs;", "DELETE FROM sessions;", ...[...TABLES].reverse().map((t) => `DELETE FROM ${t};`)];
for (const t of TABLES) {
  const { results } = await db.prepare(`SELECT * FROM ${t}`).all();
  for (const row of results) {
    const cols = Object.keys(row);
    lines.push(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`);
  }
}
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

const n = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
console.log(`利用者 ${await n("users")} / 患者 ${await n("patients")} / メモ ${await n("patient_notes")} / 処方 ${await n("prescriptions")} / 指導記録 ${await n("guidance_records")} → ${OUT}`);
console.log(`デモ用ログイン  ID: ${DEMO_LOGIN.loginId}  パスワード: ${DEMO_LOGIN.password}`);

function sqlValue(v) {
  if (v === null) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
