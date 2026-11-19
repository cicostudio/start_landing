/**
 * 每日彙總（給後台與 MCP 用）
 * ---------------------------------------------------------------------------
 * 後台預設只讀「已結算」的每天一列，期間截止到昨天，不再掃原始事件。
 * 「今天」要明確要求才算，而且同一份快照至少快取 10 分鐘。
 *
 * 一列的 data 是當天的壓縮統計（不是原始事件）。跨天的不重複訪客把每天的
 * 訪客編號集合併起來，所以跟直接 COUNT(DISTINCT vid) 一樣。
 */
export const TZ = 8 * 3600e3;
export const TODAY_CACHE_MS = 10 * 60 * 1000;
export const HISTORY_CACHE_MS = 60 * 1000;
export const YDAY_GRACE_MS = 30 * 60 * 1000;
export const BACKFILL_GAP_MS = 20 * 1000;

export const INTER_NAMES = ['hero_step_click', 'faq_open', 'store_expand', 'store_map_click', 'xsell_expand', 'xsell_pick', 'case_view', 'testimonial_view', 'line_click', 'xsell_group', 'xsell_cert'];
const INTER = new Set(INTER_NAMES);
export const CHANNELS = new Set(['meta_paid', 'meta_organic', 'line', 'google', 'google_paid', 'direct', 'other']);

const PAID = new Set(['cpc', 'ppc', 'paid', 'ad', 'ads', 'cpm', 'sponsored', 'paid_social', 'paidsocial', 'paid-social']);

export const dayOf = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const span = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;

/** 與舊版 CHANNEL_SQL 相同的管道分類。 */
export function channelOf(src, med) {
  const s = String(src ?? '').toLowerCase();
  const m = String(med ?? '').toLowerCase();
  const paid = PAID.has(m) || m.startsWith('paid');
  if (s.includes('facebook') || s.includes('instagram') || s === 'fb' || s === 'ig' || s === 'meta') return paid ? 'meta_paid' : 'meta_organic';
  if (s.includes('google')) return paid ? 'google_paid' : 'google';
  if (s.includes('line')) return 'line';
  if (src == null || src === '' || src === '(direct)') return 'direct';
  return 'other';
}

export function isEngaged(s) {
  return (s.engaged | 0) === 1 || (s.inter | 0) > 0 || (s.eng_ms | 0) >= 10000;
}

/** COALESCE(exit_sec, last_sec, 'hero')：空字串不算空。 */
export function exitSection(s) {
  if (s.exit_sec != null) return s.exit_sec;
  if (s.last_sec != null) return s.last_sec;
  return 'hero';
}

/**
 * 預設截止到昨天。只有 include_today 為真，期間才可以包含今天。
 * 呼叫端若把 to 設成今天但沒開旗標，會被夾回昨天（today_excluded）。
 */
export function resolveRange(q, now = Date.now()) {
  const today = dayOf(now);
  const yesterday = addDays(today, -1);
  const flag = q && (q.include_today === true || q.include_today === 1 || q.include_today === '1' || q.include_today === 'true');
  const cap = flag ? today : yesterday;
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let to = valid(q && q.to) ? q.to : cap;
  const clamped = to > cap;
  if (to > cap) to = cap;
  let from = valid(q && q.from) ? q.from : addDays(to, -6);
  if (from > to) from = to;
  const n = span(from, to);
  const includesToday = !!(flag && to >= today);
  return {
    from, to, n, pfrom: addDays(from, -n), pto: addDays(from, -1),
    includes_today: includesToday, today, yesterday, today_excluded: !!(clamped && !includesToday),
  };
}

export function dataNote(includesToday) {
  return includesToday ? '含今天即時數據，約每 10 分鐘更新' : '資料更新至昨日';
}

/** 08:00 台灣時間，等於該日 00:00 UTC。過了這個點，昨天的結算就固定下來。 */
export function taiwanMorningUtc(today) {
  return Date.parse(today + 'T00:00:00Z');
}

export function yesterdayNeedsRebuild(now, today, row) {
  if (!row || !row.built) return true;
  const morning = taiwanMorningUtc(today);
  if (now < morning) return now - row.built_at >= YDAY_GRACE_MS;
  return row.built_at < morning;
}

/** 閒置時最晚在明天 00:10（台灣）醒來，把剛結束的那一天結算掉。 */
export function nextIdleDelay(now) {
  const tomorrow = addDays(dayOf(now), 1);
  const at = Date.parse(tomorrow + 'T00:00:00Z') - TZ + 10 * 60 * 1000;
  return Math.max(60 * 1000, Math.min(6 * 3600 * 1000, at - now));
}

export const SQL_SESSIONS = `SELECT page, src, med, camp, dev, vid, engaged, inter, eng_ms, scroll, bclick, exit_sec, last_sec
  FROM sessions INDEXED BY s_day WHERE day = ?`;

export const SQL_EVENTS = `SELECT s.page AS page, s.src AS src, s.med AS med, e.name AS name, e.k AS k,
    COUNT(*) AS n, COUNT(DISTINCT e.sid) AS sids, SUM(e.ts - s.start) AS tSum
  FROM events AS e INDEXED BY e_day
  JOIN sessions AS s ON s.sid = e.sid
  WHERE e.day IN (?, ?, ?) AND s.day = ?
  GROUP BY s.page, s.src, s.med, e.name, e.k`;

export const SQL_CONV = `SELECT page, src, med, kind, COUNT(*) AS n
  FROM conv INDEXED BY c_day WHERE day = ?
  GROUP BY page, src, med, kind`;

export const SQL_HAS_SESSION = `SELECT 1 AS x FROM sessions INDEXED BY s_day WHERE day = ? LIMIT 1`;
export const SQL_HAS_CONV = `SELECT 1 AS x FROM conv INDEXED BY c_day WHERE day = ? LIMIT 1`;

/**
 * 用「事件日」索引把某一工作階段日的原始列收成一包。
 * 事件日可能比工作階段日晚（跨過午夜還開著的分頁），所以多看後兩天，再用 s.day 濾掉。
 * 今天的即時快照也走這條，不會掃到更早的歷史。
 */
export function rebuildDayFromDb(db, day) {
  const sessions = db.all(SQL_SESSIONS, day);
  const events = db.all(SQL_EVENTS, day, addDays(day, 1), addDays(day, 2), day);
  const convs = db.all(SQL_CONV, day);
  return docFromRows(sessions, events, convs);
}

export function docFromRows(sessions, events, convs) {
  const sessMap = new Map();
  const exitMap = new Map();
  const vidMap = new Map();
  for (const s of sessions) {
    const page = s.page ?? '';
    const src = s.src ?? null;
    const med = s.med ?? null;
    const camp = s.camp ?? null;
    const dev = s.dev ?? null;
    const sk = JSON.stringify([page, src, med, camp, dev]);
    let b = sessMap.get(sk);
    if (!b) {
      b = { page, src, med, camp, dev, n: 0, eng: 0, bSess: 0, bClicks: 0, engMsSum: 0, engMsN: 0, scrollSum: 0, scrollN: 0 };
      sessMap.set(sk, b);
    }
    b.n++;
    const eng = isEngaged(s);
    if (eng) b.eng++;
    const bclick = s.bclick == null ? 0 : (s.bclick | 0);
    if (bclick > 0) b.bSess++;
    b.bClicks += bclick;
    if (s.eng_ms != null && (s.eng_ms | 0) > 0) { b.engMsSum += s.eng_ms | 0; b.engMsN++; }
    if (s.scroll != null) { b.scrollSum += Number(s.scroll) || 0; b.scrollN++; }
    if (bclick === 0) {
      const sec = exitSection(s);
      const ek = JSON.stringify([page, src, med, sec]);
      let e = exitMap.get(ek);
      if (!e) { e = { page, src, med, sec, n: 0, bounced: 0 }; exitMap.set(ek, e); }
      e.n++;
      if (!eng) e.bounced++;
    }
    if (s.vid != null) {
      const vk = page + '\t' + channelOf(src, med);
      let set = vidMap.get(vk);
      if (!set) { set = new Set(); vidMap.set(vk, set); }
      set.add(String(s.vid));
    }
  }
  const vids = {};
  for (const [k, set] of vidMap) vids[k] = Array.from(set);
  return {
    v: 1,
    sess: Array.from(sessMap.values()),
    exit: Array.from(exitMap.values()),
    ev: (events || []).map((e) => ({
      page: e.page ?? '', src: e.src ?? null, med: e.med ?? null,
      name: e.name ?? '', k: e.k == null ? null : String(e.k),
      n: Number(e.n) || 0, sids: Number(e.sids) || 0, tSum: Number(e.tSum) || 0,
    })),
    conv: (convs || []).map((c) => ({
      page: c.page ?? '', src: c.src ?? null, med: c.med ?? null, kind: c.kind ?? '', n: Number(c.n) || 0,
    })),
    vids,
  };
}

function pageOk(page, pages, only) {
  if (only) return page === only;
  return !!(pages && pages.includes(page));
}
function chOk(src, med, channel) {
  return !channel || channelOf(src, med) === channel;
}
function cmpStr(a, b) {
  const as = a == null ? '' : String(a);
  const bs = b == null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function accumulate(docs, opts) {
  const acc = {
    sessions: 0, engaged: 0, bsessions: 0, bclicks: 0,
    engMsSum: 0, engMsN: 0, scrollSum: 0, scrollN: 0,
    liff: 0, booked: 0, vids: new Set(),
    reach: new Map(), exit: new Map(), order: new Map(),
    daily: new Map(), dconv: new Map(), channels: new Map(), cbook: new Map(),
    sources: new Map(), devices: new Map(), ctas: new Map(), inter: new Map(), scroll: new Map(),
  };
  for (const { day, doc } of docs) {
    if (!doc) continue;
    let daySessions = 0, dayEng = 0, dayBSess = 0;
    for (const s of doc.sess || []) {
      if (!pageOk(s.page, opts.pages, opts.page) || !chOk(s.src, s.med, opts.channel)) continue;
      acc.sessions += s.n; acc.engaged += s.eng; acc.bsessions += s.bSess; acc.bclicks += s.bClicks;
      acc.engMsSum += s.engMsSum; acc.engMsN += s.engMsN; acc.scrollSum += s.scrollSum; acc.scrollN += s.scrollN;
      daySessions += s.n; dayEng += s.eng; dayBSess += s.bSess;
      const ch = channelOf(s.src, s.med);
      addNum(acc.channels, ch, { sessions: s.n, engaged: s.eng, bsessions: s.bSess });
      const sk = JSON.stringify([s.src, s.med, s.camp]);
      addNum(acc.sources, sk, { sessions: s.n, engaged: s.eng, bsessions: s.bSess, src: s.src, med: s.med, camp: s.camp });
      addNum(acc.devices, JSON.stringify([s.dev]), { sessions: s.n, engaged: s.eng, bsessions: s.bSess, engMsSum: s.engMsSum, engMsN: s.engMsN, dev: s.dev });
    }
    if (daySessions) acc.daily.set(day, { d: day, sessions: daySessions, bounced: daySessions - dayEng, bsessions: dayBSess });
    for (const [vk, list] of Object.entries(doc.vids || {})) {
      const tab = vk.indexOf('\t');
      const page = tab < 0 ? vk : vk.slice(0, tab);
      const ch = tab < 0 ? '' : vk.slice(tab + 1);
      if (!pageOk(page, opts.pages, opts.page)) continue;
      if (opts.channel && ch !== opts.channel) continue;
      for (const v of list) acc.vids.add(v);
    }
    for (const e of doc.exit || []) {
      if (!pageOk(e.page, opts.pages, opts.page) || !chOk(e.src, e.med, opts.channel)) continue;
      addNum(acc.exit, JSON.stringify([e.sec]), { sec: e.sec, n: e.n, bounced: e.bounced });
    }
    for (const e of doc.ev || []) {
      if (!pageOk(e.page, opts.pages, opts.page) || !chOk(e.src, e.med, opts.channel)) continue;
      if (e.name === 'section_view') {
        addNum(acc.reach, JSON.stringify([e.k]), { sec: e.k, n: e.sids });
        addNum(acc.order, JSON.stringify([e.k]), { sec: e.k, tSum: e.tSum, n: e.n });
      } else if (e.name === 'scroll_depth') {
        addNum(acc.scroll, JSON.stringify([e.k]), { pct: e.k, n: e.sids });
      } else if (e.name === 'booking_click') {
        addNum(acc.ctas, JSON.stringify([e.k]), { cta: e.k, clicks: e.n, sessions: e.sids });
      } else if (INTER.has(e.name)) {
        addNum(acc.inter, JSON.stringify([e.name, e.k]), { name: e.name, k: e.k, n: e.n, sessions: e.sids });
      }
    }
    for (const c of doc.conv || []) {
      if (!pageOk(c.page, opts.pages, opts.page) || !chOk(c.src, c.med, opts.channel)) continue;
      if (c.kind === 'liff') acc.liff += c.n;
      else if (c.kind === 'booked') acc.booked += c.n;
      else continue;
      const ch = channelOf(c.src, c.med);
      addNum(acc.dconv, JSON.stringify([day, c.kind]), { d: day, kind: c.kind, n: c.n });
      addNum(acc.cbook, JSON.stringify([ch, c.kind]), { ch, kind: c.kind, n: c.n });
    }
  }
  return acc;
}

function addNum(map, key, extra) {
  const cur = map.get(key);
  if (!cur) { map.set(key, { ...extra }); return; }
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'number') cur[k] += v;
}

function totalsOf(acc) {
  return {
    sessions: acc.sessions, visitors: acc.vids.size, engaged: acc.engaged,
    bsessions: acc.bsessions, bclicks: acc.bclicks, liff: acc.liff, booked: acc.booked,
    bounced: acc.sessions - acc.engaged,
    avg_ms: acc.engMsN ? Math.round(acc.engMsSum / acc.engMsN) : 0,
    avg_scroll: acc.scrollN ? Math.round(acc.scrollSum / acc.scrollN) : 0,
  };
}

export function statsFromDocs(curDocs, prevDocs, opts) {
  const curAcc = accumulate(curDocs, opts);
  const prevAcc = accumulate(prevDocs, opts);
  const channelRows = mapRows(curAcc.channels, (key, x) => ({
    ch: key, sessions: x.sessions, bounced: x.sessions - x.engaged, bsessions: x.bsessions,
  })).sort((a, b) => b.sessions - a.sessions || cmpStr(a.ch, b.ch));

  const sources = mapRows(curAcc.sources, (key, x) => ({
    src: x.src, med: x.med, camp: x.camp, sessions: x.sessions, bounced: x.sessions - x.engaged, bsessions: x.bsessions,
  })).sort((a, b) => b.sessions - a.sessions || cmpStr(a.src, b.src) || cmpStr(a.med, b.med) || cmpStr(a.camp, b.camp)).slice(0, 20);

  const devices = mapRows(curAcc.devices, (key, x) => ({
    dev: x.dev, sessions: x.sessions, bounced: x.sessions - x.engaged, bsessions: x.bsessions,
    avg_ms: x.engMsN ? x.engMsSum / x.engMsN : null,
  })).sort((a, b) => b.sessions - a.sessions || cmpStr(a.dev, b.dev));

  const ctas = mapRows(curAcc.ctas, (key, x) => ({ cta: x.cta, clicks: x.clicks, sessions: x.sessions }))
    .sort((a, b) => b.clicks - a.clicks || cmpStr(a.cta, b.cta));
  const inter = mapRows(curAcc.inter, (key, x) => ({ name: x.name, k: x.k, n: x.n, sessions: x.sessions }))
    .sort((a, b) => b.n - a.n || cmpStr(a.name, b.name) || cmpStr(a.k, b.k)).slice(0, 30);
  const scroll = mapRows(curAcc.scroll, (key, x) => ({ pct: x.pct, n: x.n }));
  const reach = mapRows(curAcc.reach, (key, x) => ({ sec: x.sec, n: x.n }));
  const exits = mapRows(curAcc.exit, (key, x) => ({ sec: x.sec, n: x.n, bounced: x.bounced }));
  const order = mapRows(curAcc.order, (key, x) => x).filter((x) => x.n > 0)
    .sort((a, b) => a.tSum / a.n - b.tSum / b.n || cmpStr(a.sec, b.sec)).map((x) => x.sec);
  const daily = [...curAcc.daily.values()].sort((a, b) => cmpStr(a.d, b.d));
  const dconv = mapRows(curAcc.dconv, (key, x) => ({ d: x.d, kind: x.kind, n: x.n })).sort((a, b) => cmpStr(a.d, b.d) || cmpStr(a.kind, b.kind));
  const cbook = mapRows(curAcc.cbook, (key, x) => ({ ch: x.ch, kind: x.kind, n: x.n })).sort((a, b) => cmpStr(a.ch, b.ch) || cmpStr(a.kind, b.kind));

  const r = opts.range;
  return {
    range: { from: r.from, to: r.to, n: r.n, pfrom: r.pfrom, pto: r.pto },
    filter: { page: opts.page || '', channel: opts.channel || '' },
    cur: totalsOf(curAcc), prev: totalsOf(prevAcc),
    reach, exits, order, daily, dconv, channels: channelRows, cbook, sources, devices, ctas, inter, scroll,
    first_day: opts.firstDay || null,
    generated: opts.generated || Date.now(),
    includes_today: !!opts.includes_today,
    as_of: r.to,
    data_note: opts.data_note || dataNote(!!opts.includes_today),
    backfill_pending: opts.backfill_pending || 0,
    today_excluded: !!opts.today_excluded,
  };
}

function mapRows(map, fn) {
  const out = [];
  for (const [key, val] of map) out.push(fn(key, val));
  return out;
}

export function docsFromRows(rows, from, to, today, includesToday) {
  const out = [];
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    if (row.day === today) { if (!includesToday) continue; }
    else if (!row.built) continue;
    let doc = row.doc;
    if (!doc && row.data) { try { doc = JSON.parse(row.data); } catch (e) { continue; } }
    if (doc) out.push({ day: row.day, doc });
  }
  return out;
}

export function statsFromRollupRows(rows, opts) {
  const r = opts.range;
  const curDocs = docsFromRows(rows, r.from, r.to, opts.today, !!opts.includes_today);
  const prevDocs = docsFromRows(rows, r.pfrom, r.pto, opts.today, false);
  return statsFromDocs(curDocs, prevDocs, opts);
}
