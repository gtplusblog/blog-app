import { useState } from 'react'
import { useStore } from '../lib/store-context'
import { DEFAULT_SETTINGS } from '../types'
import type { Settings } from '../types'
import { actionsUrl, fetchRepo, invalidateCache, verifyToken } from '../lib/github'
import { listDrafts } from '../lib/drafts'
import { clearPostCache } from '../lib/post-cache'

interface Props {
  onBack: () => void
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; login: string; branch: string; private: boolean }
  | { kind: 'error'; message: string }

export function SettingsScreen({ onBack }: Props) {
  const { settings, updateSettings, pushToast, refreshTaxonomies, taxonomies } = useStore()
  const [showToken, setShowToken] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    updateSettings({ [key]: value } as Partial<Settings>)

  const runTest = async () => {
    if (!settings.token) {
      setTest({ kind: 'error', message: '请先填写 Token' })
      return
    }
    setTest({ kind: 'testing' })
    try {
      invalidateCache()
      const [user, repo] = await Promise.all([verifyToken(settings), fetchRepo(settings)])
      setTest({
        kind: 'ok',
        login: user.login,
        branch: repo.defaultBranch,
        private: repo.private,
      })
      pushToast('success', `连接成功：${repo.fullName}（分支 ${repo.defaultBranch}）`)
      void refreshTaxonomies()
    } catch (err) {
      const message = err instanceof Error ? err.message : '连接失败'
      setTest({ kind: 'error', message })
    }
  }

  const draftCount = async () => {
    try {
      return (await listDrafts()).length
    } catch {
      return 0
    }
  }

  return (
    <div className="screen settings-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          ←
        </button>
        <h1>设置</h1>
      </header>

      <section className="card">
        <h2>GitHub 访问</h2>
        <p className="muted small">
          需要一个 Fine-grained personal access token，只授权仓库{' '}
          <code>
            {settings.owner}/{settings.repo}
          </code>
          ，权限只需 <b>Contents: Read and write</b>。Token 只保存在本机浏览器里。
        </p>

        <div className="field">
          <div className="field-head">
            <label htmlFor="token">Token</label>
            <button type="button" className="link-btn" onClick={() => setShowToken((v) => !v)}>
              {showToken ? '隐藏' : '显示'}
            </button>
          </div>
          <input
            id="token"
            className="text-input"
            type={showToken ? 'text' : 'password'}
            value={settings.token}
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_… 或 ghp_…"
            onChange={(e) => set('token', e.target.value.trim())}
          />
        </div>

        <div className="row-2">
          <div className="field">
            <label htmlFor="owner">用户名 / 组织</label>
            <input
              id="owner"
              className="text-input"
              value={settings.owner}
              onChange={(e) => set('owner', e.target.value.trim())}
              autoCapitalize="off"
            />
          </div>
          <div className="field">
            <label htmlFor="repo">仓库名</label>
            <input
              id="repo"
              className="text-input"
              value={settings.repo}
              onChange={(e) => set('repo', e.target.value.trim())}
              autoCapitalize="off"
            />
          </div>
        </div>

        <button type="button" className="btn full" onClick={() => void runTest()}>
          {test.kind === 'testing' ? '正在测试…' : '测试连接'}
        </button>

        {test.kind === 'ok' && (
          <p className="result ok">
            ✓ 已登录 <b>{test.login}</b>，仓库分支 <code>{test.branch}</code>
            {test.private ? '（私有仓库）' : '（公开仓库）'}
          </p>
        )}
        {test.kind === 'error' && <p className="result error">✗ {test.message}</p>}

        <p className="muted small">
          生成 Token：
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            Fine-grained token
          </a>
          {' · '}
          <a
            href={`https://github.com/settings/tokens/new?scopes=repo&description=blog-app`}
            target="_blank"
            rel="noreferrer"
          >
            classic token（勾选 repo）
          </a>
        </p>
      </section>

      <section className="card">
        <h2>仓库路径</h2>
        <div className="field">
          <label htmlFor="postsDir">文章目录</label>
          <input
            id="postsDir"
            className="text-input"
            value={settings.postsDir}
            onChange={(e) => set('postsDir', e.target.value.trim())}
            autoCapitalize="off"
          />
        </div>
        <div className="field">
          <label htmlFor="imagesDir">图片目录</label>
          <input
            id="imagesDir"
            className="text-input"
            value={settings.imagesDir}
            onChange={(e) => set('imagesDir', e.target.value.trim())}
            autoCapitalize="off"
          />
          <p className="field-hint">
            Hugo 会把 <code>static/images/a.jpg</code> 发布到 <code>/images/a.jpg</code>
          </p>
        </div>
        <div className="field">
          <label htmlFor="momentsDir">碎碎念目录</label>
          <input
            id="momentsDir"
            className="text-input"
            value={settings.momentsDir}
            onChange={(e) => set('momentsDir', e.target.value.trim())}
            autoCapitalize="off"
          />
          <p className="field-hint">
            碎碎念存成 <code>data/moments/2026.json</code>，和工作台共用一个目录
          </p>
        </div>
        <div className="field">
          <label htmlFor="filePrefix">新文件名前缀</label>
          <input
            id="filePrefix"
            className="text-input"
            value={settings.filePrefix}
            onChange={(e) => set('filePrefix', e.target.value.trim())}
            autoCapitalize="off"
            placeholder="diary"
          />
          <p className="field-hint">
            生成的文件名形如 <code>diary20260927.md</code>，与现有习惯一致
          </p>
        </div>
        <div className="field">
          <label htmlFor="siteUrl">博客地址</label>
          <input
            id="siteUrl"
            className="text-input"
            value={settings.siteUrl}
            onChange={(e) => set('siteUrl', e.target.value.trim())}
            autoCapitalize="off"
            placeholder="https://gtplusblog.github.io/"
          />
          <p className="field-hint">用于拼图片链接、抓取分类标签候选、跳转文章页面</p>
        </div>
      </section>

      <section className="card">
        <h2>外观</h2>
        <div className="segmented">
          {(
            [
              ['auto', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={settings.theme === value ? 'active' : ''}
              onClick={() => set('theme', value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>文章列表缓存</h2>
        <p className="muted small">
          标题 / 日期 / 分类会缓存在本机，打开 App 时先用缓存秒开，再在后台按 git
          的变化增量刷新 —— 只重新解析改动过的文章，没变的直接复用。
        </p>
        <button
          type="button"
          className="btn full"
          onClick={() => {
            void clearPostCache().then(() =>
              pushToast('info', '缓存已清除，下次进入列表会全量读取一次'),
            )
          }}
        >
          清除文章列表缓存
        </button>
      </section>

      <section className="card">
        <h2>分类 / 标签候选</h2>
        <p className="muted small">
          {taxonomies.fetchedAt
            ? `已抓取 ${taxonomies.categories.length} 个分类、${taxonomies.tags.length} 个标签`
            : '尚未抓取（发布过文章后会从博客页面读取）'}
        </p>
        <button type="button" className="btn full" onClick={() => void refreshTaxonomies()}>
          立即刷新候选
        </button>
      </section>

      <section className="card">
        <h2>其他</h2>
        <div className="btn-col">
          <a
            className="btn"
            href={actionsUrl(settings)}
            target="_blank"
            rel="noreferrer"
          >
            查看 GitHub Actions 构建
          </a>
          <a className="btn" href={settings.siteUrl} target="_blank" rel="noreferrer">
            打开博客首页
          </a>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void draftCount().then((n) => pushToast('info', `本机有 ${n} 条草稿`))
            }}
          >
            查看本机草稿数量
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              if (!window.confirm('恢复默认设置？Token 也会被清空。')) return
              updateSettings({ ...DEFAULT_SETTINGS, token: '' })
              invalidateCache()
              pushToast('info', '已恢复默认设置')
            }}
          >
            恢复默认设置
          </button>
        </div>
      </section>

      <p className="footer-note">
        GUTUN 博客写作 · 直接向 <code>{settings.repo}</code> 提交 Markdown，
        GitHub Actions 自动构建 GitHub Pages
      </p>
    </div>
  )
}
