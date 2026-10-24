import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store-context'
import { GitHubError, readFileContents, scanFully, scanIncrementally } from '../lib/github'
import { parsePost } from '../lib/frontmatter'
import { deleteDraft, draftSummary, listDrafts } from '../lib/drafts'
import type { Draft } from '../lib/drafts'
import {
  loadPostCache,
  postsFromCache,
  repoKeyOf,
  savePostCache,
} from '../lib/post-cache'
import type { PostListCache, PostMetaEntry } from '../lib/post-cache'
import type { PostSummary } from '../types'

interface Props {
  onOpen: (post: PostSummary) => void
  onOpenDraft: (draft: Draft) => void
  onCompose: () => void
  onDemo: () => void
  onMoments: () => void
  onSettings: () => void
}

const PAGE_SIZE = 20
const PARSE_CONCURRENCY = 6

function formatDate(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value.slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 文件名里带 YYYYMMDD 时先按它排序，避免等 front matter 解析完 */
function fallbackKey(name: string): string {
  const match = /(\d{8})/.exec(name)
  return match ? match[1] : name
}

/** 只需要列表页展示的那几个字段，避免把整篇正文都留在内存里 */
function summarize(content: string) {
  const doc = parsePost(content)
  return {
    title: doc.frontMatter.title,
    date: doc.frontMatter.date,
    categories: doc.frontMatter.categories,
    tags: doc.frontMatter.tags,
  }
}

export function PostsScreen({ onOpen, onOpenDraft, onCompose, onDemo, onMoments, onSettings }: Props) {
  const { settings } = useStore()

  const [posts, setPosts] = useState<PostSummary[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  /** 连缓存都没有时才显示「读取中」，有缓存就直接秒开 */
  const [coldLoading, setColdLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [metaVersion, setMetaVersion] = useState(0)

  const metaRef = useRef(new Map<string, PostMetaEntry>())
  const generationRef = useRef(0)

  const configured = Boolean(settings.token && settings.owner && settings.repo)
  const repoKey = repoKeyOf(settings.owner, settings.repo, settings.postsDir)

  /* ------------------------------------------------------------ 本地草稿 */

  const refreshDrafts = useCallback(async () => {
    try {
      setDrafts(await listDrafts())
    } catch {
      setDrafts([])
    }
  }, [])

  /* ------------------------------------------- 用缓存秒开（不等待网络） */

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cache = await loadPostCache()
      if (cancelled) return
      if (!cache || cache.repoKey !== repoKey) {
        metaRef.current = new Map()
        setPosts([])
        setCachedAt(null)
        return
      }
      metaRef.current = new Map(Object.entries(cache.entries))
      setPosts(postsFromCache(cache, settings.postsDir))
      setCachedAt(cache.savedAt)
      setMetaVersion((n) => n + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [repoKey, settings.postsDir])

  /* ------------------------------------------------- 增量刷新（核心逻辑） */

  const persist = useCallback(
    async (treeSha: string, branch: string) => {
      const entries: Record<string, PostMetaEntry> = {}
      for (const [path, entry] of metaRef.current) entries[path] = entry
      const cache: PostListCache = {
        version: 1,
        repoKey,
        treeSha,
        branch,
        entries,
        savedAt: Date.now(),
      }
      await savePostCache(cache)
      setCachedAt(cache.savedAt)
    },
    [repoKey],
  )

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current
    setError(null)
    await refreshDrafts()

    if (!configured) {
      setPosts([])
      return
    }

    // 没有缓存 → 显示「读取中」；有缓存 → 后台静默刷新，界面保持可用
    if (metaRef.current.size === 0) setColdLoading(true)
    setRefreshing(true)

    try {
      const cached = await loadPostCache()
      const usableCache = cached && cached.repoKey === repoKey ? cached : null

      let treeSha: string
      let branch: string
      let files: { path: string; blobSha: string }[]
      let changedPaths: string[]
      /** 仓库相对缓存没有任何变化：此时可以直接跳过所有重建工作 */
      let unchanged = false

      if (usableCache) {
        const scan = await scanIncrementally(settings, usableCache.treeSha)
        if (scan) {
          treeSha = scan.treeSha
          branch = scan.branch
          files = scan.files
          for (const path of scan.removed) metaRef.current.delete(path)
          // 只有 blob sha 真的变了的文件才需要重新读
          changedPaths = scan.changed
            .filter((c) => metaRef.current.get(c.path)?.blobSha !== c.blobSha)
            .map((c) => c.path)
          // 上次读取失败（标题和日期都空）的文件，这次再试一次
          for (const [path, entry] of metaRef.current) {
            if (!entry.title && !entry.date && !changedPaths.includes(path)) {
              changedPaths.push(path)
            }
          }
          unchanged =
            changedPaths.length === 0 && scan.removed.length === 0 && scan.changed.length === 0
        } else {
          const full = await scanFully(settings)
          treeSha = full.treeSha
          branch = full.branch
          files = full.files
          changedPaths = full.changed.map((c) => c.path)
        }
      } else {
        const full = await scanFully(settings)
        treeSha = full.treeSha
        branch = full.branch
        files = full.files
        changedPaths = full.changed.map((c) => c.path)
        metaRef.current = new Map()
      }

      if (generation !== generationRef.current) return

      // 仓库没有变化：列表和元数据都是现成的，直接结束
      // （注意不能在这里 setPosts(files)，增量结果里 files 是空的）
      if (unchanged) {
        await persist(treeSha, branch)
        return
      }

      // 按仓库里的真实文件清单校正列表（新增/删除都能立刻反映）
      const dir = settings.postsDir.replace(/^\/+|\/+$/g, '')
      setPosts(
        files.map((f) => ({
          path: f.path,
          name: f.path.slice(dir.length + 1),
          sha: f.blobSha,
          title: '',
          date: '',
          loaded: true,
        })),
      )

      const blobShaOf = (path: string) => files.find((f) => f.path === path)?.blobSha ?? ''

      // 只解析「新增 / 改动」的文件；命中缓存时 changedPaths 通常为空
      setProgress({ done: 0, total: changedPaths.length })
      if (changedPaths.length > 0) {
        const contents = await readFileContents(settings, changedPaths, PARSE_CONCURRENCY)
        let done = 0
        for (const path of changedPaths) {
          if (generation !== generationRef.current) return
          const content = contents.get(path)
          if (content !== undefined) {
            metaRef.current.set(path, {
              blobSha: blobShaOf(path),
              ...summarize(content),
              parsedAt: Date.now(),
            })
          } else {
            // 单个文件读取失败：记一条空的，避免每次进来都重试
            metaRef.current.set(path, {
              blobSha: blobShaOf(path),
              title: '',
              date: '',
              categories: [],
              tags: [],
              parsedAt: Date.now(),
            })
          }
          done += 1
          if (done % 5 === 0) {
            setProgress({ done, total: changedPaths.length })
            setMetaVersion((n) => n + 1)
          }
        }
      }

      if (generation !== generationRef.current) return
      setProgress({ done: changedPaths.length, total: changedPaths.length })
      setMetaVersion((n) => n + 1)
      await persist(treeSha, branch)
    } catch (err) {
      if (generation !== generationRef.current) return
      setError(
        err instanceof GitHubError
          ? err.message
          : err instanceof Error
            ? err.message
            : '读取文章列表失败',
      )
    } finally {
      if (generation === generationRef.current) {
        setColdLoading(false)
        setRefreshing(false)
      }
    }
  }, [configured, persist, refreshDrafts, repoKey, settings])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.token, settings.owner, settings.repo, settings.postsDir])

  /* -------------------------------------------------------------- 派生数据 */

  const sorted = useMemo(() => {
    void metaVersion
    const withMeta = posts.map((p) => ({ post: p, meta: metaRef.current.get(p.path) }))
    withMeta.sort((a, b) => {
      const da = a.meta?.date ?? ''
      const db = b.meta?.date ?? ''
      if (da && db) return db.localeCompare(da)
      if (da) return -1
      if (db) return 1
      return fallbackKey(b.post.name).localeCompare(fallbackKey(a.post.name))
    })
    return withMeta
  }, [posts, metaVersion])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(({ post, meta }) =>
      [post.name, meta?.title ?? '', ...(meta?.categories ?? []), ...(meta?.tags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [sorted, query])

  const visible = filtered.slice(0, page * PAGE_SIZE)
  const categoryCount = useMemo(
    () => new Set(sorted.flatMap(({ meta }) => meta?.categories ?? [])).size,
    [sorted],
  )
  const parsing = progress.total > 0 && progress.done < progress.total
  const progressText = coldLoading
    ? '首次读取…'
    : parsing
      ? `解析 ${progress.done}/${progress.total}`
      : refreshing
        ? '检查更新…'
        : ''

  return (
    <div className="screen list-screen">
      <header className="topbar">
        <h1>我的博客</h1>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={onMoments}
            aria-label="动态"
            title="动态"
          >
            ◍
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void refresh()}
            aria-label="刷新"
            title="刷新"
            disabled={!configured || refreshing}
          >
            {refreshing ? '…' : '⟳'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onSettings}
            aria-label="设置"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </header>

      {!configured && (
        <div className="notice">
          <p>还没有配置 GitHub 访问令牌，暂时无法读取或发布文章。</p>
          <div className="notice-actions">
            <button type="button" className="btn primary" onClick={onSettings}>
              去设置
            </button>
            <button type="button" className="btn ghost" onClick={onDemo}>
              先看看演示
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="notice error">
          <p>{error}</p>
          <div className="notice-actions">
            <button type="button" className="btn" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        </div>
      )}

      {drafts.length > 0 && (
        <section className="list-section">
          <h2 className="section-title">
            本机草稿 <span className="badge">{drafts.length}</span>
          </h2>
          {drafts.map((draft) => (
            <div className="post-row draft" key={draft.id}>
              <button type="button" className="post-main" onClick={() => onOpenDraft(draft)}>
                <span className="post-title">
                  {draft.title || draft.body.split('\n')[0]?.trim() || '（无标题）'}
                </span>
                <span className="post-sub">
                  {draft.existing ? '已发布文章的修改' : '未发布'} ·{' '}
                  {relativeTime(draft.updatedAt)}
                </span>
                <span className="post-excerpt">{draftSummary(draft) || '（空白草稿）'}</span>
              </button>
              <button
                type="button"
                className="icon-btn danger"
                aria-label="删除草稿"
                onClick={() => {
                  if (!window.confirm('删除这条本机草稿？')) return
                  void deleteDraft(draft.id).then(refreshDrafts)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="list-section">
        <div className="list-head">
          <h2 className="section-title">
            已发布 <span className="badge">{configured ? filtered.length : 0}</span>
          </h2>
          {progressText && <span className="muted small">{progressText}</span>}
        </div>

        {configured && posts.length > 0 && (
          <input
            className="text-input search"
            value={query}
            placeholder="搜索标题 / 文件名 / 分类 / 标签"
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            type="search"
          />
        )}

        {configured && !coldLoading && filtered.length === 0 && !error && (
          <p className="muted center">
            {posts.length === 0 ? '仓库里还没有文章' : '没有匹配的文章'}
          </p>
        )}

        {visible.map(({ post, meta }) => {
          const title = meta?.title || post.name.replace(/\.md$/i, '')
          const labels = [...(meta?.categories ?? []), ...(meta?.tags ?? [])].slice(0, 4)
          return (
            <button type="button" className="post-row" key={post.path} onClick={() => onOpen(post)}>
              <span className="post-title">{title}</span>
              <span className="post-sub">
                {meta?.date ? <span className="post-date">{formatDate(meta.date)}</span> : null}
                <code className="post-file">{post.name}</code>
              </span>
              {labels.length > 0 && (
                <span className="post-labels">
                  {labels.map((l) => (
                    <span className="mini-chip" key={l}>
                      {l}
                    </span>
                  ))}
                </span>
              )}
            </button>
          )
        })}

        {visible.length < filtered.length && (
          <button type="button" className="btn full" onClick={() => setPage((p) => p + 1)}>
            加载更多（还有 {filtered.length - visible.length} 篇）
          </button>
        )}
      </section>

      <p className="footer-note">
        {configured ? `${posts.length} 篇文章 · ${categoryCount} 个分类` : '未配置仓库'}
        {cachedAt ? ` · 缓存于 ${relativeTime(cachedAt)}` : ''}
        {' · '}
        <a href={settings.siteUrl} target="_blank" rel="noreferrer">
          打开博客
        </a>
      </p>

      <button type="button" className="fab" onClick={onCompose} aria-label="写新文章">
        ＋
      </button>
    </div>
  )
}
