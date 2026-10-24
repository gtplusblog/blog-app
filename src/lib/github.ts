/**
 * GitHub REST 客户端。
 *
 * 只做三件事：读取仓库里的文章、用一次 Contents API 调用写入一个文件、把图片写进 static/images。
 * 这样每次发布对 GitHub 来说就是一次普通提交 —— 与你现在 `git push` 的效果完全相同，
 * GitHub Actions 会自动重新构建 GitHub Pages。
 */
import { base64DecodeUtf8, base64EncodeUtf8, wrapBase64 } from '../types.ts'
import type { GitHubUser, PostFile, PostSummary, Settings } from '../types'

const API = 'https://api.github.com'

export class GitHubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
  }
}

interface RepoInfo {
  defaultBranch: string
  private: boolean
  fullName: string
}

interface TreeEntry {
  path: string
  sha: string
  type: string
  size?: number
}

function headers(token: string): HeadersInit {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function ghFetch<T>(settings: Settings, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers(settings.token), ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { message?: string; documentation_url?: string }
      detail = body.message ?? ''
    } catch {
      detail = await res.text().catch(() => '')
    }
    throw new GitHubError(res.status, explain(res.status, detail))
  }
  return (await res.json()) as T
}

function explain(status: number, detail: string): string {
  switch (status) {
    case 401:
      return 'Token 无效或已过期，请到 GitHub 重新生成后更新设置'
    case 403:
      return `没有权限或触发限流（${detail || 'Forbidden'}）。请确认 Token 勾选了该仓库的 Contents: Read and write`
    case 404:
      return '仓库或文件不存在。请检查用户名 / 仓库名 / 目录是否正确；Token 也必须勾选该仓库'
    case 409:
      return '文件已被其他地方修改（sha 冲突），请下拉刷新后重试'
    case 422:
      return `请求被拒绝（${detail || 'Unprocessable Entity'}）`
    default:
      return `GitHub 返回 ${status}${detail ? `：${detail}` : ''}`
  }
}

const repoPath = (s: Settings) => `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`

/** 校验 Token 并返回登录用户 */
export async function verifyToken(settings: Settings): Promise<GitHubUser> {
  return ghFetch<GitHubUser>(settings, '/user')
}

/** 读取仓库信息（含默认分支），顺带验证仓库可访问 */
export async function fetchRepo(settings: Settings): Promise<RepoInfo> {
  const repo = await ghFetch<{ default_branch: string; private: boolean; full_name: string }>(
    settings,
    repoPath(settings),
  )
  cache.isPrivate = repo.private
  return {
    defaultBranch: repo.default_branch,
    private: repo.private,
    fullName: repo.full_name,
  }
}

/* ------------------------------------------------------------------ 读取文章 */

interface Cache {
  branch?: string
  /** 仓库是否私有：私有仓库不能用 raw.githubusercontent.com，读取会固定走 API */
  isPrivate?: boolean
  /** path -> sha，便于更新时直接使用，省掉一次额外的 GET */
  shas: Map<string, string>
}

const cache: Cache = { shas: new Map() }

export function invalidateCache(): void {
  cache.branch = undefined
  cache.isPrivate = undefined
  cache.shas.clear()
}

export async function resolveDefaultBranch(settings: Settings): Promise<string> {
  if (cache.branch) return cache.branch
  const repo = await fetchRepo(settings)
  cache.branch = repo.defaultBranch
  return repo.defaultBranch
}

/** 列出 content/posts 下的所有 md 文件（1 次 API 调用） */
export async function listPostFiles(settings: Settings): Promise<PostSummary[]> {
  const branch = await resolveDefaultBranch(settings)
  const dir = postsDirOf(settings)
  const data = await ghFetch<{ tree: TreeEntry[]; truncated: boolean }>(
    settings,
    `${repoPath(settings)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  )
  return data.tree.filter(isPostEntry(dir)).map<PostSummary>((e) => {
    cache.shas.set(e.path, e.sha)
    return {
      path: e.path,
      name: e.path.slice(dir.length + 1),
      sha: e.sha,
      title: '',
      date: '',
      loaded: false,
    }
  })
}

/* ------------------------------------------------------- 增量刷新用的原语 */

export interface TreeSnapshot {
  branch: string
  /** 分支当前指向的 commit */
  commitSha: string
  /** 该 commit 的 tree sha（整棵树的内容指纹） */
  treeSha: string
}

/**
 * 取「当前 tree 指纹」。用于判断自上次缓存以来仓库有没有变化。
 *
 * 注意字段层级：`GET /commits/{ref}` 返回的是
 *   { sha: "<commit sha>", commit: { tree: { sha: "<tree sha>" }, ... }, parents: [...] }
 * 即 `commit` 对象里直接放 `tree`，没有嵌套的第二个 `commit`。
 * （这里曾经写成 `head.commit.commit.tree.sha`，导致手机上打开就报
 *   Cannot read properties of undefined (reading 'tree')。）
 */
export async function fetchTreeSnapshot(settings: Settings): Promise<TreeSnapshot> {
  const branch = await resolveDefaultBranch(settings)
  const head = await ghFetch<GitCommitResponse>(
    settings,
    `${repoPath(settings)}/commits/${encodeURIComponent(branch)}`,
  )
  return toTreeSnapshot(head, branch)
}

/** `GET /commits/{ref}` 的响应（只声明用到的字段） */
export interface GitCommitResponse {
  sha: string
  commit: {
    /** 完整的 commit message（可能多行） */
    message?: string
    tree: { sha: string }
  }
  parents?: { sha: string }[]
}

/** 从 API 响应里取出 branch / commitSha / treeSha，单独抽出来便于单测 */
export function toTreeSnapshot(head: GitCommitResponse, branch: string): TreeSnapshot {
  const commitSha = head?.sha
  const treeSha = head?.commit?.tree?.sha
  if (!commitSha || !treeSha) {
    throw new GitHubError(0, 'GitHub 返回的提交信息缺少 tree 字段，无法判断仓库是否变化')
  }
  return { branch, commitSha, treeSha }
}

/**
 * 顺着提交历史往前找，找到 tree sha 等于 `targetTreeSha` 的那次提交，
 * 也就是缓存建立时的那个时间点。
 *
 * 先直接查一次起始 commit：缓存很可能就是「上一次访问」建立的，
 * 这样最常见的「只多了一两个提交」场景能少一次请求。
 */
async function findCommitWithTree(
  settings: Settings,
  startCommitSha: string,
  targetTreeSha: string,
  maxDepth = 25,
): Promise<string | null> {
  let sha = startCommitSha
  for (let depth = 0; depth < maxDepth; depth++) {
    const commit = await ghFetch<GitCommitResponse>(
      settings,
      `${repoPath(settings)}/commits/${sha}`,
    )

    if (commit.commit?.tree?.sha === targetTreeSha) return commit.sha
    const parent = commit.parents?.[0]
    if (!parent) return null
    sha = parent.sha
  }
  return null
}

export interface IncrementalScan {
  treeSha: string
  branch: string
  /** postsDir 下需要重新解析的文件（新增或改动） */
  changed: { path: string; blobSha: string }[]
  /** postsDir 下被删除的文件 */
  removed: string[]
  /** 当前所有文章文件（含未变动的），用于校正列表 */
  files: { path: string; blobSha: string }[]
}

/**
 * 判断能否增量：不行就返回 null，让调用方走「全量」。
 *
 * `trees/{base}...{head}` 返回两个 tree 的差异，只需要重新解析 changed 里的文件，
 * 而不是把 160 多篇全部重读一遍。
 */
export async function scanIncrementally(
  settings: Settings,
  cachedTreeSha: string,
): Promise<IncrementalScan | null> {
  const dir = postsDirOf(settings)
  const snapshot = await fetchTreeSnapshot(settings)
  if (snapshot.treeSha === cachedTreeSha) {
    // 完全没有变化：changed/removed 都是空的，调用方据此直接复用缓存。
    // files 也返回空数组 —— 拿到结果后请先判断 changed/removed 是否为空，
    // 不要用 files 去重建列表（那会把列表清空）。
    return { treeSha: snapshot.treeSha, branch: snapshot.branch, changed: [], removed: [], files: [] }
  }

  const baseCommit = await findCommitWithTree(settings, snapshot.commitSha, cachedTreeSha)
  if (!baseCommit) return null

  const diff = await ghFetch<{
    files?: { filename: string; status: string; sha?: string; previous_filename?: string }[]
  }>(settings, `${repoPath(settings)}/compare/${baseCommit}...${snapshot.commitSha}`)

  const files = diff.files ?? []
  // GitHub 的 compare 单次最多返回 300 个文件；拿到上限说明结果被截断，
  // 这时增量会漏掉文件，直接退回全量更安全。
  if (files.length >= 300) return null

  const changed: { path: string; blobSha: string }[] = []
  const removed: string[] = []
  for (const file of files) {
    const isPost =
      file.filename.startsWith(`${dir}/`) &&
      /\.(md|markdown)$/i.test(file.filename) &&
      !file.filename.slice(dir.length + 1).includes('/')
    if (file.status === 'removed') {
      if (isPost) removed.push(file.filename)
      continue
    }
    if (!isPost) continue
    if (file.status === 'renamed' || file.status === 'added' || file.status === 'modified') {
      changed.push({ path: file.filename, blobSha: file.sha ?? '' })
      if (file.status === 'renamed' && file.previous_filename) removed.push(file.previous_filename)
    }
  }

  // 取一份完整清单，用来校正「缓存里有但仓库里已经没了」的条目
  const tree = await ghFetch<{ tree: TreeEntry[] }>(
    settings,
    `${repoPath(settings)}/git/trees/${encodeURIComponent(snapshot.treeSha)}?recursive=1`,
  )
  const all = tree.tree.filter(isPostEntry(dir)).map((e) => ({ path: e.path, blobSha: e.sha }))
  for (const entry of all) cache.shas.set(entry.path, entry.blobSha)

  return { treeSha: snapshot.treeSha, branch: snapshot.branch, changed, removed, files: all }
}

/** 全量扫描：列出当前所有文章文件（含 blob sha） */
export async function scanFully(settings: Settings): Promise<IncrementalScan> {
  const dir = postsDirOf(settings)
  const snapshot = await fetchTreeSnapshot(settings)
  const tree = await ghFetch<{ tree: TreeEntry[] }>(
    settings,
    `${repoPath(settings)}/git/trees/${encodeURIComponent(snapshot.treeSha)}?recursive=1`,
  )
  const files = tree.tree.filter(isPostEntry(dir)).map((e) => ({ path: e.path, blobSha: e.sha }))
  for (const entry of files) cache.shas.set(entry.path, entry.blobSha)
  return {
    treeSha: snapshot.treeSha,
    branch: snapshot.branch,
    changed: files,
    removed: [],
    files,
  }
}

function postsDirOf(settings: Settings): string {
  return settings.postsDir.replace(/^\/+|\/+$/g, '')
}

/**
 * 列出任意目录下的直接子文件（不含子目录）。
 * 动态用的 data/moments 只有每年一个 JSON，用不上文章那套增量逻辑。
 */
export async function listBlobPaths(
  settings: Settings,
  dir: string,
): Promise<{ path: string; sha: string }[]> {
  const clean = dir.replace(/^\/+|\/+$/g, '')
  if (!clean) return []
  const snapshot = await fetchTreeSnapshot(settings)
  const tree = await ghFetch<{ tree: TreeEntry[] }>(
    settings,
    `${repoPath(settings)}/git/trees/${encodeURIComponent(snapshot.treeSha)}?recursive=1`,
  )
  const files = tree.tree
    .filter(
      (e) =>
        e.type === 'blob' &&
        e.path.startsWith(`${clean}/`) &&
        !e.path.slice(clean.length + 1).includes('/'),
    )
    .map((e) => ({ path: e.path, sha: e.sha }))
  for (const file of files) cache.shas.set(file.path, file.sha)
  return files
}

function isPostEntry(dir: string) {
  return (e: TreeEntry): boolean =>
    e.type === 'blob' &&
    e.path.startsWith(`${dir}/`) &&
    /\.(md|markdown)$/i.test(e.path) &&
    !e.path.slice(dir.length + 1).includes('/')
}

function decodeContent(payload: { content?: string; encoding?: string }): string {
  if (!payload.content) return ''
  if (payload.encoding && payload.encoding !== 'base64') return payload.content
  return base64DecodeUtf8(payload.content)
}

/** 确保仓库公开/私有已知，决定能不能走 raw */
async function ensureRepoVisibility(settings: Settings): Promise<void> {
  if (cache.isPrivate !== undefined) return
  try {
    await fetchRepo(settings)
  } catch {
    // 探测失败就当公开仓库试一次 raw，失败会自动回退到 API
  }
}

/** 正文读取：公开仓库走 raw（不吃 API 配额），否则走 Contents API */
async function fetchContent(settings: Settings, path: string, branch: string): Promise<string> {
  await ensureRepoVisibility(settings)
  if (!cache.isPrivate) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${encodeURIComponent(
        branch,
      )}/${path.split('/').map(encodeURIComponent).join('/')}`
      const res = await fetch(rawUrl, { cache: 'no-cache' })
      if (res.ok) return await res.text()
    } catch {
      // 网络异常时回退到 API
    }
  }
  const data = await ghFetch<{ content?: string; encoding?: string; sha: string }>(
    settings,
    `${repoPath(settings)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
  )
  cache.shas.set(path, data.sha)
  return decodeContent(data)
}

/**
 * 批量读取文件内容（带并发上限）。
 * 增量刷新时只需要读「变了的那些」，通常只有 0～几个文件。
 */
export async function readFileContents(
  settings: Settings,
  paths: string[],
  concurrency = 6,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (paths.length === 0) return result
  const branch = await resolveDefaultBranch(settings)
  let cursor = 0
  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      try {
        result.set(path, await fetchContent(settings, path, branch))
      } catch {
        // 单个文件读失败不阻塞其它文件
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()),
  )
  return result
}

/**
 * 读取单个文件。
 * 公开仓库优先走 raw.githubusercontent.com —— 它不消耗 GitHub API 的
 * 5000 次/小时配额；私有仓库（或 raw 取不到时）再回退到 Contents API。
 */
export async function readFile(settings: Settings, path: string): Promise<PostFile> {
  const branch = await resolveDefaultBranch(settings)
  const name = path.split('/').pop() ?? path
  const content = await fetchContent(settings, path, branch)
  return {
    path,
    name,
    sha: cache.shas.get(path) ?? '',
    title: '',
    date: '',
    loaded: false,
    content,
  }
}

/** 文章是否已存在 */
export async function fileExists(settings: Settings, path: string): Promise<string | null> {
  if (cache.shas.has(path)) return cache.shas.get(path) ?? null
  const branch = await resolveDefaultBranch(settings)
  try {
    const data = await ghFetch<{ sha: string }>(
      settings,
      `${repoPath(settings)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    )
    cache.shas.set(path, data.sha)
    return data.sha
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null
    throw err
  }
}

/* ------------------------------------------------------------------ 写入 */

export interface CommitResult {
  path: string
  sha: string
  htmlUrl: string
  created: boolean
}

export interface WriteOptions {
  /** 已知 sha（更新时必填，避免覆盖别人的修改）；null 表示新建 */
  sha?: string | null
  message: string
}

/** 写入一个文本文件；sha 为 null/未提供时若远端已存在则自动补一次查询 */
export async function writeTextFile(
  settings: Settings,
  path: string,
  content: string,
  options: WriteOptions,
): Promise<CommitResult> {
  const branch = await resolveDefaultBranch(settings)
  let sha = options.sha ?? null
  if (!sha) sha = await fileExists(settings, path)

  const body: Record<string, unknown> = {
    message: options.message,
    content: base64EncodeUtf8(content),
    branch,
  }
  if (sha) body.sha = sha

  const res = await ghFetch<{ content: { sha: string; html_url: string } }>(
    settings,
    `${repoPath(settings)}/contents/${encodeURIComponent(path)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  cache.shas.set(path, res.content.sha)
  if (cache.branch === undefined) cache.branch = branch
  return { path, sha: res.content.sha, htmlUrl: res.content.html_url, created: !sha }
}

/** 写入一个二进制文件（图片） */
export async function writeBinaryFile(
  settings: Settings,
  path: string,
  bytes: ArrayBuffer,
  message: string,
  sha?: string | null,
): Promise<CommitResult> {
  const branch = await resolveDefaultBranch(settings)
  const existing = sha ?? (await fileExists(settings, path))
  const b64 = wrapBase64(
    (() => {
      const view = new Uint8Array(bytes)
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < view.length; i += chunk) {
        binary += String.fromCharCode(...view.subarray(i, i + chunk))
      }
      return btoa(binary)
    })(),
  )
  const body: Record<string, unknown> = { message, content: b64, branch }
  if (existing) body.sha = existing

  const res = await ghFetch<{ content: { sha: string; html_url: string } }>(
    settings,
    `${repoPath(settings)}/contents/${encodeURIComponent(path)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  cache.shas.set(path, res.content.sha)
  return { path, sha: res.content.sha, htmlUrl: res.content.html_url, created: !existing }
}

/* ------------------------------------------------------------------ 辅助 */

export function sanitizeFileName(input: string, fallback: string): string {
  const cleaned = input
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[\s]+/g, '-')
    .replace(/[<>:"|?*\u0000-\u001f]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const name = cleaned || fallback
  return name.length > 80 ? name.slice(0, 80) : name
}

/** 默认文件名：<prefix><YYYYMMDD>，与仓库现有命名习惯一致 */
export function defaultFileName(prefix: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  return `${prefix}${stamp}`
}

/**
 * 从 slug 反查 / 从文件名构造文章在网上的地址。
 * hugo.toml 里 `posts = "/posts/:slug"`，所以地址由 slug 决定，与文件名无关。
 */
export function postUrl(siteUrl: string, slug: string): string {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`
  return `${base}posts/${encodeURIComponent(slug)}/`
}

export function blobUrl(settings: Settings, branch: string, path: string): string {
  return `https://github.com/${settings.owner}/${settings.repo}/blob/${branch}/${path}`
}

export function actionsUrl(settings: Settings): string {
  return `https://github.com/${settings.owner}/${settings.repo}/actions`
}
