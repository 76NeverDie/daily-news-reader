import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const REPO_NAME = process.env.REPO_NAME || 'daily-news-reader';
const PRIVATE = process.env.PRIVATE !== 'false';
const WORKFLOW = 'update-news.yml';

if (process.argv.includes('--help')) {
  console.log(`用法：node scripts/publish.mjs
环境变量（均可选）：
  GITHUB_TOKEN    GitHub Personal Access Token；不设置则运行时交互式输入
  REPO_NAME       仓库名，默认 daily-news-reader
  PRIVATE=false   创建公开仓库（默认私有）
  USE_GIT_PUSH=1  改用 git 客户端推送（默认走 GitHub API，可绕过代理/TLS 问题）
令牌只在本次进程内使用，不会写入 .git/config 或任何文件。`);
  process.exit(0);
}

function git(args, env = {}) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

async function api(pathname, token, { method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'daily-news-reader-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' ? (data.message || res.statusText) : String(data || res.statusText);
    const err = new Error(`GitHub API ${method} ${pathname} → ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function trackedFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

// 空仓库下 Git Data API 会返回 409，需先用 Contents API 建一个初始提交
async function ensureRepoReady(base, token) {
  try {
    await api(`${base}/git/ref/heads/main`, token);
    return;
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }
  const info = await api(base, token);
  if (info.size === 0) {
    const seed = readFileSync(path.join(ROOT, '.gitignore')).toString('base64');
    await api(`${base}/contents/.gitignore`, token, {
      method: 'PUT', body: { message: 'chore: 初始化仓库', content: seed },
    });
  }
  const after = await api(base, token);
  const created = after.default_branch || 'main';
  if (created !== 'main') {
    const ref = await api(`${base}/git/ref/heads/${encodeURIComponent(created)}`, token);
    await api(`${base}/git/refs`, token, { method: 'POST', body: { ref: 'refs/heads/main', sha: ref.object.sha } });
    try { await api(base, token, { method: 'PATCH', body: { default_branch: 'main' } }); } catch { /* 已存在 */ }
  }
}

// 通过 Git Data API 建立提交，不依赖本机 git 的代理 / Schannel / 凭据管理器
async function uploadViaApi(owner, repo, token) {
  const base = `/repos/${owner}/${repo}`;
  const files = trackedFiles();
  if (!files.length) throw new Error('没有已跟踪文件可上传');
  await ensureRepoReady(base, token);

  const tree = [];
  for (const rel of files) {
    const content = readFileSync(path.join(ROOT, rel)).toString('base64');
    const blob = await api(`${base}/git/blobs`, token, {
      method: 'POST', body: { content, encoding: 'base64' },
    });
    tree.push({ path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: blob.sha });
  }
  const treeObj = await api(`${base}/git/trees`, token, { method: 'POST', body: { tree } });

  let localTree = '';
  try { localTree = git(['rev-parse', 'HEAD^{tree}']); } catch { /* 无本地仓库时忽略 */ }
  const same = localTree && localTree === treeObj.sha;
  console.log(`   ${files.length} 个文件已上传，tree ${treeObj.sha.slice(0, 7)}${same ? '（与本地内容完全一致）' : ''}`);

  let parent = null;
  try {
    const ref = await api(`${base}/git/ref/heads/main`, token);
    parent = ref.object.sha;
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }
  const commit = await api(`${base}/git/commits`, token, {
    method: 'POST',
    body: {
      message: 'feat: 每日新闻聚合器（抓取脚本 / 页面 / 定时更新 / 一键发布）',
      tree: treeObj.sha,
      parents: parent ? [parent] : [],
    },
  });
  if (parent) {
    await api(`${base}/git/refs/heads/main`, token, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } else {
    await api(`${base}/git/refs`, token, { method: 'POST', body: { ref: 'refs/heads/main', sha: commit.sha } });
  }
  try { await api(base, token, { method: 'PATCH', body: { default_branch: 'main' } }); } catch { /* 稍后自动指向 main */ }
  return commit.sha;
}

async function main() {
  let token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('请粘贴 GitHub Personal Access Token（仅本次使用，不保存）: ')).trim();
    rl.close();
  }
  if (!token) throw new Error('未提供令牌');

  const me = await api('/user', token);
  const owner = me.login;
  console.log(`✓ 已认证为 ${owner}`);

  let repo;
  try {
    repo = await api(`/repos/${owner}/${REPO_NAME}`, token);
    console.log(`✓ 复用已有仓库 ${repo.full_name}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      repo = await api('/user/repos', token, {
        method: 'POST',
        body: {
          name: REPO_NAME,
          private: PRIVATE,
          description: '每日新闻聚合：学习强国同源内容 / 人民日报 / Bloomberg',
          has_issues: false, has_projects: false, has_wiki: false, auto_init: false,
        },
      });
      console.log(`✓ 已创建${PRIVATE ? '私有' : '公开'}仓库 ${repo.full_name}`);
    } catch (createErr) {
      throw new Error(`创建仓库失败：${createErr.message}。若使用细粒度令牌，请先在 GitHub 网页手动新建空仓库 ${REPO_NAME} 后重跑本脚本。`);
    }
  }

  try { git(['rev-parse', 'HEAD']); }
  catch { throw new Error('本地还没有提交，请先执行 git add 与 git commit'); }

  const remoteUrl = `https://github.com/${owner}/${REPO_NAME}.git`;
  try { git(['remote', 'remove', 'origin']); } catch { /* 尚无 origin */ }
  git(['remote', 'add', 'origin', remoteUrl]);

  if (process.env.USE_GIT_PUSH === '1') {
    // 显式禁用凭据管理器，并用 GitHub 官方推荐的 Basic 认证头
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const authEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_TERMINAL_PROMPT: '0',
    };
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    console.log('→ 通过 git 客户端推送…');
    git(['-c', 'credential.helper=', 'push', '-u', 'origin', `${branch}:main`], authEnv);
    console.log('✓ 代码已推送到 main');
  } else {
    console.log('→ 通过 GitHub API 创建提交…');
    const sha = await uploadViaApi(owner, REPO_NAME, token);
    console.log(`✓ 远端提交 ${sha.slice(0, 7)} 已写入 main`);
  }

  try {
    await api(`/repos/${owner}/${REPO_NAME}/actions/permissions`, token, {
      method: 'PUT',
      body: { enabled: true, default_workflow_permissions: 'write' },
    });
    console.log('✓ Actions 工作流权限已设为 Read and write');
  } catch (e) {
    console.log(`! 权限设置跳过（${e.message}）`);
    console.log('  请在仓库 Settings → Actions → General → Workflow permissions 手动选 Read and write');
  }

  let dispatched = false;
  for (let i = 0; i < 4 && !dispatched; i++) {
    try {
      await api(`/repos/${owner}/${REPO_NAME}/actions/workflows/${WORKFLOW}/dispatches`, token, {
        method: 'POST', body: { ref: 'main' },
      });
      dispatched = true;
    } catch {
      if (i < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(dispatched ? '✓ 已触发首次自动抓取' : '! 首次抓取未自动触发，请到 Actions 页手动 Run workflow');

  console.log(`\n仓库地址：https://github.com/${owner}/${REPO_NAME}`);
  console.log(`运行状态：https://github.com/${owner}/${REPO_NAME}/actions`);
  console.log('\n剩余步骤（Cloudflare Pages 必须在网页端完成）：');
  console.log('  1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git');
  console.log(`  2. 选择 ${owner}/${REPO_NAME}；Framework preset = None，Build command 留空，Build output directory 填 /`);
  console.log('  3. 拿到 https://<项目名>.pages.dev，手机和电脑打开同一网址即可');
  console.log('  4. 建议：Pages 项目 Settings → 创建 Deploy Hook，将 URL 存为仓库 Secret CLOUDFLARE_DEPLOY_HOOK_URL');
}

main().catch((e) => {
  const msg = String(e.message || e).replace(/(bearer|basic)\s+\S+/gi, '$1 ***');
  console.error(`\n✗ 发布失败：${msg}`);
  process.exitCode = 1;
});
