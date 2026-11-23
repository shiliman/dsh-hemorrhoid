/**
 * 落盘：原子写 + 读写容错。
 *
 * 所有失败都不抛给调用方（插件坏掉不该拖垮会话），但要留日志。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export function readJson(file, fallback, logger) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] 读 ${file} 失败：${e?.message ?? e}`)
    return fallback
  }
}

export function writeJsonAtomic(file, obj, logger) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] 写 ${file} 失败：${e?.message ?? e}`)
    try {
      writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }
}

export function writeTextAtomic(file, text, logger) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, String(text ?? ''), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    logger?.warn?.(`[dsh-hemorrhoid] 写 ${file} 失败：${e?.message ?? e}`)
    return false
  }
}

/** 会话 id 变成安全文件名（只留字母数字与 - _）。 */
export function safeSid(sid) {
  const s = String(sid || 'default').replace(/[^A-Za-z0-9_-]/g, '_')
  return s.slice(0, 120) || 'default'
}

export function sessionsDir(baseDir) {
  return join(baseDir, 'sessions')
}

export function sessionFile(baseDir, sid) {
  return join(sessionsDir(baseDir), `${safeSid(sid)}.json`)
}

export function listSessionFiles(baseDir) {
  const dir = sessionsDir(baseDir)
  const out = []
  try {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      let mtime = 0
      try {
        mtime = statSync(file).mtimeMs
      } catch {}
      out.push({ file, name, mtime })
    }
  } catch {}
  return out
}

/** 历史只留最后 max 条。 */
export function pushHistory(history, entry, max) {
  const list = Array.isArray(history) ? history.slice() : []
  list.push(entry)
  const cap = Math.max(20, Number(max) || 300)
  return list.length > cap ? list.slice(list.length - cap) : list
}
