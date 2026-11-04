/**
 * start-landing Worker
 * ---------------------------------------------------------------------------
 * 靜態頁面照舊由 site/ 提供；這支 Worker 只接手：
 *   POST /api/e        頁面上的行為事件（第一方收集，不怕廣告攔截器）
 *   POST /api/login    後台登入（單一密碼，存在 Cloudflare 祕密 ADMIN_PASSWORD）
 *   POST /api/logout
 *   GET  /api/stats    後台數據（需登入）
 *
 * 資料存在 Durable Object（內建 SQLite），不需要另外建資料庫。
 *
 * 選用的外部數據（設定了才會啟用）：
 *   GA4：  變數 GA4_PROPERTY_ID ＋ 祕密 GA_SA_KEY（服務帳戶 JSON）
 *   Meta： 變數 META_AD_ACCOUNT_ID ＋ 祕密 META_ADS_TOKEN（需 ads_read）
 */
import { DurableObject } from 'cloudflare:workers';

const PAGES = { 'one-on-one-zh': '/one/', 'run-zh': '/run/' };
const SESSION_DAYS = 30;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/api/e' && req.method === 'POST') return collect(req, env);
    if (p === '/api/e' && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (p === '/api/login' && req.method === 'POST') return login(req, env);
    if (p === '/api/logout') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie('', 0) } });
    if (p === '/api/stats') {
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
      const q = Object.fromEntries(url.searchParams);
      const db = store(env);
      const out = await db.stats(q);
      out.ga4 = await ga4Report(env, db, q).catch((e) => ({ error: String(e.message || e) }));
      out.meta = await metaReport(env, db, q).catch((e) => ({ error: String(e.message || e) }));
      return json(out);
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

// ---------------------------------------------------------------------------
// 日期工具（台灣時間）
// ---------------------------------------------------------------------------
const TZ = 8 * 3600e3;
export const dayOf = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
function range(q) {
  const today = dayOf(Date.now());
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(to, -6);
  const n = span(from, to);
  return { from, to, n, pfrom: addDays(from, -n), pto: addDays(from, -1) };
}

// 流量來源 → 管道（後台用的分類；src/med 欄位在 SQL 裡被替換成實際欄名）
const PAID = `(lower(med) IN ('cpc','ppc','paid','ad','ads','cpm','sponsored','paid_social','paidsocial','paid-social') OR lower(med) LIKE 'paid%')`;
const CHANNEL_SQL = `CASE
  WHEN (lower(src) LIKE '%facebook%' OR lower(src) LIKE '%instagram%' OR lower(src) IN ('fb','ig','meta'))
    THEN CASE WHEN ${PAID} THEN 'meta_paid' ELSE 'meta_organic' END
  WHEN lower(src) LIKE '%google%' THEN CASE WHEN ${PAID} THEN 'google_paid' ELSE 'google' END
  WHEN lower(src) LIKE '%line%' THEN 'line'
  WHEN src IS NULL OR src = '' OR src = '(direct)' THEN 'direct'
  ELSE 'other' END`;

// ---------------------------------------------------------------------------
// Durable Object：SQLite 存所有事件
// ---------------------------------------------------------------------------
export class Analytics extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
    `);
  }

  // 互動事件：有這些就不算跳出
  static INTER = new Set(['booking_click', 'line_click', 'faq_open', 'store_expand', 'store_map_click', 'xsell_expand', 'xsell_pick',
    'case_view', 'testimonial_view', 'xsell_group', 'xsell_cert', 'animation_toggle']);

  async ingest(list) {
    const now = Date.now();
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

  // ---- 後台數據 -------------------------------------------------------------
  stats(q) {
    const r = range(q);
    const page = PAGES[q.page] ? q.page : '';
    const ch = q.channel || '';
    const one = (sql, ...a) => this.sql.exec(sql, ...a).toArray()[0] || {};
    const all = (sql, ...a) => this.sql.exec(sql, ...a).toArray();

    // 篩選條件（套用在 sessions 表 s 與 conv 表）
    const sw = (from, to) => {
      let w = `s.day BETWEEN '${from}' AND '${to}'`;
      if (page) w += ` AND s.page='${page}'`;
      if (ch) w += ` AND (${CHANNEL_SQL.replace(/\bsrc\b/g, 's.src').replace(/\bmed\b/g, 's.med')})='${ch.replace(/'/g, '')}'`;
      return w;
    };
    const cw = (from, to, kind) => {
      let w = `day BETWEEN '${from}' AND '${to}' AND kind='${kind}'`;
      if (page) w += ` AND page='${page}'`;
      if (ch) w += ` AND (${CHANNEL_SQL})='${ch.replace(/'/g, '')}'`;
      return w;
    };
    const ENG = `(s.engaged=1 OR s.inter>0 OR s.eng_ms>=10000)`;

    const totals = (from, to) => {
      const t = one(`SELECT COUNT(*) sessions, COUNT(DISTINCT s.vid) visitors,
          SUM(CASE WHEN ${ENG} THEN 1 ELSE 0 END) engaged,
          SUM(CASE WHEN s.bclick>0 THEN 1 ELSE 0 END) bsessions,
          SUM(s.bclick) bclicks,
          AVG(CASE WHEN s.eng_ms>0 THEN s.eng_ms END) avg_ms,
          AVG(s.scroll) avg_scroll
        FROM sessions s WHERE ${sw(from, to)}`);
      t.liff = one(`SELECT COUNT(*) n FROM conv WHERE ${cw(from, to, 'liff')}`).n || 0;
      t.booked = one(`SELECT COUNT(*) n FROM conv WHERE ${cw(from, to, 'booked')}`).n || 0;
      for (const k of ['sessions', 'visitors', 'engaged', 'bsessions', 'bclicks']) t[k] = t[k] || 0;
      t.bounced = t.sessions - t.engaged;
      t.avg_ms = Math.round(t.avg_ms || 0);
      t.avg_scroll = Math.round(t.avg_scroll || 0);
      return t;
    };

    const cur = totals(r.from, r.to), prev = totals(r.pfrom, r.pto);

    // 各區塊：到達（看到過）與在此離開（沒點預約就離開時，畫面停在哪）
    const reach = all(`SELECT e.k sec, COUNT(DISTINCT e.sid) n FROM events e JOIN sessions s ON s.sid=e.sid
      WHERE e.name='section_view' AND ${sw(r.from, r.to)} GROUP BY e.k`);
    const exits = all(`SELECT COALESCE(s.exit_sec, s.last_sec, 'hero') sec, COUNT(*) n,
        SUM(CASE WHEN ${ENG} THEN 0 ELSE 1 END) bounced
      FROM sessions s WHERE ${sw(r.from, r.to)} AND s.bclick=0 GROUP BY 1`);
    const order = all(`SELECT e.k sec, AVG(CAST(e.ts - s.start AS REAL)) t FROM events e JOIN sessions s ON s.sid=e.sid
      WHERE e.name='section_view' AND ${sw(r.from, r.to)} GROUP BY e.k ORDER BY t`).map((x) => x.sec);

    const daily = all(`SELECT s.day d, COUNT(*) sessions, SUM(CASE WHEN ${ENG} THEN 0 ELSE 1 END) bounced,
        SUM(CASE WHEN s.bclick>0 THEN 1 ELSE 0 END) bsessions
      FROM sessions s WHERE ${sw(r.from, r.to)} GROUP BY s.day`);
    const dconv = all(`SELECT day d, kind, COUNT(*) n FROM conv WHERE (${cw(r.from, r.to, 'liff')}) OR (${cw(r.from, r.to, 'booked')}) GROUP BY day, kind`);

    const channels = all(`SELECT ${CHANNEL_SQL.replace(/\bsrc\b/g, 's.src').replace(/\bmed\b/g, 's.med')} ch, COUNT(*) sessions,
        SUM(CASE WHEN ${ENG} THEN 0 ELSE 1 END) bounced, SUM(CASE WHEN s.bclick>0 THEN 1 ELSE 0 END) bsessions
      FROM sessions s WHERE ${sw(r.from, r.to)} GROUP BY 1 ORDER BY sessions DESC`);
    const cbook = all(`SELECT ${CHANNEL_SQL} ch, kind, COUNT(*) n FROM conv WHERE (${cw(r.from, r.to, 'liff')}) OR (${cw(r.from, r.to, 'booked')}) GROUP BY 1, 2`);
    const sources = all(`SELECT s.src, s.med, s.camp, COUNT(*) sessions, SUM(CASE WHEN ${ENG} THEN 0 ELSE 1 END) bounced,
        SUM(CASE WHEN s.bclick>0 THEN 1 ELSE 0 END) bsessions
      FROM sessions s WHERE ${sw(r.from, r.to)} GROUP BY 1, 2, 3 ORDER BY sessions DESC LIMIT 20`);
    const devices = all(`SELECT s.dev, COUNT(*) sessions, SUM(CASE WHEN ${ENG} THEN 0 ELSE 1 END) bounced,
        SUM(CASE WHEN s.bclick>0 THEN 1 ELSE 0 END) bsessions, AVG(CASE WHEN s.eng_ms>0 THEN s.eng_ms END) avg_ms
      FROM sessions s WHERE ${sw(r.from, r.to)} GROUP BY 1 ORDER BY sessions DESC`);
    const ctas = all(`SELECT e.k cta, COUNT(*) clicks, COUNT(DISTINCT e.sid) sessions FROM events e JOIN sessions s ON s.sid=e.sid
      WHERE e.name='booking_click' AND ${sw(r.from, r.to)} GROUP BY e.k ORDER BY clicks DESC`);
    const inter = all(`SELECT e.name, e.k, COUNT(*) n, COUNT(DISTINCT e.sid) sessions FROM events e JOIN sessions s ON s.sid=e.sid
      WHERE e.name IN ('faq_open','store_expand','store_map_click','xsell_expand','xsell_pick','case_view','testimonial_view','line_click','xsell_group','xsell_cert')
        AND ${sw(r.from, r.to)} GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`);
    const scroll = all(`SELECT e.k pct, COUNT(DISTINCT e.sid) n FROM events e JOIN sessions s ON s.sid=e.sid
      WHERE e.name='scroll_depth' AND ${sw(r.from, r.to)} GROUP BY e.k`);
    const first = one(`SELECT MIN(day) d FROM sessions`).d || null;

    return { range: r, filter: { page, channel: ch }, cur, prev, reach, exits, order, daily, dconv, channels, cbook, sources, devices, ctas, inter, scroll, first_day: first, generated: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Meta 廣告（Marketing API insights）
// ---------------------------------------------------------------------------
async function metaReport(env, db, q) {
  if (!env.META_ADS_TOKEN || !env.META_AD_ACCOUNT_ID) return { configured: false };
  const r = range(q);
  const acct = String(env.META_AD_ACCOUNT_ID).replace(/^act_/, '');
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
  const path = PAGES[q.page] || '';
  const key = `ga4:${r.from}:${r.to}:${path}`;
  const hit = await db.cacheGet(key, 15 * 60e3);
  if (hit) return hit;
  const sa = JSON.parse(env.GA_SA_KEY);
  const tok = await googleToken(sa);
  const by = (p) => ({ filter: { fieldName: 'landingPage', stringFilter: { matchType: 'BEGINS_WITH', value: p } } });
  const filter = path ? by(path) : { orGroup: { expressions: Object.values(PAGES).map(by) } };
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
