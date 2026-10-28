// 块 5（施工计划 E）：对局记忆，放在 $DSH_HOME/dsh-riichi/（调研 §1.4）。
// - games/<时间>-<房间码>.json：终局后才写（对局中绝不写牌山和别家手牌，她有文件工具，读到就等于作弊）
// - notes.md：她的牌桌笔记，整份最多 5 条，只能整份改写（riichi_note），不往下追加
// - persona.md：她的牌桌人设卡（开局时写的，下次没给就用这份）
// 不碰她自己的记忆目录；插件不猜别人的记忆体系。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MAX_NOTES = 5
const MAX_NOTE_CHARS = 200

export function defaultDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-riichi')
}

/** 笔记文本 → 条目：按行，去掉开头的 “- / * / 1. / 1、” 这类记号，空行不算。 */
export function splitNotes(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)）])\s*/, '').trim()).filter(Boolean)
}

export class Memory {
  constructor(dir = defaultDir()) { this.dir = dir }

  file(name) { return path.join(this.dir, name) }

  read(name) {
    try { return fs.readFileSync(this.file(name), 'utf8') } catch { return '' }
  }

  write(name, text) {
    fs.mkdirSync(path.dirname(this.file(name)), { recursive: true })
    const tmp = this.file(name) + '.tmp'
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, this.file(name))
  }

  notes() { return splitNotes(this.read('notes.md')) }

  notesText() {
    const n = this.notes()
    return n.length ? n.map((x, i) => `${i + 1}. ${x}`).join('\n') : ''
  }

  /** 整份改写。超过 5 条、单条太长都拒收，原文件不动。 */
  setNotes(text) {
    const items = splitNotes(text)
    if (items.length > MAX_NOTES) return { ok: false, error: `笔记最多 ${MAX_NOTES} 条，你写了 ${items.length} 条。合并或删掉一些再改写。` }
    const long = items.find((x) => x.length > MAX_NOTE_CHARS)
    if (long) return { ok: false, error: `每条最多 ${MAX_NOTE_CHARS} 字，这条太长：${long.slice(0, 30)}…` }
    this.write('notes.md', items.map((x) => `- ${x}`).join('\n') + (items.length ? '\n' : ''))
    return { ok: true, items }
  }

  persona() { return this.read('persona.md').trim() }
  setPersona(text) { this.write('persona.md', String(text).trim() + '\n') }

  /** 终局（或中止）后存一份。room 已经结束，完整牌谱这时才可以写盘。 */
  saveGame(room, extra = {}) {
    const t = new Date(room.createdAt)
    const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`
    const name = `games/${stamp}-${room.code}.json`
    const data = {
      code: room.code, createdAt: room.createdAt, endedAt: room.endedAt, status: room.status,
      settings: { ...room.settings, persona: undefined }, names: room.names, kinds: room.seatInfo.map((s) => s.kind),
      result: room.result, hands: room.hands, events: room.events, chat: room.chatLog,
      paipu: room.status === 'ended' ? room.paipu : null, ...extra,
    }
    this.write(name, JSON.stringify(data, null, 1))
    return name
  }

  /** 最近几场的一句话战绩（新的在前）。seat = 她坐的座位号。 */
  recentGames(n = 3, seat = 0) {
    let files = []
    try { files = fs.readdirSync(this.file('games')).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, n) } catch { return [] }
    const out = []
    for (const f of files) {
      try {
        const g = JSON.parse(fs.readFileSync(this.file(`games/${f}`), 'utf8'))
        const when = new Date(g.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        if (!g.result) { out.push(`${when} ${g.settings.length}战 中止`); continue }
        const order = [0, 1, 2, 3].sort((a, b) => g.result.rank[a] - g.result.rank[b])
        const me = g.agentSeat ?? seat // 联机坐进别人的桌时她不一定是 0 号（块 8 存档里记着）
        out.push(`${when} ${g.settings.length}战${g.joined ? '（联机）' : ''}：你（${g.names[me]}）第 ${g.result.rank[me]} 位 ${g.result.defen[me]}；${order.map((id) => `${g.result.rank[id]}位 ${g.names[id]}`).join(' / ')}`)
      } catch {}
    }
    return out
  }
}
