// 画面の通し確認を流す。手元の DB（npm run dev）には触らず、e2e 用のサーバー（ポート 8789・.wrangler/e2e-state）を使う。
//   npm run e2e                 全部の手順（公開の前に1回）
//   npm run e2e -- rx kohi      ファイル名にその文字を含む手順だけ（直した画面の分だけ流す）
// 毎回、e2e の DB を種データで作り直してから流すので、どの手順も単独で流せる。
// e2e 用のサーバーが動いていなければ起こし、終わったら止める（npm run e2e:server で起こしておけば使い回す）。
import { spawn, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { BASE, errors, launch, closeBrowser } from "./lib.js";
import { resetE2eDb } from "../scripts/e2e-reset.js";

const root = join(import.meta.dirname, "..");
const filters = process.argv.slice(2);
const flows = readdirSync(join(import.meta.dirname, "flows")).filter((f) => f.endsWith(".js")).sort()
  .filter((f) => filters.length === 0 || filters.some((w) => f.includes(w)));
if (flows.length === 0) throw new Error(`当てはまる手順がありません：${filters.join(" ")}`);

const alive = () => fetch(`${BASE}/login`).then(() => true, () => false);
let server;
if (!(await alive())) {
  const port = new URL(BASE).port;
  server = spawn(`npx wrangler pages dev public --port ${port} --persist-to .wrangler/e2e-state`, { cwd: root, shell: true, stdio: "ignore" });
  for (let i = 0; !(await alive()); i++) {
    if (i === 120) throw new Error("e2e のサーバーが起動しない");
    await new Promise((r) => setTimeout(r, 500));
  }
}
await fetch(`${BASE}/api/login`, { method: "POST", body: "{}" }); // DB のファイルを作らせる（初めて起動したとき）
execFileSync(process.execPath, ["scripts/seed-demo.js"], { cwd: root, stdio: "ignore" });
resetE2eDb();

await launch();
const started = Date.now();
try {
  for (const f of flows) {
    const t = Date.now();
    console.log(f);
    await import(`./flows/${f}`); // 各手順はモジュールの本体（トップレベルの await）で流れる
    assert.deepEqual(errors, [], "ブラウザのエラー");
    console.log(`  （${((Date.now() - t) / 1000).toFixed(1)}秒）`);
  }
} finally {
  await closeBrowser();
  if (server) execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
}
console.log(`すべて通りました（${flows.length}本・${((Date.now() - started) / 1000).toFixed(0)}秒）`);
