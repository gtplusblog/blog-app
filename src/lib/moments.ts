/**
 * 动态（短句）读写。
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
import { fileExists, listBlobPaths, readFileContents, writeTextFile } from './github.ts'
import { toHugoDate } from '../types.ts'
import type { Settings } from '../types.ts'

/** 一条动态的字数上限，与输入框保持一致 */
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

/** 读取全部年份的动态，按时间倒序 */
export async function listMoments(settings: Settings): Promise<Moment[]> {
  const files = (await listBlobPaths(settings, momentsDirOf(settings))).filter((file) =>
    /\/\d{4}\.json$/.test(file.path),
  )
  if (files.length === 0) return []

  const contents = await readFileContents(settings, files.map((file) => file.path))
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

async function readYear(settings: Settings, path: string): Promise<StoredMoment[]> {
  const contents = await readFileContents(settings, [path])
  const raw = contents.get(path)
  if (!raw) return []
  return parseMoments(raw, path)
}

/** 追加一条动态，返回新条目与提交信息 */
export async function postMoment(
  settings: Settings,
  text: string,
  when: Date = new Date(),
): Promise<{ moment: Moment; path: string; sha: string }> {
  const content = text.trim()
  if (!content) throw new Error('动态内容不能为空')
  if (content.length > MOMENT_MAX_LENGTH) {
    throw new Error(`一条动态最多 ${MOMENT_MAX_LENGTH} 个字（当前 ${content.length}）`)
  }

  const date = toHugoDate(when)
  const year = date.slice(0, 4)
  const path = momentPathFor(settings, year)
  const entries = await readYear(settings, path)
  const entry: StoredMoment = {
    id: momentIdFor(date, entries.map((item) => item.id)),
    date,
    text: content,
  }
  const next = sortMoments([...entries, entry])
  const sha = await fileExists(settings, path)
  const written = await writeTextFile(settings, path, serializeMoments(next), {
    sha,
    message: `moment: ${year} 新增一条动态`,
  })
  return { moment: { ...entry, year, file: path }, path, sha: written.sha }
}

/** 删除一条动态 */
export async function removeMoment(
  settings: Settings,
  moment: Moment,
): Promise<{ path: string; sha: string }> {
  const path = moment.file || momentPathFor(settings, moment.year)
  const entries = await readYear(settings, path)
  const next = entries.filter((entry) => entry.id !== moment.id)
  if (next.length === entries.length) throw new Error('这条动态已经不在文件里了，刷新看看')
  const sha = await fileExists(settings, path)
  const written = await writeTextFile(settings, path, serializeMoments(next), {
    sha,
    message: `moment: ${moment.year} 删除一条动态`,
  })
  return { path, sha: written.sha }
}
