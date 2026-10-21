/**
 * 零依赖静态服务器：把构建好的 dist/ 发布到局域网，手机浏览器直接访问。
 *
 *   npm run build
 *   npm run serve          # 监听 0.0.0.0:4180，自动打印手机可访问的地址
 *   npm run serve -- 8080  # 指定端口
 *
 * 注意：局域网是 http://，浏览器不把 http 视为「安全上下文」，
 * 因此只能用浏览器打开、不能「添加到主屏幕」安装成 App。
 * 想要真正安装到手机桌面，请把 dist/ 部署到 GitHub Pages（HTTPS）后安装。
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const port = Number(process.argv[2] ?? process.env.PORT ?? 4180)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

async function safeFile(urlPath) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://localhost').pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  // 阻止 ../ 跳出 dist
  const target = resolve(root, `.${normalize(pathname)}`)
  if (!target.startsWith(root)) return null
  try {
    const info = await stat(target)
    if (info.isDirectory()) return safeFile(`${pathname.replace(/\/?$/, '/')}index.html`)
    return target
  } catch {
    return null
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost')
  const file = await safeFile(req.url ?? '/')
  if (!file) {
    // 单页应用：未知路径一律交给 index.html（hash 路由自己处理）
    const fallback = join(root, 'index.html')
    try {
      const html = await readFile(fallback)
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(html)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dist/ 还没有构建，请先运行 npm run build')
    }
    return
  }
  // ?seed=1 时注入一段脚本，往当前源的 IndexedDB 写一条演示草稿，
  // 方便在没有 Token 的情况下点开「本机草稿」看编辑与预览效果。
  if (requestUrl.searchParams.has('seed') && file.endsWith('index.html')) {
    const html = await readFile(file, 'utf8')
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    res.end(html.replace('</body>', `${SEED_SCRIPT}</body>`))
    return
  }
  // ?mock=1 时注入假 GitHub 后端 + 一个假 Token，用来在没有真实 Token 的情况下
  // 端到端跑通「读取列表 → 增量刷新 → 缓存」这条链路。
  if (requestUrl.searchParams.has('mock') && file.endsWith('index.html')) {
    const html = await readFile(file, 'utf8')
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
    res.end(html.replace('</body>', `${MOCK_SCRIPT}</body>`))
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
})

function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

/** 演示草稿：纯本地数据，不发往任何地方，用来在没有 Token 时体验编辑器 */
const MOCK_SCRIPT = `
<script>
(function () {
  var OWNER = 'gtplusblog';
  var REPO = 'gtplusblog.github.io';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function commit(sha, treeSha, parent, message) {
    return { sha: sha, commit: { message: message, tree: { sha: treeSha } }, parents: parent ? [{ sha: parent }] : [] };
  }
  function post(title, date, slug, cat, tags) {
    return '---\\ntitle: ' + title + '\\ndate: ' + date + '\\nslug: ' + slug +
      '\\ncategories:\\n  - ' + cat + '\\ntags:\\n' + tags.map(function (t) { return '  - ' + t; }).join('\\n') +
      '\\n---\\n\\n这是 ' + title + ' 的正文。\\n';
  }

  var C1 = 'a'.repeat(40), C2 = 'b'.repeat(40), C3 = 'c'.repeat(40);
  var T1 = '1'.repeat(40), T2 = '2'.repeat(40), T3 = '3'.repeat(40);
  var B = { a: '4'.repeat(40), b: '5'.repeat(40), c: '6'.repeat(40) };

  // 三次提交：T3 是当前，T1 是「缓存建立时」
  var commits = { master: commit(C3, T3, C2, 'newest'), prev1: commit(C2, T2, C1, 'middle'), prev2: commit(C1, T1, null, 'oldest') };
  var bySha = {}; bySha[C3] = commits.master; bySha[C2] = commits.prev1; bySha[C1] = commits.prev2;

  var filesNow = [
    { path: 'content/posts/diary20260101.md', blob: B.a, text: post('日记一', '2026-01-01T08:00:00+08:00', 'aaaaaaa', '日记', ['测试']) },
    { path: 'content/posts/poem20260202.md', blob: B.b, text: post('诗一', '2026-02-02T08:00:00+08:00', 'bbbbbbb', '诗歌', ['测试']) }
  ];
  // T1 时只有一篇，另一篇是后来新增的
  var filesOld = [filesNow[0]];

  var mode = 'current';          // current | stale
  var stats = { commits: 0, trees: 0, compares: 0, raw: 0, content: 0, repos: 0, writes: 0 };

  function tree(files) {
    return { sha: T3, truncated: false, tree: files.map(function (f) {
      return { path: f.path, type: 'blob', sha: f.blob, mode: '100644' };
    }) };
  }
  function json(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var method = (init && init.method) || 'GET';
    if (url.indexOf('api.github.com') === -1 && url.indexOf('raw.githubusercontent.com') === -1) {
      return realFetch(input, init);
    }
    if (method === 'PUT') {
      stats.writes++;
      return Promise.resolve(json({ content: { sha: '9'.repeat(40), html_url: 'https://github.com/mock' } }));
    }
    if (url === API) { stats.repos++; return Promise.resolve(json({ default_branch: 'master', private: false, full_name: OWNER + '/' + REPO })); }
    var mCommit = url.match(/\\/commits\\/([^?/]+)/);
    if (mCommit) {
      stats.commits++;
      var ref = mCommit[1];
      var body = bySha[ref] || commits[ref];
      return Promise.resolve(body ? json(body) : json({ message: 'Not Found' }, 404));
    }
    if (url.indexOf('/compare/') !== -1) {
      stats.compares++;
      var range = url.split('/compare/')[1].split('?')[0];
      var parts = range.split('...');
      var files = [];
      if (parts[0] === C1) {
        // 从「缓存建立时」到当前：新增一篇 + 改了一篇
        files = [
          { filename: filesNow[1].path, status: 'added', sha: filesNow[1].blob },
          { filename: filesNow[0].path, status: 'modified', sha: filesNow[0].blob }
        ];
      }
      return Promise.resolve(json({ files: files }));
    }
    if (url.indexOf('/git/trees/') !== -1) {
      stats.trees++;
      var which = url.indexOf(T1) !== -1 ? filesOld : filesNow;
      return Promise.resolve(json(tree(which)));
    }
    if (url.indexOf('raw.githubusercontent.com') !== -1) {
      stats.raw++;
      var hit = filesNow.filter(function (f) { return url.indexOf(f.path) !== -1; })[0];
      return Promise.resolve(hit ? new Response(hit.text, { status: 200 }) : new Response('no', { status: 404 }));
    }
    if (url.indexOf('/contents/') !== -1) {
      stats.content++;
      var p = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      var f2 = filesNow.filter(function (x) { return x.path === p; })[0];
      return Promise.resolve(f2 ? json({ content: b64(f2.text), encoding: 'base64', sha: f2.blob }) : json({ message: 'Not Found' }, 404));
    }
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };

  window.__mockGithub = {
    stats: function () { return JSON.parse(JSON.stringify(stats)); },
    reset: function () { Object.keys(stats).forEach(function (k) { stats[k] = 0; }); },
    setMode: function (m) { mode = m; },
    // 往缓存里塞一条「旧记录」：tree 指向 T1、只含第一篇文章。
    // 之后刷新就会走「tree 变了 → compare → 只解析改动文件」的增量路径。
    seedStaleCache: function () {
      var entry = {};
      entry[filesOld[0].path] = {
        blobSha: filesOld[0].blob, title: '日记一', date: '2026-01-01T08:00:00+08:00',
        categories: ['日记'], tags: ['测试'], parsedAt: Date.now()
      };
      var cache = {
        version: 1, repoKey: OWNER + '/' + REPO + '#content/posts',
        treeSha: T1, branch: 'master', entries: entry, savedAt: Date.now()
      };
      return new Promise(function (resolve) {
        var req = indexedDB.open('keyval-store');
        req.onsuccess = function () {
          var tx = req.result.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(cache, 'gutun-blog-app:post-cache:v1');
          tx.oncomplete = function () { resolve('seeded'); };
        };
      });
    }
  };

  // 写入设置：一个假 Token，让 App 认为已配置
  var SETTINGS = {
    token: 'mock-token-not-real',
    owner: OWNER, repo: REPO,
    postsDir: 'content/posts', imagesDir: 'static/images',
    filePrefix: 'diary', siteUrl: 'https://gtplusblog.github.io/', theme: 'auto'
  };
  // 联调时不注册 Service Worker：它的缓存会干扰「每次打开走哪条链路」的观察
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations().then(function (rs) {
      rs.forEach(function (r) { r.unregister(); });
    });
  }
  var req = indexedDB.open('keyval-store');
  req.onupgradeneeded = function () { req.result.createObjectStore('keyval'); };
  req.onsuccess = function () {
    var tx = req.result.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put(SETTINGS, 'gutun-blog-app:settings:v1');
    tx.oncomplete = function () {
      var el = document.createElement('div');
      el.id = 'mock-banner';
      el.textContent = 'MOCK 模式：假的 GitHub 后端';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#c0392b;color:#fff;padding:4px;font:12px sans-serif;text-align:center';
      document.body.appendChild(el);
      if (!sessionStorage.getItem('mock-reloaded')) {
        sessionStorage.setItem('mock-reloaded', '1');
        location.reload();
      }
    };
  };
})();
</script>
`

/** 演示草稿：纯本地数据，不发往任何地方，用来在没有 Token 时体验编辑器 */
const SEED_SCRIPT = `
<script>
(function () {
  var body = [
    '## 二级标题',
    '',
    '这是 **粗体**、*斜体* 和 \`行内代码\`，以及一个[外链](https://gohugo.io)。',
    '',
    '行内公式 $a_1 = b_2$，块级公式：',
    '',
    '$$',
    '\\\\int_0^1 x^2 \\\\, dx = \\\\frac{1}{3}',
    '$$',
    '',
    '> 引用一行，用来确认样式。',
    '',
    '- 列表一',
    '- [ ] 待办事项',
    '- [x] 已完成事项',
    '',
    '| 列 1 | 列 2 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '\`\`\`js',
    'const answer = 42',
    '\`\`\`',
    ''
  ].join('\\n');
  var draft = {
    id: 'd-demo-seed',
    title: '演示草稿：排版与公式',
    path: 'content/posts/demo.md',
    sha: null,
    frontMatter: {
      title: '演示草稿：排版与公式', subtitle: '', date: new Date().toISOString(),
      slug: 'demo001', draft: false,
      author: { name: 'GUTUN', link: '', email: '', avatar: '' },
      description: '', keywords: [], license: '', comment: false, weight: 0,
      tags: ['演示'], categories: ['演示'], hiddenFromHomePage: false,
      hiddenFromSearch: false, hiddenFromRelated: false, hiddenFromFeed: false,
      summary: '', toc: true, math: true, lightgallery: false, password: '',
      message: '', repost: { enable: true, url: '' }, extra: {}
    },
    body: body,
    createdAt: Date.now(), updatedAt: Date.now(), existing: false
  };
  var req = indexedDB.open('keyval-store');
  req.onupgradeneeded = function () { req.result.createObjectStore('keyval'); };
  req.onsuccess = function () {
    var db = req.result;
    var tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put(draft, 'gutun-draft:d-demo-seed');
    tx.oncomplete = function () {
      var el = document.createElement('div');
      el.textContent = '演示草稿已写入本机，正在打开…';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#5bbad5;color:#fff;padding:6px;font:12px sans-serif;text-align:center';
      document.body.appendChild(el);
      location.hash = '#/edit/draft:d-demo-seed';
    };
  };
})();
</script>
`

server.listen(port, '0.0.0.0', () => {
  console.log(`\n  本机：      http://localhost:${port}/`)
  for (const ip of lanAddresses()) {
    console.log(`  同一 WiFi： http://${ip}:${port}/   ← 手机浏览器打开这个`)
  }
  console.log('\n  提示：局域网是 http，浏览器不会把它当作安全上下文，')
  console.log('        所以「添加到主屏幕」装不了；要装成 App 请部署到 GitHub Pages。\n')
})
