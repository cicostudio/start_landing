/* Page behaviour: booking links, case carousel, FAQ, animations, analytics hooks. */
(function () {
  var S = window.SITE || {}, A = window.NJ_ATTR || {};
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---- booking CTA → LIFF with attribution ---------------------------------
  function bookingUrl(loc) {
    var u = new URL(S.booking);
    var p = Object.assign({}, A.first || {}, A.last || {});
    Object.keys(p).forEach(function (k) { if (p[k]) u.searchParams.set(k, p[k]); });
    u.searchParams.set('lp', S.page);
    u.searchParams.set('cta', loc);
    if (A.vid) u.searchParams.set('vid', A.vid);
    return u.toString();
  }
  $$('[data-cta]').forEach(function (a) {
    var loc = a.getAttribute('data-cta');
    a.href = bookingUrl(loc);
    a.addEventListener('click', function () {
      track('booking_click', { cta_location: loc }, { meta: 'Lead', line: 'BookingClick' });
    });
  });

  // ---- other tracked links --------------------------------------------------
  $$('[data-track]').forEach(function (a) {
    a.addEventListener('click', function () {
      var t = a.getAttribute('data-track');
      if (t === 'line_click') track('line_click', {}, { meta: 'Contact', line: 'LineClick' });
      else if (t === 'store_map') track('store_map_click', { store: a.getAttribute('data-store') }, { meta: 'FindLocation' });
      else track(t, { link_url: a.href });
    });
  });

  // ---- sticky bar: show once the hero CTA has scrolled away ----------------
  var sticky = $('.sticky'), heroCta = $('[data-cta="hero"]');
  if (sticky && heroCta && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      sticky.classList.toggle('on', !es[0].isIntersecting && es[0].boundingClientRect.top < 0);
    }).observe(heroCta);
  } else if (sticky) sticky.classList.add('on');

  // ---- hero slideshow ------------------------------------------------------------
  var hs = $$('.hero-slide');
  if (hs.length > 1) {   // reduced motion: cross-fade only (no zoom, via CSS)
    var hi = 0, HOLD = 6000;
    hs.forEach(function (img, k) { if (k) img.loading = 'eager'; });
    setInterval(function () {
      if (document.hidden) return;
      var prev = hs[hi]; hi = (hi + 1) % hs.length; var next = hs[hi];
      next.classList.remove('off'); void next.offsetWidth; next.classList.add('on');
      prev.classList.remove('on'); prev.classList.add('off');
    }, HOLD);
  }

  // ---- bubble wall pause ---------------------------------------------------
  var wall = $('#wall'), wb = $('#wall-toggle');
  if (wall && wb) {
    if (reduce) { wall.style.animationPlayState = 'paused'; wb.textContent = '▶ 播放'; wb.setAttribute('aria-pressed', 'true'); }
    wb.addEventListener('click', function () {
      var paused = wall.style.animationPlayState === 'paused';
      wall.style.animationPlayState = paused ? 'running' : 'paused';
      wb.textContent = paused ? 'Ⅱ 暫停' : '▶ 播放';
      wb.setAttribute('aria-label', paused ? '暫停動畫' : '繼續播放');
      wb.setAttribute('aria-pressed', paused ? 'false' : 'true');
      track('animation_toggle', { target: 'pain_wall', state: paused ? 'play' : 'pause' });
    });
  }

  // ---- case carousel --------------------------------------------------------
  var track_ = $('#case-track'), slides = $$('.case'), dots = $$('.case-dot');
  if (track_ && slides.length) {
    var cur = 0, prog = 0, visible = false, DUR = 5000, TICK = 100, timer = null;
    function paint() {
      track_.style.transform = 'translateX(' + (-cur * 100) + '%)';
      dots.forEach(function (d, k) {
        $('.bar', d).style.width = (k < cur ? 100 : k === cur ? prog : 0) + '%';
        d.setAttribute('aria-current', k === cur ? 'true' : 'false');
      });
    }
    function go(i, byUser) {
      cur = (i + slides.length) % slides.length; prog = 0; paint();
      if (byUser) track('case_view', { case_id: slides[cur].getAttribute('data-case'), case_index: cur + 1 });
    }
    function tick() {
      if (!visible || document.hidden) return;
      prog += TICK / DUR * 100;
      if (prog >= 100) go(cur + 1, false); else paint();
    }
    dots.forEach(function (d) { d.addEventListener('click', function () { go(+d.getAttribute('data-go'), true); }); });
    // swipe
    var x0 = null;
    track_.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
    track_.addEventListener('pointerup', function (e) {
      if (x0 === null) return; var dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1), true);
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }, { threshold: 0.35 }).observe(track_.parentElement);
    } else { visible = true; }
    timer = setInterval(tick, TICK);   // reduced motion: slides change without the sliding transition (CSS)
    paint();
  }

  // ---- FAQ ----------------------------------------------------------------------
  $$('.faq-q').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = b.getAttribute('aria-expanded') === 'true';
      $$('.faq-q').forEach(function (o) {
        o.setAttribute('aria-expanded', 'false'); $('.faq-sign', o).textContent = '+';
        document.getElementById(o.getAttribute('aria-controls')).hidden = true;
      });
      if (!open) {
        b.setAttribute('aria-expanded', 'true'); $('.faq-sign', b).textContent = '−';
        document.getElementById(b.getAttribute('aria-controls')).hidden = false;
        track('faq_open', { question: b.textContent.replace(/[+−]$/, '').trim() });
      }
    });
  });

  // ---- section views ----------------------------------------------------------
  if ('IntersectionObserver' in window) {
    var seen = {}, secs = $$('section[data-section]');
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var n = e.target.getAttribute('data-section');
        if (e.isIntersecting && !seen[n]) {
          seen[n] = 1; io.unobserve(e.target);
          track('section_view', { section: n, section_index: secs.indexOf(e.target) + 1 });
        }
      });
    }, { threshold: 0.4 });
    secs.forEach(function (s) { io.observe(s); });
  }

  // ---- scroll depth -----------------------------------------------------------
  var marks = [25, 50, 75, 90], hitm = {};
  window.addEventListener('scroll', function () {
    var h = document.documentElement, pct = (h.scrollTop + innerHeight) / h.scrollHeight * 100;
    marks.forEach(function (m) { if (pct >= m && !hitm[m]) { hitm[m] = 1; track('scroll_depth', { percent: m }); } });
  }, { passive: true });

  // ---- ?debug=1 : on-screen diagnostics for checking a phone ---------------------
  if (/[?&]debug=1/.test(location.search)) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:99;padding:10px;border-radius:10px;background:rgba(0,0,0,.8);color:#fff;font:12px/1.5 monospace;white-space:pre-wrap';
    document.body.appendChild(box);
    setInterval(function () {
      var vids = $$('#case-track img').filter(function (m) { return m.complete && m.naturalWidth; }).length + ' / ' + $$('#case-track img').length + ' loaded (' + ($$('#case-track img')[0] ? $$('#case-track img')[0].currentSrc.split('/').pop() : '') + ')';
      box.textContent = 'reduce-motion: ' + reduce + '\nhidden: ' + document.hidden +
        '\nhero: ' + hs.map(function (h) { return h.className.replace('hero-slide', '').trim() || '-'; }).join(',') +
        '\ncase: ' + (typeof cur !== 'undefined' ? cur : '?') + ' visible: ' + (typeof visible !== 'undefined' ? visible : '?') +
        '\nvideos: ' + vids + '\nUA: ' + navigator.userAgent.slice(0, 90);
    }, 500);
  }
})();
