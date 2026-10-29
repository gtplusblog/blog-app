/**
 * 碎碎念（短句）读写。
 *
 * 存储与博客工作台（studio/server/moments.mjs）保持完全一致：
 *   data/moments/<年份>.json
 *   [
 *     {"id":"20261024-113900","date":"2026-10-24T11:39:00+08:00","text":"今天天气很好"},
 *     {"id":"20261023-220100","date":"2026-10-23T22:01:00+08:00","text":"……"}
 *   ]
 *
 * 规则：一条一行、字段顺序固定 id/date/text、换行统一 LF、文件内按时间倒序。
 * 每次发布只会追加（或删掉）一行，GitHub 上的 diff 很好读。
 */
import {
  GitHubError,
  listBlobPaths,
  readFileContents,
  readFileWithSha,
  writeTextFile,
} from './github.ts'
import { toHugoDate } from '../types.ts'
import type { Settings } from '../types.ts'

/** 一条碎碎念的字数上限，与输入框保持一致 */
export const MOMENT_MAX_LENGTH = 500

export interface Moment {
  id: string
  /** 带时区偏移的时间，例如 2026-10-24T11:39:00+08:00 */
  date: string
  text: string
  /** 年份，取自 date 前 4 位 */
  year: string
  /** 所在文件，例如 data/moments/2026.json */
  file: string
}

export interface StoredMoment {
  id: string
  date: string
  text: string
}

export function momentsDirOf(settings: Settings): string {
  return (settings.momentsDir || 'data/moments').replace(/^\/+|\/+$/g, '')
}

export function momentPathFor(settings: Settings, year: string): string {
  return `${momentsDirOf(settings)}/${year}.json`
}

/* ------------------------------------------------------------------ 序列化 */

/** 与 Studio 完全相同的输出：一条一行，数组缩进两个空格，结尾换行 */
export function serializeMoments(entries: StoredMoment[]): string {
  if (entries.length === 0) return '[]\n'
  const lines = entries.map(
    (entry) => `  ${JSON.stringify({ id: entry.id, date: entry.date, text: entry.text })}`,
  )
  return `[\n${lines.join(',\n')}\n]\n`
}

/** 解析一个年份文件；格式不对时抛出可读的错误 */
export function parseMoments(raw: string, file = 'moments.json'): StoredMoment[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`${file} 不是合法的 JSON（${(error as Error).message}）`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} 应该是一个数组`)
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`${file} 第 ${index + 1} 条不是对象`)
    }
    const record = item as Record<string, unknown>
    const text = String(record.text ?? '').trim()
    if (!text) throw new Error(`${file} 第 ${index + 1} 条缺少 text`)
    const date = String(record.date ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) {
      throw new Error(`${file} 第 ${index + 1} 条的 date 格式不对：${date || '（空）'}`)
    }
    return { id: String(record.id ?? '').trim(), date, text }
  })
}

/** 20261024-113900，同秒重复时追加 -2、-3 */
export function momentIdFor(iso: string, taken: Iterable<string> = []): string {
  const digits = iso.replace(/[^0-9]/g, '').slice(0, 14)
  const base = `${digits.slice(0, 8)}-${digits.slice(8, 14)}`
  const used = new Set(taken)
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

/** 时间倒序；同一秒内 id 大的在前，保证结果稳定 */
export function sortMoments<T extends { date: string; id: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const diff = Date.parse(b.date) - Date.parse(a.date)
    if (diff !== 0) return diff
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

/* -------------------------------------------------------------------- 读写 */

/** 读取全部年份的碎碎念，按时间倒序 */
export async function listMoments(settings: Settings): Promise<Moment[]> {
  const files = (await listBlobPaths(settings, momentsDirOf(settings))).filter((file) =>
    /\/\d{4}\.json$/.test(file.path),
  )
  if (files.length === 0) return []

  const contents = await readFileContents(settings, files.map((file) => file.path))
  const missing = files.filter((file) => !contents.has(file.path))
  if (missing.length > 0 && missing.length === files.length) {
    // 全部读不到 ≠ 一条都没有：让用户看到真实的错误，而不是空列表
    throw new Error('读取碎碎念失败：连不上 GitHub，检查网络后重试')
  }
  const all: Moment[] = []
  for (const file of files) {
    const raw = contents.get(file.path)
    if (!raw) continue
    let entries: StoredMoment[]
    try {
      entries = parseMoments(raw, file.path)
    } catch {
      // 某一年文件坏了不该让整页打不开
      continue
    }
    for (const entry of entries) {
      all.push({ ...entry, year: entry.date.slice(0, 4), file: file.path })
    }
  }
  return sortMoments(all)
}

/**
 * 写之前重新读一次：内容与 sha 来自同一次 API 调用。
 * 解析失败直接抛出 —— 宁可报错，也不要用空数组把已有内容覆盖掉。
 */
async function readYearForWrite(
  settings: Settings,
  path: string,
): Promise<{ entries: StoredMoment[]; sha: string | null }> {
  const existing = await readFileWithSha(settings, path)
  if (!existing) return { entries: [], sha: null }
  return { entries: parseMoments(existing.text, path), sha: existing.sha }
}

/**
 * 读 → 改 → 写。
 * 遇到 409（同一秒里别处也动过这个文件）就重新读一次再试一次，
 * 这样手机上点一下重发就能成功，不会卡在「sha 冲突」里。
 */
async function updateYear(
  settings: Settings,
  path: string,
  mutate: (entries: StoredMoment[]) => StoredMoment[],
  message: string,
): Promise<{ entries: StoredMoment[]; sha: string }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { entries, sha } = await readYearForWrite(settings, path)
    const next = mutate(entries)
    try {
      const written = await writeTextFile(settings, path, serializeMoments(next), { sha, message })
      return { entries: next, sha: written.sha }
    } catch (error) {
      lastError = error
      const conflict = error instanceof GitHubError && (error.status === 409 || error.status === 422)
      if (attempt === 0 && conflict) continue
      throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('写入碎碎念失败，请稍后重试')
}

/** 追加一条碎碎念，返回新条目与提交信息 */
export async function postMoment(
  settings: Settings,
  text: string,
  when: Date = new Date(),
): Promise<{ moment: Moment; path: string; sha: string }> {
  const content = text.trim()
  if (!content) throw new Error('碎碎念内容不能为空')
  if (content.length > MOMENT_MAX_LENGTH) {
    throw new Error(`一条碎碎念最多 ${MOMENT_MAX_LENGTH} 个字（当前 ${content.length}）`)
  }

  const date = toHugoDate(when)
  const year = date.slice(0, 4)
  const path = momentPathFor(settings, year)
  const holder: { entry: StoredMoment | null } = { entry: null }

  const { sha } = await updateYear(
    settings,
    path,
    (entries) => {
      const entry: StoredMoment = {
        id: momentIdFor(
          date,
          entries.map((item) => item.id),
        ),
        date,
        text: content,
      }
      holder.entry = entry
      return sortMoments([...entries, entry])
    },
    `moment: ${year} 新增一条碎碎念`,
  )

  const entry = holder.entry
  if (!entry) throw new Error('没能生成这条碎碎念，请重试')
  return { moment: { ...entry, year, file: path }, path, sha }
}

/** 删除一条碎碎念 */
export async function removeMoment(
  settings: Settings,
  moment: Moment,
): Promise<{ path: string; sha: string }> {
  const path = moment.file || momentPathFor(settings, moment.year)
  const { sha } = await updateYear(
    settings,
    path,
    (entries) => {
      const next = entries.filter((entry) => entry.id !== moment.id)
      if (next.length === entries.length) throw new Error('这条碎碎念已经不在文件里了，刷新看看')
      return next
    },
    `moment: ${moment.year} 删除一条碎碎念`,
  )
  return { path, sha }
}
