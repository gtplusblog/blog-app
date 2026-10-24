import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store-context'
import { listMoments, MOMENT_MAX_LENGTH, postMoment, removeMoment } from '../lib/moments'
import type { Moment } from '../lib/moments'

interface Props {
  onBack: () => void
  onSettings: () => void
}

function timeOf(date: string): string {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date.slice(11, 16)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayOf(date: string): string {
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date.slice(5, 10).replace('-', '.')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}

export function MomentsScreen({ onBack, onSettings }: Props) {
  const { settings, pushToast } = useStore()
  const [moments, setMoments] = useState<Moment[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const configured = Boolean(settings.token && settings.owner && settings.repo)

  const refresh = useCallback(async () => {
    if (!configured) return
    setLoading(true)
    setError(null)
    try {
      setMoments(await listMoments(settings))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取碎碎念失败')
    } finally {
      setLoading(false)
    }
  }, [configured, settings])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`
  }, [text])

  const submit = async () => {
    const content = text.trim()
    if (!content || posting) return
    setPosting(true)
    try {
      const { moment } = await postMoment(settings, content, new Date())
      setText('')
      setMoments((prev) => [moment, ...prev])
      pushToast('success', '已经发布，等 GitHub 构建完就会出现在博客上')
      // GitHub 构建需要几十秒；稍后再拉一次，拿到真实顺序
      window.setTimeout(() => void refresh(), 4000)
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : '发布失败')
    } finally {
      setPosting(false)
    }
  }

  const remove = async (moment: Moment) => {
    if (!window.confirm(`删除「${moment.text.slice(0, 24)}…」这条碎碎念？`)) return
    try {
      await removeMoment(settings, moment)
      setMoments((prev) => prev.filter((item) => item.id !== moment.id))
      pushToast('success', '已删除')
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : '删除失败')
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Moment[]>()
    for (const moment of moments) {
      const key = moment.year
      const list = map.get(key) ?? []
      list.push(moment)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [moments])

  return (
    <div className="screen moments-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          ←
        </button>
        <h1>碎碎念</h1>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void refresh()}
            aria-label="刷新"
            disabled={!configured || loading}
          >
            {loading ? '…' : '⟳'}
          </button>
        </div>
      </header>

      {!configured && (
        <div className="notice">
          <p>还没有配置 GitHub 访问令牌，暂时不能发碎碎念。</p>
          <div className="notice-actions">
            <button type="button" className="btn primary" onClick={onSettings}>
              去设置
            </button>
          </div>
        </div>
      )}

      <section className="card moment-compose">
        <textarea
          ref={inputRef}
          className="moment-input"
          value={text}
          maxLength={MOMENT_MAX_LENGTH}
          placeholder="此刻想说的一句话…"
          onChange={(event) => setText(event.target.value)}
          disabled={!configured}
        />
        <div className="moment-compose-foot">
          <span className={`moment-count ${text.length > MOMENT_MAX_LENGTH - 40 ? 'tight' : ''}`}>
            {text.length} / {MOMENT_MAX_LENGTH}
          </span>
          <button
            type="button"
            className="btn primary small"
            onClick={() => void submit()}
            disabled={!configured || posting || !text.trim()}
          >
            {posting ? '发布中…' : '发布'}
          </button>
        </div>
      </section>

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

      {moments.length === 0 && !loading && !error && configured && (
        <p className="muted center">还没有碎碎念，写第一句吧</p>
      )}

      {groups.map(([year, items]) => (
        <section className="list-section" key={year}>
          <h2 className="section-title">
            {year} <span className="badge">{items.length}</span>
          </h2>
          {items.map((moment) => (
            <div className="moment-row" key={moment.id}>
              <div className="moment-when">
                <strong>{timeOf(moment.date)}</strong>
                <span>{dayOf(moment.date)}</span>
              </div>
              <p className="moment-text">{moment.text}</p>
              <button
                type="button"
                className="icon-btn danger small"
                aria-label="删除"
                onClick={() => void remove(moment)}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      ))}

      <p className="footer-note">
        {moments.length > 0 ? `共 ${moments.length} 条 · 存放在 ` : '存放在 '}
        <code>{settings.momentsDir || 'data/moments'}/</code>
        {' · '}
        <a href={`${settings.siteUrl.replace(/\/$/, '')}/moments/`} target="_blank" rel="noreferrer">
          打开碎碎念页
        </a>
      </p>
    </div>
  )
}
