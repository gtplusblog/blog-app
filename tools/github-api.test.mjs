/**
 * github.ts 的响应解析回归测试（mock fetch，不联网）。
 *
 * 为什么需要这层测试：
 * 联网测试只能验证「GitHub 返回的形状对不对」，验证不到「我们的代码怎么读这个响应」。
 * 曾经因为把 tree 的层级写成 `head.commit.commit.tree.sha`
 * （实际是 `head.commit.tree.sha`），手机上打开就直接报
 * Cannot read properties of undefined (reading 'tree')。
 * 这里的 mock 数据照着 GitHub 真实响应的形状写，读错层级必然失败。
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchTreeSnapshot,
  invalidateCache,
  readFileContents,
  scanFully,
  scanIncrementally,
  toTreeSnapshot,
} from '../.test-build/lib/github.js'

// github.ts 里有模块级缓存（默认分支、是否私有、path->sha）。
// 用例之间必须清掉，否则前一个用例探测到的「公开仓库」会串到后一个用例，
// 让「私有仓库不走 raw」这类断言失效。
beforeEach(() => {
  invalidateCache()
})

const SETTINGS = {
  token: 'test-token',
  owner: 'gtplusblog',
  repo: 'gtplusblog.github.io',
  postsDir: 'content/posts',
  imagesDir: 'static/images',
  filePrefix: 'diary',
  siteUrl: 'https://gtplusblog.github.io/',
  theme: 'auto',
}

const SHA = {
  commitHead: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  commitPrev: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
  treeHead: 'cccc3333cccc3333cccc3333cccc3333cccc3333',
  treePrev: 'dddd4444dddd4444dddd4444dddd4444dddd4444',
  blobA: 'eeee5555eeee5555eeee5555eeee5555eeee5555',
  blobB: 'ffff6666ffff6666ffff6666ffff6666ffff6666',
}

/** 照抄 GitHub 的真实响应形状：commit 对象里直接放 tree，没有第二个 commit */
const COMMIT_HEAD = {
  sha: SHA.commitHead,
  commit: { message: 'add post', tree: { sha: SHA.treeHead } },
  parents: [{ sha: SHA.commitPrev }],
}

const COMMIT_PREV = {
  sha: SHA.commitPrev,
  commit: { message: 'older', tree: { sha: SHA.treePrev } },
  parents: [],
}

const REPO_INFO = {
  default_branch: 'master',
  private: false,
  full_name: 'gtplusblog/gtplusblog.github.io',
}

const API = 'https://api.github.com/repos/gtplusblog/gtplusblog.github.io'

const TREE_RESPONSE = {
  sha: SHA.treeHead,
  truncated: false,
  tree: [
    { path: 'README.md', type: 'blob', sha: '1'.repeat(40), mode: '100644' },
    { path: 'content/posts/a.md', type: 'blob', sha: SHA.blobA, mode: '100644' },
    { path: 'content/posts/b.md', type: 'blob', sha: SHA.blobB, mode: '100644' },
    { path: 'content/posts', type: 'tree', sha: '2'.repeat(40), mode: '040000' },
  ],
}

const FRONT_MATTER = (title, date) =>
  `---\ntitle: ${title}\ndate: ${date}\nslug: abc1234\ncategories:\n  - 日记\ntags:\n  - 测试\n---\n\n正文内容\n`

/**
 * 装一个假的 fetch：按路由表返回预设响应，并记录所有请求。
 *
 * 匹配规则：
 *   - 带 `://` 的 pattern 走**精确**匹配（去掉查询串后相等），
 *     这样 `/repos/o/r` 不会把 `/repos/o/r/commits/master` 也吃掉；
 *   - 其它 pattern 走「包含」匹配，方便写 `raw.githubusercontent.com` 这种片段。
 * 数组顺序仍然重要：先匹配的先生效。
 */
function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push({ url: href, method: init?.method ?? 'GET' })
    for (const [pattern, handler] of routes) {
      const hit = pattern.includes('://')
        ? href.split('?')[0] === pattern
        : href.includes(pattern)
      if (hit) {
        const result = typeof handler === 'function' ? handler(href) : handler
        if (result === undefined) continue
        if (typeof result === 'string') return new Response(result, { status: 200 })
        return new Response(JSON.stringify(result.body ?? result), {
          status: result.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  return calls
}

/** 按 commit sha 取提交时的路由：master 是 HEAD，prev 是上一个提交 */
const commitRoute = (sha, body) => [`${API}/commits/${sha}`, body]

/**
 * 公开仓库的常规路由。
 * `resolveDefaultBranch` 会先取仓库信息，再按分支名取一次提交；
 * 之后 findCommitWithTree 还会按**提交 sha** 取同一个提交，所以两条都要配上。
 */
const ROUTES_FULL = [
  [`${API}/commits/master`, COMMIT_HEAD],
  [`${API}/commits/${SHA.commitHead}`, COMMIT_HEAD],
  [`${API}/git/trees/${SHA.treeHead}`, TREE_RESPONSE],
  [API, REPO_INFO],
  [
    'raw.githubusercontent.com',
    (href) => FRONT_MATTER(href.includes('a.md') ? '文章 A' : '文章 B', '2026-01-01T00:00:00+08:00'),
  ],
]

test('toTreeSnapshot 从真实响应形状里取出 tree sha（回归：误写成 commit.commit）', () => {
  const snapshot = toTreeSnapshot(COMMIT_HEAD, 'master')
  assert.equal(snapshot.branch, 'master')
  assert.equal(snapshot.commitSha, SHA.commitHead)
  assert.equal(snapshot.treeSha, SHA.treeHead)

  // 明确锁死错误写法：commit 里没有第二个 commit
  assert.equal(COMMIT_HEAD.commit.commit, undefined, 'commit 里不应再有 commit 字段')
})

test('toTreeSnapshot 遇到缺字段时给出可读错误，而不是 TypeError', () => {
  assert.throws(() => toTreeSnapshot({ sha: SHA.commitHead }, 'master'), /缺少 tree 字段/)
  assert.throws(() => toTreeSnapshot({}, 'master'), /缺少 tree 字段/)
})

test('fetchTreeSnapshot 走 /commits/{branch} 并解析出 treeSha', async () => {
  const calls = mockFetch(ROUTES_FULL)
  const snapshot = await fetchTreeSnapshot(SETTINGS)
  assert.equal(snapshot.treeSha, SHA.treeHead)
  assert.equal(snapshot.commitSha, SHA.commitHead)
  assert.ok(
    calls.some((c) => c.url === `${API}/commits/master`),
    `应当请求 commits/master，实际：${calls.map((c) => c.url).join(', ')}`,
  )
})

test('scanFully 只挑出 content/posts 下的 md，并带上 blob sha', async () => {
  mockFetch(ROUTES_FULL)
  const scan = await scanFully(SETTINGS)
  assert.equal(scan.treeSha, SHA.treeHead)
  assert.deepEqual(
    scan.files.map((f) => f.path).sort(),
    ['content/posts/a.md', 'content/posts/b.md'],
  )
  assert.equal(scan.files.find((f) => f.path.endsWith('a.md')).blobSha, SHA.blobA)
})

test('scanIncrementally：tree 没变时 0 个改动（对应缓存命中）', async () => {
  mockFetch(ROUTES_FULL)
  const scan = await scanIncrementally(SETTINGS, SHA.treeHead)
  assert.ok(scan, '应当返回结果而不是 null')
  assert.equal(scan.changed.length, 0)
  assert.equal(scan.removed.length, 0)
})

test('scanIncrementally：tree 变了时用 compare 只拿到改动的文件', async () => {
  // 缓存的 tree 等于「上一次提交」的 tree —— 正是真实场景：上次访问后仓库又前进了
  const calls = mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitHead}`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitPrev}`, COMMIT_PREV],
    [
      `${API}/compare/${SHA.commitPrev}...${SHA.commitHead}`,
      {
        files: [
          { filename: 'content/posts/a.md', status: 'modified', sha: SHA.blobA },
          { filename: 'content/posts/gone.md', status: 'removed' },
          { filename: 'README.md', status: 'modified', sha: '3'.repeat(40) },
        ],
      },
    ],
    [`${API}/git/trees/${SHA.treeHead}`, TREE_RESPONSE],
    [API, REPO_INFO],
  ])
  const scan = await scanIncrementally(SETTINGS, SHA.treePrev)
  assert.ok(scan, '应当拿到增量结果')
  assert.equal(scan.treeSha, SHA.treeHead)
  assert.deepEqual(scan.changed, [{ path: 'content/posts/a.md', blobSha: SHA.blobA }])
  assert.deepEqual(scan.removed, ['content/posts/gone.md'])
  // README.md 不在 content/posts 下，应被忽略
  assert.ok(!scan.changed.some((c) => c.path === 'README.md'))
  assert.equal(scan.files.length, 2, 'files 应当是当前完整的文章清单')
  // 应当用缓存那次提交的 commit sha 去 compare，而不是 tree sha
  assert.ok(
    calls.some((c) => c.url.includes(`/compare/${SHA.commitPrev}...${SHA.commitHead}`)),
    `compare 的参数应当是两个 commit sha，实际请求：${calls.map((c) => c.url).join(', ')}`,
  )
})

test('scanIncrementally：compare 触达 300 上限时返回 null（退回全量）', async () => {
  mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitHead}`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitPrev}`, COMMIT_PREV],
    [
      `${API}/compare/${SHA.commitPrev}...${SHA.commitHead}`,
      {
        files: Array.from({ length: 300 }, (_, i) => ({
          filename: `content/posts/x${i}.md`,
          status: 'modified',
          sha: '4'.repeat(40),
        })),
      },
    ],
    [API, REPO_INFO],
  ])
  const scan = await scanIncrementally(SETTINGS, SHA.treePrev)
  assert.equal(scan, null, '结果被截断时必须退回全量')
})

test('scanIncrementally：找不到缓存那棵树时返回 null（调用方退回全量）', async () => {
  mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitHead}`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitPrev}`, COMMIT_PREV],
    [API, REPO_INFO],
  ])
  const scan = await scanIncrementally(SETTINGS, '9'.repeat(40))
  assert.equal(scan, null)
})

test('readFileContents：公开仓库走 raw，并返回每篇的正文', async () => {
  const calls = mockFetch(ROUTES_FULL)
  const contents = await readFileContents(SETTINGS, ['content/posts/a.md', 'content/posts/b.md'])
  assert.equal(contents.size, 2)
  assert.match(contents.get('content/posts/a.md'), /文章 A/)
  assert.match(contents.get('content/posts/b.md'), /文章 B/)
  // 读正文的请求必须全部走 raw（API 请求另外算，不计入）
  const contentCalls = calls.filter((c) => c.url.includes('content/posts'))
  assert.ok(contentCalls.length >= 2, `应当有两次正文读取，实际 ${contentCalls.length}`)
  assert.ok(
    contentCalls.every((c) => c.url.includes('raw.githubusercontent.com')),
    '公开仓库不应消耗 API 配额，正文应全部走 raw',
  )
})

test('单个文件读取失败不会拖垮整批', async () => {
  mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [API, REPO_INFO],
    [
      'raw.githubusercontent.com',
      (href) =>
        href.includes('b.md')
          ? { status: 500, body: { message: 'boom' } }
          : // 返回 undefined 让路由继续往下匹配（这里没有下一条，最终 404）
            undefined,
    ],
  ])
  const contents = await readFileContents(SETTINGS, ['content/posts/a.md', 'content/posts/b.md'])
  // a.md 走到 404（raw 拿不到就回退 API，也拿不到）→ 缺席
  // b.md 是 500 → 同样缺席；关键是整批不能抛错
  assert.equal(contents.size, 0)
  assert.equal(contents.has('content/posts/a.md'), false)
  assert.equal(contents.has('content/posts/b.md'), false)
})

test('单个文件读取失败时，其它文件照常返回', async () => {
  mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [API, REPO_INFO],
    [
      'raw.githubusercontent.com',
      (href) =>
        href.includes('b.md')
          ? { status: 500, body: { message: 'boom' } }
          : FRONT_MATTER('文章 A', '2026-01-01T00:00:00+08:00'),
    ],
  ])
  const contents = await readFileContents(SETTINGS, ['content/posts/a.md', 'content/posts/b.md'])
  assert.equal(contents.get('content/posts/a.md')?.includes('文章 A'), true)
  assert.equal(contents.has('content/posts/b.md'), false, '失败的这篇应当缺席而不是抛错')
})

test('私有仓库不会去请求 raw，改用 Contents API', async () => {
  const calls = mockFetch([
    [`${API}/commits/master`, COMMIT_HEAD],
    [`${API}/commits/${SHA.commitHead}`, COMMIT_HEAD],
    [
      `${API}/contents/content%2Fposts%2Fa.md`,
      {
        content: Buffer.from('---\ntitle: 私有\n---\n\nx\n').toString('base64'),
        encoding: 'base64',
        sha: SHA.blobA,
      },
    ],
    // 仓库信息（标记为私有）必须保留，否则 resolveDefaultBranch 会 404
    [API, { ...REPO_INFO, private: true }],
  ])
  const contents = await readFileContents(SETTINGS, ['content/posts/a.md'])
  assert.ok(contents.get('content/posts/a.md')?.includes('私有'))
  assert.ok(!calls.some((c) => c.url.includes('raw.githubusercontent.com')))
})
