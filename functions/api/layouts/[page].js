// 画面の箱の配置（自分の分）：読む・保存する・初期に戻す
import { json, readJson } from "../../../src/server/http.js";
import { getLayout, saveLayout, deleteLayout } from "../../../src/server/layouts.js";

export async function onRequestGet({ params, env, data }) {
  return json({ layout: await getLayout(env.DB, data.user, params.page) });
}

export async function onRequestPut({ params, request, env, data }) {
  return json({ layout: await saveLayout(env.DB, data.user, params.page, (await readJson(request)).layout) });
}

export async function onRequestDelete({ params, env, data }) {
  await deleteLayout(env.DB, data.user, params.page);
  return json({ layout: null });
}
