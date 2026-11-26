/**
 * 回流客喚醒活動（cico.tw/rejoin/）
 * ---------------------------------------------------------------------------
 * 流程：LINE 推播（每人一個專屬 token）→ cico.tw/rejoin/?t=token（倒數＋剩餘名額）
 *       → /api/rejoin/go 記點擊 → 預約系統活動連結（帶 rj=token）→ 預約系統貼標並回呼 webhook
 *
 * 公開：
 *   GET  /api/rejoin/status?t=   活動狀態（截止時間、剩餘名額）；帶 t 會記一次「開啟」
 *   GET  /api/rejoin/go?t=&vid=  記點擊後 302 到預約系統活動連結
 * 預約系統（Authorization: Bearer REJOIN_HOOK_KEY）：
 *   POST /api/rejoin/booked      { booking_id, rj?, status: "confirmed" | "cancelled" }
 * 管理（後台登入 cookie，或 Authorization: Bearer REJOIN_ADMIN_KEY）：
 *   後台網頁 cico.tw/admin/rejoin.html 用下面這些：
 *   POST /api/rejoin/upload      { text }   貼上的 UID 名單（自動驗證、去重、配 token）
 *   POST /api/rejoin/test        { uid }    發一則給指定 UID（測試用，可重複）
 *   POST /api/rejoin/push        { n, retry_failed }  發給下一批尚未發送的人（每次最多 20 人，網頁會自動連續呼叫）
 *   GET  /api/rejoin/quota       LINE 本月訊息額度
 *   （需要 Cloudflare 祕密 LINE_TOKEN：官方帳號 Messaging API 的 Channel access token）
 *   POST /api/rejoin/recipients  { items: [{ t, uid }] }       發送前登記 token ↔ UID
 *   POST /api/rejoin/sent        { items: [{ t, ok, err? }] }   發送結果
 *   GET  /api/rejoin/report      漏斗數字；?format=csv 下載逐人明細
 *   POST /api/rejoin/adjust      { offset }  不經系統的名額（例如電話預約）手動扣除
 *
 * 剩餘名額 = 總名額 − 已確認預約 − 手動扣除。數字一律來自真實預約，不灌水。
 */

import { buildMessage, CAMPAIGN } from './rejoin-message.js';

export const REJOIN = {
  id: 'rejoin_261125',
  total: 50,
  deadline: '2026-12-09T23:59:59+08:00',
  booking: 'https://s.cicostudio.com/a/261125-2023rj',
};

// 環境變數可覆寫（Cloudflare 後台 → 變數）：REJOIN_TOTAL、REJOIN_DEADLINE
const conf = (env) => ({
  ...REJOIN,
  total: Number(env.REJOIN_TOTAL) || REJOIN.total,
  deadline: env.REJOIN_DEADLINE || REJOIN.deadline,
});

const TOKEN_RE = /^[A-Za-z0-9]{6,16}$/;
const UID_RE = /^U[0-9a-f]{32}$/;
const okToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

// ---------------------------------------------------------------------------
// Durable Object 端（由 Analytics.rj(op, arg) 呼叫，sql = ctx.storage.sql）
// ---------------------------------------------------------------------------
export function rjMigrate(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS rj_rcpt(
      t TEXT PRIMARY KEY, uid TEXT UNIQUE, added INTEGER,
      sent INTEGER, err TEXT,
      open1 INTEGER, opens INTEGER DEFAULT 0,
      click1 INTEGER, clicks INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rj_book(id TEXT PRIMARY KEY, t TEXT, status TEXT, ts INTEGER, upd INTEGER);
    CREATE TABLE IF NOT EXISTS rj_kv(k TEXT PRIMARY KEY, v TEXT);
  `);
  // v2：發送鎖（避免兩個分頁同時發給同一人）
  try { sql.exec(`ALTER TABLE rj_rcpt ADD COLUMN lock INTEGER`); } catch (e) {}
}

const B62 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function newToken() { const b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map((x) => B62[x % B62.length]).join(''); }
const LOCK_MS = 120000;

const one = (sql, q, ...a) => sql.exec(q, ...a).toArray()[0];

export const rjOps = {
  register(sql, items) {
    let added = 0, skipped = 0;
    const now = Date.now();
    for (const it of (items || []).slice(0, 1000)) {
      if (!it || !okToken(it.t) || !UID_RE.test(String(it.uid || ''))) { skipped++; continue; }
      const r = sql.exec(`INSERT OR IGNORE INTO rj_rcpt(t, uid, added) VALUES(?,?,?)`, it.t, it.uid, now);
      if (r.rowsWritten) added++; else skipped++;
    }
    return { added, skipped };
  },
  upload(sql, uids) {
    let added = 0, existing = 0;
    const now = Date.now();
    for (const uid of uids) {
      if (one(sql, `SELECT 1 FROM rj_rcpt WHERE uid=?`, uid)) { existing++; continue; }
      let t; do { t = newToken(); } while (one(sql, `SELECT 1 FROM rj_rcpt WHERE t=?`, t));
      sql.exec(`INSERT INTO rj_rcpt(t, uid, added) VALUES(?,?,?)`, t, uid, now);
      added++;
    }
    return { added, existing };
  },
  ensure(sql, uid) {
    const row = one(sql, `SELECT t FROM rj_rcpt WHERE uid=?`, uid);
    if (row) return { t: row.t };
    rjOps.upload(sql, [uid]);
    return { t: one(sql, `SELECT t FROM rj_rcpt WHERE uid=?`, uid).t };
  },
  pick(sql, o) {
    const now = Date.now();
    const n = Math.max(1, Math.min(20, Number(o && o.n) || 20));
    const rows = sql.exec(`SELECT t, uid FROM rj_rcpt WHERE sent IS NULL AND (lock IS NULL OR lock < ?) ${o && o.retry ? '' : 'AND err IS NULL'}
      ORDER BY added, t LIMIT ?`, now - LOCK_MS, n).toArray();
    for (const r of rows) sql.exec(`UPDATE rj_rcpt SET lock=? WHERE t=?`, now, r.t);
    return rows;
  },
  sent(sql, items) {
    const now = Date.now();
    let n = 0;
    for (const it of (items || []).slice(0, 1000)) {
      if (!it || !okToken(it.t)) continue;
      if (it.ok) sql.exec(`UPDATE rj_rcpt SET sent=COALESCE(sent, ?), err=NULL, lock=NULL WHERE t=?`, now, it.t);
      else sql.exec(`UPDATE rj_rcpt SET err=?, lock=NULL WHERE t=? AND sent IS NULL`, String(it.err || 'error').slice(0, 200), it.t);
      n++;
    }
    return { updated: n };
  },
  open(sql, t) {
    if (!okToken(t)) return false;
    const now = Date.now();
    return !!sql.exec(`UPDATE rj_rcpt SET opens=opens+1, open1=COALESCE(open1, ?) WHERE t=?`, now, t).rowsWritten;
  },
  click(sql, t) {
    if (!okToken(t)) return false;
    const now = Date.now();
    return !!sql.exec(`UPDATE rj_rcpt SET clicks=clicks+1, click1=COALESCE(click1, ?), open1=COALESCE(open1, ?) WHERE t=?`, now, now, t).rowsWritten;
  },
  booked(sql, b) {
    const id = String(b.booking_id || '').slice(0, 80);
    if (!id) return { error: 'booking_id required' };
    const status = b.status === 'cancelled' ? 'cancelled' : 'confirmed';
    const t = okToken(b.rj) ? b.rj : null;
    const now = Date.now();
    sql.exec(`INSERT INTO rj_book(id, t, status, ts, upd) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, upd=excluded.upd, t=COALESCE(rj_book.t, excluded.t)`, id, t, status, now, now);
    const known = t ? !!one(sql, `SELECT 1 FROM rj_rcpt WHERE t=?`, t) : false;
    return { ok: true, status, matched: known };
  },
  setOffset(sql, offset) {
    const v = Math.max(0, Math.floor(Number(offset) || 0));
    sql.exec(`INSERT INTO rj_kv(k, v) VALUES('offset', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, String(v));
    return { offset: v };
  },
  counts(sql) {
    const booked = one(sql, `SELECT COUNT(*) n FROM rj_book WHERE status='confirmed'`).n;
    const offset = Number((one(sql, `SELECT v FROM rj_kv WHERE k='offset'`) || {}).v || 0);
    return { booked, offset };
  },
  report(sql) {
    const r = one(sql, `SELECT COUNT(*) listed, COUNT(sent) sent, SUM(sent IS NULL AND err IS NOT NULL) failed, SUM(sent IS NULL AND err IS NULL) pending,
      COUNT(open1) opened, COUNT(click1) clicked, COALESCE(SUM(opens),0) opens, COALESCE(SUM(clicks),0) clicks FROM rj_rcpt`);
    const b = one(sql, `SELECT SUM(status='confirmed') confirmed, SUM(status='cancelled') cancelled,
      SUM(status='confirmed' AND t IN (SELECT t FROM rj_rcpt)) matched FROM rj_book`);
    const daily = sql.exec(`SELECT date((ts/1000)+28800, 'unixepoch') day, SUM(status='confirmed') confirmed FROM rj_book GROUP BY day ORDER BY day`).toArray();
    return { recipients: r, bookings: { confirmed: b.confirmed || 0, cancelled: b.cancelled || 0, matched: b.matched || 0 }, daily, ...rjOps.counts(sql) };
  },
  rows(sql) {
    return sql.exec(`SELECT r.t, r.uid, r.sent, r.err, r.open1, r.opens, r.click1, r.clicks,
      (SELECT GROUP_CONCAT(id || ':' || status) FROM rj_book WHERE t=r.t) bookings FROM rj_rcpt r ORDER BY r.added, r.t`).toArray();
  },
  unmatched(sql) {
    return sql.exec(`SELECT id, status, ts FROM rj_book WHERE t IS NULL OR t NOT IN (SELECT t FROM rj_rcpt) ORDER BY ts`).toArray();
  },
};

// ---------------------------------------------------------------------------
// Worker 端路由
// ---------------------------------------------------------------------------
export function rjState(c, counts, now = Date.now()) {
  const remaining = Math.max(0, c.total - counts.booked - counts.offset);
  const end = Date.parse(c.deadline);
  const state = now > end ? 'ended' : remaining <= 0 ? 'soldout' : 'open';
  return { campaign: c.id, total: c.total, remaining, deadline: c.deadline, now, state };
}

const tsIso = (v) => (v ? new Date(Number(v) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) : '');
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/**
 * @param deps { db, json, authed, same, hmac }
 */
export async function handleRejoin(req, env, url, deps) {
  const { db, json, authed, same, hmac } = deps;
  const p = url.pathname;
  const c = conf(env);
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const keyIs = async (name) => !!(env[name] && bearer && same(await hmac('rj', bearer), await hmac('rj', env[name])));
  const isAdmin = async () => (await keyIs('REJOIN_ADMIN_KEY')) || (await authed(req, env));
  const body = async () => { try { return await req.json(); } catch (e) { return {}; } };

  if (p === '/api/rejoin/status' && req.method === 'GET') {
    const t = url.searchParams.get('t');
    if (t && url.searchParams.get('o') === '1') await db.rj('open', t);
    return json(rjState(c, await db.rj('counts')));
  }

  if (p === '/api/rejoin/go' && req.method === 'GET') {
    const t = url.searchParams.get('t') || '';
    const vid = (url.searchParams.get('vid') || '').slice(0, 64);
    const st = rjState(c, await db.rj('counts'));
    if (st.state !== 'open') return Response.redirect(url.origin + '/rejoin/' + (okToken(t) ? '?t=' + t : ''), 302);
    if (okToken(t)) await db.rj('click', t);
    const dest = new URL(c.booking);
    if (okToken(t)) dest.searchParams.set('rj', t);
    dest.searchParams.set('utm_source', 'line');
    dest.searchParams.set('utm_medium', okToken(t) ? 'push' : 'share');
    dest.searchParams.set('utm_campaign', c.id);
    dest.searchParams.set('lp', 'rejoin-zh');
    if (vid) dest.searchParams.set('vid', vid);
    return new Response(null, { status: 302, headers: { Location: dest.toString(), 'Cache-Control': 'no-store' } });
  }

  if (p === '/api/rejoin/booked' && req.method === 'POST') {
    if (!(await keyIs('REJOIN_HOOK_KEY'))) return json({ error: 'unauthorized' }, 401);
    const out = await db.rj('booked', await body());
    if (out.error) return json(out, 400);
    return json({ ...out, ...rjState(c, await db.rj('counts')) });
  }

  // ---- 管理 ----
  if (!(await isAdmin())) return json({ error: 'unauthorized' }, 401);

  if (p === '/api/rejoin/upload' && req.method === 'POST') {
    const text = String((await body()).text || '').slice(0, 2_000_000);
    const raw = text.split(/[\s,;"']+/).filter(Boolean);
    const valid = [...new Set(raw.filter((u) => UID_RE.test(u)))];
    const out = valid.length ? await db.rj('upload', valid) : { added: 0, existing: 0 };
    return json({ ...out, invalid: raw.filter((u) => !UID_RE.test(u)).length, duplicates: raw.filter((u) => UID_RE.test(u)).length - valid.length,
      sample_invalid: raw.filter((u) => !UID_RE.test(u)).slice(0, 3) });
  }
  if (p === '/api/rejoin/quota' && req.method === 'GET') {
    if (!env.LINE_TOKEN) return json({ error: 'LINE_TOKEN 未設定' }, 503);
    return json(await lineQuota(env));
  }
  if (p === '/api/rejoin/test' && req.method === 'POST') {
    if (!env.LINE_TOKEN) return json({ error: 'LINE_TOKEN 未設定' }, 503);
    const uid = String((await body()).uid || '').trim();
    if (!UID_RE.test(uid)) return json({ error: 'UID 格式不對（U 開頭、共 33 碼）' }, 400);
    const { t } = await db.rj('ensure', uid);
    const res = await linePush(env, uid, t, crypto.randomUUID());
    return json({ ...res, link: landingFor(t) });
  }
  if (p === '/api/rejoin/push' && req.method === 'POST') {
    if (!env.LINE_TOKEN) return json({ error: 'LINE_TOKEN 未設定' }, 503);
    if (rjState(c, await db.rj('counts')).state !== 'open') return json({ error: '活動已額滿或截止，不再發送' }, 409);
    const o = await body();
    const batch = await db.rj('pick', { n: o.n, retry: !!o.retry_failed });
    const results = await Promise.all(batch.map(async (r) => ({ t: r.t, ...(await linePush(env, r.uid, r.t, await retryKey(r.t))) })));
    if (results.length) await db.rj('sent', results);
    const rep = await db.rj('report');
    return json({ sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length,
      errors: results.filter((x) => !x.ok).slice(0, 3).map((x) => x.err), pending: rep.recipients.pending || 0 });
  }

  if (p === '/api/rejoin/recipients' && req.method === 'POST') return json(await db.rj('register', (await body()).items));
  if (p === '/api/rejoin/sent' && req.method === 'POST') return json(await db.rj('sent', (await body()).items));
  if (p === '/api/rejoin/adjust' && req.method === 'POST') return json(await db.rj('setOffset', (await body()).offset));
  if (p === '/api/rejoin/report' && req.method === 'GET') {
    const fmt = url.searchParams.get('format');
    if (fmt === 'csv') {
      const rows = await db.rj('rows');
      const head = ['token', 'uid', '發送時間', '發送錯誤', '第一次開啟', '開啟次數', '第一次點擊', '點擊次數', '預約（編號:狀態）'];
      const lines = [head.join(',')].concat(rows.map((r) => [r.t, r.uid, tsIso(r.sent), r.err, tsIso(r.open1), r.opens, tsIso(r.click1), r.clicks, r.bookings].map(csvCell).join(',')));
      return new Response('﻿' + lines.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${c.id}.csv"`, 'Cache-Control': 'no-store' } });
    }
    const rep = await db.rj('report');
    return json({ ...rep, ...rjState(c, rep), unmatched: await db.rj('unmatched') });
  }
  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// LINE Messaging API
// ---------------------------------------------------------------------------
const LINE = 'https://api.line.me';
const landingFor = (t) => buildMessage(t).contents.footer.contents[0].action.uri;

// 同一個 token 永遠用同一個 retry key：就算重送，LINE 也不會讓同一人收到兩次
async function retryKey(t) {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rj:' + CAMPAIGN + ':' + t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function linePush(env, uid, t, key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(LINE + '/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.LINE_TOKEN, 'Content-Type': 'application/json', 'X-Line-Retry-Key': key },
      body: JSON.stringify({ to: uid, messages: [buildMessage(t)], customAggregationUnits: [CAMPAIGN] }),
    });
    if (r.status === 200 || r.status === 409) return { ok: true };
    const txt = (await r.text()).slice(0, 160);
    if ((r.status === 429 || r.status >= 500) && attempt === 0) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    return { ok: false, err: `HTTP ${r.status} ${txt}` };
  }
  return { ok: false, err: 'retry failed' };
}

async function lineQuota(env) {
  const get = async (p) => { const r = await fetch(LINE + p, { headers: { Authorization: 'Bearer ' + env.LINE_TOKEN } }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
  const [q, c] = await Promise.all([get('/v2/bot/message/quota'), get('/v2/bot/message/quota/consumption')]);
  if (q.s !== 200) return { error: `讀不到額度（HTTP ${q.s}），請確認 LINE_TOKEN`, detail: q.b };
  const limited = q.b.type === 'limited';
  return { limited, limit: q.b.value ?? null, used: c.b.totalUsage ?? null, left: limited ? q.b.value - (c.b.totalUsage || 0) : null };
}
