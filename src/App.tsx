import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { StoreProvider } from './lib/store'
import { useStore } from './lib/store-context'
import { ToastHost } from './components/ToastHost'
import { PostsScreen } from './screens/PostsScreen'
import { MomentsScreen } from './screens/MomentsScreen'
import { EditorScreen } from './screens/EditorScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { loadDraft } from './lib/drafts'
import type { Draft } from './lib/drafts'
import { useServiceWorker } from './lib/use-service-worker'
import type { PostSummary } from './types'

export type Route =
  | { kind: 'list' }
  | { kind: 'moments' }
  | { kind: 'editor'; path?: string; draftId?: string; demo?: boolean }
  | { kind: 'settings' }

/* --------------------------------------------------------------- hash 路由 */

function subscribeHash(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

function getHash(): string {
  return window.location.hash
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  if (!raw) return { kind: 'list' }
  const [head, ...rest] = raw.split('/')
  const tail = rest.join('/')
  if (head === 'edit') {
    if (!tail) return { kind: 'editor' }
    if (tail.startsWith('draft:')) return { kind: 'editor', draftId: tail.slice(6) }
    return { kind: 'editor', path: safeDecode(tail) }
  }
  if (head === 'new') return { kind: 'editor' }
  if (head === 'demo') return { kind: 'editor', demo: true }
  if (head === 'moments') return { kind: 'moments' }
  if (head === 'settings') return { kind: 'settings' }
  return { kind: 'list' }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function navigate(route: Route): void {
  const hash =
    route.kind === 'list'
      ? '#/'
      : route.kind === 'moments'
        ? '#/moments'
        : route.kind === 'settings'
          ? '#/settings'
          : route.demo
            ? '#/demo'
            : route.path
              ? `#/edit/${encodeURIComponent(route.path)}`
              : route.draftId
                ? `#/edit/draft:${route.draftId}`
                : '#/new'
  if (window.location.hash === hash) return
  window.location.hash = hash
}

/* -------------------------------------------------------------------- App */

function Shell() {
  const { online } = useStore()
  const hash = useSyncExternalStore(subscribeHash, getHash, () => '')
  const route = parseHash(hash)

  /** 从列表点进来的对象先放进内存，避免编辑页再查一次 */
  const [pendingPost, setPendingPost] = useState<PostSummary | null>(null)
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null)
  const [editorKey, setEditorKey] = useState(0)

  const sw = useServiceWorker()

  // 直接以 #/edit/draft:xxx 打开（例如刷新页面）时，从 IndexedDB 恢复
  useEffect(() => {
    if (route.kind !== 'editor' || !route.draftId) return
    if (pendingDraft?.id === route.draftId) return
    void loadDraft(route.draftId).then((draft) => {
      if (draft) setPendingDraft(draft)
    })
  }, [route, pendingDraft?.id])

  const openPost = useCallback((post: PostSummary) => {
    setPendingDraft(null)
    setPendingPost(post)
    setEditorKey((k) => k + 1)
    navigate({ kind: 'editor', path: post.path })
  }, [])

  const openDraft = useCallback((draft: Draft) => {
    setPendingDraft(draft)
    setPendingPost(null)
    setEditorKey((k) => k + 1)
    navigate({ kind: 'editor', draftId: draft.id })
  }, [])

  const compose = useCallback(() => {
    setPendingDraft(null)
    setPendingPost(null)
    setEditorKey((k) => k + 1)
    navigate({ kind: 'editor' })
  }, [])

  const backToList = useCallback(() => {
    navigate({ kind: 'list' })
  }, [])

  return (
    <div className="app">
      {!online && <div className="offline-bar">离线模式：编辑会保存到本机，联网后再发布</div>}

      {sw.updateReady && (
        <div className="update-bar">
          <span>有新版本可用</span>
          <button
            type="button"
            className="btn small primary"
            onClick={() => sw.applyUpdate()}
          >
            立即更新
          </button>
          <button type="button" className="link-btn" onClick={() => sw.snooze()}>
            稍后
          </button>
        </div>
      )}

      {route.kind === 'list' && (
        <PostsScreen
          onOpen={openPost}
          onOpenDraft={openDraft}
          onCompose={compose}
          onDemo={() => {
            setPendingPost(null)
            setPendingDraft(null)
            setEditorKey((k) => k + 1)
            navigate({ kind: 'editor', demo: true })
          }}
          onMoments={() => navigate({ kind: 'moments' })}
          onSettings={() => navigate({ kind: 'settings' })}
        />
      )}

      {route.kind === 'moments' && (
        <MomentsScreen
          onBack={backToList}
          onSettings={() => navigate({ kind: 'settings' })}
        />
      )}

      {route.kind === 'settings' && <SettingsScreen onBack={backToList} />}

      {route.kind === 'editor' && (
        <EditorScreen
          key={editorKey}
          initial={pendingPost}
          initialDraft={pendingDraft}
          demo={route.demo}
          onExit={backToList}
          onPublished={() => {
            setPendingPost(null)
            setPendingDraft(null)
            // 让列表下次进入时重新拉取仓库（含刚发布的文章）
            window.setTimeout(() => setEditorKey((k) => k + 1), 0)
          }}
        />
      )}

      <ToastHost />
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
