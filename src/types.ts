/** GitHub 仓库与访问令牌等本地设置 */
export interface Settings {
  /** Fine-grained PAT，需对目标仓库授予 Contents: Read and write */
  token: string
  /** 仓库所有者，例如 gtplusblog */
  owner: string
  /** 仓库名，例如 gtplusblog.github.io */
  repo: string
  /** 文章所在目录，默认 content/posts */
  postsDir: string
  /** 图片所在目录，默认 static/images */
  imagesDir: string
  /** 动态（短句）所在目录，默认 data/moments */
  momentsDir: string
  /** 文章文件名前缀，默认 posts */
  filePrefix: string
  /** 博客线上地址，用于图片链接与「查看站点」 */
  siteUrl: string
  /** 主题：跟随系统 / 亮 / 暗 */
  theme: 'auto' | 'light' | 'dark'
}

export const DEFAULT_SETTINGS: Settings = {
  token: '',
  owner: 'gtplusblog',
  repo: 'gtplusblog.github.io',
  postsDir: 'content/posts',
  imagesDir: 'static/images',
  momentsDir: 'data/moments',
  filePrefix: 'posts',
  siteUrl: 'https://gtplusblog.github.io/',
  theme: 'auto',
}

/**
 * 一篇文章的 front matter。
 * 字段顺序与 `gtplusblog.github.io/archetypes/posts.md` 保持一致，
 * 因此 APP 生成的文件与 `hugo new posts/xxx.md` 的结果几乎完全相同。
 */
export interface FrontMatter {
  title: string
  subtitle: string
  date: string
  slug: string
  draft: boolean
  author: { name: string; link: string; email: string; avatar: string }
  description: string
  keywords: string[]
  license: string
  comment: boolean
  weight: number
  tags: string[]
  categories: string[]
  hiddenFromHomePage: boolean
  hiddenFromSearch: boolean
  hiddenFromRelated: boolean
  hiddenFromFeed: boolean
  summary: string
  toc: boolean
  math: boolean
  lightgallery: boolean
  password: string
  message: string
  repost: { enable: boolean; url: string }
  /** 原文件中存在、但 APP 未建模的字段（如 collections），解析时保留、生成时回写 */
  extra: Record<string, unknown>
}

export function createEmptyFrontMatter(now = new Date()): FrontMatter {
  return {
    title: '',
    subtitle: '',
    date: toHugoDate(now),
    slug: randomSlug(),
    draft: false,
    author: { name: 'GUTUN', link: '', email: '', avatar: '' },
    description: '',
    keywords: [],
    license: '',
    comment: false,
    weight: 0,
    tags: [],
    categories: [],
    hiddenFromHomePage: false,
    hiddenFromSearch: false,
    hiddenFromRelated: false,
    hiddenFromFeed: false,
    summary: '',
    toc: true,
    math: false,
    lightgallery: false,
    password: '',
    message: '',
    repost: { enable: true, url: '' },
    extra: {},
  }
}

/** 拆开的一篇 Markdown 文档 */
export interface PostDoc {
  frontMatter: FrontMatter
  body: string
}

/** 仓库中的一篇文章（列表项） */
export interface PostSummary {
  /** 仓库内完整路径，例如 content/posts/diary20260927.md */
  path: string
  /** 文件名（不含目录），例如 diary20260927.md */
  name: string
  /** git blob sha，用于更新时避免冲突 */
  sha: string
  /** 列表页轻量展示用的标题（解析自 front matter title） */
  title: string
  date: string
  /** 是否已解析过完整 front matter */
  loaded: boolean
}

/** 一篇文章的完整内容（列表 → 编辑时按需加载） */
export interface PostFile extends PostSummary {
  content: string
}

export interface GitHubUser {
  login: string
  name?: string | null
  avatar_url?: string
}

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
  /** 可选的第二个动作按钮 */
  action?: { label: string; href: string }
}

/** 7 位小写十六进制 slug，与 Hugo 的 `.File.UniqueID` 前 7 位风格一致 */
export function randomSlug(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 7)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 输出 Hugo 使用的带时区偏移时间，例如 2026-09-27T21:00:34+08:00 */
export function toHugoDate(d: Date): string {
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 与 toHugoDate 互逆，用于把已有文章的时间填进 datetime-local 输入框 */
export function parseHugoDate(value: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function toDateTimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 折叠 base64 到 60 字符一行，符合 GitHub Contents API 对 blob 的要求 */
export function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64DecodeUtf8(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function wrapBase64(b64: string): string {
  return b64.replace(/(.{60})/g, '$1\n')
}
