# 凝聚｜一對一服務介紹 Landing Page

靜態網站，部署在 Cloudflare Pages。

## 結構

```
site/                  ← Cloudflare Pages 的輸出資料夾（直接部署這個）
  index.html           ← 由 tools/build.py 產生，不要手改
  privacy.html
  assets/site.css      ← 全站樣式（RWD、固定按鈕列）
  assets/track.js      ← GA4、Meta Pixel、LINE Tag、來源歸因
  assets/app.js        ← 互動：案例輪播、FAQ、預約連結、事件追蹤
  assets/img, media    ← 圖片與案例影片
src/
  template.zh.html     ← 定稿設計（版面）
  content/zh.json      ← 所有會變動的內容：案例、FAQ、價格、門市、連結、追蹤 ID
tools/build.py         ← template + content → site/index.html
```

改內容：編輯 `src/content/zh.json` → `python3 tools/build.py` → commit。

## Cloudflare Pages 設定

- Framework preset：None
- Build command：（留空）
- Build output directory：`site`

## 追蹤事件（GA4 事件名稱 → Meta / LINE）

| 事件 | 觸發 | Meta | LINE Tag |
|---|---|---|---|
| booking_click（cta_location: hero / price / sticky） | 點預約按鈕 | Lead | BookingClick |
| line_click | 點 LINE 客服 | Contact | LineClick |
| store_map_click（store） | 點門市地圖 | FindLocation | — |
| section_view（section, section_index） | 每一屏第一次出現 40% | — | — |
| scroll_depth（percent: 25/50/75/90） | 捲動深度 | — | — |
| case_view（case_id） | 手動切換案例 | — | — |
| faq_open（question） | 展開常見問題 | — | — |
| animation_toggle | 泡泡牆暫停／播放 | — | — |
| nav_hub / xsell_group / xsell_cert | 返回集合頁、團班、認證 | — | — |

預約連結會自動帶上：`utm_*`、`fbclid`、`gclid`、`lp`（頁面）、`cta`（按鈕位置）、`vid`（訪客 ID），
LIFF 端可讀取這些參數，於預約完成時回傳 Conversions API。

除錯：在瀏覽器 console 輸入 `NJ_DEBUG=1`，之後的事件會印出來。
