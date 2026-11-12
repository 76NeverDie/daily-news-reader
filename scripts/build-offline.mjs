#!/usr/bin/env node
/**
 * 把 index.html + data/news.json 合并成一个完全自包含的 HTML 文件。
 * 产物不发起任何网络请求，可直接双击打开、发到手机、传微信、放任意网盘。
 * 用法: node scripts/build-offline.mjs [输出路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const raw = fs.readFileSync(path.join(ROOT, 'data', 'news.json'), 'utf8');
const data = JSON.parse(raw);
const out = process.argv[2] || path.join(ROOT, 'news-offline.html');

// 内嵌 JSON 必须转义 < 与行分隔符，否则可能提前闭合 <script> 或破坏 JS 字面量
const payload = JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

const FETCH_BLOCK = `      var res = await fetch('./data/news.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();`;

if (!html.includes(FETCH_BLOCK)) {
  throw new Error('未找到数据加载代码块，index.html 结构可能已变更，请检查后再构建');
}
if (!/<script>/.test(html)) {
  throw new Error('未找到内联 <script> 标签');
}

let result = html
  // 移除外部资源引用，保证 file:// 协议下零网络请求
  .replace(/<link[^>]+rel=["']manifest["'][^>]*>\s*/gi, '')
  .replace(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>\s*/gi, '')
  // 注入内嵌数据
  .replace('<script>', `<script>\n  const EMBEDDED_NEWS = ${payload};`)
  // 把 fetch 换成读内嵌数据
  .replace(FETCH_BLOCK, '      var data = EMBEDDED_NEWS;')
  // 标注为离线快照
  .replace(/<title>([\s\S]*?)<\/title>/i, (m, t) => `<title>${t} · 离线快照</title>`);

// 断言：产物里不能再出现外部数据请求
if (/fetch\(['"]\.\/data\/news\.json/.test(result)) {
  throw new Error('构建失败：仍存在对 data/news.json 的外部请求');
}

fs.writeFileSync(out, result, 'utf8');
const hotCount = data.items.filter((x) => x.kind === 'hot').length;
console.log(`已生成 ${out}`);
console.log(`  ${data.items.length} 条条目（新闻 ${data.items.length - hotCount} / 热搜 ${hotCount}）| 快照时间 ${data.generatedAt} | ${(Buffer.byteLength(result) / 1024).toFixed(1)} KB`);
console.log('  零外部请求，可直接双击打开或发送到手机');
