-- テーブル定義。npm run db:init で空の状態から作り直す。
-- 金額は全て「銭（1/100円）の整数」、1日量は「1/1000単位の整数」で持つ（小数の誤差を持ち込まない）。
-- 日付は 'YYYY-MM-DD' の文字列。文字列のまま大小比較できる。

DROP TABLE IF EXISTS user_layouts;
DROP TABLE IF EXISTS patient_memos;
DROP TABLE IF EXISTS access_logs;
DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS line_messages;
DROP TABLE IF EXISTS inspection_scans;
DROP TABLE IF EXISTS inspections;
DROP TABLE IF EXISTS reception_steps;
DROP TABLE IF EXISTS visit_records;
DROP TABLE IF EXISTS visit_schedules;
DROP TABLE IF EXISTS care_plans;
DROP TABLE IF EXISTS home_patients;
DROP TABLE IF EXISTS facilities;
DROP TABLE IF EXISTS tracing_reports;
DROP TABLE IF EXISTS guidance_templates;
DROP TABLE IF EXISTS measurements;
DROP TABLE IF EXISTS guidance_records;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS patient_notes;
DROP TABLE IF EXISTS handover_checks;
DROP TABLE IF EXISTS prescription_kohi;
DROP TABLE IF EXISTS patient_kohi;
DROP TABLE IF EXISTS prescription_fees;
DROP TABLE IF EXISTS inquiries;
DROP TABLE IF EXISTS prescription_items;
DROP TABLE IF EXISTS prescription_rps;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS receptions;
DROP TABLE IF EXISTS patients;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS staging_fee_rows;
DROP TABLE IF EXISTS staging_rows;
DROP TABLE IF EXISTS pending_imports;
DROP TABLE IF EXISTS fee_points;
DROP TABLE IF EXISTS fee_items;
DROP TABLE IF EXISTS drug_prices;
DROP TABLE IF EXISTS drug_packages;
DROP TABLE IF EXISTS generic_flags;
DROP TABLE IF EXISTS drugs;
DROP TABLE IF EXISTS master_imports;
DROP TABLE IF EXISTS pharmacy_facility;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS pharmacies;

-- 薬価と調剤報酬の点数の出どころは、社会保険診療報酬支払基金（医療情報基盤・診療報酬審査支払機構）の基本マスター。
--   医薬品マスター   … 全件ファイル（y_ALL….csv）と改定分ファイル（y_….csv）。内用薬だけを入れる
--   調剤行為マスター … 全件ファイル（m….csv）。調剤基本料・薬剤調製料・薬学管理料などの算定項目と点数
-- 公表されるたびに取り込む。どちらも1行が「変更年月日から、この内容」を表す。

-- 取り込んだマスターのファイル
CREATE TABLE master_imports (
  id            INTEGER PRIMARY KEY,
  master        TEXT NOT NULL CHECK (master IN ('drug', 'fee')), -- 医薬品マスター / 調剤行為マスター
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'diff')), -- 全件 / 改定分
  published_on  TEXT NOT NULL,          -- 支払基金の公表日
  file_name     TEXT NOT NULL,
  row_count     INTEGER NOT NULL,       -- 取り込んだ行（内用薬）
  changed_count INTEGER NOT NULL,       -- 薬価の履歴に書いた行
  imported_at   TEXT NOT NULL,
  imported_by   INTEGER REFERENCES users(id), -- 初期データは NULL
  pending_id    TEXT NOT NULL UNIQUE    -- 取り込み中の作業（pending_imports.id）との対応
);

-- 薬（医薬品コードごと）。名称などは、公表日がいちばん新しいマスターの内容にする。
-- 長期収載品は、医療上必要な場合のコード（sentei = 1）と、患者希望で選定療養になるコード（sentei = 2、名称の末尾が「（選）」）が別にある。
CREATE TABLE drugs (
  code               TEXT PRIMARY KEY,  -- 医薬品コード（レセプト電算処理用、9桁）
  yj_code            TEXT NOT NULL,     -- 薬価基準収載医薬品コード（12桁）
  name               TEXT NOT NULL,     -- 基本漢字名称（品名）
  unit               TEXT NOT NULL,     -- 薬価の単位（錠、g、mL …）。薬価はこの単位1つ当たり
  generic            INTEGER NOT NULL CHECK (generic IN (0, 1)), -- 加算等の算定対象となる後発医薬品
  general_name       TEXT,              -- 一般名処方の標準的な記載（無い薬もある）
  sentei             INTEGER NOT NULL CHECK (sentei IN (0, 1, 2)), -- 選定療養区分
  pair_code          TEXT,              -- sentei = 2 のとき、対になる sentei = 1 のコード
  narcotic           INTEGER NOT NULL CHECK (narcotic IN (0, 1, 2, 3, 5)), -- 1 麻薬 2 毒薬 3 覚醒剤原料 5 向精神薬（薬剤調製料の加算）
  name_key           TEXT NOT NULL,     -- 検索用（全角半角・ひらがなカタカナを揃えた品名）
  general_key        TEXT NOT NULL,     -- 検索用（同じく一般名）
  attrs_published_on TEXT NOT NULL      -- 名称などを取ったマスターの公表日
);

-- 薬価の履歴。「ある日付時点の薬価」は、その日付以前で最も新しい valid_from の行。
-- マスターの1行は「変更年月日から、この薬価」を表すので、その日に薬価や経過措置が変わるときだけ行を足す。
CREATE TABLE drug_prices (
  drug_code          TEXT NOT NULL REFERENCES drugs(code),
  valid_from         TEXT NOT NULL,     -- 適用開始日（マスターの変更年月日。廃止は廃止年月日の翌日）
  import_id          INTEGER NOT NULL REFERENCES master_imports(id),
  price_sen          INTEGER,           -- NULL＝この日以降は使えない（廃止・抹消・マスターから消えた）
  transitional_until TEXT,              -- 経過措置による使用期限（この日まで使える）
  PRIMARY KEY (drug_code, valid_from)
);

CREATE INDEX idx_drugs_name_key ON drugs(name_key);

-- 薬の箱のバーコード（GS1 の GTIN-14）→ 医薬品コード。調剤監査で、取り出した薬が処方と合っているかを照合する。
-- 出どころは MEDIS（医療情報システム開発センター）の「医薬品HOTコードマスター」販売包装単位コード付き版。
-- 医薬品マスターとは別に公表されるので、drugs への外部キーは付けない（内用薬以外の行や、マスターに無いコードもある）。
CREATE TABLE drug_packages (
  gtin       TEXT PRIMARY KEY CHECK (length(gtin) = 14), -- 販売包装単位コード
  drug_code  TEXT NOT NULL,             -- レセプト電算処理システムコード（医薬品コード）
  hot_code   TEXT NOT NULL,             -- HOTコード（13桁）
  package    TEXT NOT NULL              -- 包装（例：ＰＴＰ 10錠×10）
);

CREATE INDEX idx_drug_packages_drug ON drug_packages(drug_code);

-- 後発医薬品の使用割合の分母に入れる薬。厚生労働省「薬価基準収載品目リスト」の
-- 「同一剤形・規格の後発医薬品がある先発医薬品」欄に印がある品目（薬価基準収載医薬品コード単位）。
-- 分子の「後発医薬品」は医薬品マスターの後発品区分（drugs.generic）を使う。
CREATE TABLE generic_flags (
  yj_code   TEXT PRIMARY KEY,
  list_date TEXT NOT NULL               -- 使ったリストの適用日
);

-- 調剤報酬の算定項目（調剤行為コードごと）
CREATE TABLE fee_items (
  code               TEXT PRIMARY KEY,  -- 調剤行為コード（9桁、先頭は4）
  name               TEXT NOT NULL,     -- いちばん新しいマスターの漢字名称
  attrs_published_on TEXT NOT NULL
);

-- 算定項目の点数と名称の履歴。考え方は drug_prices と同じ。
-- 名称も日付で持つ（改定で同じコードの名称が変わることがある。例：440012210 は令和6年度「服薬管理指導料（３月以内再度処方箋以外）」、
-- 令和8年度「服薬管理指導料２（イ）（かかりつけ・３月内以外）」）
CREATE TABLE fee_points (
  code        TEXT NOT NULL REFERENCES fee_items(code),
  valid_from  TEXT NOT NULL,
  import_id   INTEGER NOT NULL REFERENCES master_imports(id),
  name        TEXT,                     -- その日の名称（明細書に出す）。NULL＝廃止
  point_kind  TEXT,                     -- 3 点数 5 %加算 6 %減算 7 分数減算 8 整数倍 9 点数（マイナス）。NULL＝廃止
  points_x100 INTEGER,                  -- 点数の100倍（マスターは下2桁を小数で持つ）。NULL＝この日以降は使えない
  PRIMARY KEY (code, valid_from)
);

-- 取り込み中のマスター。ブラウザが読んだ行を何回かに分けて送り、ここに貯める。
-- 「取り込む」で1つのトランザクションとして drugs / drug_prices に反映し、ここは消す。途中で止めたら、ここを消すだけで元のまま。
CREATE TABLE pending_imports (
  id            TEXT PRIMARY KEY,
  master        TEXT NOT NULL CHECK (master IN ('drug', 'fee')),
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'diff')),
  published_on  TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  expected_rows INTEGER NOT NULL CHECK (expected_rows > 0),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- 取り込み中の行。改定分のファイルは変わった項目しか入っていないので、NULL＝「この項目は変更なし」。
-- 空文字＝「値なし」（一般名が無い・経過措置が無い・廃止年月日が無い など）。
CREATE TABLE staging_rows (
  pending_id         TEXT NOT NULL REFERENCES pending_imports(id),
  line_no            INTEGER NOT NULL,  -- ファイルの行番号
  change_kind        TEXT NOT NULL CHECK (change_kind IN ('0', '1', '3', '5', '9')), -- 変更区分
  code               TEXT NOT NULL CHECK (length(code) = 9 AND code GLOB '6[0-9]*'),
  yj_code            TEXT,
  name               TEXT,
  unit               TEXT,
  generic            INTEGER CHECK (generic IN (0, 1)),
  general_name       TEXT,
  general_key        TEXT,
  name_key           TEXT,
  sentei             INTEGER CHECK (sentei IN (0, 1, 2)),
  pair_code          TEXT,
  narcotic           INTEGER CHECK (narcotic IN (0, 1, 2, 3, 5)),
  price_sen          INTEGER CHECK (price_sen >= 0),
  change_date        TEXT NOT NULL CHECK (change_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date           TEXT CHECK (end_date = '' OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  transitional_until TEXT CHECK (transitional_until = '' OR transitional_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (pending_id, code)
);

-- 取り込み中の調剤行為マスターの行（全件ファイルだけなので、どの項目も入っている）
CREATE TABLE staging_fee_rows (
  pending_id  TEXT NOT NULL REFERENCES pending_imports(id),
  line_no     INTEGER NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('0', '3', '5', '9')),
  code        TEXT NOT NULL CHECK (length(code) = 9 AND code GLOB '4[0-9]*'),
  name        TEXT NOT NULL,
  point_kind  TEXT NOT NULL CHECK (point_kind IN ('3', '5', '6', '7', '8', '9')),
  points_x100 INTEGER NOT NULL CHECK (points_x100 >= 0),
  change_date TEXT NOT NULL CHECK (change_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date    TEXT NOT NULL CHECK (end_date = '' OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (pending_id, code)
);

-- 薬局。1つの DB を全国の薬局で使うので、利用者・患者・施設・テンプレート・届出は必ずどれかの薬局に属する。
-- 患者の下にある行（処方・メモ・指導記録など）は患者を通して薬局が決まる。薬価・点数のマスターは全薬局で共通。
-- 列は領収証・お薬手帳に出す情報
CREATE TABLE pharmacies (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  prefecture_code TEXT NOT NULL,        -- 都道府県番号（2桁）
  pharmacy_code   TEXT NOT NULL,        -- 薬局コード（7桁）
  postal_code     TEXT NOT NULL,
  address         TEXT NOT NULL,
  phone           TEXT NOT NULL
);

-- 薬局が地方厚生局に届け出た施設基準（調剤基本料の区分と加算）。届出は変わるので、適用開始日ごとに持つ。
-- 列は令和6年度・令和8年度の点数表の両方の区分を持ち、その時期に無い区分は 0 にする。
CREATE TABLE pharmacy_facility (
  pharmacy_id       INTEGER NOT NULL REFERENCES pharmacies(id),
  valid_from        TEXT NOT NULL,
  basic_fee         TEXT NOT NULL CHECK (basic_fee IN ('1', '2', '3i', '3ro', '3ha')), -- 調剤基本料の区分
  community_support INTEGER NOT NULL CHECK (community_support BETWEEN 0 AND 5), -- 地域支援体制加算（R6：1〜4）／地域支援・医薬品供給対応体制加算（R8：1〜5）
  renkei            INTEGER NOT NULL CHECK (renkei IN (0, 1)),          -- 連携強化加算
  generic_system    INTEGER NOT NULL CHECK (generic_system BETWEEN 0 AND 3), -- 後発医薬品調剤体制加算（R6 のみ）
  iryo_dx           INTEGER NOT NULL CHECK (iryo_dx BETWEEN 0 AND 3),   -- 医療ＤＸ推進体制整備加算（R6 のみ）
  iryo_joho         INTEGER NOT NULL CHECK (iryo_joho IN (0, 1)),       -- 医療情報取得加算の施設基準（R6 のみ）
  denshi_renkei     INTEGER NOT NULL CHECK (denshi_renkei IN (0, 1)),   -- 電子的調剤情報連携体制整備加算（R8 のみ）
  base_up           INTEGER NOT NULL CHECK (base_up IN (0, 1)),         -- 調剤ベースアップ評価料（R8 のみ）
  PRIMARY KEY (pharmacy_id, valid_from)
);

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  pharmacy_id         INTEGER NOT NULL REFERENCES pharmacies(id), -- 勤めている薬局。この薬局のデータだけを見られる
  login_id            TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,    -- PBKDF2-SHA256 の結果（16進）
  password_salt       TEXT NOT NULL,    -- ユーザーごとのランダムな塩（16進）
  password_iterations INTEGER NOT NULL,
  -- 多要素認証（スマホの認証アプリが30秒ごとに出す6桁の数字。RFC 6238 の TOTP）
  totp_secret         TEXT,             -- 認証アプリと共有する秘密（Base32）。NULL＝未設定
  totp_pending_secret TEXT,             -- 設定の途中（QR を読ませて、6桁の確認が済むまで）
  totp_last_step      INTEGER           -- 最後に使った6桁の時刻の区切り（同じ数字を2回使わせない）
);

-- パスワードが合って、6桁の数字を待っている状態（5分）。Cookie にはトークン、DB にはそのハッシュだけを置く
CREATE TABLE mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- ログイン中のセッション。Cookie にはランダムなトークンを渡し、DB にはそのハッシュだけを置く。
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE patients (
  id         INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  patient_no TEXT NOT NULL,             -- 画面に出す患者番号（薬局ごとに6桁の連番）
  name       TEXT NOT NULL,
  kana       TEXT NOT NULL,             -- 全角カタカナ
  birth_date TEXT NOT NULL,
  sex        TEXT NOT NULL CHECK (sex IN ('M', 'F')),
  burden_percent INTEGER NOT NULL CHECK (burden_percent IN (0, 10, 20, 30)), -- 一部負担金の割合（保険証の負担割合）。0＝生活保護・一部負担金の免除。年齢で標準が決まる（burden.js）
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  burden_checked_on TEXT,               -- 負担割合を資格確認で最後に確かめた日。この日より後に年齢で割合が変わる日が来たら、確認の窓を出す
  burden_reason TEXT CHECK (burden_reason IN ('disability', 'exempt', 'welfare')), -- 年齢の標準から外れる理由（burden.js）。NULL＝年齢の標準
  burden_until  TEXT,                  -- 一部負担金の免除の期限（burden_reason = 'exempt' のとき）
  UNIQUE (pharmacy_id, patient_no)
);

CREATE INDEX idx_patients_kana ON patients(pharmacy_id, kana);

-- 受付（処方箋を受け取った時刻）。業務の進み具合（入力・監査・投薬・会計）は reception_steps に1行ずつ足す
CREATE TABLE receptions (
  id          INTEGER PRIMARY KEY,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  received_at TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_receptions_at ON receptions(received_at);

-- 処方（処方箋1枚分）
CREATE TABLE prescriptions (
  id            TEXT PRIMARY KEY,       -- サーバーで採番（明細と同じトランザクションで入れるため）
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  prescribed_on TEXT NOT NULL,          -- 処方箋の交付日
  dispensed_on  TEXT NOT NULL,          -- 調剤日。薬価と点数はこの日付で引く
  handbook      TEXT NOT NULL CHECK (handbook IN ('paper', 'electronic', 'none')), -- お薬手帳の提示（紙・電子版・なし）
  drug_points   INTEGER NOT NULL,       -- 薬剤料（選定療養の品目は保険給付の分）
  total_points  INTEGER NOT NULL,       -- 調剤技術料・薬学管理料・薬剤料・その他の合計
  burden_percent INTEGER NOT NULL,      -- 保存した時点の負担割合
  burden_reason  TEXT,                  -- 保存した時点の負担割合の理由（patients.burden_reason）
  copay_yen     INTEGER NOT NULL,       -- 一部負担金（円）。合計点数 × 10円 × 負担割合 を10円未満四捨五入
  special_fee_yen INTEGER,              -- 選定療養の特別の料金（消費税込み、円）。対象の薬が無ければ NULL
  special_fee_method TEXT CHECK (special_fee_method IN ('points', 'amount')), -- 計算方法（調剤日で決まる）
  reception_id  INTEGER UNIQUE REFERENCES receptions(id), -- 受付から入力したとき（受付1件に処方1枚）
  created_at    TEXT NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  CHECK (prescribed_on <= dispensed_on)
);

CREATE INDEX idx_prescriptions_patient ON prescriptions(patient_id, dispensed_on);

-- 剤（Rp）。薬剤料は剤ごとに「1日分の薬価合計 → 点数」を出すので、この単位が要る。
CREATE TABLE prescription_rps (
  id              TEXT PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  rp_no           INTEGER NOT NULL,     -- Rp1, Rp2 …
  usage           TEXT NOT NULL,        -- 用法（1日3回毎食後 など）
  rx_days         INTEGER NOT NULL CHECK (rx_days > 0), -- 処方箋に書かれた日数
  days            INTEGER NOT NULL CHECK (days > 0),    -- 調剤した日数
  days_change     TEXT CHECK (days_change IN ('inquiry', 'instruction')), -- 日数を変えた根拠：処方医への照会／処方箋の減数調剤の指示
  daily_yen       TEXT NOT NULL,        -- 1日分の薬価合計（表示用。小数第2位まで）
  points_per_day  INTEGER NOT NULL,
  points          INTEGER NOT NULL,     -- points_per_day × days
  special_points  INTEGER,              -- 選定療養の特別の料金を点数で出す期間だけ：この剤の分（1日分の点数 × 日数）
  CHECK ((days = rx_days) = (days_change IS NULL)),
  UNIQUE (prescription_id, rp_no)
);

-- 剤の中の薬。使った薬価を保存時点の値で残す（後で薬価マスタが変わっても、算定した額は変わらない）。
CREATE TABLE prescription_items (
  rp_id           TEXT NOT NULL REFERENCES prescription_rps(id),
  line_no         INTEGER NOT NULL,
  drug_code       TEXT NOT NULL REFERENCES drugs(code), -- 調剤した（渡した）薬
  daily_qty_milli INTEGER NOT NULL CHECK (daily_qty_milli > 0),
  rx_name         TEXT,                 -- 処方箋に書かれた薬（NULL＝調剤した薬と同じ）
  rx_daily_qty_milli INTEGER CHECK (rx_daily_qty_milli > 0),
  change_reason   TEXT CHECK (change_reason IN ('general', 'generic', 'inquiry')), -- 一般名処方の銘柄選択／後発品への変更調剤／照会による変更
  price_sen       INTEGER NOT NULL,     -- 調剤日時点の薬価（選定療養の品目は「保険外併用療養費の算出に用いる価格」）
  special_diff_sen INTEGER,             -- 選定療養の品目だけ：長期収載品と後発医薬品の価格差の1/2（令和8年5月までは1/4）
  CHECK ((rx_name IS NULL) = (change_reason IS NULL) AND (rx_name IS NULL) = (rx_daily_qty_milli IS NULL)),
  PRIMARY KEY (rp_id, line_no)
);

-- 疑義照会（処方医への問い合わせ）。残薬調整か、重複投薬・相互作用など（薬学的有害事象等の防止）か
CREATE TABLE inquiries (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  kind            TEXT NOT NULL CHECK (kind IN ('leftover', 'adverse')),
  content         TEXT NOT NULL,        -- 問い合わせた内容
  answer          TEXT NOT NULL,        -- 処方医の回答
  changed         INTEGER NOT NULL CHECK (changed IN (0, 1)), -- 処方が変わったか
  short_reason    TEXT,                 -- 残薬調整で6日分以下の変更をした理由（加算を算定するときに明細書へ書く）
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);

-- 算定した項目（明細書の行）。薬剤料は剤ごと（prescription_rps）に持つので、ここには入れない
CREATE TABLE prescription_fees (
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  line_no         INTEGER NOT NULL,
  section         TEXT NOT NULL CHECK (section IN ('tech', 'mgmt', 'other')), -- 調剤技術料／薬学管理料／その他
  code            TEXT NOT NULL REFERENCES fee_items(code),
  name            TEXT NOT NULL,
  points          INTEGER NOT NULL,     -- 1回の点数
  count           INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (prescription_id, line_no)
);

CREATE INDEX idx_prescription_fees_code ON prescription_fees(code);

-- 来局ごとの引き継ぎの確認（薬剤師が付ける項目）。付ける・外すたびに行を足し、項目ごとに最後の行が今の状態
--   plan：前回の申し送り（P）に今日応えた／cautions：アレルギー・副作用歴・併用薬を今日の処方と照らした／change：処方が変わった理由を聞いた
CREATE TABLE handover_checks (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  item            TEXT NOT NULL CHECK (item IN ('plan', 'cautions', 'change')),
  checked         INTEGER NOT NULL CHECK (checked IN (0, 1)),
  at              TEXT NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_handover_checks_rx ON handover_checks(prescription_id, id);

-- 公費（受給者証）。1枚の受給者証が1行。更新されたら新しい行を足す。計算の規則は kohi.js
CREATE TABLE patient_kohi (
  id            INTEGER PRIMARY KEY,
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  kind          TEXT NOT NULL CHECK (kind IN ('mental', 'childchronic', 'nanbyo', 'local')), -- 精神通院 21・小児慢性 52・難病 54・自治体の助成
  payer_no      TEXT NOT NULL,          -- 公費負担者番号（8桁。先頭2桁が法別番号）
  recipient_no  TEXT NOT NULL,          -- 受給者番号
  local_name    TEXT,                   -- 自治体の助成の名前（例：子ども医療費助成（上田市））
  local_form    TEXT CHECK (local_form IN ('free', 'perVisit', 'cap')), -- 自治体の助成の、薬局での負担の形
  per_visit_yen INTEGER,                -- 1回いくら（local_form = 'perVisit'）
  cap_yen       INTEGER,                -- 自己負担の上限月額。NULL＝上限なし
  valid_from    TEXT NOT NULL,
  valid_until   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_patient_kohi_patient ON patient_kohi(patient_id);

-- 処方に使った公費と、その公費をかけた後の患者の負担。順は国の公費 → 自治体の助成。
-- 最後の行の pay_yen が窓口で受け取る保険の分（無ければ prescriptions.copay_yen）。管理票に書く累計は prior_month_yen + pay_yen
CREATE TABLE prescription_kohi (
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  order_no        INTEGER NOT NULL,
  kohi_id         INTEGER NOT NULL REFERENCES patient_kohi(id),
  prior_month_yen INTEGER,              -- 管理票のこの来局より前の今月の累計（月の上限のある公費だけ）
  pay_yen         INTEGER NOT NULL,
  PRIMARY KEY (prescription_id, order_no)
);

-- 患者ごとのメモ（来局をまたいで引き継ぐ情報）。分類は服薬管理指導料の通知が薬歴への記載を求める項目に合わせる。
-- 1行が1件（アレルギー1つ、併用薬1つ）。直すときは行を書き換えず、直した内容を新しい行として足し、revises で直す前の行を指す。
-- 今の内容は「どの行からも revises で指されていない行」。直す前の内容は消えずに残る（誰が・いつ・何を直したかが追える）。
CREATE TABLE patient_notes (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  category   TEXT NOT NULL CHECK (category IN ('allergy', 'adverse', 'disease', 'concomitant', 'lifestyle', 'generic', 'handover')),
  body       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('manual', 'conversation')), -- 手で書いた／服薬指導の会話から拾って薬剤師が確かめた
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  revises    INTEGER REFERENCES patient_notes(id) -- 直す前の行。NULL＝最初に書いた行
);

CREATE INDEX idx_patient_notes_patient ON patient_notes(patient_id, created_at);
-- 同じ行を2人が同時に直したら、後の方を失敗させる（片方の修正が黙って消えない）
CREATE UNIQUE INDEX idx_patient_notes_revises ON patient_notes(revises);

-- 検査値・体重。処方箋に印字された検査値、検査結果の用紙、薬局での聞き取りなどから入れる。
-- 値は小数を持ち込まないよう 1000倍の整数にする（eGFR 48 → 48000、PT-INR 1.25 → 1250）。項目は lab-items.js
CREATE TABLE measurements (
  id          INTEGER PRIMARY KEY,
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  item        TEXT NOT NULL CHECK (item IN ('weight', 'wbc', 'hb', 'plt', 'ast', 'alt', 'tbil', 'cr', 'egfr', 'k', 'ck', 'hba1c', 'ptinr', 'mg', 'ldl')),
  value_milli INTEGER NOT NULL CHECK (value_milli >= 0),
  measured_on TEXT NOT NULL,            -- 検査日・測定日
  source      TEXT NOT NULL CHECK (source IN ('manual', 'photo')), -- 手で入力／用紙を撮影して読み取り、薬剤師が確かめた
  created_at  TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_measurements_patient ON measurements(patient_id, item, measured_on);

-- 服薬指導の会話の文字起こし。音声そのものは保存しない（文字にしたら捨てる）
CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  source          TEXT NOT NULL CHECK (source IN ('recording', 'file')), -- その場で録音／録音したファイルを後から読み込み（通信が切れていたとき）
  file_name       TEXT,
  duration_sec    INTEGER NOT NULL CHECK (duration_sec > 0),
  transcript      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  CHECK ((source = 'file') = (file_name IS NOT NULL))
);

-- 来局ごとの指導記録（SOAP）。1回の来局に複数書ける（追記）。
CREATE TABLE guidance_records (
  id              INTEGER PRIMARY KEY,
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  subjective      TEXT NOT NULL,      -- S：患者の訴え・相談
  objective       TEXT NOT NULL,      -- O：服薬状況・検査値など
  assessment      TEXT NOT NULL,      -- A：薬剤師の評価
  plan            TEXT NOT NULL,      -- P：指導内容・次回の留意点
  leftover        TEXT NOT NULL CHECK (leftover IN ('none', 'some', 'unchecked')),   -- 残薬
  notebook        TEXT NOT NULL CHECK (notebook IN ('used', 'not_used', 'unchecked')), -- お薬手帳の活用
  conversation_id INTEGER REFERENCES conversations(id), -- 会話の文字起こしから下書きを作ったとき
  drafted         INTEGER NOT NULL CHECK (drafted IN (0, 1)), -- 下書き（会話・処方から組み立てた文）を元に書いたか
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  CHECK (subjective || objective || assessment || plan <> '')
);

CREATE INDEX idx_guidance_records_patient ON guidance_records(patient_id, created_at);

-- 指導記録のテンプレート。選ぶと S・O・A・P にまとめて写す
CREATE TABLE guidance_templates (
  id         INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  title      TEXT NOT NULL,
  subjective TEXT NOT NULL,
  objective  TEXT NOT NULL,
  assessment TEXT NOT NULL,
  plan       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (pharmacy_id, title)
);

-- トレーシングレポート（服薬情報提供書）。急ぎではないが処方医に伝えたいことを、文書で医療機関に送る。
-- 急ぎ・処方の内容を変える必要があるときは疑義照会（inquiries）。欄は病院の様式（服薬状況・併用薬・副作用・家族からの情報・提案）に合わせた
CREATE TABLE tracing_reports (
  id              INTEGER PRIMARY KEY,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  prescription_id TEXT REFERENCES prescriptions(id), -- 元にした来局
  institution     TEXT NOT NULL,        -- 医療機関
  department      TEXT NOT NULL,        -- 診療科
  doctor          TEXT NOT NULL,        -- 処方医
  consent         TEXT NOT NULL CHECK (consent IN ('agreed', 'necessary')), -- 患者の同意あり／同意は無いが治療上必要
  adherence       TEXT NOT NULL,        -- 1. 服薬状況（必須）
  leftover        TEXT NOT NULL,        -- 1-1. 残薬調整の報告
  concomitant     TEXT NOT NULL,        -- 2. 併用薬（他院・OTC・健康食品）
  complaint       TEXT NOT NULL,        -- 3. 患者の訴え（アレルギー・副作用と思われる症状）
  family          TEXT NOT NULL,        -- 4. 家族・介護者からの情報
  proposal        TEXT NOT NULL,        -- 5. 薬学的観点からの提案
  other           TEXT NOT NULL,        -- 6. その他
  next_visit_on   TEXT,                 -- 次回受診日
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);

-- 在宅：訪問先の施設（老人ホームなど）。自宅の患者は施設なし
CREATE TABLE facilities (
  id         INTEGER PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (pharmacy_id, name)
);

-- 在宅で訪問する患者。訪問は医師の指示に基づくので、指示した医師を持つ
CREATE TABLE home_patients (
  patient_id   INTEGER PRIMARY KEY REFERENCES patients(id),
  facility_id  INTEGER REFERENCES facilities(id), -- NULL＝自宅
  institution  TEXT NOT NULL,           -- 指示した医師の医療機関
  doctor       TEXT NOT NULL,
  care_manager TEXT,                    -- 介護支援専門員（ケアマネジャー）。介護保険の患者は報告先になる
  intensive    INTEGER NOT NULL CHECK (intensive IN (0, 1)), -- 末期の悪性腫瘍・注射による麻薬・中心静脈栄養（月8回・週2回まで）
  started_on   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id)
);

-- 薬学的管理指導計画書。通知の記載事項：薬剤の管理方法、薬剤特性（副作用・相互作用等）を確認した上で実施すべき指導の内容、
-- 訪問回数、訪問間隔。少なくとも月1回見直す（見直したら新しい行を足す）
CREATE TABLE care_plans (
  id               INTEGER PRIMARY KEY,
  patient_id       INTEGER NOT NULL REFERENCES home_patients(patient_id),
  made_on          TEXT NOT NULL,
  management       TEXT NOT NULL,       -- 薬剤の管理方法
  drug_notes       TEXT NOT NULL,       -- 薬剤特性（副作用・相互作用等）
  guidance         TEXT NOT NULL,       -- 実施すべき指導の内容
  visits_per_month INTEGER NOT NULL CHECK (visits_per_month BETWEEN 1 AND 8),
  interval_text    TEXT NOT NULL,       -- 訪問間隔（例：毎週木曜）
  created_at       TEXT NOT NULL,
  created_by       INTEGER NOT NULL REFERENCES users(id)
);

-- 訪問の予定。1人1日1回
CREATE TABLE visit_schedules (
  id            INTEGER PRIMARY KEY,
  patient_id    INTEGER NOT NULL REFERENCES home_patients(patient_id),
  visit_on      TEXT NOT NULL,
  pharmacist_id INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (patient_id, visit_on)
);

CREATE INDEX idx_visit_schedules_on ON visit_schedules(visit_on);

-- 訪問の記録。通知が薬歴に求める事項（実施した薬学的管理指導の内容、処方医に提供した訪問結果の要点、他職種と共有した要点）。
-- report は処方医への報告書の本文になる
CREATE TABLE visit_records (
  id          INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL UNIQUE REFERENCES visit_schedules(id),
  storage     TEXT NOT NULL,            -- 薬の保管状況
  adherence   TEXT NOT NULL,            -- 服薬状況
  leftover    TEXT NOT NULL,            -- 残薬の状況
  guidance    TEXT NOT NULL,            -- 実施した指導・服薬支援
  report      TEXT NOT NULL,            -- 処方医への報告の要点
  shared      TEXT NOT NULL,            -- ケアマネジャー・訪問看護など他職種と共有した要点
  created_at  TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id)
);

-- 受付から会計までの進み具合。1つの受付に、段階ごとに1行
CREATE TABLE reception_steps (
  reception_id INTEGER NOT NULL REFERENCES receptions(id),
  step         TEXT NOT NULL CHECK (step IN ('entered', 'audited', 'handed', 'paid')), -- 入力済み／監査済み／投薬済み／会計済み
  at           TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (reception_id, step)
);

-- 調剤監査（ピッキングの照合）。取り出した薬の箱のバーコードを読み、処方の薬と合っているかを確かめた結果
CREATE TABLE inspections (
  id              TEXT PRIMARY KEY,     -- サーバーで採番（読み取りの行と同じトランザクションで入れるため）
  prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
  created_at      TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id)
);

-- 読んだバーコード。合わなかったもの（取り違え・期限切れ）も残す
CREATE TABLE inspection_scans (
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  line_no       INTEGER NOT NULL,
  gtin          TEXT NOT NULL,
  drug_code     TEXT,                   -- バーコードから引いた医薬品コード（マスターに無ければ NULL）
  expiry        TEXT,                   -- 有効期限（AI 17）
  lot           TEXT,                   -- 製造番号（AI 10）
  result        TEXT NOT NULL CHECK (result IN ('match', 'wrong', 'unknown', 'expired')), -- 処方の薬／処方に無い薬／マスターに無い／期限切れ
  PRIMARY KEY (inspection_id, line_no)
);

-- 箱にバーコードの無い薬（生薬など、HOT コードマスターに包装が無い薬）を、薬剤師が目で確かめた記録
CREATE TABLE inspection_visual_checks (
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  drug_code     TEXT NOT NULL,
  PRIMARY KEY (inspection_id, drug_code)
);

-- 「つながる薬局」（ファーマシフト社の LINE 公式アカウントのサービス）でのやり取り。
-- 実際のサービスとはつないでいない。受信したメッセージをここに入れる形だけを作った
CREATE TABLE line_messages (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')), -- 患者から／薬局から
  body       TEXT NOT NULL,
  sent_at    TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) -- 薬局から送ったときの送信者
);

CREATE INDEX idx_line_messages_patient ON line_messages(patient_id, sent_at);

-- 誰が・いつ・どの患者の情報に触れたか
CREATE TABLE access_logs (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,             -- 操作の種類（一覧は logs.js の ACTIONS）
  patient_id INTEGER REFERENCES patients(id),
  detail     TEXT
);

CREATE INDEX idx_access_logs_at ON access_logs(at);
CREATE INDEX idx_access_logs_patient ON access_logs(patient_id, at);

-- ログインの失敗（試行回数の制限に使う。src/server/throttle.js）
CREATE TABLE login_failures (
  id   INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('id', 'ip', 'mfa')), -- ログインID ごと／接続元 IP ごと／6桁（ユーザーごと）
  key  TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE INDEX idx_login_failures ON login_failures(kind, key, at);

-- 画面の箱の配置（利用者ごと・画面ごと）。薬局のタブレットは何人かで使い回すので、端末ではなく利用者に持たせる。
-- layout は { boxes: [{ id: 箱の名前, w: 列の数, h: 段の数 }, …（並び順）], options: { 表示の選び方 } } の JSON。無ければ画面の初期の配置
CREATE TABLE user_layouts (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  page       TEXT NOT NULL,
  layout     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, page)
);

-- メモ帳（患者ごとの自由なメモ。家族構成・懸念事項・スタッフ間の伝言など、薬局が好きに使う）。
-- 書き換えるたびに新しい行を足し、いちばん新しい行を今の内容とする（前の内容は消さない）
CREATE TABLE patient_memos (
  id         INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_patient_memos_patient ON patient_memos(patient_id, id);
