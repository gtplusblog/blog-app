/**
 * 碎碎念（data/moments/*.json）的读写测试：不联网，mock 掉 GitHub API。
 *
 * 重点锁死三件事，因为博客工作台（studio）写的是同一批文件：
 *   1. 序列化格式 —— 一条一行、字段顺序 id/date/text、LF、文件内时间倒序
 *   2. id 规则 —— YYYYMMDD-HHmmss，同秒重复时追加 -2
 *   3. 发布路径 —— 只会改 data/moments/YYYY.json，且带上正确的 sha 与提交信息
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  listMoments,
  momentIdFor,
  MOMENT_MAX_LENGTH,
  parseMoments,
  postMoment,
  removeMoment,
  serializeMoments,
  sortMoments,
} from '../.test-build/lib/moments.js'
import { invalidateCache } from '../.test-build/lib/github.js'
import { base64DecodeUtf8 } from '../.test-build/types.js'

const SETTINGS = {
  token: 'test-token',
  owner: 'gtplusblog',
  repo: 'gtplusblog.github.io',
  postsDir: 'content/posts',
  imagesDir: 'static/images',
  momentsDir: 'data/moments',
  filePrefix: 'posts',
  siteUrl: 'https://gtplusblog.github.io/',
  theme: 'auto',
}

const API = 'https://api.github.com/repos/gtplusblog/gtplusblog.github.io'
const SHA = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  file: 'c'.repeat(40),
  nextFile: 'd'.repeat(40),
}

const COMMIT = {
  sha: SHA.commit,
  commit: { message: 'chore', tree: { sha: SHA.tree } },
  parents: [],
}

const REPO_INFO = {
  default_branch: 'master',
  private: false,
  full_name: 'gtplusblog/gtplusblog.github.io',
}

/** Contents API 会用 encodeURIComponent 把整条路径编码，斜杠也变成 %2F */
const CONTENTS_2026 = `${API}/contents/${encodeURIComponent('data/moments/2026.json')}`

const OLDER = '[\n  {"id":"20261020-090000","date":"2026-10-20T09:00:00+08:00","text":"更早的一条"}\n]\n'

const TREE = {
  sha: SHA.tree,
  truncated: false,
  tree: [
    { path: 'content/posts/a.md', type: 'blob', sha: '1'.repeat(40), mode: '100644' },
    { path: 'data/moments/2026.json', type: 'blob', sha: SHA.file, mode: '100644' },
    { path: 'data/moments/2025.json', type: 'blob', sha: '2'.repeat(40), mode: '100644' },
    { path: 'data/moments/notes.txt', type: 'blob', sha: '3'.repeat(40), mode: '100644' },
  ],
}

beforeEach(() => {
  invalidateCache()
})

/**
 * 记录所有请求；`routes` 里用 (url, init) 判断，返回字符串或对象。
 * 最后一条兜底返回 404，避免测试真的联网。
 */
function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url: href, method, body: init?.body })
    for (const [match, handler] of routes) {
      if (!match(href, method)) continue
      const result = handler(href, init)
      if (result === undefined) continue
      if (typeof result === 'string') return new Response(result, { status: 200 })
      return new Response(JSON.stringify(result.body ?? result), {
        status: result.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  return calls
}

const baseRoutes = (rawJson, rawPrev = '[]\n') => [
  [
    (href, method) => method === 'GET' && href.split('?')[0] === `${API}/commits/master`,
    () => COMMIT,
  ],
  [
    (href, method) => method === 'GET' && href.split('?')[0] === `${API}/git/trees/${SHA.tree}`,
    () => TREE,
  ],
  [
    (href, method) => method === 'GET' && href.split('?')[0] === API,
    () => REPO_INFO,
  ],
  [
    (href) => href.includes('raw.githubusercontent.com') && href.endsWith('/data/moments/2026.json'),
    () => rawJson,
  ],
  [
    (href) => href.includes('raw.githubusercontent.com') && href.endsWith('/data/moments/2025.json'),
    () => rawPrev,
  ],
]

/* ------------------------------------------------------------------ 纯函数 */

test('序列化：一条一行、字段顺序固定、LF 结尾，与 Studio 写入的字节完全一致', () => {
  const text = serializeMoments([
    { id: '20261024-113900', date: '2026-10-24T11:39:00+08:00', text: '今天天气很好' },
    { id: '20261023-220100', date: '2026-10-23T22:01:00+08:00', text: '两行\n文字' },
  ])
  assert.equal(
    text,
    '[\n' +
      '  {"id":"20261024-113900","date":"2026-10-24T11:39:00+08:00","text":"今天天气很好"},\n' +
      '  {"id":"20261023-220100","date":"2026-10-23T22:01:00+08:00","text":"两行\\n文字"}\n' +
      ']\n',
  )
  assert.ok(!text.includes('\r'), '统一 LF，避免 Windows 下多出一堆 diff')
  assert.equal(serializeMoments([]), '[]\n')
})

test('解析：宽容空文件，格式不对时给出可读错误', () => {
  assert.deepEqual(parseMoments('', 'a.json'), [])
  assert.deepEqual(parseMoments('[]', 'a.json'), [])
  assert.deepEqual(parseMoments(OLDER, 'a.json'), [
    { id: '20261020-090000', date: '2026-10-20T09:00:00+08:00', text: '更早的一条' },
  ])

  assert.throws(() => parseMoments('{', 'a.json'), /不是合法的 JSON/)
  assert.throws(() => parseMoments('{}', 'a.json'), /应该是一个数组/)
  assert.throws(() => parseMoments('[{"date":"2026-10-20T09:00:00+08:00"}]', 'a.json'), /第 1 条缺少 text/)
  assert.throws(() => parseMoments('[{"text":"x","date":"昨天"}]', 'a.json'), /date 格式不对/)
})

test('序列化 → 解析 可以无损往返', () => {
  const entries = [
    { id: '20261024-113900', date: '2026-10-24T11:39:00+08:00', text: '带 "引号" 和 \\ 反斜杠' },
    { id: '20251231-230000', date: '2025-12-31T23:00:00+08:00', text: '换行\n第二行' },
  ]
  assert.deepEqual(parseMoments(serializeMoments(entries)), entries)
})

test('id：YYYYMMDD-HHmmss，同秒重复时追加 -2、-3', () => {
  assert.equal(momentIdFor('2026-10-24T11:39:00+08:00'), '20261024-113900')
  assert.equal(
    momentIdFor('2026-10-24T11:39:00+08:00', ['20261024-113900']),
    '20261024-113900-2',
  )
  assert.equal(
    momentIdFor('2026-10-24T11:39:00+08:00', ['20261024-113900', '20261024-113900-2']),
    '20261024-113900-3',
  )
})

test('排序：时间倒序，同一秒内 id 大的在前', () => {
  const sorted = sortMoments([
    { id: '20260101-000000', date: '2026-01-01T00:00:00+08:00' },
    { id: '20261024-113900', date: '2026-10-24T11:39:00+08:00' },
    { id: '20261024-113900-2', date: '2026-10-24T11:39:00+08:00' },
  ])
  assert.deepEqual(sorted.map((m) => m.id), [
    '20261024-113900-2',
    '20261024-113900',
    '20260101-000000',
  ])
})

/* -------------------------------------------------------------- 读写流程 */

test('listMoments 只读 YYYY.json，并按时间倒序合并多个年份', async () => {
  mockFetch(
    baseRoutes(
      OLDER,
      '[\n  {"id":"20251231-235900","date":"2025-12-31T23:59:00+08:00","text":"去年最后一条"}\n]\n',
    ),
  )

  const moments = await listMoments(SETTINGS)
  assert.deepEqual(moments.map((m) => m.id), ['20261020-090000', '20251231-235900'])
  assert.equal(moments[0].file, 'data/moments/2026.json')
  assert.equal(moments[1].year, '2025')
})

test('postMoment：新的写在最上面，只提交 data/moments/2026.json', async () => {
  let written = null
  const calls = mockFetch([
    ...baseRoutes(OLDER),
    [
      (href, method) =>
        method === 'GET' && href.split('?')[0] === CONTENTS_2026,
      () => ({ sha: SHA.file, content: '', encoding: 'base64' }),
    ],
    [
      (href, method) =>
        method === 'PUT' && href.split('?')[0] === CONTENTS_2026,
      (_href, init) => {
        written = JSON.parse(init.body)
        return { content: { sha: SHA.nextFile, html_url: 'https://github.com/x/y/blob/master/z' } }
      },
    ],
  ])

  const result = await postMoment(SETTINGS, '  新的一条  ', new Date('2026-10-24T11:39:00+08:00'))
  assert.equal(result.moment.id, '20261024-113900')
  assert.equal(result.moment.text, '新的一条', '应当去掉首尾空白')
  assert.equal(result.moment.year, '2026')
  assert.equal(result.path, 'data/moments/2026.json')

  assert.ok(written, '应当有一次 PUT')
  assert.equal(written.message, 'moment: 2026 新增一条碎碎念')
  assert.equal(written.sha, SHA.file, '更新已有文件必须带 sha')
  assert.equal(written.branch, 'master')

  const content = base64DecodeUtf8(written.content)
  assert.equal(
    content,
    '[\n' +
      `  {"id":"20261024-113900","date":"${result.moment.date}","text":"新的一条"},\n` +
      '  {"id":"20261020-090000","date":"2026-10-20T09:00:00+08:00","text":"更早的一条"}\n' +
      ']\n',
  )

  const puts = calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 1, '只应写一个文件')
  assert.ok(
    puts.every((c) => c.url.includes(CONTENTS_2026)),
    `不应写到其它文件：${puts.map((c) => c.url).join(', ')}`,
  )
})

test('postMoment 拒绝空内容与超长内容', async () => {
  mockFetch(baseRoutes(OLDER))
  await assert.rejects(() => postMoment(SETTINGS, '   '), /不能为空/)
  await assert.rejects(
    () => postMoment(SETTINGS, 'x'.repeat(MOMENT_MAX_LENGTH + 1)),
    /最多 500 个字/,
  )
})

test('removeMoment 只删掉那一条，其它保持原样', async () => {
  const twoEntries =
    '[\n' +
    '  {"id":"20261024-113900","date":"2026-10-24T11:39:00+08:00","text":"要删的"},\n' +
    '  {"id":"20261020-090000","date":"2026-10-20T09:00:00+08:00","text":"留着的"}\n' +
    ']\n'
  let written = null
  mockFetch([
    ...baseRoutes(twoEntries),
    [
      (href, method) =>
        method === 'GET' && href.split('?')[0] === CONTENTS_2026,
      () => ({ sha: SHA.file, content: '', encoding: 'base64' }),
    ],
    [
      (href, method) =>
        method === 'PUT' && href.split('?')[0] === CONTENTS_2026,
      (_href, init) => {
        written = JSON.parse(init.body)
        return { content: { sha: SHA.nextFile, html_url: 'https://github.com/x/y/blob/master/z' } }
      },
    ],
  ])

  await removeMoment(SETTINGS, {
    id: '20261024-113900',
    date: '2026-10-24T11:39:00+08:00',
    text: '要删的',
    year: '2026',
    file: 'data/moments/2026.json',
  })

  assert.ok(written)
  assert.equal(written.message, 'moment: 2026 删除一条碎碎念')
  const content = base64DecodeUtf8(written.content)
  assert.ok(!content.includes('要删的'))
  assert.ok(content.includes('留着的'))
  assert.equal(parseMoments(content).length, 1)
})
