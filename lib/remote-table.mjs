// 块 8：联机时朋友那边的“牌桌镜像”。牌桌（Room）在房主的电脑上，这边只有自己座位的事件流（SeatClient）。
// 把收到的事件攒成 SessionLink、赛后回顾、存战绩要用的那几样东西，字段名和形状跟 Room 一样，
// 所以 lib/session-link.mjs、index.mjs 的 reviewPrompt、lib/memory.mjs 不用分两套。
// 只用这个座位本来就看得到的东西（座位视角 view、公开的 room/lobby、聊天、终局分数）。
import { windSentence, familiesSentence } from './room.mjs'
import { tileName } from './tiles.mjs'

// riichi_join：入座请求等多久；入座后连不上房主的牌桌超过多久就放弃这一桌（房主那边多半关了）。测试里会改小
export const JOIN = { maxOfflineMs: 10 * 60_000, timeoutMs: 8000 }

export class RemoteTable {
  /**
   * @param {object} o
   * @param {import('./seat-client.mjs').SeatClient} o.client 她的座位客户端（连着房主的牌桌）
   * @param {string} o.code 房间码
   * @param {number} o.seatId 她的座位号
   */
  constructor({ client, code, seatId, logger = console }) {
    Object.assign(this, { code, seatId, logger })
    this.names = []
    this.status = 'lobby'
    this.settings = {}
    this.seatInfo = []
    this.families = []
    this.chatLog = []
    this.events = [] // 只记和了、流局、终局（赛后回顾用）
    this.result = null
    this.hands = 0
    this.createdAt = Date.now()
    this.endedAt = null
    this.view = null
    this.winds0 = null // 开局前的风位（房主那边按起家算好的，sync 里带着）
    this.chatHooks = new Set()
    this.momentHooks = new Set()
    this.endHooks = new Set()
    client.hooks.add((type, data) => this.onEvent(type, data))
  }

  onEvent(type, d) {
    if (type === 'sync') {
      if (d.room) this.applyRoom(d.room)
      if (d.lobby) this.applyLobby(d.lobby)
      if (d.view) this.applyView(d.view)
      this.chatLog = (d.chat || []).slice() // 重连时整份换掉，不重复转给她
    } else if (type === 'lobby') {
      this.applyLobby(d)
    } else if (type === 'msg') {
      if (d.view) this.applyView(d.view)
      this.onMsg(d.msg)
    } else if (type === 'chat') {
      this.chatLog.push(d)
      if (this.chatLog.length > 200) this.chatLog.shift()
      for (const f of this.chatHooks) { try { f(d) } catch (e) { this.logger.warn?.('riichi remote chat hook', e) } }
    } else if (type === 'end') {
      this.endedAt = Date.now()
      if (d.aborted) {
        this.status = 'aborted'
        this.abortReason = d.reason
      } else {
        this.status = 'ended'
        if (d.names) this.names = d.names.slice()
        this.result = { defen: d.defen, rank: d.rank, point: d.point, names: this.names }
        const order = [0, 1, 2, 3].sort((a, b) => d.rank[a] - d.rank[b])
        this.events.push({ t: Date.now(), text: '终局：' + order.map((id) => `${d.rank[id]}位 ${this.names[id]} ${d.defen[id]}（${d.point[id]}）`).join(' / ') })
      }
      for (const f of this.endHooks) { try { f(this) } catch (e) { this.logger.warn?.('riichi remote end hook', e) } }
    }
  }

  applyRoom(r) {
    this.status = r.status
    this.names = r.names.slice()
    this.settings = r.settings || {}
    this.families = r.families || []
    this.winds0 = r.winds || null
    this.hands = r.hands || 0
    this.seatInfo = r.kinds.map((kind, i) => ({ kind, color: r.colors?.[i], name: r.names[i] }))
  }

  applyLobby(l) {
    this.lobby = l
    this.status = l.status
    this.names = l.seats.map((s) => s.name)
    this.seatInfo = l.seats.map((s) => ({ kind: s.kind, color: s.color, name: s.name }))
    if (l.families) this.families = l.families
  }

  applyView(v) {
    this.view = v
    if (v.families) this.families = v.families
    if (v.phase === 'playing') this.status = 'playing'
  }

  idAt(l) { return this.view?.seats?.[l]?.id }

  onMsg(m) {
    if (!m) return
    const me = this.view?.me
    if (m.kaiju) this.moment({ type: 'start' })
    else if (m.qipai) this.hands++
    else if (m.dapai && m.dapai.p.includes('*') && m.dapai.l === me) this.moment({ type: 'lizhi', id: this.seatId, tile: tileName(m.dapai.p.slice(0, 2)) })
    else if (m.hule) {
      const h = m.hule
      const id = this.idAt(h.l), from = h.baojia == null ? null : this.idAt(h.baojia)
      const yaku = (h.hupai || []).map((x) => x.name).join('、')
      this.events.push({ t: Date.now(), text: `${this.names[id]} ${from == null ? '自摸' : `荣和 ${this.names[from]}`}，${h.defen} 点（${yaku}）` })
      this.moment({ type: 'hule', id, from, defen: h.defen, yaku })
    } else if (m.pingju) this.events.push({ t: Date.now(), text: `流局：${m.pingju.name}` })
  }

  moment(m) {
    for (const f of this.momentHooks) { try { f(m) } catch (e) { this.logger.warn?.('riichi remote moment hook', e) } }
  }

  /** 和 Room.publicInfo() 同名的几项（SessionLink 用 names、defen、families）。 */
  publicInfo() {
    let defen = null
    if (this.view?.phase === 'playing') {
      defen = []
      for (const s of this.view.seats) defen[s.id] = s.defen
    }
    return { code: this.code, status: this.status, names: this.names, defen, families: this.families, settings: this.settings }
  }

  windText(seatId) {
    const v = this.view
    let w = this.winds0
    if (v?.phase === 'playing') {
      const feng = []
      for (const s of v.seats) feng[s.id] = s.feng
      w = { round: `${v.round} ${v.changbang}本场`, dealer: v.seats[0].id, feng }
    }
    return w ? windSentence(w, this.names, seatId) : '风位还不知道（等房主那边开局）'
  }

  familiesText() { return familiesSentence(this.families) }
}
