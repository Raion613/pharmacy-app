-- 患者メモを分類ごとに1つにする（2026-11-14）。前の作りで何件かあった分類を1つに書き換えたとき、まとめた行が新しい行を指す（行は消さない）
ALTER TABLE patient_notes ADD COLUMN merged_into INTEGER REFERENCES patient_notes(id);
