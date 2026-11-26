/**
 * start-landing Worker
 * ---------------------------------------------------------------------------
 * 靜態頁面照舊由 site/ 提供；這支 Worker 只接手：
 *   POST /api/e        頁面上的行為事件（第一方收集，不怕廣告攔截器）
 *   POST /api/login    後台登入（單一密碼，存在 Cloudflare 祕密 ADMIN_PASSWORD）
 *   POST /api/logout
 *   GET  /api/stats    後台數據（需登入。預設截止到昨天；include_today=1 才含今天，並快取 10 分鐘）
 *   /api/rejoin/*      回流客活動（worker/rejoin.js）
 *
 * 資料存在 Durable Object（內建 SQLite），不需要另外建資料庫。
 *
 * 選用的外部數據（設定了才會啟用）：
 *   GA4：  變數 GA4_PROPERTY_ID ＋ 祕密 GA_SA_KEY（服務帳戶 JSON）
 *   Meta： 祕密 META_ADS_TOKEN（需 ads_read）＋ 各產品線的廣告帳號變數
 *          META_AD_ACCOUNT_ID（一對一）、META_AD_ACCOUNT_GROUP（團班課）、META_AD_ACCOUNT_CERT（認證課／工作坊／講座）
 */
import { DurableObject } from 'cloudflare:workers';
import { handleMcp } from './mcp.js';
import { handleRejoin, rjMigrate, rjOps } from './rejoin.js';
import {
  addDays, dayOf, resolveRange, rebuildDayFromDb, statsFromRollupRows, dataNote,
  TODAY_CACHE_MS, HISTORY_CACHE_MS, BACKFILL_GAP_MS,
  YDAY_GRACE_MS, CHANNELS, yesterdayNeedsRebuild, nextIdleDelay,
  SQL_HAS_SESSION, SQL_HAS_CONV,
} from './rollup.js';

export { dayOf };

// 頁面（page_id → 網址）。新增頁面時在這裡加一行，並在 LINES 指定它屬於哪條產品線。
const PAGES = { 'one-on-one-zh': '/one/', 'run-zh': '/run/', 'run-direct-zh': '/two/', 'three-zh': '/three/', 'central-zh': '/central/', 'rejoin-zh': '/rejoin/' };
// 產品線：各自的頁面與 Meta 廣告帳號（帳號編號放在 Cloudflare 變數，名稱見 acct）
export const LINES = {
  one:   { name: '一對一',              pages: ['one-on-one-zh', 'run-zh', 'run-direct-zh', 'three-zh', 'central-zh', 'rejoin-zh'], acct: 'META_AD_ACCOUNT_ID' },
  group: { name: '團班課',              pages: [],                          acct: 'META_AD_ACCOUNT_GROUP' },
  cert:  { name: '認證課／工作坊／講座', pages: [],                          acct: 'META_AD_ACCOUNT_CERT' },
};
const lineOf = (q) => LINES[q.line] ? q.line : 'one';
const linesInfo = (env) => Object.fromEntries(Object.entries(LINES).map(([k, l]) => [k, { name: l.name, pages: l.pages.map((p) => ({ id: p, path: PAGES[p] })), ads: !!(env.META_ADS_TOKEN && env[l.acct]) }]));
const SESSION_DAYS = 30;
const REDIRECTS = { '/run': '/two/', '/run/': '/two/', '/run/index.html': '/two/' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    // 跑者版流量全部改看直球版（/two/）：保留廣告參數（utm、fbclid…），302 方便日後改回
    if (REDIRECTS[p]) return Response.redirect(url.origin + REDIRECTS[p] + url.search, 302);
    if (p === '/api/e' && req.method === 'POST') return collect(req, env);
    if (p === '/api/e' && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (p === '/api/login' && req.method === 'POST') return login(req, env);
    if (p === '/api/logout') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie('', 0) } });
    if (p === '/api/stats') {
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
      const q = Object.fromEntries(url.searchParams);
      const db = store(env);
      q.line = lineOf(q);
      const out = await db.stats(q);
      out.ga4 = await ga4Report(env, db, q).catch((e) => ({ error: String(e.message || e) }));
      out.meta = await metaReport(env, db, q).catch((e) => ({ configured: true, error: String(e.message || e) }));
      out.lines = linesInfo(env);
      out.line = lineOf(q);
      return json(out);
    }
    // 回流客活動（cico.tw/rejoin/）：狀態、點擊導流、預約回呼、管理（見 worker/rejoin.js）
    if (p.startsWith('/api/rejoin/')) return handleRejoin(req, env, url, { db: store(env), json, authed, same, hmac });
    if (p.startsWith('/mcp/') || p === '/mcp') {
      // Claude 用的唯讀 MCP：網址裡帶 MCP_KEY 才能用（沒設 MCP_KEY 就關閉）
      const key = p.split('/')[2] || '';
      if (!env.MCP_KEY || !same(await hmac('mcp', key), await hmac('mcp', env.MCP_KEY))) return new Response('Not found', { status: 404 });
      return handleMcp(req, env, { store, stats: (db, q) => db.stats(q), metaReport, ga4Report, linesInfo, LINES });
    }
    if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};

const store = (env) => env.ANALYTICS.get(env.ANALYTICS.idFromName('main'));
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h } });
const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });

// ---------------------------------------------------------------------------
// 收集
// ---------------------------------------------------------------------------
async function collect(req, env) {
  let body;
  try { body = JSON.parse(await req.text()); } catch (e) { return new Response(null, { status: 400, headers: cors() }); }
  const list = Array.isArray(body) ? body.slice(0, 50) : [body];
  const ua = req.headers.get('user-agent') || '';
  if (/bot|crawl|spider|headless|lighthouse|facebookexternalhit/i.test(ua)) return new Response(null, { status: 204, headers: cors() });
  const dev = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  await store(env).ingest(list.map((e) => ({ ...e, dev })));
  return new Response(null, { status: 204, headers: cors() });
}

// ---------------------------------------------------------------------------
// 登入：cookie = 到期時間.HMAC(ADMIN_PASSWORD, 到期時間)；改密碼即全部登出
// ---------------------------------------------------------------------------
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const cookie = (v, maxAge) => `nj_admin=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function login(req, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'not_configured' }, 503);
  let pw = '';
  try { pw = String((await req.json()).password || ''); } catch (e) {}
  const a = await hmac('cmp', pw), b = await hmac('cmp', env.ADMIN_PASSWORD);
  if (!same(a, b)) { await new Promise((r) => setTimeout(r, 800)); return json({ error: 'wrong' }, 401); }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const v = exp + '.' + (await hmac(env.ADMIN_PASSWORD, String(exp)));
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(v, SESSION_DAYS * 86400) });
}
async function authed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)nj_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await hmac(env.ADMIN_PASSWORD, exp));
}

// 日期與管道分類在 rollup.js。預設期間截止到昨天；include_today=1 才含今天。
const range = (q) => resolveRange(q || {});

// ---------------------------------------------------------------------------
// Durable Object：SQLite 存所有事件
// ---------------------------------------------------------------------------
export class Analytics extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      // 物件被鬧鐘叫醒時，建構式會先跑、getAlarm() 會是 null。這裡補一個鬧鐘不會取消
      // alarm() 結尾再設定的下一次時間（後寫入的為準）。
      const existing = await ctx.storage.getAlarm();
      if (existing == null) await ctx.storage.setAlarm(Date.now() + 5000);
    });
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        sid TEXT PRIMARY KEY, vid TEXT, page TEXT, day TEXT, start INTEGER, last INTEGER,
        src TEXT, med TEXT, camp TEXT, cont TEXT, ref TEXT, dev TEXT,
        engaged INTEGER DEFAULT 0, eng_ms INTEGER DEFAULT 0, inter INTEGER DEFAULT 0, scroll INTEGER DEFAULT 0,
        last_sec TEXT, exit_sec TEXT, bclick INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS s_day ON sessions(day);
      CREATE TABLE IF NOT EXISTS events(ts INTEGER, day TEXT, sid TEXT, page TEXT, name TEXT, k TEXT);
      CREATE INDEX IF NOT EXISTS e_day ON events(day, name);
      CREATE TABLE IF NOT EXISTS conv(id TEXT PRIMARY KEY, ts INTEGER, day TEXT, kind TEXT, vid TEXT, page TEXT, cta TEXT, src TEXT, med TEXT, camp TEXT);
      CREATE INDEX IF NOT EXISTS c_day ON conv(day, kind);
      CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, t INTEGER, v TEXT);
      CREATE TABLE IF NOT EXISTS rollup(
        day TEXT PRIMARY KEY, built INTEGER NOT NULL DEFAULT 0, built_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    `);
    rjMigrate(this.sql);
  }

  // 回流客活動的資料操作（worker/rejoin.js 的 rjOps）
  async rj(op, arg) {
    if (!rjOps[op]) throw new Error('unknown rejoin op ' + op);
    return rjOps[op](this.sql, arg);
  }

  // 互動事件：有這些就不算跳出
  static INTER = new Set(['booking_click', 'line_click', 'faq_open', 'store_expand', 'store_map_click', 'xsell_expand', 'xsell_pick',
    'case_view', 'testimonial_view', 'xsell_group', 'xsell_cert', 'animation_toggle', 'hero_step_click']);

  async ingest(list) {
    const now = Date.now();
    if (!this._firstChecked) {
      if (!this.metaGet('first_day')) this.ensureFirstDay();
      this._firstChecked = true;
    }
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const n = String(e.n || '').slice(0, 40);
      const sid = String(e.sid || '').slice(0, 64);
      const page = String(e.page || '').slice(0, 40);
      const day = dayOf(now);
      const k = e.k == null ? null : String(e.k).slice(0, 120);

      // 預約流程（LIFF 頁回報）：以訪客＋天或預約鍵去重
      if (n === 'liff_open' || n === 'booking_complete') {
        const a = e.a || {};
        const vid = String(e.vid || a.vid || '').slice(0, 64);
        const id = n === 'liff_open' ? 'o:' + (vid || sid || now) + ':' + day : 'b:' + String(e.key || vid + now).slice(0, 80);
        this.sql.exec(`INSERT OR IGNORE INTO conv(id,ts,day,kind,vid,page,cta,src,med,camp) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          id, now, day, n === 'liff_open' ? 'liff' : 'booked', vid, String(a.lp || page || '').slice(0, 40), String(a.cta || '').slice(0, 40),
          String(a.utm_source || (a.fbclid ? 'facebook' : '') || (a.gclid ? 'google' : '')).slice(0, 80),
          String(a.utm_medium || (a.fbclid || a.gclid ? 'paid' : '')).slice(0, 80), String(a.utm_campaign || '').slice(0, 120));
        continue;
      }
      if (!sid || !n) continue;

      if (n === 'session_start') {
        const a = e.a || {};
        let src = a.utm_source || (a.fbclid ? 'facebook' : '') || (a.gclid ? 'google' : '');
        let med = a.utm_medium || (a.fbclid || a.gclid ? 'paid' : '');
        if (!src && a.ref) { src = a.ref; med = 'referral'; }
        this.sql.exec(`INSERT OR IGNORE INTO sessions(sid,vid,page,day,start,last,src,med,camp,cont,ref,dev) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          sid, String(e.vid || '').slice(0, 64), page, day, now, now, String(src || '(direct)').slice(0, 80), String(med || '(none)').slice(0, 80),
          String(a.utm_campaign || '').slice(0, 120), String(a.utm_content || '').slice(0, 120), String(a.ref || '').slice(0, 120), e.dev || '');
        continue;
      }
      // 沒有 session_start（例如被擋）也補一筆，避免漏算
      this.sql.exec(`INSERT OR IGNORE INTO sessions(sid,vid,page,day,start,last,src,med,dev) VALUES(?,?,?,?,?,?,?,?,?)`,
        sid, String(e.vid || '').slice(0, 64), page, day, now, now, '(direct)', '(none)', e.dev || '');

      if (n === 'exit' || n === 'ping') {
        const ms = Math.max(0, Math.min(Number(e.ms) || 0, 6 * 3600e3));
        this.sql.exec(`UPDATE sessions SET last=?, eng_ms=MAX(eng_ms,?), engaged=CASE WHEN ?>=10000 THEN 1 ELSE engaged END,
          scroll=MAX(scroll,?), exit_sec=COALESCE(?,exit_sec) WHERE sid=?`, now, ms, ms, Number(e.scroll) || 0, k, sid);
        continue;
      }
      this.sql.exec(`INSERT INTO events(ts,day,sid,page,name,k) VALUES(?,?,?,?,?,?)`, now, day, sid, page, n, k);
      if (n === 'section_view') this.sql.exec(`UPDATE sessions SET last=?, last_sec=? WHERE sid=?`, now, k, sid);
      else if (n === 'scroll_depth') this.sql.exec(`UPDATE sessions SET last=?, scroll=MAX(scroll,?) WHERE sid=?`, now, Number(k) || 0, sid);
      else if (Analytics.INTER.has(n)) this.sql.exec(`UPDATE sessions SET last=?, inter=inter+1, engaged=1, bclick=bclick+? WHERE sid=?`, now, n === 'booking_click' ? 1 : 0, sid);
    }
  }

  cacheGet(k, maxAge) {
    const r = this.sql.exec(`SELECT t, v FROM cache WHERE k=?`, k).toArray()[0];
    return r && Date.now() - r.t < maxAge ? JSON.parse(r.v) : null;
  }
  cacheSet(k, v) { this.sql.exec(`INSERT OR REPLACE INTO cache(k,t,v) VALUES(?,?,?)`, k, Date.now(), JSON.stringify(v)); }

  dbAll(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }
  metaGet(k) {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k=?`, k).toArray()[0];
    return r ? r.v : null;
  }
  metaSet(k, v) {
    this.sql.exec(`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, String(v));
  }
  ensureFirstDay() {
    const cur = this.metaGet('first_day');
    if (cur) return cur;
    const s = this.sql.exec(`SELECT day FROM sessions ORDER BY day LIMIT 1`).toArray()[0];
    const c = this.sql.exec(`SELECT day FROM conv ORDER BY day LIMIT 1`).toArray()[0];
    const days = [s && s.day, c && c.day].filter(Boolean).sort();
    if (!days.length) return null;
    this.metaSet('first_day', days[0]);
    return days[0];
  }
  saveRollup(day, built, now) {
    const doc = rebuildDayFromDb({ all: (sql, ...a) => this.dbAll(sql, ...a) }, day);
    this.sql.exec(
      `INSERT INTO rollup(day, built, built_at, data) VALUES(?,?,?,?)
       ON CONFLICT(day) DO UPDATE SET built=excluded.built, built_at=excluded.built_at, data=excluded.data`,
      day, built ? 1 : 0, now, JSON.stringify(doc));
  }
  // 今天的即時快照全站共用，10 分鐘內不重算（不同篩選只是把同一包再加總）。
  refreshToday(now, today) {
    const at = Number(this.metaGet('today_at') || 0);
    if (at && now - at < TODAY_CACHE_MS && this.sql.exec(`SELECT day FROM rollup WHERE day=?`, today).toArray()[0]) return;
    this.saveRollup(today, 0, now);
    this.metaSet('today_at', String(now));
  }
  ensureYesterday(now, yesterday) {
    const row = this.sql.exec(`SELECT built FROM rollup WHERE day=?`, yesterday).toArray()[0];
    if (row && row.built) return;
    this.saveRollup(yesterday, 1, now);
  }
  backfillPending(today) {
    if (this.metaGet('bf_done') === '1') return 0;
    const first = this.metaGet('first_day') || this.ensureFirstDay();
    if (!first) return 0;
    let cursor = this.metaGet('bf_next');
    if (!cursor) cursor = addDays(addDays(today, -1), -1);
    if (cursor < first) return 0;
    return Math.round((Date.parse(cursor + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 864e5) + 1;
  }
  dayHasRaw(day) {
    return !!(this.dbAll(SQL_HAS_SESSION, day)[0] || this.dbAll(SQL_HAS_CONV, day)[0]);
  }
  sessionTouchedAfter(day, ts) {
    const row = this.dbAll(`SELECT MAX(last) AS m FROM sessions INDEXED BY s_day WHERE day=?`, day)[0];
    return !!(row && row.m > ts);
  }

  // ---- 後台數據：只讀每日彙總。今天要 include_today 才算，並快取 10 分鐘。----
  stats(q) {
    q = q || {};
    const r = resolveRange(q);
    const pages = (LINES[q.line] || LINES.one).pages;
    const page = pages.includes(q.page) ? q.page : '';
    const channel = CHANNELS.has(q.channel) ? q.channel : '';
    const ttl = r.includes_today ? TODAY_CACHE_MS : HISTORY_CACHE_MS;
    const ck = `st:${q.line || ''}|${page}|${channel}|${r.from}|${r.to}|${r.includes_today ? 1 : 0}`;
    const hit = this.cacheGet(ck, ttl);
    if (hit) return hit;

    const now = Date.now();
    if (r.from <= r.yesterday && r.to >= r.yesterday) this.ensureYesterday(now, r.yesterday);
    if (r.includes_today) this.refreshToday(now, r.today);
    const rows = this.dbAll(`SELECT day, built, data FROM rollup WHERE day >= ? AND day <= ?`, r.pfrom, r.to);
    const out = statsFromRollupRows(rows, {
      pages, page, channel, range: r, today: r.today, includes_today: r.includes_today,
      firstDay: this.ensureFirstDay(), generated: now, data_note: dataNote(r.includes_today),
      backfill_pending: this.backfillPending(r.today), today_excluded: r.today_excluded,
    });
    this.cacheSet(ck, out);
    return out;
  }

  // 一次只結算一天，把讀取量攤開，避免補歷史資料時衝破每天 500 萬列的上限。
  async alarm() {
    let delay = 60 * 1000;
    try { delay = this.maintenance(); }
    catch (e) {
      try { await this.ctx.storage.setAlarm(Date.now() + delay); } catch (err) { /* 下次請求還會再排 */ }
      throw e;
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  maintenance() {
    const now = Date.now();
    const today = dayOf(now);
    const yesterday = addDays(today, -1);
    const first = this.ensureFirstDay();
    const yrow = this.dbAll(`SELECT built, built_at FROM rollup WHERE day=?`, yesterday)[0];
    if (yesterdayNeedsRebuild(now, today, yrow)) {
      this.saveRollup(yesterday, 1, now);
      if (this.metaGet('bf_done') !== '1') return BACKFILL_GAP_MS;
      return this.afterYesterday(now, today);
    }
    if (this.metaGet('bf_done') === '1' && yrow && yrow.built && this.sessionTouchedAfter(yesterday, yrow.built_at)) {
      // 補歷史資料時不要每 20 秒重讀昨天。結算後若還有分頁補送離開（last 變新）再算一次。
      this.saveRollup(yesterday, 1, now);
      return this.afterYesterday(now, today);
    }
    if (this.metaGet('bf_done') !== '1') {
      if (!first) this.metaSet('bf_done', '1');
      else {
        let cursor = this.metaGet('bf_next');
        if (!cursor) cursor = addDays(yesterday, -1);
        if (cursor < first) this.metaSet('bf_done', '1');
        else {
          if (this.dayHasRaw(cursor)) this.saveRollup(cursor, 1, now);
          const next = addDays(cursor, -1);
          this.metaSet('bf_next', next);
          if (next < first) this.metaSet('bf_done', '1');
          return BACKFILL_GAP_MS;
        }
      }
    }
    return this.afterYesterday(now, today);
  }

  afterYesterday(now, today) {
    if (now < Date.parse(today + 'T00:00:00Z')) return YDAY_GRACE_MS;
    return nextIdleDelay(now);
  }
}

// ---------------------------------------------------------------------------
// Meta 廣告（Marketing API insights）
// ---------------------------------------------------------------------------
async function metaReport(env, db, q) {
  const L = LINES[lineOf(q)];
  if (!env.META_ADS_TOKEN || !env[L.acct]) return { configured: false, acct_var: L.acct };
  const r = range(q);
  const acct = String(env[L.acct]).trim().replace(/^act_/, '');
  const v = env.META_API_VERSION || 'v21.0';
  const key = `meta:${acct}:${r.from}:${r.to}`;
  const hit = await db.cacheGet(key, 15 * 60e3);
  if (hit) return hit;
  const base = `https://graph.facebook.com/${v}/act_${acct}/insights`;
  const common = `fields=campaign_id,campaign_name,impressions,reach,inline_link_clicks,spend&access_token=${encodeURIComponent(env.META_ADS_TOKEN)}`;
  const get = async (u) => {
    const res = await fetch(u);
    const j = await res.json();
    if (j.error) throw new Error('Meta：' + (j.error.message || res.status));
    return j.data || [];
  };
  const tr = (a, b) => encodeURIComponent(JSON.stringify({ since: a, until: b }));
  const [camps, daily, prev] = await Promise.all([
    get(`${base}?level=campaign&time_range=${tr(r.from, r.to)}&limit=200&${common}`),
    get(`${base}?level=campaign&time_range=${tr(r.from, r.to)}&time_increment=1&limit=500&${common}`),
    get(`${base}?level=campaign&time_range=${tr(r.pfrom, r.pto)}&limit=200&${common}`),
  ]);
  const num = (x) => Number(x || 0);
  const pick = (d) => ({ id: d.campaign_id, name: d.campaign_name, day: d.date_start, impressions: num(d.impressions), reach: num(d.reach), clicks: num(d.inline_link_clicks), spend: num(d.spend) });
  const out = { configured: true, campaigns: camps.map(pick), daily: daily.map(pick), prev: prev.map(pick) };
  await db.cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// GA4 Data API（服務帳戶 JWT）
// ---------------------------------------------------------------------------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64uStr(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('GA4 授權失敗：' + (j.error_description || j.error || res.status));
  return j.access_token;
}
async function ga4Report(env, db, q) {
  if (!env.GA_SA_KEY || !env.GA4_PROPERTY_ID) return { configured: false };
  const r = range(q);
  const L = LINES[lineOf(q)];
  if (!L.pages.length) return { configured: true, no_pages: true };
  const path = L.pages.includes(q.page) ? PAGES[q.page] : '';
  const key = `ga4:${r.from}:${r.to}:${path || L.pages.join(',')}`;
  const hit = await db.cacheGet(key, 15 * 60e3);
  if (hit) return hit;
  const sa = JSON.parse(env.GA_SA_KEY);
  const tok = await googleToken(sa);
  const by = (p) => ({ filter: { fieldName: 'landingPage', stringFilter: { matchType: 'BEGINS_WITH', value: p } } });
  const filter = path ? by(path) : L.pages.length === 1 ? by(PAGES[L.pages[0]]) : { orGroup: { expressions: L.pages.map((p) => by(PAGES[p])) } };
  const run = async (body) => {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}:runReport`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateRanges: [{ startDate: r.from, endDate: r.to }], dimensionFilter: filter, ...body }),
    });
    const j = await res.json();
    if (j.error) throw new Error('GA4：' + j.error.message);
    return (j.rows || []).map((row) => ({
      dims: (row.dimensionValues || []).map((d) => d.value),
      m: (row.metricValues || []).map((m) => Number(m.value)),
    }));
  };
  const metrics = [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }, { name: 'totalUsers' }];
  const [tot, src] = await Promise.all([
    run({ metrics }),
    run({ dimensions: [{ name: 'sessionSourceMedium' }], metrics, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 15 }),
  ]);
  const t = tot[0] ? tot[0].m : [0, 0, 0, 0, 0];
  const out = {
    configured: true,
    totals: { sessions: t[0], engaged: t[1], bounce: t[2], avg_s: t[3], users: t[4] },
    sources: src.map((x) => ({ sm: x.dims[0], sessions: x.m[0], engaged: x.m[1], bounce: x.m[2], avg_s: x.m[3] })),
  };
  await db.cacheSet(key, out);
  return out;
}
