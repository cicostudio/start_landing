#!/usr/bin/env node
/**
 * 回流活動 LINE 推播（每人一則、每人一個專屬 token）
 * ---------------------------------------------------------------------------
 * 需要 Node 18 以上，不用安裝套件。環境變數：
 *   LINE_TOKEN        官方帳號 Messaging API 的 Channel access token（長期）
 *   REJOIN_ADMIN_KEY  與 Cloudflare 祕密 REJOIN_ADMIN_KEY 相同
 *   SITE              預設 https://cico.tw
 *
 * 指令：
 *   node send.mjs check   uids.txt              檢查格式、去重、抽樣確認 UID 是不是這個官方帳號的好友、看額度
 *   node send.mjs test    Uxxxxxxxx…            只發給一個 UID（自己），走完整流程
 *   node send.mjs send    uids.txt --limit 100  先試發 100 人
 *   node send.mjs send    uids.txt              發給其餘尚未發送的人（會跳過已發送）
 *   node send.mjs preview                       印出 Flex JSON（貼到 Flex Simulator 預覽）
 *   node send.mjs report                        看活動漏斗數字
 * 選項：--dry-run（不真的發）、--force（額度不足仍發送）
 *
 * 進度存在同資料夾的 rejoin-state.json（含 UID，不要 commit、不要外流）。中斷後重跑會接續。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMessage, CAMPAIGN, SITE } from './message.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'rejoin-state.json');
const UID_RE = /^U[0-9a-f]{32}$/;
const LINE = 'https://api.line.me';

const [cmd, arg, ...rest] = process.argv.slice(2);
const flags = new Set(rest.concat(arg && arg.startsWith('--') ? [arg] : []));
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
const DRY = flags.has('--dry-run');

const die = (m) => { console.error('✖ ' + m); process.exit(1); };
const need = (k) => process.env[k] || die(`請先設定環境變數 ${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
function readUids(file) {
  if (!file || !existsSync(file)) die('找不到 UID 檔案：' + file);
  const raw = readFileSync(file, 'utf8').split(/[\s,;]+/).map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const bad = raw.filter((u) => !UID_RE.test(u));
  const uids = [...new Set(raw.filter((u) => UID_RE.test(u)))];
  return { uids, bad, dup: raw.length - bad.length - uids.length };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { campaign: CAMPAIGN, people: {} };
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (s.campaign !== CAMPAIGN) die(`rejoin-state.json 是另一個活動（${s.campaign}）的，請先改名備份`);
  return s;
}
function saveState(s) {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, STATE_FILE);
}
const B62 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 去掉易混淆字元
function newToken() { return [...randomBytes(10)].map((b) => B62[b % B62.length]).join(''); }

function ensurePeople(state, uids) {
  const used = new Set(Object.values(state.people).map((p) => p.t));
  for (const uid of uids) {
    if (state.people[uid]) continue;
    let t; do { t = newToken(); } while (used.has(t));
    used.add(t);
    state.people[uid] = { t, key: randomUUID(), sent: null, err: null, registered: false };
  }
}

// ---------------------------------------------------------------------------
async function lineGet(path) {
  const r = await fetch(LINE + path, { headers: { Authorization: 'Bearer ' + need('LINE_TOKEN') } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function quota() {
  const [q, c] = await Promise.all([lineGet('/v2/bot/message/quota'), lineGet('/v2/bot/message/quota/consumption')]);
  if (q.status !== 200) die('讀不到訊息額度（Channel access token 錯誤？）HTTP ' + q.status + ' ' + JSON.stringify(q.body));
  const limited = q.body.type === 'limited';
  return { limited, value: q.body.value, used: c.body.totalUsage, left: limited ? q.body.value - c.body.totalUsage : Infinity };
}

async function site(path, method = 'GET', body) {
  const r = await fetch(SITE + path, {
    method, headers: { Authorization: 'Bearer ' + need('REJOIN_ADMIN_KEY'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`${method} ${path} 失敗 HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function registerAll(state, uids) {
  const todo = uids.filter((u) => !state.people[u].registered);
  for (let i = 0; i < todo.length; i += 500) {
    const chunk = todo.slice(i, i + 500);
    if (!DRY) await site('/api/rejoin/recipients', 'POST', { items: chunk.map((uid) => ({ uid, t: state.people[uid].t })) });
    if (!DRY) { chunk.forEach((u) => { state.people[u].registered = true; }); saveState(state); }
  }
  if (todo.length) console.log(`已登記 ${todo.length} 位的專屬連結${DRY ? '（dry-run，未實際登記）' : ''}`);
}

async function push(uid, p) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(LINE + '/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + need('LINE_TOKEN'), 'Content-Type': 'application/json', 'X-Line-Retry-Key': p.key },
      body: JSON.stringify({ to: uid, messages: [buildMessage(p.t)], customAggregationUnits: [CAMPAIGN] }),
    });
    if (r.status === 200) return { ok: true };
    if (r.status === 409) return { ok: true, note: 'already accepted' }; // 同一個 retry key 已送出過 → 不會重複發
    const body = await r.text();
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    return { ok: false, err: `HTTP ${r.status} ${body.slice(0, 160)}` };
  }
  return { ok: false, err: 'retry exhausted' };
}

async function sendTo(state, uids) {
  const pending = uids.filter((u) => !state.people[u].sent).slice(0, LIMIT);
  if (!pending.length) return console.log('沒有待發送的名單（全部都發過了）');
  const q = DRY ? await quota().catch(() => ({ limited: false, left: Infinity })) : await quota();
  console.log(`本次要發 ${pending.length} 則；本月額度 ${q.limited ? `${q.used}/${q.value}（剩 ${q.left}）` : '不限'}`);
  if (pending.length > q.left && !flags.has('--force')) die('額度不足。加購額度後再發，或加 --force（超過的部分會失敗）');
  if (DRY) { console.log('dry-run：不實際發送。第一則的連結：' + buildMessage(state.people[pending[0]].t).contents.footer.contents[0].action.uri); return; }

  await registerAll(state, pending);
  let ok = 0, fail = 0, report = [];
  const flush = async () => { if (report.length) { await site('/api/rejoin/sent', 'POST', { items: report }); report = []; } };
  const CONC = 5;
  for (let i = 0; i < pending.length; i += CONC) {
    await Promise.all(pending.slice(i, i + CONC).map(async (uid) => {
      const p = state.people[uid];
      const res = await push(uid, p);
      if (res.ok) { p.sent = new Date().toISOString(); p.err = null; ok++; } else { p.err = res.err; fail++; }
      report.push({ t: p.t, ok: res.ok, err: res.err });
    }));
    saveState(state);
    if (report.length >= 200) await flush();
    process.stdout.write(`\r已發送 ${ok}，失敗 ${fail}／${pending.length}`);
  }
  await flush();
  console.log(`\n完成：成功 ${ok}、失敗 ${fail}。失敗原因記在 rejoin-state.json 的 err 欄位。`);
}

// ---------------------------------------------------------------------------
const main = {
  async check() {
    const { uids, bad, dup } = readUids(arg);
    console.log(`有效 UID ${uids.length} 筆；格式錯誤 ${bad.length} 筆；重複 ${dup} 筆`);
    if (bad.length) console.log('  格式錯誤範例：', bad.slice(0, 3).join(', '));
    const sample = [...uids].sort(() => Math.random() - 0.5).slice(0, 10);
    let okN = 0;
    for (const u of sample) {
      const r = await lineGet('/v2/bot/profile/' + u);
      if (r.status === 200) okN++;
      console.log(`  ${u.slice(0, 9)}…  ${r.status === 200 ? '✓ ' + r.body.displayName : '✗ HTTP ' + r.status}`);
    }
    console.log(`抽樣 ${sample.length} 位，${okN} 位是這個官方帳號的好友。`);
    if (sample.length && okN / sample.length < 0.5) console.log('⚠ 大多數對不上：這份 UID 可能來自不同 Provider，先不要發。');
    const q = await quota();
    console.log(`本月額度：${q.limited ? `${q.used}/${q.value}（剩 ${q.left}）` : '不限'}`);
  },
  async test() {
    if (!UID_RE.test(arg || '')) die('用法：node send.mjs test U開頭的33碼UID');
    const state = loadState();
    ensurePeople(state, [arg]);
    state.people[arg].sent = null; state.people[arg].key = randomUUID(); // 測試可以重複發
    saveState(state);
    await sendTo(state, [arg]);
    console.log('測試連結：' + buildMessage(state.people[arg].t).contents.footer.contents[0].action.uri);
  },
  async send() {
    const { uids, bad } = readUids(arg);
    if (bad.length) console.log(`略過 ${bad.length} 筆格式錯誤的 UID`);
    const state = loadState();
    ensurePeople(state, uids);
    saveState(state);
    await sendTo(state, uids);
  },
  async preview() { console.log(JSON.stringify(buildMessage('PREVIEW01').contents, null, 2)); },
  async report() { console.log(JSON.stringify(await site('/api/rejoin/report'), null, 2)); },
};

if (!main[cmd]) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 22).join('\n')); process.exit(cmd ? 1 : 0); }
main[cmd]().catch((e) => die(e.stack || e.message));
