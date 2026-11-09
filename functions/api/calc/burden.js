// 負担割合の規則（src/rules/burden.js）で出した結果だけを返す。規則は画面に配らない
//   body：{ birthDate, date, patient? }。patient（{ burdenPercent, burdenReason, burdenUntil, lastDispensedOn, burdenCheckedOn }）を
//   付けると、前回確かめた日より後に割合が変わりうる出来事と、今の割合がその日にありうるかも返す
import { json, readJson, HttpError, isDate } from "../../../src/server/http.js";
import { burdenChoices, burdenEvents, burdenProblem, standardBurdens } from "../../../src/rules/burden.js";

export async function onRequestPost({ request }) {
  const { birthDate, date, patient } = await readJson(request);
  if (!isDate(birthDate) || !isDate(date)) throw new HttpError(400, "日付が不正です");
  const out = { choices: burdenChoices(birthDate, date), standard: standardBurdens(birthDate, date) };
  if (patient) {
    const p = { ...patient, birthDate };
    const since = [p.lastDispensedOn, p.burdenCheckedOn].filter((d) => d !== null).sort().at(-1) ?? null;
    out.events = since === null ? [] : burdenEvents(p, since, date);
    out.problem = burdenProblem(p, date);
    out.needed = out.events.length > 0 || out.problem !== null;
  }
  return json(out);
}
