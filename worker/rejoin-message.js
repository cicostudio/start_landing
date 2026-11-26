// 回流活動的 LINE 訊息（Flex Message）。改文案改這裡（後台網頁發送與本機腳本共用）。
// 預覽：node tools/rejoin/send.mjs preview > flex.json，貼到 https://developers.line.biz/flex-simulator/
export const CAMPAIGN = 'rejoin_261125';
// 網址前綴：Worker 傳入 url.origin；本機腳本用環境變數 SITE
const DEFAULT_SITE = 'https://cico.tw';

export function landingUrl(token, site = DEFAULT_SITE) {
  const u = new URL('/rejoin/', site);
  u.searchParams.set('t', token);
  u.searchParams.set('utm_source', 'line');
  u.searchParams.set('utm_medium', 'push');
  u.searchParams.set('utm_campaign', CAMPAIGN);
  return u.toString();
}

const INK = '#2C2B28', PAPER = '#F5F4F1', BRONZE = '#9C7A4B', MUTE = '#6E6A62';

export function buildMessage(token, site = DEFAULT_SITE) {
  const SITE = site;
  const uri = landingUrl(token, site);
  return {
    type: 'flex',
    altText: '好久不見。首次體驗價 $1,999，再回來一次（限額 50 位）',
    contents: {
      type: 'bubble',
      size: 'mega',
      hero: {
        type: 'image', url: `${SITE}/one/assets/img/flow-2.jpg`,
        size: 'full', aspectRatio: '20:13', aspectMode: 'cover',
        action: { type: 'uri', label: '看活動', uri },
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', backgroundColor: PAPER,
        contents: [
          { type: 'text', text: 'WELCOME BACK', size: 'xs', color: BRONZE, weight: 'bold' },
          { type: 'text', text: '好久不見。', size: 'xl', weight: 'bold', color: INK, wrap: true },
          { type: 'text', wrap: true, size: 'sm', color: MUTE, lineSpacing: '6px',
            text: '凝聚的預約系統換新了。\n想邀請你，\n用首次體驗價再回來一次。' },
          {
            type: 'box', layout: 'vertical', backgroundColor: INK, cornerRadius: '16px', paddingAll: '16px', margin: 'lg',
            contents: [
              { type: 'text', text: '首次體驗・120 分鐘', size: 'xs', color: '#E3D3BC' },
              { type: 'text', text: 'NT$1,999', size: '3xl', weight: 'bold', color: '#E3C99F' },
              { type: 'text', text: '限額 50 位\n至 12/9（三）23:59', size: 'xs', color: '#E3D3BC', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: PAPER,
        contents: [
          { type: 'button', style: 'primary', color: INK, height: 'md',
            action: { type: 'uri', label: '預約回訪', uri } },
        ],
      },
    },
  };
}
