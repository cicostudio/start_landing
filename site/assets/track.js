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
    if (window.NJ_DEBUG) console.log('[track]', name, params, opts);
  };
})();
