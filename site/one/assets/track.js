/* Marketing tags + first-party attribution. Loaded in <head>; exposes window.track(). */
(function () {
  var S = window.SITE || {};
  var LS = { get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  // ---- attribution: first touch + last touch, 90 days -------------------
  var q = new URLSearchParams(location.search), now = Date.now(), DAY = 864e5;
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ttclid'];
  var hit = {}; KEYS.forEach(function (k) { if (q.get(k)) hit[k] = q.get(k); });
  if (!hit.utm_source && document.referrer && document.referrer.indexOf(location.host) < 0) {
    try { hit.ref = new URL(document.referrer).hostname; } catch (e) {}
  }
  var vid = LS.get('nj_vid');
  if (!vid) { vid = (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2)); LS.set('nj_vid', vid); }
  var first = LS.get('nj_first');
  if (!first || now - first.t > 90 * DAY) { first = { t: now, p: hit }; LS.set('nj_first', first); }
  var last = LS.get('nj_last');
  if (Object.keys(hit).length || !last || now - last.t > 90 * DAY) { last = { t: now, p: hit }; LS.set('nj_last', last); }
  window.NJ_ATTR = { vid: vid, first: first.p, last: last.p };

  // ---- GA4 ---------------------------------------------------------------
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  if (S.ga4) { gtag('js', new Date()); gtag('config', S.ga4, { page_type: S.page }); }
  // GA4 client id → passed to LIFF so both pages count as the same visitor
  if (S.ga4) gtag('get', S.ga4, 'client_id', function (id) { if (id) window.NJ_ATTR.gcid = id; });

  // ---- Meta Pixel --------------------------------------------------------
  if (S.pixel) {
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', S.pixel, { external_id: vid });
    fbq('track', 'PageView');
  }

  // ---- LINE Tag ----------------------------------------------------------
  if (S.lineTag) {
    (function(g,d,o){g._ltq=g._ltq||[];g._lt=g._lt||function(){g._ltq.push(arguments)};var h=location.protocol==='https:'?'https://d.line-scdn.net':'http://d.line-cdn.net';var s=d.createElement('script');s.async=1;s.src=o||h+'/n/line_tag/public/release/v1/lt.js';var t=d.getElementsByTagName('script')[0];t.parentNode.insertBefore(s,t);})(window,document);
    _lt('init', { customerType: 'lap', tagId: S.lineTag });
    _lt('send', 'pv', [S.lineTag]);
  }


  // ---- 第一方收集（後台 cico.tw/admin 的數據來源）--------------------------
  // 送到同網域 /api/e，不經第三方，所以廣告攔截器通常不會擋。
  // 在後台勾「這台裝置不計入」會設定 nj_optout，自己測試時不會灌水。
  var OPT = false; try { OPT = !!localStorage.getItem('nj_optout'); } catch (e) {}
  var Q = [], flushT = null;
  function flush() {
    clearTimeout(flushT); flushT = null;
    if (!Q.length || OPT) { Q = []; return; }
    var body = JSON.stringify(Q); Q = [];
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/e', new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { fetch('/api/e', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }
  function push(ev, now) { ev.sid = SID; ev.vid = vid; ev.page = S.page; Q.push(ev); if (now) flush(); else if (!flushT) flushT = setTimeout(flush, 1500); }
  // 工作階段：同一個分頁 30 分鐘內算同一次造訪
  var SID, ss = null;
  try { ss = JSON.parse(sessionStorage.getItem('nj_sid') || 'null'); } catch (e) {}
  var newSession = !ss || now - ss.t > 30 * 60e3 || Object.keys(hit).length > 0 && ss.p !== S.page;
  SID = newSession ? (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2)) : ss.id;
  function touch() { try { sessionStorage.setItem('nj_sid', JSON.stringify({ id: SID, t: Date.now(), p: S.page })); } catch (e) {} }
  touch();
  if (newSession) push({ n: 'session_start', a: hit }, true);
  // 停留時間（只算畫面在前景的時間）、10 秒標記、離開時停在哪一屏
  var shown = document.visibilityState === 'visible' ? Date.now() : 0, acc = 0, pinged = false;
  function engaged() { return acc + (shown ? Date.now() - shown : 0); }
  function currentSection() {
    var el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    var sec = el && el.closest && el.closest('section[data-section]');
    return sec ? sec.getAttribute('data-section') : null;
  }
  function scrollPct() { var h = document.documentElement; return Math.min(100, Math.round((h.scrollTop + innerHeight) / h.scrollHeight * 100)); }
  setInterval(function () {
    if (!pinged && engaged() >= 10000) { pinged = true; push({ n: 'ping', ms: engaged(), scroll: scrollPct() }, true); }
  }, 2000);
  function leave() {
    if (shown) { acc += Date.now() - shown; shown = 0; }
    touch();
    push({ n: 'exit', ms: acc, scroll: scrollPct(), k: currentSection() }, true);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') leave(); else shown = Date.now();
  });
  window.addEventListener('pagehide', function () { if (shown) leave(); });
  var KEYOF = { section_view: 'section', scroll_depth: 'percent', booking_click: 'cta_location', faq_open: 'question',
    store_expand: 'store', store_map_click: 'store', xsell_pick: 'course', xsell_expand: 'course_type',
    case_view: 'case_id', testimonial_view: 'name' };

  // ---- one call for every event -----------------------------------------
  // opts.meta  = Meta standard event name (or 'custom:Name')
  // opts.line  = LINE conversion type
  window.track = function (name, params, opts) {
    params = params || {}; opts = opts || {};
    params.page_type = S.page;
    try { gtag('event', name, Object.assign({ transport_type: 'beacon' }, params)); } catch (e) {}
    if (opts.meta && window.fbq) {
      if (opts.meta.indexOf('custom:') === 0) fbq('trackCustom', opts.meta.slice(7), params);
      else fbq('track', opts.meta, params);
    }
    if (opts.line && window._lt && S.lineTag) _lt('send', 'cv', { type: opts.line }, [S.lineTag]);
    try { var kk = KEYOF[name]; push({ n: name, k: kk ? params[kk] : (params.link_url || null) }, name === 'booking_click'); } catch (e) {}
    if (window.NJ_DEBUG) console.log('[track]', name, params, opts);
  };
})();
