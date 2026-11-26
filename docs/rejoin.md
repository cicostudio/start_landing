# 回流客喚醒活動：操作手冊（rejoin_261125）

**活動**：歡慶新系統上線，老朋友再次享有首次體驗價 $1,999（120 分鐘），限額 50 位
**頁面**：https://cico.tw/rejoin/（noindex）
**預約連結**：https://s.cicostudio.com/a/261125-2023rj
**截止**：2026/12/9（三）23:59，可在 `worker/rejoin.js` 的 `REJOIN` 修改，或在 Cloudflare 設定變數 `REJOIN_DEADLINE`

```
LINE 推播（每人一個 token）
  └→ cico.tw/rejoin/?t=TOKEN         記「開啟」，顯示倒數與剩餘名額
       └→ /api/rejoin/go?t=TOKEN     記「點擊」
            └→ s.cicostudio.com/a/261125-2023rj?rj=TOKEN&utm_…   預約系統：貼標「回流客」
                 └→ 預約完成時 POST cico.tw/api/rejoin/booked     名額 −1，並對回 LINE UID
```

剩餘名額 = 50 − 已確認預約 − 手動扣除。數字一律來自真實預約，取消會自動釋出。

---

## 一、上線前設定（一次）

1. **Cloudflare → Workers → start-landing → 設定 → 變數和祕密**，新增兩個祕密（各自一長串隨機字，不要相同）：
   - `REJOIN_ADMIN_KEY`：發送腳本用
   - `REJOIN_HOOK_KEY`：預約系統回呼用
2. 部署這次的修改（push 到 GitHub，或執行 `npx wrangler deploy`）。資料表會自動建立在現有的 Durable Object 裡，不用另外開資料庫。
3. 打開 https://cico.tw/rejoin/，確認倒數和「剩餘 50 位」都有出現。
4. **預約系統要做的三件事**（見第四節）。

## 二、發送（在自己電腦上）

```bash
cd start_landing/tools/rejoin
export LINE_TOKEN='官方帳號 Messaging API 的 Channel access token'
export REJOIN_ADMIN_KEY='同 Cloudflare 的那一組'

node send.mjs check uids.txt           # 1. 格式、重複、抽 10 人確認是好友、看額度
node send.mjs preview > flex.json      # 2. 貼到 Flex Message Simulator 看樣子
node send.mjs test U你自己的UID         # 3. 發給自己，點連結、預約一次（再到系統取消），確認整條流程
node send.mjs send uids.txt --limit 100  # 4. 先試發 100 人，隔幾小時看封鎖數和點擊
node send.mjs send uids.txt            # 5. 發其餘的人（已發過的會自動跳過）
node send.mjs report                   # 隨時看漏斗
```

- `uids.txt`：一行一個 UID（逗號、空白分隔也可以）。
- 進度存在 `rejoin-state.json`，**內含 UID，不要上傳、不要 commit**（已加進 .gitignore）。中斷後重跑同一行指令會接續，不會重複發；每則都帶 `X-Line-Retry-Key`，網路重試也不會重複。
- 推播會扣官方帳號的訊息額度，跟群發一樣。額度不足時腳本會停下來。
- 推播有帶 `customAggregationUnits: rejoin_261125`，LINE 官方的開封統計之後也能用這個單位查詢。

## 三、看成效

- `node send.mjs report`，或先登入 https://cico.tw/admin/ 後再開 https://cico.tw/api/rejoin/report
- 逐人明細 CSV（Excel 可直接開）：https://cico.tw/api/rejoin/report?format=csv
- 漏斗：名單數 → 發送成功 → 開啟頁面 → 點預約 → 確認預約（`matched` = 能對回推播名單的回流客）
- `unmatched`：預約系統有回報，但沒有對到 token 的預約（例如有人轉傳連結，或 rj 參數在流程中遺失）
- 活動頁也會照常進到原本的後台（page_id `rejoin-zh`，歸在一對一產品線），GA4、Meta Pixel、LINE Tag 都有埋。
- 電話或現場預約要占名額時：
  ```bash
  curl -X POST https://cico.tw/api/rejoin/adjust -H "Authorization: Bearer $REJOIN_ADMIN_KEY" -H 'Content-Type: application/json' -d '{"offset":2}'
  ```
  （offset 是「目前總共要手動扣幾位」，不是累加）

## 四、預約系統（s.cicostudio.com）要做的事

1. **保留 `rj` 參數**：從活動連結進來時，把網址上的 `rj`（以及 utm_*、`vid`）存進這筆預約。
2. **貼標**：活動代碼 `261125-2023rj` 的預約貼「回流客」標籤。有 `rj` 的預約，可以直接確定是推播名單裡的過往學員。
3. **回呼**：預約確認或取消時，呼叫：

```http
POST https://cico.tw/api/rejoin/booked
Authorization: Bearer <REJOIN_HOOK_KEY>
Content-Type: application/json

{ "booking_id": "預約編號", "rj": "網址上的 rj（沒有就省略）", "status": "confirmed" }
```

- `status`：`confirmed`（占名額）或 `cancelled`（釋出名額）。同一個 `booking_id` 重送不會重複計算，改期不用呼叫。
- 回應裡有 `remaining`。預約系統可以在 `remaining` 為 0 時把活動價關掉，避免超賣（活動頁額滿時也會擋住按鈕）。
- 測試：
  ```bash
  curl -X POST https://cico.tw/api/rejoin/booked -H "Authorization: Bearer $REJOIN_HOOK_KEY" \
    -H 'Content-Type: application/json' -d '{"booking_id":"TEST-1","rj":"你的測試token"}'
  # 測完記得送 status: cancelled 把名額還回去
  ```

## 五、檔案

| 檔案 | 用途 |
|---|---|
| `site/rejoin/index.html` | 活動頁（倒數、剩餘名額、固定按鈕列、事件追蹤） |
| `worker/rejoin.js` | 活動設定、API、資料表 |
| `worker/index.js` | 掛上 `/api/rejoin/*`、頁面登記為 `rejoin-zh` |
| `tools/rejoin/send.mjs` | 發送腳本 |
| `tools/rejoin/message.mjs` | LINE Flex 訊息文案 |
