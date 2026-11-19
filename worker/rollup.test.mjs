import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CHANNELS, SQL_EVENTS, SQL_SESSIONS, SQL_CONV,
  addDays, channelOf, dataNote, dayOf, nextIdleDelay, rebuildDayFromDb, resolveRange,
  statsFromRollupRows, yesterdayNeedsRebuild,
} from './rollup.js';

const PAGES = ['one-on-one-zh', 'run-zh', 'run-direct-zh', 'three-zh'];
const NOW = Date.parse('2026-11-19T05:00:00Z'); // 2026-11-19 13:00 台灣

const PAID = `(lower(med) IN ('cpc','ppc','paid','ad','ads','cpm','sponsored','paid_social','paidsocial','paid-social') OR lower(med) LIKE 'paid%')`;
const CHANNEL_SQL = `CASE
  WHEN (lower(src) LIKE '%facebook%' OR lower(src) LIKE '%instagram%' OR lower(src) IN ('fb','ig','meta'))
    THEN CASE WHEN ${PAID} THEN 'meta_paid' ELSE 'meta_organic' END
  WHEN lower(src) LIKE '%google%' THEN CASE WHEN ${PAID} THEN 'google_paid' ELSE 'google' END
  WHEN lower(src) LIKE '%line%' THEN 'line'
  WHEN src IS NULL OR src = '' OR src = '(direct)' THEN 'direct'
  ELSE 'other' END`;

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions(
      sid TEXT PRIMARY KEY, vid TEXT, page TEXT, day TEXT, start INTEGER, last INTEGER,
      src TEXT, med TEXT, camp TEXT, cont TEXT, ref TEXT, dev TEXT,
      engaged INTEGER DEFAULT 0, eng_ms INTEGER DEFAULT 0, inter INTEGER DEFAULT 0, scroll INTEGER DEFAULT 0,
      last_sec TEXT, exit_sec TEXT, bclick INTEGER DEFAULT 0);
    CREATE INDEX s_day ON sessions(day);
    CREATE TABLE events(ts INTEGER, day TEXT, sid TEXT, page TEXT, name TEXT, k TEXT);
    CREATE INDEX e_day ON events(day, name);
    CREATE TABLE conv(id TEXT PRIMARY KEY, ts INTEGER, day TEXT, kind TEXT, vid TEXT, page TEXT, cta TEXT, src TEXT, med TEXT, camp TEXT);
    CREATE INDEX c_day ON conv(day, kind);
  `);
  return db;
}

function seed(db) {
  const insS = db.prepare(`INSERT INTO sessions(sid,vid,page,day,start,last,src,med,camp,dev,engaged,eng_ms,inter,scroll,bclick,exit_sec,last_sec)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insE = db.prepare(`INSERT INTO events(ts,day,sid,page,name,k) VALUES (?,?,?,?,?,?)`);
  const insC = db.prepare(`INSERT INTO conv(id,ts,day,kind,vid,page,cta,src,med,camp) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const S = (sid, vid, page, day, src, med, camp, dev, engaged, eng, inter, scroll, bclick, exit, last, start = 1000) =>
    insS.run(sid, vid, page, day, start, start, src, med, camp, dev, engaged, eng, inter, scroll, bclick, exit, last);

  S('prev', 'vp', 'one-on-one-zh', '2026-11-15', '(direct)', '(none)', '', 'mobile', 0, 0, 0, 5, 0, 'hero', 'hero');
  S('s1', 'v1', 'one-on-one-zh', '2026-11-16', 'facebook', 'cpc', 'spring', 'mobile', 1, 20000, 1, 80, 2, null, 'price', 5000);
  S('s2', 'v2', 'one-on-one-zh', '2026-11-16', '(direct)', '(none)', '', 'desktop', 0, 3000, 0, 10, 0, 'cases', 'cases', 6000);
  S('s3', 'v3', 'run-zh', '2026-11-16', 'google', 'organic', '', 'mobile', 1, 0, 2, 0, 0, null, 'faq', 7000);
  S('s9', 'v7', 'one-on-one-zh', '2026-11-16', 'fb', '(none)', null, 'mobile', 0, 15000, 0, 20, 0, 'faq', 'faq', 8000);
  S('sUp', 'v8', 'one-on-one-zh', '2026-11-16', 'Facebook', 'CPC', 'Spring', 'desktop', 1, 11000, 0, 30, 1, null, 'hero', 9000);
  S('s4', 'v1', 'one-on-one-zh', '2026-11-17', 'facebook', 'paid', 'spring', 'mobile', 1, 10000, 1, 40, 1, null, 'hero', 11000);
  S('s5', 'v4', 'one-on-one-zh', '2026-11-17', 'line', 'social', '', 'tablet', 0, 0, 0, 0, 0, null, null, 12000);
  S('s6', 'v5', 'one-on-one-zh', '2026-11-17', 'instagram', 'cpc', 'ig', 'mobile', 1, 12000, 0, 60, 0, null, 'stores', 13000);
  S('s7', 'v6', 'run-direct-zh', '2026-11-18', 'google', 'cpc', 'g1', 'desktop', 0, 9000, 0, 90, 0, 'closing', 'closing', 14000);
  S('sOther', 'v10', 'three-zh', '2026-11-18', 'newsletter', 'email', 'nov', 'desktop', 0, 1000, 0, 15, 0, 'hero', 'hero', 15000);
  S('sToday', 'v9', 'one-on-one-zh', '2026-11-19', 'facebook', 'cpc', 'live', 'mobile', 1, 50000, 1, 100, 5, null, 'price', 16000);

  const E = (day, sid, page, name, k, ts) => insE.run(ts, day, sid, page, name, k);
  E('2026-11-16', 's1', 'one-on-one-zh', 'section_view', 'hero', 5000 + 1000);
  E('2026-11-16', 's1', 'one-on-one-zh', 'section_view', 'hero', 5000 + 1500);
  E('2026-11-16', 's1', 'one-on-one-zh', 'section_view', 'price', 5000 + 8000);
  E('2026-11-16', 's1', 'one-on-one-zh', 'scroll_depth', '25', 5100);
  E('2026-11-16', 's1', 'one-on-one-zh', 'scroll_depth', '50', 5200);
  E('2026-11-16', 's1', 'one-on-one-zh', 'booking_click', 'price', 5300);
  E('2026-11-16', 's1', 'one-on-one-zh', 'booking_click', 'sticky', 5400);
  E('2026-11-16', 's1', 'one-on-one-zh', 'faq_open', '如何預約', 5500);
  E('2026-11-16', 's1', 'one-on-one-zh', 'faq_open', '如何預約', 5600);
  E('2026-11-16', 's2', 'one-on-one-zh', 'section_view', 'hero', 6000 + 500);
  E('2026-11-16', 's2', 'one-on-one-zh', 'scroll_depth', '25', 6100);
  E('2026-11-16', 's3', 'run-zh', 'section_view', 'hero', 7000 + 200);
  E('2026-11-16', 's3', 'run-zh', 'hero_step_click', '跑姿', 7100);
  E('2026-11-16', 's3', 'run-zh', 'animation_toggle', null, 7200);
  E('2026-11-16', 's3', 'run-zh', 'line_click', null, 7300);
  E('2026-11-17', 's4', 'one-on-one-zh', 'section_view', 'hero', 11000 + 400);
  E('2026-11-17', 's4', 'one-on-one-zh', 'booking_click', 'hero', 11400);
  // 跨午夜：工作階段日 11/17，事件日 11/18，仍要算在 11/17
  E('2026-11-18', 's6', 'one-on-one-zh', 'section_view', 'stores', 13000 + 9000);
  E('2026-11-18', 's7', 'run-direct-zh', 'section_view', 'hero', 14000 + 100);
  E('2026-11-18', 's7', 'run-direct-zh', 'section_view', 'closing', 14000 + 7000);
  E('2026-11-18', 's7', 'run-direct-zh', 'scroll_depth', '90', 14100);
  E('2026-11-19', 'sToday', 'one-on-one-zh', 'section_view', 'hero', 16000 + 100);
  E('2026-11-19', 'sToday', 'one-on-one-zh', 'booking_click', 'hero', 16100);
  E('2026-11-19', 'sToday', 'one-on-one-zh', 'booking_click', 'hero', 16200);
  E('2026-11-19', 'sToday', 'one-on-one-zh', 'booking_click', 'sticky', 16300);

  insC.run('c1', 1, '2026-11-16', 'liff', 'v1', 'one-on-one-zh', 'price', 'facebook', 'cpc', 'spring');
  insC.run('c2', 2, '2026-11-16', 'booked', 'v1', 'one-on-one-zh', 'price', 'facebook', 'cpc', 'spring');
  insC.run('c3', 3, '2026-11-16', 'liff', 'v3', 'run-zh', 'hero', 'google', 'organic', '');
  insC.run('c4', 4, '2026-11-17', 'booked', 'v4', 'one-on-one-zh', '', 'line', 'social', '');
  insC.run('c5', 5, '2026-11-19', 'booked', 'v9', 'one-on-one-zh', 'hero', 'facebook', 'cpc', 'live');

  for (let i = 1; i <= 22; i++) {
    const camp = 'extra-' + String(i).padStart(2, '0');
    for (let n = 0; n < i; n++) {
      S('x' + i + '-' + n, 'xv' + i + '-' + n, 'one-on-one-zh', '2026-11-16', 'newsletter', 'email', camp, 'mobile', 0, 0, 0, 0, 0, 'hero', 'hero', 20000 + i * 100 + n);
    }
  }
}

function legacyStats(db, opts) {
  const page = PAGES.includes(opts.page) ? opts.page : '';
  const inPages = PAGES.map((x) => `'${x}'`).join(',');
  const ch = opts.channel || '';
  const r = opts.range;
  const one = (sql) => db.prepare(sql).all()[0] || {};
  const all = (sql) => db.prepare(sql).all();
  const sw = (from, to) => {
    let w = `s.day BETWEEN '${from}' AND '${to}'`;
    w += page ? ` AND s.page='${page}'` : ` AND s.page IN (${inPages})`;
    if (ch) w += ` AND (${CHANNEL_SQL.replace(/\bsrc\b/g, 's.src').replace(/\bmed\b/g, 's.med')})='${ch}'`;
    return w;
  };
  const cw = (from, to, kind) => {
    let w = `day BETWEEN '${from}' AND '${to}' AND kind='${kind}'`;
    w += page ? ` AND page='${page}'` : ` AND page IN (${inPages})`;
    if (ch) w += ` AND (${CHANNEL_SQL})='${ch}'`;
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
    WHERE e.name IN ('hero_step_click','faq_open','store_expand','store_map_click','xsell_expand','xsell_pick','case_view','testimonial_view','line_click','xsell_group','xsell_cert')
      AND ${sw(r.from, r.to)} GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`);
  const scroll = all(`SELECT e.k pct, COUNT(DISTINCT e.sid) n FROM events e JOIN sessions s ON s.sid=e.sid
    WHERE e.name='scroll_depth' AND ${sw(r.from, r.to)} GROUP BY e.k`);
  return { range: r, filter: { page, channel: ch }, cur, prev, reach, exits, order, daily, dconv, channels, cbook, sources, devices, ctas, inter, scroll };
}

function num(v) {
  if (typeof v === 'bigint') return Number(v);
  return v;
}
function norm(v, ordered = false) {
  v = num(v);
  if (Array.isArray(v)) {
    const mapped = v.map((x) => norm(x));
    return ordered ? mapped : mapped.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (['generated', 'data_note', 'includes_today', 'as_of', 'backfill_pending', 'today_excluded', 'first_day'].includes(k)) continue;
      o[k] = k === 'order' ? norm(v[k], true) : norm(v[k]);
    }
    return o;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
  return v;
}

function rollupRows(db) {
  const days = db.prepare(`SELECT DISTINCT day FROM sessions ORDER BY day`).all().map((r) => r.day);
  return days.map((day) => ({ day, built: day === '2026-11-19' ? 0 : 1, doc: JSON.parse(JSON.stringify(rebuildDayFromDb({ all: (sql, ...a) => db.prepare(sql).all(...a) }, day))) }));
}

function rollupStats(db, q) {
  const range = resolveRange(q, NOW);
  const rows = rollupRows(db);
  return statsFromRollupRows(rows, {
    pages: PAGES, page: PAGES.includes(q.page) ? q.page : '', channel: CHANNELS.has(q.channel) ? q.channel : '',
    range, today: range.today, includes_today: range.includes_today,
    firstDay: '2026-11-15', generated: 1,
    data_note: dataNote(range.includes_today), today_excluded: range.today_excluded,
  });
}

test('預設期間截止到昨天，今天要明確打開', () => {
  const quiet = resolveRange({}, NOW);
  assert.equal(quiet.today, '2026-11-19');
  assert.equal(quiet.to, '2026-11-18');
  assert.equal(quiet.from, '2026-11-12');
  assert.equal(quiet.n, 7);
  assert.equal(quiet.includes_today, false);
  assert.equal(dataNote(false), '資料更新至昨日');

  const live = resolveRange({ include_today: '1' }, NOW);
  assert.equal(live.to, '2026-11-19');
  assert.equal(live.from, addDays('2026-11-19', -6));
  assert.equal(live.includes_today, true);
  assert.equal(dataNote(true), '含今天即時數據，約每 10 分鐘更新');

  const clamped = resolveRange({ from: '2026-11-19', to: '2026-11-19' }, NOW);
  assert.equal(clamped.to, '2026-11-18');
  assert.equal(clamped.today_excluded, true);
  assert.equal(clamped.includes_today, false);

  const past = resolveRange({ from: '2026-11-01', to: '2026-11-10', include_today: '1' }, NOW);
  assert.equal(past.to, '2026-11-10');
  assert.equal(past.includes_today, false);
});

test('管道分類與舊 SQL 一致', () => {
  assert.equal(channelOf('facebook', 'cpc'), 'meta_paid');
  assert.equal(channelOf('Facebook', 'CPC'), 'meta_paid');
  assert.equal(channelOf('fb', '(none)'), 'meta_organic');
  assert.equal(channelOf('instagram', 'cpc'), 'meta_paid');
  assert.equal(channelOf('IG', 'paid_social'), 'meta_paid');
  assert.equal(channelOf('meta', 'social'), 'meta_organic');
  assert.equal(channelOf('google', 'organic'), 'google');
  assert.equal(channelOf('google', 'cpc'), 'google_paid');
  assert.equal(channelOf('line', 'social'), 'line');
  assert.equal(channelOf('(direct)', '(none)'), 'direct');
  assert.equal(channelOf(null, null), 'direct');
  assert.equal(channelOf('', ''), 'direct');
  assert.equal(channelOf('newsletter', 'email'), 'other');
  assert.equal(channelOf('notfacebook', 'cpc'), 'meta_paid');
  assert.equal(dayOf(NOW), '2026-11-19');
});

test('昨天的結算在台灣時間早上八點前還會重算，之後固定', () => {
  const today = '2026-11-19';
  const morning = Date.parse('2026-11-19T00:00:00Z');
  assert.equal(yesterdayNeedsRebuild(morning - 60_000, today, null), true);
  const builtEarly = morning - 3 * 3600e3;
  assert.equal(yesterdayNeedsRebuild(builtEarly + 31 * 60e3, today, { built: 1, built_at: builtEarly }), true);
  assert.equal(yesterdayNeedsRebuild(builtEarly + 5 * 60e3, today, { built: 1, built_at: builtEarly }), false);
  assert.equal(yesterdayNeedsRebuild(morning + 3600e3, today, { built: 1, built_at: builtEarly }), true);
  assert.equal(yesterdayNeedsRebuild(morning + 3600e3, today, { built: 1, built_at: morning + 1000 }), false);
  const afternoon = Date.parse('2026-11-19T05:00:00Z'); // 13:00 台灣，離午夜還超過 6 小時
  assert.equal(nextIdleDelay(afternoon), 6 * 3600e3);
  const late = Date.parse('2026-11-19T14:00:00Z'); // 22:00 台灣
  const target = Date.parse('2026-11-20T00:00:00Z') - 8 * 3600e3 + 10 * 60 * 1000;
  assert.equal(late + nextIdleDelay(late), target);
});

test('彙總查詢走日期索引，不掃整張事件表', () => {
  const db = openDb();
  const plan = (sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join('\n');
  const events = plan(SQL_EVENTS, '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-17');
  assert.match(events, /SEARCH e USING INDEX e_day/);
  assert.doesNotMatch(events, /SCAN e\b|SCAN events/);
  const sessions = plan(SQL_SESSIONS, '2026-11-17');
  assert.match(sessions, /USING INDEX s_day/);
  const conv = plan(SQL_CONV, '2026-11-17');
  assert.match(conv, /USING INDEX c_day/);
});

test('每日彙總與舊版 stats() 的數字一致，且預設不含今天', () => {
  const db = openDb();
  seed(db);
  const cases = [
    { from: '2026-11-16', to: '2026-11-18' },
    { from: '2026-11-16', to: '2026-11-18', page: 'one-on-one-zh' },
    { from: '2026-11-16', to: '2026-11-18', page: 'run-zh' },
    { from: '2026-11-16', to: '2026-11-18', channel: 'meta_paid' },
    { from: '2026-11-16', to: '2026-11-18', channel: 'direct' },
    { from: '2026-11-16', to: '2026-11-18', channel: 'line' },
    { from: '2026-11-18', to: '2026-11-19', include_today: '1' },
    { from: '2026-11-19', to: '2026-11-19' },
  ];
  for (const q of cases) {
    const rolled = rollupStats(db, q);
    const range = { from: rolled.range.from, to: rolled.range.to, n: rolled.range.n, pfrom: rolled.range.pfrom, pto: rolled.range.pto };
    const old = legacyStats(db, { ...q, page: q.page, channel: q.channel, range });
    assert.deepEqual(norm(rolled), norm(old), JSON.stringify(q));
  }

  const quiet = rollupStats(db, { from: '2026-11-16', to: '2026-11-19' });
  const live = rollupStats(db, { from: '2026-11-16', to: '2026-11-19', include_today: '1' });
  assert.equal(quiet.range.to, '2026-11-18');
  assert.equal(quiet.includes_today, false);
  assert.equal(quiet.data_note, '資料更新至昨日');
  assert.equal(live.includes_today, true);
  assert.ok(live.cur.sessions > quiet.cur.sessions);
  assert.ok(live.cur.bclicks > quiet.cur.bclicks);
  assert.equal(live.cur.visitors, quiet.cur.visitors + 1);

  const paid = rollupStats(db, { from: '2026-11-16', to: '2026-11-18', channel: 'meta_paid' });
  const hero = paid.reach.find((x) => x.sec === 'hero');
  assert.ok(hero.n >= 1);
  const faq = paid.inter.find((x) => x.name === 'faq_open');
  assert.equal(faq.n, 2);
  assert.equal(faq.sessions, 1);
  assert.equal(paid.inter.some((x) => x.name === 'animation_toggle'), false);
  const all = rollupStats(db, { from: '2026-11-16', to: '2026-11-18' });
  assert.equal(all.sources.length, 20);
  assert.equal(all.sources[0].camp, 'extra-22');
  assert.equal(all.sources.some((x) => x.camp === 'extra-01'), false);
  assert.equal(all.sources.some((x) => x.camp === 'extra-03'), true);
});
