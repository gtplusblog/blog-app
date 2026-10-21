/**
 * 增量刷新所用 GitHub 端点的真实校验（跑在 gtplusblog.github.io 这个真实仓库上）。
 *
 * 验证四件事：
 *   1. 分支 head 能取到 commit / tree sha（fetchTreeSnapshot 的前提）
 *   2. 递归 tree 里的文章条目带 blob sha，可直接用于比对
 *   3. compare 能精确列出改动的文章（增量解析的依据），且上限 300 未被触达
 *   4. compare 返回的 sha 与 tree 里的 blob sha 一致（否则判断「有没有变」会出错）
 *
 * 这些用例需要联网，默认跳过；显式打开：
 *   BLOG_APP_NET_TESTS=1 pnpm test
 *
 * 未认证的 GitHub API 每小时只有 60 次配额，跑几轮就会被限流；
 * 设了 GITHUB_TOKEN / GH_TOKEN 时会自动带上，配额提升到 5000/小时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const OWNER = 'gtplusblog'
const REPO = 'gtplusblog.github.io'
const POSTS_DIR = 'content/posts'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const H = {
  'user-agent': 'blog-app-test',
  accept: 'application/vnd.github+json',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
}

const skip =
  process.env.BLOG_APP_NET_TESTS === '1'
    ? false
    : '联网用例默认跳过：设 BLOG_APP_NET_TESTS=1 启用'

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, { headers: H })
  if (!res.ok) {
    const hint =
      res.status === 403 && !TOKEN
        ? '（未认证 API 每小时仅 60 次，设 GITHUB_TOKEN 可提升到 5000）'
        : ''
    throw new Error(`GitHub 返回 ${res.status}：${path} ${hint}`)
  }
  return res.json()
}

test('分支 head 能取到 commit 与 tree sha（fetchTreeSnapshot 的前提）', { skip }, async () => {
  const head = await gh('/commits/master')
  assert.ok(head.sha, '应有 commit sha')
  assert.ok(head.commit?.tree?.sha, '应有 tree sha')
  assert.match(head.commit.tree.sha, /^[0-9a-f]{40}$/)
})

test('递归 tree 里的文章条目带 blob sha，可直接用于比对', { skip }, async () => {
  const head = await gh('/commits/master')
  const tree = await gh(`/git/trees/${head.commit.tree.sha}?recursive=1`)
  const posts = tree.tree.filter(
    (e) =>
      e.type === 'blob' &&
      e.path.startsWith(`${POSTS_DIR}/`) &&
      /\.(md|markdown)$/i.test(e.path) &&
      !e.path.slice(POSTS_DIR.length + 1).includes('/'),
  )
  assert.ok(posts.length > 100, `应能列出 100+ 篇文章，实际 ${posts.length}`)
  for (const p of posts.slice(0, 5)) {
    assert.match(p.sha, /^[0-9a-f]{40}$/, `${p.path} 的 blob sha 格式不对`)
  }
})

test('compare 能精确列出改动的文章（增量解析的依据）', { skip }, async () => {
  // 「上一次提交 → 当前提交」就是真实场景里增量要处理的差异
  const commits = await gh('/commits?per_page=5')
  assert.ok(commits.length >= 2, '至少要有两个提交才能做对比')

  const head = commits[0]
  const parent = commits[1]
  const cmp = await gh(`/compare/${parent.sha}...${head.sha}`)

  assert.ok(Array.isArray(cmp.files), 'compare 应返回 files 数组')
  for (const f of cmp.files) {
    assert.ok(typeof f.filename === 'string', 'files[].filename 应为字符串')
    assert.ok(typeof f.status === 'string', 'files[].status 应为字符串')
    if (f.status !== 'removed') {
      assert.match(f.sha ?? '', /^[0-9a-f]{40}$/, `${f.filename} 的 sha 格式不对`)
    }
  }

  // 拿同一个 commit 和自己比：应当没有任何文件变化（对应「缓存命中」的情况）
  const sameCommit = await gh(`/compare/${head.sha}...${head.sha}`)
  assert.equal((sameCommit.files ?? []).length, 0, '同一个 commit 自比不应有变化')

  // compare 单次最多 300 个文件，触达上限时实现会退回全量
  assert.ok(cmp.files.length < 300, `本次改了 ${cmp.files.length} 个文件，需确认未截断`)

  console.log(
    `    最近一次提交改动了 ${cmp.files.length} 个文件：` +
      cmp.files.map((f) => `${f.status}:${f.filename}`).join(', '),
  )
})

test('跨多次提交的 compare 能找到「新增之后」的改动集合', { skip }, async () => {
  const commits = await gh('/commits?per_page=5')
  if (commits.length < 3) {
    console.log('    提交太少，跳过')
    return
  }
  const older = commits[2]
  const head = commits[0]
  const cmp = await gh(`/compare/${older.sha}...${head.sha}`)
  assert.ok(Array.isArray(cmp.files))
  const posts = cmp.files.filter((f) => f.filename.startsWith(`${POSTS_DIR}/`))
  console.log(`    跨两次提交共 ${cmp.files.length} 个文件变化，其中文章 ${posts.length} 个`)
  for (const f of posts) {
    assert.ok(
      ['added', 'modified', 'removed', 'renamed'].includes(f.status),
      `未知状态 ${f.status}`,
    )
  }
})

test('compare 的 file sha 与 tree 里的 blob sha 一致', { skip }, async () => {
  const commits = await gh('/commits?per_page=5')
  const head = commits[0]
  const parent = commits[1]
  const cmp = await gh(`/compare/${parent.sha}...${head.sha}`)
  const changedMd = (cmp.files ?? []).filter(
    (f) => f.filename.startsWith(`${POSTS_DIR}/`) && f.status !== 'removed',
  )
  if (changedMd.length === 0) {
    console.log('    最近一次提交没有改动文章，跳过比对')
    return
  }
  const tree = await gh(`/git/trees/${head.commit.tree.sha}?recursive=1`)
  const byPath = new Map(tree.tree.map((e) => [e.path, e.sha]))
  for (const f of changedMd) {
    assert.equal(
      byPath.get(f.filename),
      f.sha,
      `${f.filename} 在 tree 与 compare 中的 sha 应一致`,
    )
  }
})
