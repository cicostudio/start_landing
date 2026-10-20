#!/usr/bin/env python3
"""Build the static landing page: src/template.<lang>.html + src/content/<lang>.json -> site/.

Usage:  python3 tools/build.py            (builds zh)
The template holds the approved design; every piece that changes over time
(cases, FAQ, stores, prices, links, tracking IDs) lives in the content JSON,
so edits never touch layout code. A future admin can write the same JSON (or D1)
and reuse these renderers.
"""
import hashlib
import html
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
esc = html.escape


def load(lang):
    tpl = open(os.path.join(ROOT, 'src', f'template.{lang}.html'), encoding='utf-8').read()
    c = json.load(open(os.path.join(ROOT, 'src', 'content', f'{lang}.json'), encoding='utf-8'))
    return tpl, c


# ---------- renderers -------------------------------------------------------

def r_cases(c):
    out = []
    for i, k in enumerate([x for x in c['cases'] if x.get('visible', True)]):
        vid = lambda side: (
            f'<video data-src="assets/media/{k["id"]}-{side}.mp4" data-anim="assets/media/{k["id"]}-{side}.webp" poster="assets/media/{k["id"]}-{side}.jpg" '
            f'muted loop playsinline preload="none" aria-hidden="true" '
            f'style="width: 100%; height: 100%; object-fit: cover; display: block"></video>')
        tag = lambda bg, lab, when, left: (
            f'<span style="position: absolute; left: {left}; top: 12px; display: flex; align-items: center; gap: 6px; '
            f'padding: 3px 10px; border-radius: 999px; background: {bg}; font-size: 12px; font-weight: 700">{lab}'
            f'<span style="font-weight: 400; opacity: .85">{esc(when)}</span></span>')
        title = (f'<span style="color: #F2A48F">{esc(k["spot"])}</span>{esc(k["feel"])}，<br>'
                 f'問題出在<span style="color: #E2C38F">{esc(k["source"])}</span>。')
        label = f'案例 {i + 1}：{k["spot"]}{k["feel"]}，問題出在{k["source"]}。{k["caption"]}'
        out.append(f'''        <div class="case" role="group" aria-roledescription="slide" aria-label="{esc(label)}" data-case="{esc(k["id"])}" style="position: relative; flex: 0 0 100%; aspect-ratio: 4 / 5; color: #F5F4F1; background: #2C2B28">
          <div style="position: absolute; inset: 0; display: flex; gap: 2px"><div style="flex: 1; overflow: hidden">{vid('before')}</div><div style="flex: 1; overflow: hidden">{vid('after')}</div></div>
          {tag('rgba(28,27,25,0.6)', '前', k['before_label'], '10px')}
          {tag('rgba(47,107,85,0.92)', '後', k['after_label'], 'calc(50% + 9px)')}
          <div aria-hidden="true" style="position: absolute; left: 0; right: 0; bottom: 0; height: 50%; background: linear-gradient(180deg, rgba(28,27,25,0) 0%, rgba(28,27,25,0.9) 72%)"></div>
          <div style="position: absolute; left: 20px; right: 20px; bottom: 20px">
            <div style="font-size: 30px; font-weight: 900; line-height: 1.2">{title}</div>
            <div style="font-size: 14px; color: #E4E0D7; margin-top: 10px; line-height: 1.5">{esc(k["caption"])}</div>
          </div>
        </div>''')
    return '\n'.join(out) + '\n      '


def r_case_dots(c):
    n = len([x for x in c['cases'] if x.get('visible', True)])
    return ''.join(
        f'<button type="button" class="case-dot" data-go="{i}" aria-label="看第 {i + 1} 個案例" '
        f'style="flex: 1; height: 36px; padding: 0; border: 0; background: transparent; display: flex; align-items: center">'
        f'<span style="display: block; width: 100%; height: 3px; border-radius: 2px; background: #DCD7CD; overflow: hidden">'
        f'<span class="bar" style="display: block; height: 100%; width: 0; background: #2C2B28"></span></span></button>'
        for i in range(n))


def r_faq(c):
    items = []
    for i, f in enumerate(c['faq']):
        ans = '<br><br>'.join('<br>'.join(esc(l) for l in p.split('\n')) for p in f['a'].split('\n\n'))
        items.append(f'''      <div style="border-top: 1px solid #E4E0D7">
        <button type="button" class="faq-q" id="faq-q{i}" aria-expanded="false" aria-controls="faq-a{i}" style="display: flex; width: 100%; align-items: center; gap: 12px; min-height: 60px; padding: 14px 0; border: 0; background: transparent; text-align: left; color: #2C2B28"><span style="flex: 1; font-size: 17px; font-weight: 700; line-height: 1.45">{esc(f["q"])}</span><span class="faq-sign" aria-hidden="true" style="font-size: 22px; color: #7E6139">+</span></button>
        <div class="faq-a" id="faq-a{i}" role="region" aria-labelledby="faq-q{i}" hidden style="padding: 0 0 20px; font-size: 15px; line-height: 1.75; color: #45433E">{ans}</div>
      </div>''')
    return '<div style="margin-top: 20px; border-bottom: 1px solid #E4E0D7">\n' + '\n'.join(items) + '\n    </div>'


CH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7E6139" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>'


def r_stores(c):
    rows = []
    for i, s in enumerate(c['stores']):
        pills = ''.join(f'<span style="padding: 2px 8px; border-radius: 999px; background: {bg}; color: {fg}; font-size: 11px; font-weight: 700">{esc(n)}</span>' for n, bg, fg in s['lines'])
        border = '0' if i == 0 else '1px solid #E4E0D7'
        rows.append(f'<a href="{esc(s["map_url"])}" target="_blank" rel="noopener" data-track="store_map" data-store="{esc(s["name"])}" style="display: flex; align-items: center; gap: 12px; padding: 18px 16px; border-top: {border}"><span style="flex: 1"><span style="display: block; font-size: 19px; font-weight: 900">{esc(s["name"])}</span><span style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: 13px; color: #5E5B55">{pills}{esc(s["station"])}・<b style="color: #2F6B55">{esc(s["walk"])}</b></span><span style="display: block; font-size: 12px; color: #7E6139; margin-top: 4px">在 Google 地圖開啟</span></span>{CH}</a>')
    return '<div style="margin-top: 24px; border-radius: 24px; background: #FBFAF8; border: 1px solid #E4E0D7; overflow: hidden">\n      ' + '\n      '.join(rows) + '\n    </div>'


def r_trainers(c):
    if not c.get('trainers'):
        return ''
    cards = ''.join(f'<div style="flex: 0 0 200px"><img src="assets/img/{esc(t["photo"])}" alt="{esc(t["name"])}" loading="lazy" style="display: block; width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 22px"><div style="font-size: 17px; font-weight: 900; margin-top: 12px">{esc(t["name"])}</div><div style="font-size: 13px; color: #5E5B55">{esc(t["title"])}</div></div>' for t in c['trainers'])
    return f'''<section data-section="trainers" style="padding: 80px 0 0">
    <div style="padding: 0 16px"><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: #7E6139">你的訓練師</div><h2 style="margin: 8px 0 0; font-size: 30px; font-weight: 900; line-height: 1.15; letter-spacing: -0.02em">結構的專業，<br>說到你聽得懂。</h2></div>
    <div style="display: flex; gap: 12px; padding: 28px 16px 0; overflow-x: auto">{cards}</div>
  </section>
  '''


def r_testimonial(c):
    t = c.get('testimonial')
    if not t:
        return ''
    return f'''<section data-section="testimonial" style="padding: 80px 16px 0">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: #7E6139">他們怎麼說</div>
    <div aria-hidden="true" style="font-size: 72px; font-weight: 900; line-height: 0.6; height: 36px; margin-top: 20px; color: #9C7A4B">“</div>
    <blockquote style="margin: 8px 0 0; font-size: 28px; font-weight: 900; line-height: 1.3">{esc(t["quote"])}</blockquote>
    <div style="margin-top: 24px; font-size: 15px; font-weight: 700">{esc(t["name"])}<span style="display: block; font-size: 13px; font-weight: 400; color: #5E5B55">{esc(t["role"])}</span></div>
  </section>
  '''


def r_head(c):
    m, t = c['meta'], c['tracking']
    url = m['site_url'].rstrip('/') + m['path']
    og = m['site_url'].rstrip('/') + '/' + m['og_image']
    robots = '' if m.get('indexable') else '<meta name="robots" content="noindex">\n'
    ld = {
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'Organization', '@id': '#org', 'name': '凝聚運動顧問', 'alternateName': 'Cohesion Sports Consulting', 'foundingDate': '2018', 'url': url},
            {'@type': 'Service', 'name': '一對一結構調整 × 功能整合', 'provider': {'@id': '#org'},
             'offers': {'@type': 'Offer', 'name': '首次體驗 120 分鐘', 'price': c['price']['first'].replace(',', ''), 'priceCurrency': 'TWD'}},
        ] + [
            {'@type': 'SportsActivityLocation', 'name': f'凝聚運動顧問 {s["name"]}', 'parentOrganization': {'@id': '#org'},
             'hasMap': s['map_url'], 'address': {'@type': 'PostalAddress', 'addressLocality': s['city'], 'addressCountry': 'TW'}}
            for s in c['stores']
        ] + [
            {'@type': 'FAQPage', 'mainEntity': [{'@type': 'Question', 'name': f['q'], 'acceptedAnswer': {'@type': 'Answer', 'text': f['a'].replace('\n', '')}} for f in c['faq']]}
        ]}
    cfg = {'ga4': t['ga4'], 'pixel': t['meta_pixel'], 'lineTag': t['line_tag'], 'page': m['page_id'], 'booking': c['links']['booking_url']}
    return f'''<!doctype html>
<html lang="{m['lang']}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(m['title'])}</title>
<meta name="description" content="{esc(m['description'])}">
{robots}<link rel="canonical" href="{esc(url)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="zh_TW">
<meta property="og:title" content="{esc(m['title'])}">
<meta property="og:description" content="{esc(m['description'])}">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="{esc(og)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#2C2B28">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;700;900&family=Noto+Sans+TC:wght@400;700;900&display=swap" rel="stylesheet">
<link rel="preload" as="image" href="assets/img/{c['images']['hero_images'][0]}" fetchpriority="high">
<link rel="stylesheet" href="assets/site.css">
<script>window.SITE={json.dumps(cfg)};</script>
<script async src="https://www.googletagmanager.com/gtag/js?id={t['ga4']}"></script>
<script src="assets/track.js"></script>
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'''


def r_hero_slides(c):
    imgs = c['images']['hero_images']
    return ''.join(
        f'<img class="hero-slide{" on" if i == 0 else ""}" src="assets/img/{esc(f)}" alt=""'
        + (' fetchpriority="high"' if i == 0 else ' loading="lazy"') + '>'
        for i, f in enumerate(imgs))


def r_foot(c):
    return '<script src="assets/app.js" defer></script>\n</body>\n</html>\n'


def version_assets(text):
    """Append ?v=<content hash> to every local asset URL so browsers never keep a stale copy."""
    def sub(m):
        path = m.group(2)
        f = os.path.join(ROOT, 'site', path)
        if not os.path.isfile(f):
            return m.group(0)
        h = hashlib.sha1(open(f, 'rb').read()).hexdigest()[:8]
        return f'{m.group(1)}{path}?v={h}'
    return re.sub(r'((?:src|href|poster|data-src|data-anim)="|og:image" content="[^"]*?/)(assets/[^"?#]+)', sub, text)


def build(lang='zh'):
    tpl, c = load(lang)
    vals = {
        'head': r_head(c), 'foot': r_foot(c),
        'cases': r_cases(c), 'case_dots': r_case_dots(c), 'faq': r_faq(c), 'stores': r_stores(c),
        'trainers': r_trainers(c), 'hero_slides': r_hero_slides(c), 'testimonial': r_testimonial(c),
        'price_regular': esc(c['price']['regular']), 'reschedule': esc(c['price']['reschedule']),
        **{k: esc(v) for k, v in c['links'].items()},
        **{k: esc(v) for k, v in c['images'].items() if isinstance(v, str)},
    }
    out = re.sub(r'<!--@(\w+)-->', lambda m: vals[m.group(1)], tpl)
    out = version_assets(out)
    left = re.findall(r'<!--@\w+-->', out)
    assert not left, left
    os.makedirs(os.path.join(ROOT, 'site'), exist_ok=True)
    name = 'index.html' if lang == 'zh' else f'{lang}/index.html'
    open(os.path.join(ROOT, 'site', name), 'w', encoding='utf-8').write(out)
    print('built site/' + name, len(out), 'bytes')


if __name__ == '__main__':
    build('zh')
