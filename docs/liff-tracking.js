/*
 * 凝聚 LIFF 預約頁｜追蹤碼接收與轉換回傳
 * ------------------------------------------------------------------
 * 一對一介紹頁的「預約首次體驗」會用這樣的網址開啟 LIFF：
 *   https://liff.line.me/2001467446-KNVd49W2?utm_source=…&utm_campaign=…&fbclid=…
 *        &lp=one-on-one-zh&cta=price&vid=<訪客ID>&gcid=<GA4 client id>
 *
 * 用法（3 步）：
 *   1. 把這個檔案放進 LIFF 頁面（<script src="liff-tracking.js"></script>）
 *   2. 在 `await liff.init(...)` 成功之後呼叫：  const attr = NJTrack.init();
 *      ※ 一定要在 liff.init 之後：之前網址參數還包在 liff.state 裡，讀不到
 *   3. 預約「完成」的那一刻呼叫：
 *        NJTrack.bookingComplete({ bookingId: 'B12345', store: '台北旗艦店', value: 1999 });
 *      並把 attr 跟預約資料一起存進你們的資料庫（之後就能查每筆預約來自哪個廣告）。
 */
(function () {
  var CFG = {
    ga4: 'G-55G78H5BPG',
    pixel: '800186701890749',
    lineTag: 'da896487-a669-425e-be02-3dc3afbd3638'
  };
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
              'fbclid', 'gclid', 'ttclid', 'lp', 'cta', 'vid', 'gcid'];
  var attr = {};

  function loadScript(src) {
    var s = document.createElement('script'); s.async = true; s.src = src;
    document.head.appendChild(s);
  }

  function init() {
    // ---- 1. 讀取參數（重新整理或頁內跳轉時，從 sessionStorage 補回） ----
    try { attr = JSON.parse(sessionStorage.getItem('nj_attr') || '{}'); } catch (e) { attr = {}; }
    var q = new URLSearchParams(location.search);
    KEYS.forEach(function (k) { if (q.get(k)) attr[k] = q.get(k); });
    if (attr.fbclid && !attr.fbc) attr.fbc = 'fb.1.' + Date.now() + '.' + attr.fbclid;  // Meta click id 格式
    try { sessionStorage.setItem('nj_attr', JSON.stringify(attr)); } catch (e) {}

    // ---- 2. GA4：沿用介紹頁的 client id，兩頁算同一位訪客；UTM 會從網址自動讀取 ----
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { dataLayer.push(arguments); };
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + CFG.ga4);
    gtag('js', new Date());
    var gaCfg = { page_location: location.href, page_type: 'liff-booking' };
    if (attr.gcid) gaCfg.client_id = attr.gcid;
    gtag('config', CFG.ga4, gaCfg);

    // ---- 3. Meta Pixel ----
    if (!window.fbq) {
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    }
    fbq('init', CFG.pixel, attr.vid ? { external_id: attr.vid } : {});
    fbq('track', 'PageView');

    // ---- 4. LINE Tag ----
    (function(g,d){g._ltq=g._ltq||[];g._lt=g._lt||function(){g._ltq.push(arguments)};var s=d.createElement('script');s.async=1;s.src='https://d.line-scdn.net/n/line_tag/public/release/v1/lt.js';var t=d.getElementsByTagName('script')[0];t.parentNode.insertBefore(s,t);})(window,document);
    _lt('init', { customerType: 'lap', tagId: CFG.lineTag });
    _lt('send', 'pv', [CFG.lineTag]);

    return attr;  // ← 跟預約資料一起存進資料庫
  }

  // 預約完成時呼叫一次（同一筆預約不要重複呼叫）
  function bookingComplete(opt) {
    opt = opt || {};
    var value = opt.value || 1999;
    var eventId = 'booking_' + (opt.bookingId || Date.now());   // 與伺服器端 CAPI 去重用
    gtag('event', 'booking_complete', {
      booking_id: opt.bookingId, store: opt.store, value: value, currency: 'TWD',
      lp: attr.lp, cta_location: attr.cta
    });
    fbq('track', 'Schedule', { value: value, currency: 'TWD', content_name: '一對一首次體驗' }, { eventID: eventId });
    _lt('send', 'cv', { type: 'Conversion' }, [CFG.lineTag]);
    return eventId;   // 傳給後端，CAPI 用同一個 event_id
  }

  window.NJTrack = { init: init, bookingComplete: bookingComplete, attr: function () { return attr; } };
})();


/* ==================================================================
 * （選用・建議）伺服器端 Meta Conversions API — 放在你們的 Hono Worker
 * 預約寫入資料庫成功後呼叫，iOS 擋追蹤或廣告阻擋器也收得到轉換。
 * 需要在 Events Manager → 設定 → Conversions API 產生 Access Token，
 * 存成 Worker secret：META_CAPI_TOKEN。Graph API 版本請用 Events Manager 顯示的最新版。
 * ==================================================================

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function sendMetaSchedule(env, { eventId, attr, phone, ip, ua, pageUrl, value = 1999 }) {
  const user_data = { client_ip_address: ip, client_user_agent: ua };
  if (attr.vid) user_data.external_id = [await sha256(attr.vid)];
  if (attr.fbc) user_data.fbc = attr.fbc;
  if (phone) user_data.ph = [await sha256(phone.replace(/\D/g, '').replace(/^0/, '886'))];
  const body = { data: [{
    event_name: 'Schedule', event_time: Math.floor(Date.now() / 1000), event_id: eventId,
    action_source: 'website', event_source_url: pageUrl, user_data,
    custom_data: { value, currency: 'TWD', content_name: '一對一首次體驗' }
  }] };
  await fetch(`https://graph.facebook.com/v21.0/800186701890749/events?access_token=${env.META_CAPI_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}
*/
