import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'news.json');
const UA = 'Mozilla/5.0 (compatible; DailyNewsReader/1.0; personal use)';
const TIMEOUT = 9000;
const LIMIT_PER_SOURCE = 40;

const SOURCE_META = [
  { id: 'xuexi', name: '学习强国', note: '学习强国未提供公开数据接口，本栏展示人民网时政、理论、党建、评论等官方同源内容' },
  { id: 'people', name: '人民日报', note: '人民日报当日电子版版面 + 人民网当日要闻' },
  { id: 'bloomberg', name: 'Bloomberg', note: '仅收录公开 RSS 的标题与摘要，正文请跳转原文阅读' },
];

const XUEXI_HOSTS = new Set([
  'politics.people.com.cn', 'theory.people.com.cn',
  'dangjian.people.com.cn', 'opinion.people.com.cn',
]);

const CHANNEL_NAMES = {
  'politics.people.com.cn': '时政', 'theory.people.com.cn': '理论',
  'dangjian.people.com.cn': '党建', 'opinion.people.com.cn': '评论',
  'world.people.com.cn': '国际', 'society.people.com.cn': '社会',
  'finance.people.com.cn': '财经', 'military.people.com.cn': '军事',
  'pic.people.com.cn': '图片', 'legal.people.com.cn': '法治',
  'edu.people.com.cn': '教育', 'health.people.com.cn': '健康',
  'sports.people.com.cn': '体育', 'culture.people.com.cn': '文化',
};

const BLOOMBERG_CHANNELS = [
  ['markets', '市场'], ['technology', '科技'],
  ['economics', '经济'], ['politics', '政治'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// 全部按北京时间(UTC+8)计算日期，避免 CI 的 UTC 时区导致抓到前一天的版面
function bjDate(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = String(t.getUTCFullYear());
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return { y, m, d, iso: `${y}-${m}-${d}`, ym: `${y}${m}`, seg: `${y}/${m}${d}` };
}

async function fetchText(url, { timeout = TIMEOUT, retries = 1 } = {}) {
  let last = 'unknown';
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,text/xml,*/*',
        },
      });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        if ((res.status === 429 || res.status >= 500) && i < retries) { await sleep(900); continue; }
        return { ok: false, error: last };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      let text = buf.toString('utf8');
      if (/charset\s*=\s*gb(?:2312|k|18030)/i.test(ct)) {
        try { text = new TextDecoder('gbk').decode(buf); } catch { /* 保持 utf8 */ }
      }
      return { ok: true, text };
    } catch (e) {
      last = e.cause?.code || e.name || String(e.message).slice(0, 60);
      if (i < retries) await sleep(350);
    }
  }
  return { ok: false, error: last };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, e) => {
    if (e[0] === '#') {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : raw;
    }
    return ENTITIES[e.toLowerCase()] ?? raw;
  });
}

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const unwrapCdata = (s) => String(s ?? '').replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? unwrapCdata(m[1]) : '';
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  const m = String(s).match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

function parseRss(xml) {
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)
    || xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = stripTags(tag(b, 'title'));
    let link = stripTags(tag(b, 'link'));
    if (!link) {
      const m = b.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = m ? decodeEntities(m[1]) : '';
    }
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 220);
    const date = parseDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    out.push({ title, link, summary, date });
  }
  return out;
}

function parsePeopleHome(html, day) {
  const re = /<a[^>]+href=["']([^"']*\/20\d{2}\/\d{4}\/[^"']*\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const link = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    if (!title || title.length < 5 || !link.includes(`/${day.seg}/`) || seen.has(link)) continue;
    let host = '';
    try { host = new URL(link).hostname; } catch { continue; }
    seen.add(link);
    out.push({ title, link, host, date: day.iso });
  }
  return out;
}

function parsePaperPage(html, pageNo, day) {
  const re = /<a[^>]+href=["']([^"']*content_\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const base = `http://paper.people.com.cn/rmrb/pc/layout/${day.ym}/${day.d}/`;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const title = stripTags(m[2]);
    if (!title || title.length < 5 || /PDF下载|^第\d+版|^(导读|图片报道)$/.test(title)) continue;
    let link = '';
    try { link = new URL(decodeEntities(m[1]), base).href; } catch { continue; }
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ title, link, summary: '', date: day.iso, channel: `第${pageNo}版` });
  }
  return out;
}

function normUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname + x.pathname;
  } catch { return ''; }
}

async function main() {
  const day = bjDate();
  const collected = { xuexi: [], people: [], bloomberg: [] };
  const status = Object.fromEntries(SOURCE_META.map((m) => [
    m.id, { id: m.id, name: m.name, note: m.note, status: 'ok', count: 0, error: null },
  ]));

  // 1) 人民网首页：按当日日期路径过滤，按域名分流到两个中文栏目
  const home = await fetchText('https://www.people.com.cn/');
  if (home.ok) {
    for (const it of parsePeopleHome(home.text, day)) {
      const row = {
        title: it.title, url: it.link, summary: '', date: it.date,
        channel: CHANNEL_NAMES[it.host] || '要闻',
      };
      if (XUEXI_HOSTS.has(it.host)) collected.xuexi.push({ ...row, source: 'xuexi' });
      else collected.people.push({ ...row, source: 'people' });
    }
  } else {
    status.xuexi.error = `人民网首页 ${home.error}`;
    status.people.error = `人民网首页 ${home.error}`;
  }

  // 2) 人民日报当日电子版前 4 个版面
  let paperOk = 0;
  let paperErr = '';
  for (const n of ['01', '02', '03', '04']) {
    await sleep(200);
    const url = `http://paper.people.com.cn/rmrb/pc/layout/${day.ym}/${day.d}/node_${n}.html`;
    const r = await fetchText(url, { retries: 0 });
    if (!r.ok) { paperErr = r.error; continue; }
    const list = parsePaperPage(r.text, n, day);
    if (list.length) paperOk++;
    collected.people.push(...list.map((x) => ({ ...x, source: 'people' })));
  }
  if (!paperOk) status.people.error = `电子版 ${paperErr || '无当日版面'}`;

  // 3) Bloomberg：CI 上优先官方 feed；受限网络下依次降级到镜像与新闻聚合
  const probe = await fetchText('https://feeds.bloomberg.com/markets/news.rss', { timeout: 6000, retries: 0 });
  const official = probe.ok && /<item[\s>]/i.test(probe.text);
  let mirrorBlocked = false;
  for (const [key, label] of BLOOMBERG_CHANNELS) {
    let xml = '';
    if (official) {
      if (key === 'markets') xml = probe.text;
      else {
        await sleep(200);
        xml = (await fetchText(`https://feeds.bloomberg.com/${key}/news.rss`, { retries: 0 })).text || '';
      }
    } else {
      if (mirrorBlocked) break;
      await sleep(350);
      const r = await fetchText(`https://openrss.org/feed/www.bloomberg.com/${key}`, { retries: 0 });
      if (!r.ok) {
        status.bloomberg.error = `镜像 ${r.error}`;
        if (/429/.test(r.error)) mirrorBlocked = true;
        continue;
      }
      xml = r.text;
    }
    for (const x of parseRss(xml)) {
      collected.bloomberg.push({
        source: 'bloomberg', channel: label,
        title: x.title.replace(/\s+-\s+Bloomberg.*$/i, ''),
        url: x.link, summary: x.summary, date: x.date || day.iso,
      });
    }
  }
  if (!official) {
    const fallbackNote = '官方 feed 不可达，已使用备用镜像';
    status.bloomberg.error = status.bloomberg.error ? `${fallbackNote}；${status.bloomberg.error}` : fallbackNote;
    if (!collected.bloomberg.length) {
      const g = await fetchText(
        'https://news.google.com/rss/search?q=site%3Abloomberg.com+when%3A1d&hl=en-US&gl=US&ceid=US%3Aen',
        { timeout: 6000, retries: 0 },
      );
      if (g.ok) {
        for (const x of parseRss(g.text).slice(0, 20)) {
          collected.bloomberg.push({
            source: 'bloomberg', channel: '聚合', title: x.title,
            url: x.link, summary: x.summary, date: x.date || day.iso,
          });
        }
      }
    }
  }

  // 4) 跨源去重、限量；某源本次为空时沿用上次成功抓取的数据
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 首次运行 */ }
  const seen = new Set();
  let items = [];
  for (const m of SOURCE_META) {
    const uniq = [];
    for (const it of collected[m.id]) {
      const key = normUrl(it.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
      if (uniq.length >= LIMIT_PER_SOURCE) break;
    }
    if (!uniq.length && Array.isArray(prev?.items)) {
      const old = prev.items.filter((x) => x.source === m.id).slice(0, LIMIT_PER_SOURCE);
      items.push(...old);
      status[m.id].count = old.length;
      status[m.id].status = old.length ? 'stale' : 'error';
    } else {
      items.push(...uniq);
      status[m.id].count = uniq.length;
      status[m.id].status = status[m.id].error ? 'degraded' : 'ok';
    }
  }

  items = items
    .map((x, i) => ({ ...x, _i: i }))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a._i - b._i)
    .map(({ _i, ...x }) => ({ ...x, id: hash(normUrl(x.url)) }));

  const payload = {
    generatedAt: new Date().toISOString(),
    date: day.iso,
    sources: SOURCE_META.map((m) => status[m.id]),
    items,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`[新闻抓取] ${day.iso} 共 ${items.length} 条`);
  for (const m of SOURCE_META) {
    const s = status[m.id];
    console.log(`  ${m.name}: ${s.count} 条 [${s.status}]${s.error ? ` - ${s.error}` : ''}`);
  }
  if (!items.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[新闻抓取] 失败:', e);
  process.exitCode = 1;
});
