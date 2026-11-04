/**
 * 凝聚行銷後台 MCP（給 Claude 讀數據用，唯讀）
 * ---------------------------------------------------------------------------
 * 網址：https://cico.tw/mcp/<MCP_KEY>   （MCP_KEY 是 Cloudflare 祕密，沒設就關閉）
 * 協定：MCP Streamable HTTP（JSON 回應，不需要 SSE）
 * 工具：
 *   list_product_lines   產品線、頁面、資料串接狀態
 *   get_marketing_report 指定產品線＋期間的漏斗、跳出位置、來源、裝置、互動，含前期比較與換算指標
 *   get_ad_campaigns     Meta 廣告活動明細與每日數字
 */
const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SECTIONS = { hero: '首屏', pain_wall: '痛點牆', testimonials: '選手證言', cases: '真實案例', tight_tangled: '緊與卡', process: '體驗流程', price: '價格', stores: '門市', cross_sell: '其他課程', faq: '常見問題', closing: '結尾' };
const ORDER = {
  'one-on-one-zh': ['hero', 'pain_wall', 'cases', 'tight_tangled', 'process', 'price', 'testimonials', 'stores', 'cross_sell', 'faq', 'closing'],
  'run-zh': ['hero', 'pain_wall', 'testimonials', 'cases', 'tight_tangled', 'process', 'price', 'stores', 'cross_sell', 'faq', 'closing'],
};
const CH = { meta_paid: 'Meta 廣告', meta_organic: 'FB／IG 自然', line: 'LINE', google: 'Google 自然', google_paid: 'Google 廣告', direct: '直接輸入', other: '其他網站' };
const CTA = { hero: '首屏按鈕', price: '價格區按鈕', sticky: '底部常駐列', 'store-taipei': '台北店卡片', 'store-banqiao': '板橋店卡片' };

const dateArg = { type: 'string', description: 'YYYY-MM-DD（台灣時間）。省略時預設近 7 天（含今天）。' };
const TOOLS = [
  {
    name: 'list_product_lines',
    description: '列出凝聚的產品線（一對一、團班課、認證課／工作坊／講座）、各自的介紹頁，以及 Meta 廣告與自家收集是否已串接、從哪天開始有資料。判讀前先呼叫，確認能看哪些數據。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_marketing_report',
    description: '取得一條產品線在指定期間的行銷成效：Meta 廣告曝光／點擊／花費、介紹頁造訪、跳出、各區塊到達率與離開位置、預約按鈕點擊、進入預約頁、完成預約，以及換算後的點閱率、跳出率、轉換率、成本等，並附上同長度前一期的數字供比較。數字都已算好，請直接引用，不要自行估算。',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string', enum: ['one', 'group', 'cert'], description: 'one=一對一（預設）, group=團班課, cert=認證課／工作坊／講座' },
        from: dateArg, to: dateArg,
        page: { type: 'string', description: '只看某一頁（如 one-on-one-zh、run-zh）。省略＝這條產品線全部頁面。' },
        channel: { type: 'string', enum: ['meta_paid', 'meta_organic', 'line', 'google', 'google_paid', 'direct', 'other'], description: '只看某個流量管道。省略＝全部。' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_ad_campaigns',
    description: '取得一條產品線的 Meta 廣告活動明細（每個活動的曝光、觸及、連結點擊、花費、CTR、CPC、CPM、頻率）與每日數字，含前一期比較。',
    inputSchema: {
      type: 'object',
      properties: { line: { type: 'string', enum: ['one', 'group', 'cert'] }, from: dateArg, to: dateArg },
    },
    annotations: { readOnlyHint: true },
  },
];

const r1 = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const rate = (a, b) => (b > 0 ? r1((a / b) * 100, 2) : null);
const per = (a, b) => (b > 0 ? r1(a / b, 2) : null);
const chg = (cur, prev) => (prev > 0 ? r1(((cur - prev) / prev) * 100, 1) : null);

function adSum(list) {
  const t = { impressions: 0, reach: 0, clicks: 0, spend: 0 };
  (list || []).forEach((c) => { t.impressions += c.impressions; t.reach += c.reach; t.clicks += c.clicks; t.spend += c.spend; });
  t.spend = r1(t.spend, 0);
  return t;
}
function adCalc(t) {
  return { ctr_pct: rate(t.clicks, t.impressions), cpc_twd: per(t.spend, t.clicks), cpm_twd: per(t.spend * 1000, t.impressions), frequency: per(t.impressions, t.reach) };
}

export async function handleMcp(req, env, deps) {
  const { store, stats, metaReport, ga4Report, linesInfo, LINES } = deps;
  if (req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response(null, { status: 405 });

  let msg;
  try { msg = await req.json(); } catch (e) { return rpcError(null, -32700, 'Parse error'); }
  const batch = Array.isArray(msg);
  const list = batch ? msg : [msg];
  const out = [];
  for (const m of list) {
    if (!m || m.id === undefined || m.id === null) continue; // notification
    out.push(await handle(m));
  }
  if (!out.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(batch ? out : out[0]), { headers: { 'Content-Type': 'application/json' } });

  async function handle(m) {
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const v = m.params && m.params.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED.includes(v) ? v : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ningju-marketing', title: '凝聚行銷後台', version: '1.0.0' },
          instructions: '凝聚運動顧問的行銷後台數據（唯讀）。先用 list_product_lines 看有哪些產品線與資料，再用 get_marketing_report 取漏斗與跳出數據、get_ad_campaigns 取廣告活動明細。金額單位為新台幣，日期為台灣時間。',
        });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params && m.params.name;
        const args = (m.params && m.params.arguments) || {};
        try {
          const data = await call(name, args);
          if (data === undefined) return fail(-32602, 'Unknown tool: ' + name);
          return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: '讀取失敗：' + (e.message || e) }], isError: true });
        }
      }
      default: return fail(-32601, 'Method not found: ' + m.method);
    }
  }

  async function call(name, a) {
    const db = store(env);
    if (name === 'list_product_lines') {
      const info = linesInfo(env);
      const s = await db.stats({ line: 'one' });
      return {
        product_lines: Object.entries(info).map(([id, l]) => ({ id, name: l.name, pages: l.pages, meta_ads_connected: l.ads, has_landing_page: l.pages.length > 0 })),
        first_party_data_since: s.first_day,
        ga4_connected: !!(env.GA_SA_KEY && env.GA4_PROPERTY_ID),
        today_taiwan: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
      };
    }
    if (name === 'get_ad_campaigns') {
      const q = { line: LINES[a.line] ? a.line : 'one', from: a.from, to: a.to };
      const s = await db.stats(q);
      const m = await metaReport(env, db, q);
      if (!m.configured) return { product_line: LINES[q.line].name, range: { from: s.range.from, to: s.range.to, days: s.range.n }, meta_ads: '尚未串接這條產品線的廣告帳號' };
      if (m.error) throw new Error(m.error);
      const cur = adSum(m.campaigns), prev = adSum(m.prev);
      const byDay = {};
      (m.daily || []).forEach((d) => { const x = (byDay[d.day] = byDay[d.day] || { day: d.day, impressions: 0, clicks: 0, spend: 0 }); x.impressions += d.impressions; x.clicks += d.clicks; x.spend += d.spend; });
      return {
        product_line: LINES[q.line].name,
        range: { from: s.range.from, to: s.range.to, days: s.range.n, previous: { from: s.range.pfrom, to: s.range.pto } },
        totals: { ...cur, ...adCalc(cur) },
        previous_totals: { ...prev, ...adCalc(prev) },
        change_pct: { impressions: chg(cur.impressions, prev.impressions), clicks: chg(cur.clicks, prev.clicks), spend: chg(cur.spend, prev.spend) },
        campaigns: m.campaigns.map((c) => ({ id: c.id, name: c.name, impressions: c.impressions, reach: c.reach, clicks: c.clicks, spend: r1(c.spend, 0), ...adCalc(c),
          previous: (() => { const p = m.prev.find((x) => x.id === c.id); return p ? { impressions: p.impressions, clicks: p.clicks, spend: r1(p.spend, 0), ...adCalc(p) } : null; })() })),
        daily: Object.values(byDay).sort((x, y) => x.day.localeCompare(y.day)).map((d) => ({ ...d, spend: r1(d.spend, 0), ctr_pct: rate(d.clicks, d.impressions) })),
        notes: ['clicks＝連結點擊（不含按讚留言）', 'reach 為各活動加總，同一人可能重複計算', '金額單位：新台幣'],
      };
    }
    if (name === 'get_marketing_report') {
      const q = { line: LINES[a.line] ? a.line : 'one', from: a.from, to: a.to, page: a.page || '', channel: a.channel || '' };
      const D = await stats(db, q);
      const m = await metaReport(env, db, q).catch((e) => ({ configured: true, error: String(e.message || e) }));
      const g = await ga4Report(env, db, q).catch((e) => ({ error: String(e.message || e) }));
      const L = LINES[q.line];
      const c = D.cur, p = D.prev;
      const ad = m.configured && !m.error ? adSum(m.campaigns) : null, adp = ad ? adSum(m.prev) : null;
      const mps = (D.channels.find((x) => x.ch === 'meta_paid') || {}).sessions || 0;
      const site = (x) => ({
        sessions: x.sessions, unique_visitors: x.visitors, bounced_sessions: x.bounced, engaged_sessions: x.engaged,
        sessions_clicked_booking: x.bsessions, booking_button_clicks: x.bclicks, opened_booking_page: x.liff, completed_bookings: x.booked,
        avg_engaged_seconds: x.avg_ms ? Math.round(x.avg_ms / 1000) : null, avg_scroll_pct: x.avg_scroll,
        bounce_rate_pct: rate(x.bounced, x.sessions), booking_click_rate_pct: rate(x.bsessions, x.sessions),
        booking_page_reach_pct: rate(x.liff, x.bsessions), booking_completion_pct: rate(x.booked, x.liff), overall_conversion_pct: rate(x.booked, x.sessions),
      });
      const reach = {}; D.reach.forEach((x) => { reach[x.sec] = x.n; });
      const exitsBy = {}; let exitTotal = 0; D.exits.forEach((x) => { exitsBy[x.sec] = (exitsBy[x.sec] || 0) + x.n; exitTotal += x.n; });
      const base = ORDER[q.page] || ORDER[L.pages[0]] || D.order;
      const secOrder = base.concat(Object.keys(reach).filter((k) => !base.includes(k)));
      const sections = secOrder.map((k) => ({
        section: SECTIONS[k] || k, key: k, reached_sessions: k === 'hero' ? Math.max(reach[k] || 0, c.sessions) : reach[k] || 0,
        reach_pct: rate(k === 'hero' ? Math.max(reach[k] || 0, c.sessions) : reach[k] || 0, c.sessions),
        exits_without_booking: exitsBy[k] || 0, share_of_exits_pct: rate(exitsBy[k] || 0, exitTotal),
      }));
      const book = {}; D.cbook.forEach((x) => { (book[x.ch] = book[x.ch] || {})[x.kind] = x.n; });
      const out = {
        product_line: L.name,
        has_landing_page: L.pages.length > 0,
        filter: { page: q.page || '全部頁面', channel: q.channel ? CH[q.channel] : '全部流量' },
        range: { from: D.range.from, to: D.range.to, days: D.range.n, previous: { from: D.range.pfrom, to: D.range.pto } },
        first_party_data_since: D.first_day,
        meta_ads: ad ? { totals: { ...ad, ...adCalc(ad) }, previous: { ...adp, ...adCalc(adp) },
          landing_rate_pct: rate(mps, ad.clicks), meta_paid_sessions: mps,
          cost_per_booking_twd: per(ad.spend, c.booked), cost_per_booking_page_open_twd: per(ad.spend, c.liff) }
          : (m.error ? { error: m.error } : '尚未串接這條產品線的廣告帳號'),
      };
      if (L.pages.length) {
        Object.assign(out, {
          site: site(c), site_previous: site(p),
          funnel: [
            ...(ad ? [{ step: '廣告曝光', value: ad.impressions }, { step: '廣告連結點擊', value: ad.clicks }] : []),
            { step: '造訪', value: c.sessions }, { step: '有互動（未跳出）', value: c.engaged }, { step: '點了預約按鈕', value: c.bsessions },
            { step: '進入預約頁', value: c.liff }, { step: '完成預約', value: c.booked },
          ],
          sections_in_page_order: sections,
          ...(!q.page && L.pages.length > 1 ? { sections_note: '多個頁面合併計算，區塊順序以第一個頁面為準；兩個版本順序不同，要精準判斷請指定 page。' } : {}),
          channels: D.channels.map((x) => ({ channel: CH[x.ch] || x.ch, sessions: x.sessions, bounce_rate_pct: rate(x.bounced, x.sessions), booking_click_rate_pct: rate(x.bsessions, x.sessions), opened_booking_page: (book[x.ch] || {}).liff || 0, completed_bookings: (book[x.ch] || {}).booked || 0 })),
          top_sources: D.sources.slice(0, 10).map((x) => ({ source: x.src, medium: x.med, campaign: x.camp || null, sessions: x.sessions, bounce_rate_pct: rate(x.bounced, x.sessions), booking_click_rate_pct: rate(x.bsessions, x.sessions) })),
          devices: D.devices.map((x) => ({ device: x.dev, sessions: x.sessions, bounce_rate_pct: rate(x.bounced, x.sessions), booking_click_rate_pct: rate(x.bsessions, x.sessions), avg_engaged_seconds: x.avg_ms ? Math.round(x.avg_ms / 1000) : null })),
          booking_buttons: D.ctas.map((x) => ({ button: CTA[x.cta] || x.cta, clicks: x.clicks })),
          scroll_depth: D.scroll.map((x) => ({ reached_pct: Number(x.pct), sessions: x.n, share_pct: rate(x.n, c.sessions) })).sort((x, y) => x.reached_pct - y.reached_pct),
          interactions: D.inter.slice(0, 15).map((x) => ({ type: x.name, item: x.k, count: x.n, sessions: x.sessions })),
          daily: D.daily.map((x) => ({ day: x.d, sessions: x.sessions, bounce_rate_pct: rate(x.bounced, x.sessions), sessions_clicked_booking: x.bsessions })),
        });
        if (g && g.configured && !g.no_pages) out.ga4 = g.error ? { error: g.error } : g;
      }
      out.definitions = {
        跳出: '停留未滿 10 秒且沒有任何點擊／展開就離開（只捲動不算互動）',
        造訪: '同一分頁 30 分鐘內算一次；換了廣告來源再進來算新的一次',
        在此離開: '沒點預約就離開時，畫面中央停在哪一屏',
        到站率: 'Meta 廣告帶來的造訪 ÷ 廣告連結點擊',
        資料來源: '造訪以後的數字是 cico.tw 自家收集（不受廣告攔截器影響）；廣告數字來自 Meta Marketing API',
      };
      if (D.cur.sessions < 100) out.caution = `樣本只有 ${D.cur.sessions} 次造訪，比率波動大，判讀時請保守。`;
      return out;
    }
    return undefined;
  }
}

function rpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}
