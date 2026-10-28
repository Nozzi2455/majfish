// 一张牌桌：持有 majiang-core 的 Game、房间码、座位令牌。
// 每个座位只拿得到引擎发给它的那份消息（别家手牌、别家摸到的牌引擎已经清空，core/lib/game.js qipai()/zimo()），
// 完整牌谱只在本进程内存里。
import crypto from 'node:crypto'
import { ShadowAI, botClass, sameReply, Majiang } from './shadow.mjs'
import { tileName, mianziName, roundName, FENG, yakuName, pingjuName } from './tiles.mjs'
// 整局聊天都留着（存战绩、做视频要用）。10-29 实测：一个东风战聊了 200 多条，只留 200 条时开头 18 分钟的聊天丢了。
const CHAT_KEEP = 3000

const token = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url')
// 房间码：去掉易混的 0/O/1/I，6 位约 10^9 种
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export function roomCode() {
  let s = ''
  for (const b of crypto.randomBytes(6)) s += CODE_CHARS[b % CODE_CHARS.length]
  return s
}

export const RULE_PRESETS = {
  // majiang-core 的默认规则已对上雀魂（调研 §3.2），这里只覆盖局数
  雀魂: {},
  天凤: { 'ダブル役満あり': false },
}

// graceMs：事件流断开多久算掉线（之后由机器人代打）。
// pollGraceMs：命令行客户端（外部 agent，cli/riichi-seat.mjs）是“等到轮到我 → 退出 → 想 → 再出牌”，两次之间本来就不连着，
// 轮到它以后 5 分钟没动静才算掉线（房间设了限时的话照样按限时代打那一手）。测试里会改小。
export const TIMING = { graceMs: 20_000, pollGraceMs: 300_000 }

// 昵称颜色：牌桌底色是深绿，太暗的颜色看不清，往白色里调亮到够用（WCAG 相对亮度 ≥ 0.28）。
export const DEFAULT_COLORS = { agent: '#5ec8f2', human: '#ffb454', remote: '#c792ea', bot: ['#b8c4b8', '#c9bfa6', '#a9bccb'] }
export function normalizeColor(c, fallback) {
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c ?? '').trim())
  if (!m) return fallback
  let hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1]
  let rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const lum = (v) => v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0)
  for (let k = 0; k < 20 && lum(rgb) < 0.28; k++) rgb = rgb.map((x) => Math.round(x + (255 - x) * 0.15))
  return '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('')
}
export const cleanName = (n, fallback) => String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || fallback

/** 牌河一张：'m1_*-' 这类 → 显示用对象。 */
function heTile(p) {
  return { p: p.slice(0, 2), name: tileName(p), tsumogiri: p.includes('_'), lizhi: p.includes('*'), called: /[\+\=\-]$/.test(p) }
}

/** Shoupai 对象 → 手牌（按 万筒索字排好，摸到的那张单列）。 */
function handView(sp) {
  const tiles = []
  for (const s of ['m', 'p', 's', 'z']) {
    const b = sp._bingpai[s]
    for (let n = 1; n < b.length; n++) {
      let c = b[n]
      if (s !== 'z' && n === 5) {
        for (let k = 0; k < b[0]; k++) { tiles.push(s + '0'); c-- }
      }
      for (let k = 0; k < c; k++) tiles.push(s + n)
    }
  }
  let zimo = null
  if (sp._zimo && sp._zimo.length === 2) {
    const i = tiles.lastIndexOf(sp._zimo)
    if (i >= 0) { tiles.splice(i, 1); zimo = sp._zimo }
  }
  return {
    tiles: tiles.map((p) => ({ p, name: tileName(p) })),
    zimo: zimo && { p: zimo, name: tileName(zimo) },
    fulou: sp._fulou.map((m) => ({ m, name: mianziName(m) })),
    lizhi: !!sp.lizhi,
  }
}

/**
 * 听牌提示（主人 10-28 实测：“听牌没有提示听的什么牌”）。只用这个座位自己看得到的东西：自己的手牌、
 * 四家牌河、四家副露、宝牌指示牌，算出每张听的牌还剩几枚（别人手里的看不到，算在“剩”里）。
 */
const norm = (p) => p[0] + (p[1] === '0' ? '5' : p[1])
function visibleCounts(md, me) {
  const seen = {}
  const add = (p) => { const k = norm(p); seen[k] = (seen[k] || 0) + 1 }
  const sp = md.shoupai[me]
  for (const s of ['m', 'p', 's', 'z']) sp._bingpai[s].forEach((c, n) => { if (n > 0) for (let k = 0; k < c; k++) add(s + n) })
  for (let l = 0; l < 4; l++) {
    for (const p of md.he[l]._pai) if (!/[\+\=\-]$/.test(p)) add(p) // 被鸣走的那张算在副露里
    for (const m of md.shoupai[l]._fulou) for (const d of m.match(/\d/g) || []) add(m[0] + d)
  }
  for (const p of md.shan.baopai) add(p)
  return seen
}
/** 手牌没摸牌（13 张）且听牌时：[{p, name, left}]；不听牌 null。 */
function waitsOf(sp, seen) {
  if (sp._zimo || Majiang.Util.xiangting(sp) !== 0) return null
  return Majiang.Util.tingpai(sp).map((p) => ({ p, name: tileName(p), left: Math.max(0, 4 - (seen[p] || 0)) }))
}
/** 振听：听的牌里有自己打过的（只看牌河，不算同巡和立直后见逃）。 */
const furiten = (waits, he) => !!waits && waits.some((w) => he._pai.some((p) => norm(p) === w.p))

/** 引擎发给座位的消息瘦身：终局消息里带着整场牌谱，座位只要分数名次。 */
function slim(msg) {
  if (msg.jieju) return { jieju: { defen: msg.jieju.defen, rank: msg.jieju.rank, point: msg.jieju.point, player: msg.jieju.player } }
  if (msg.kaiju) return { kaiju: { ...msg.kaiju } }
  // 役名换成中文，网页和座位客户端直接能用
  if (msg.pingju) return { pingju: { ...msg.pingju, name: pingjuName(msg.pingju.name) } }
  if (msg.hule) return { hule: { ...msg.hule, hupai: (msg.hule.hupai || []).map((x) => ({ ...x, name: yakuName(x.name) })) } }
  return msg
}

/**
 * 现在轮到谁出牌（座位视角的 l），给网页标“轮到谁”用。只在某一家摸了牌、或吃碰完要打牌时标出他；
 * 别人打出一张之后、下一次摸牌之前（这段时间可能有人在想要不要吃碰杠和）一律是 null，
 * 所以不管有没有人能鸣牌，所有人看到的都一样（主人 10-28 实测的要求）。
 */
function actorAfter(msg) {
  if (msg.zimo) return msg.zimo.l
  if (msg.gangzimo) return msg.gangzimo.l
  if (msg.fulou) return (msg.fulou.m.match(/\d/g) || []).length === 4 ? null : msg.fulou.l
  return null
}

/** 这个决定是不是“别人打出一张后能不能鸣牌”的那种（有“跳过”）。这种决定的存在本身就不能让别家知道。 */
const isCallWindow = (p) => !!p && p.options.some((o) => o.kind === 'skip')

/** 通过 HTTP/SSE 等回话的座位（真人浏览器、肥鱼客户端、测试客户端都是它）。 */
class ProtocolSeat {
  constructor(room, id, info) {
    this.room = room
    this.id = id
    this.name = info.name
    this.kind = info.kind // 'human' | 'agent' | 'remote'
    // 留给别人入座的空座（开房时 kind = 'remote'）：命令行 agent 领了还是 remote；
    // 联机时朋友的肥鱼领了变 agent、朋友本人领了变 human（块 8）。slot 一直是 true，离桌、空出来都看它
    this.slot = info.kind === 'remote'
    this.defaultName = info.name
    // 房主本人的座位：只有它能在网页上结束对局（块 8）。开房时就有的真人座位只可能是房主的；联机朋友本人是后来领的空座，不算
    this.host = info.host ?? info.kind === 'human'
    this.ready = false // 大厅里点了“准备”没有
    this.token = token()
    this.shadow = new ShadowAI()
    this.subs = new Set()
    this.log = [] // 本座位视角：开局消息 + 本局以来的消息（重连时整份补发）
    this.pending = null
    this.rev = 0
    this.everConnected = false
    this.offline = false // 掉线了：之后每一手都由机器人直接代打，桌上只在掉线、重连时各说一次
    this.left = false // 外部座位自己离桌了（cli leave）：机器人接着打到底
    this.goneTimer = null
    this.actor = null
    this.stats = { decisions: 0, takeovers: 0 }
  }

  action(msg, callback) {
    let fallback
    this.shadow.action(msg, (r) => { fallback = r }) // majiang-ai 同步回调
    let options = this.shadow.pending
    this.shadow.pending = null
    if (callback && !options && this.kind === 'human' && (msg.hule || msg.pingju)) {
      options = [{ kind: 'next', label: '继续', reply: {} }]
    }
    const m = slim(msg)
    if (msg.kaiju) this.log = [m]
    else if (msg.qipai) this.log = [this.log[0], m].filter(Boolean)
    else this.log.push(m)
    // 翻新宝牌不算换回合（暗杠后会先翻宝牌再岭上摸牌，别把正在出牌的那家冲掉）
    if (!msg.kaigang) {
      const now = this.room.eventTime()
      this.actor = actorAfter(msg)
      this.actorSince = this.actor == null ? null : now // 这一家从什么时候开始想（网页的“思考中 N 秒”）
      this.waitSince = msg.dapai || msg.gang ? now : null // 打出一张后的等待从什么时候开始（所有人看到的一样）
    }

    if (!callback || !options) {
      this.send('msg', { msg: m, view: this.view() })
      if (callback) callback(fallback)
      return
    }
    // 掉线或离桌了：不再等，直接由机器人打这一手，也不再每手写一条
    if (this.offline || this.left) {
      this.send('msg', { msg: m, view: this.view() })
      this.stats.decisions++
      this.stats.takeovers++
      callback(fallback)
      return
    }
    // 打牌选项附上“打这张以后听什么”（不听牌就不附）
    try {
      const md = this.shadow._model, me = this.shadow._menfeng, seen = visibleCounts(md, me)
      for (const o of options) {
        if (!o.reply?.dapai) continue
        const sp = md.shoupai[me].clone()
        sp.dapai(o.reply.dapai.replace(/\*$/, ''))
        const w = waitsOf(sp, seen)
        if (w) o.ting = { waits: w, furiten: furiten(w, { _pai: [...md.he[me]._pai, o.reply.dapai] }) }
      }
    } catch (e) { this.room.logger?.warn?.('riichi ting', e?.message || e) }
    const rev = ++this.rev
    this.stats.decisions++
    const limit = this.room.settings.timeLimitSec
    this.pending = {
      rev, callback, fallback, since: Date.now(),
      options: options.map((o, i) => ({ i, ...o })),
      deadline: limit ? Date.now() + limit * 1000 : null,
      timers: [],
    }
    if (limit) this.pending.timers.push(setTimeout(() => this.takeover(rev, '超时'), limit * 1000))
    if (this.subs.size === 0) this.watchGone()
    this.send('msg', { msg: m, view: this.view(), decision: this.decision() })
  }

  decision() {
    const p = this.pending
    if (!p) return null
    return { rev: p.rev, deadline: p.deadline, options: p.options.map(({ i, kind, label, reply, ting }) => ({ i, kind, label, reply, ...(ting ? { ting } : {}) })) }
  }

  view() {
    const sh = this.shadow, md = sh._model
    if (!md.shan) return { phase: this.room.status === 'lobby' ? 'lobby' : 'waiting', names: this.room.names, families: this.room.familiesInfo() }
    const me = sh._menfeng
    const seats = [0, 1, 2, 3].map((l) => {
      const id = md.player_id[l]
      return {
        l, id, name: this.room.names[id], feng: FENG[l], defen: md.defen[id], me: l === me,
        he: md.he[l]._pai.map(heTile),
        fulou: md.shoupai[l]._fulou.map((m) => ({ m, name: mianziName(m) })),
        lizhi: !!md.shoupai[l].lizhi,
      }
    })
    return {
      phase: 'playing',
      round: roundName(md.zhuangfeng, md.jushu), changbang: md.changbang, lizhibang: md.lizhibang,
      paishu: md.shan.paishu, baopai: md.shan.baopai.map((p) => ({ p, name: tileName(p) })),
      lunban: md.lunban, actor: this.actor, actorSince: this.actorSince ?? null, waitSince: this.waitSince ?? null, now: Date.now(),
      me, seats, hand: this.handWithWaits(md, me),
      families: this.room.familiesInfo(), // 谁和谁是一家：公开信息，所有座位和旁观都一样
    }
  }

  handWithWaits(md, me) {
    const hand = handView(md.shoupai[me])
    try {
      const w = waitsOf(md.shoupai[me], visibleCounts(md, me))
      if (w) hand.ting = { waits: w, furiten: furiten(w, md.he[me]) }
    } catch (e) { this.room.logger?.warn?.('riichi ting', e?.message || e) }
    return hand
  }

  act(rev, choice, say, by = 'seat') {
    const p = this.pending
    if (!p || p.rev !== rev) return { ok: false, status: 409, error: '局面已经变了（rev 不对），这一手不收' }
    const opt = p.options[choice]
    if (!opt) return { ok: false, status: 400, error: `没有编号 ${choice} 的选项` }
    for (const t of p.timers) clearTimeout(t)
    this.pending = null
    if (this.polling) this.clearGone() // 命令行座位出了牌就是还活着
    const ms = Date.now() - p.since
    this.send('acted', { rev, i: opt.i, label: opt.label, by, ms })
    // 出牌时顺带的台词。在鸣牌窗口里选了“跳过”时，“出牌时说的”这个标记本身就会让别家知道他刚才能鸣牌，
    // 所以这种情况下当普通聊天发出去
    if (say) this.room.chat(this.id, String(say).slice(0, 200), isCallWindow(p) && opt.kind === 'skip' ? 'chat' : 'line')
    this.room.onActed(this, opt, by, ms)
    p.callback(opt.reply)
    return { ok: true }
  }

  /** 机器人代打这一手，并在桌上写明。鸣牌窗口里的代打攒到这一局结束再说，免得泄露“他刚才能鸣牌”。 */
  takeover(rev, reason, { silent = false } = {}) {
    const p = this.pending
    if (!p || p.rev !== rev) return
    let i = p.options.findIndex((o) => sameReply(o.reply, p.fallback))
    if (i < 0) i = p.options.findIndex((o) => o.kind === 'skip' || o.kind === 'next')
    if (i < 0) i = p.options.length - 1
    this.stats.takeovers++
    if (!silent) this.room.takeoverNote(this, reason, isCallWindow(p))
    this.act(rev, i, null, `代打·${reason}`)
  }

  /**
   * 事件流一个都没连着：过一会儿还没连回来就算掉线。浏览器座位从断开那一刻算 20 秒（跟有没有轮到他无关，
   * 所以掉线消息出现的时机不会泄露他有没有鸣牌选项）；命令行座位平时本来就不连着，只在轮到他、5 分钟没动静时算。
   * 真人座位从没连上过不算，牌局会一直等他打开页面。
   */
  watchGone() {
    if (this.offline || this.left || this.goneTimer || !this.everConnected || this.room.status !== 'playing') return
    if (this.polling && !this.pending) return
    this.goneTimer = setTimeout(() => {
      this.goneTimer = null
      if (this.subs.size === 0 && (!this.polling || this.pending)) this.goOffline()
    }, this.polling ? TIMING.pollGraceMs : TIMING.graceMs)
  }

  clearGone() { clearTimeout(this.goneTimer); this.goneTimer = null }

  goOffline() {
    if (this.offline || this.left || this.room.status !== 'playing') return
    this.offline = true
    this.room.note(this.polling
      ? `${this.name} 5 分钟没动静，算掉线：之后由机器人代打，重新 wait 就接回座位`
      : `${this.name} 掉线了：之后由机器人代打，重新连上就接回座位`)
    if (this.pending) this.takeover(this.pending.rev, '掉线', { silent: true })
  }

  /** 又连上了（或命令行座位又来要牌面了）：接回座位，桌上说一次。 */
  backOnline() {
    this.clearGone()
    if (!this.offline || this.left) return
    this.offline = false
    if (this.room.status === 'playing') this.room.note(`${this.name} 重新连上了，接回座位`)
  }

  /**
   * 命令行拿现成的座位令牌接座（她派的 DSH 子代理坐她自己的座位，seat_mode = subagent）：
   * 跟命令行领空座一样按“不常连着”算，轮到它 5 分钟没动静才算掉线。真人座位不行。
   */
  attach() {
    if (this.kind === 'human') return { ok: false, status: 403, error: '真人座位不能用命令行接' }
    this.polling = true
    this.everConnected = true
    this.attached = true
    this.backOnline()
    return { ok: true }
  }

  /** 外部座位离桌（cli leave）：大厅里就把座位空出来；开局后由机器人接着打到底。 */
  leave() {
    if (!this.slot) return { ok: false, status: 403, error: '只有外部座位能离桌' }
    if (this.room.status === 'lobby') {
      const was = this.name
      this.room.dropFamily(this.id) // 一家里有人走了，这一家就拆了（另一位还在座位上）
      this.claimed = false
      this.ready = false
      this.polling = false
      this.everConnected = false
      this.kind = 'remote'
      this.room.seatInfo[this.id].kind = 'remote'
      // 名字还原成空座的默认名（别人用了就不还原）
      if (!this.room.names.some((x, i) => i !== this.id && x === this.defaultName)) { this.name = this.defaultName; this.room.names[this.id] = this.defaultName; this.room.seatInfo[this.id].name = this.defaultName }
      this.token = token() // 旧令牌作废，空座可以再被别人领
      for (const s of this.subs) s.close?.()
      this.subs.clear()
      this.room.note(`${was} 离开了大厅，座位空出来了`)
      this.room.lobbyChanged()
      return { ok: true, lobby: true }
    }
    if (this.room.status !== 'playing') return { ok: false, status: 409, error: '这一桌已经结束了' }
    if (this.left) return { ok: true }
    this.left = true
    this.clearGone()
    this.room.note(`${this.name} 离桌了，之后由机器人接着打`)
    if (this.pending) this.takeover(this.pending.rev, '离桌', { silent: true })
    return { ok: true }
  }

  subscribe(sub) {
    this.subs.add(sub)
    this.everConnected = true
    this.backOnline()
    sub.send('sync', { seat: this.id, name: this.name, room: this.room.publicInfo(), lobby: this.room.lobbyInfo(), log: this.log, view: this.view(), decision: this.decision(), chat: this.room.chatLog.slice(-30), left: this.left, eggs: this.room.eggs || [], bgm: (this.room.bgm || []).length })
    if (this.subs.size === 1) this.room.lobbyChanged()
    return () => {
      this.subs.delete(sub)
      if (this.subs.size === 0) this.watchGone()
      if (this.subs.size === 0) this.room.lobbyChanged()
    }
  }

  send(type, data) {
    for (const s of this.subs) s.send(type, data)
    // 旁观只看牌面：不给 decision、不给 acted（旁观的人也不该知道这一家刚才有没有鸣牌选项）
    if (type === 'acted') return
    const w = type === 'msg' && data.decision ? { msg: data.msg, view: data.view } : data
    for (const x of this.room.watchers) if (x.seat === this.id) x.send(type, w)
  }
}

/** 在服务进程里直接跑的机器人座位（不走网络）。 */
function makeBot(level) {
  const Bot = botClass(level)
  return new Bot()
}

export class Room {
  /**
   * @param {object} o
   * @param {{ length: '东风'|'半庄', rules: string, botLevel: string, effort: string, timeLimitSec: number|null }} o.settings
   * @param {Array<{ name: string, kind: 'bot'|'human'|'agent'|'remote' }>} o.seats 按 player id 0..3
   */
  constructor({ settings, seats, onEnd, owner, logger, online = false }) {
    this.logger = logger
    this.code = roomCode()
    this.settings = settings
    this.owner = owner || null // 开房的会话 id
    this.online = !!online // 联机房：局域网那一路只认联机房（块 8）
    // “一家”（主人 10-28 晚定）：一位主人和他的肥鱼。只能由插件替主人领座位时登记（服务端说了算），
    // 桌上改昵称冒充不了；登记了就公开给所有座位和旁观。元素是 { members: [座位号…] }
    this.families = []
    let botN = 0
    this.seatInfo = seats.map((s) => ({ ...s, color: normalizeColor(s.color, s.kind === 'bot' ? DEFAULT_COLORS.bot[botN++ % 3] : DEFAULT_COLORS[s.kind] || DEFAULT_COLORS.remote) }))
    this.names = seats.map((s) => s.name)
    this.createdAt = Date.now()
    // 先进大厅：所有座位都点了“准备”（机器人自动准备）才开局（改进 2）
    this.status = 'lobby'
    this.events = [] // 公开信息：打牌、副露、和了、流局（不含任何人的手牌和摸到的牌）
    this.chatLog = []
    this.endHooks = new Set() // 终局或中止时调（插件存战绩、请她赛后回顾）
    this.chatHooks = new Set() // 插件挂的聊天监听（把别人的话送进她的会话，lib/session-link.mjs）
    this.momentHooks = new Set() // 牌局里的关键时刻（立直、和了、放铳、开局）：插件拿去提醒她“想说可以说”
    this.chatSeq = 0 // 聊天流水号：命令行客户端靠它只打印新消息
    this.deferredNotes = [] // 鸣牌窗口里的代打：这一局结束时再写到桌上
    // 起家（东1局的庄家）开房时就定下来，开局前就能告诉她风位
    this.qijia = crypto.randomInt(4)
    this.watchers = new Set()
    this.watchTokens = new Map() // 令牌 → 看哪个座位
    this.result = null
    this.onEnd = onEnd
    this.hands = 0
    this.players = seats.map((s, id) => (s.kind === 'bot' ? makeBot(s.level || settings.botLevel) : new ProtocolSeat(this, id, s)))
    this.lastActionAt = Date.now()
  }

  /** 大厅公开信息：每个座位的名字、颜色、准备没有、连没连上。 */
  lobbyInfo() {
    return {
      status: this.status,
      seats: this.players.map((p, id) => {
        const s = this.seatInfo[id]
        const proto = p instanceof ProtocolSeat
        const fam = this.familyOf(id)
        return {
          id, name: this.names[id], kind: s.kind, color: s.color, ready: proto ? p.ready : true, connected: proto ? p.subs.size > 0 : true,
          claimed: !(proto && p.slot) || !!p.claimed, host: !!(proto && p.host), outside: !!(proto && p.slot), family: fam ? fam.n : null,
        }
      }),
      families: this.familiesInfo(),
    }
  }

  /**
   * 领一个留给别人的空座（POST join）。kind：'remote' = 命令行 agent；联机时 'agent' = 朋友的肥鱼、'human' = 朋友本人。
   * 没有空座返回 null。昵称重名不拒绝入座，用空座的默认名，warning 里写原因。
   */
  claimSlot({ name, color, kind = 'remote', poll = false } = {}) {
    const seat = this.players.find((p) => p instanceof ProtocolSeat && p.slot && !p.claimed)
    if (!seat) return null
    seat.claimed = true
    seat.kind = kind
    this.seatInfo[seat.id].kind = kind
    // 命令行客户端不常连着，掉线代打放宽到 5 分钟；从入座起就算“连过”
    if (poll) { seat.polling = true; seat.everConnected = true }
    let warning = null
    if (name || color) {
      const r = this.setProfile(seat, { name: name || undefined, color: color || undefined })
      if (!r.ok) warning = r.error
    }
    return { seat, warning }
  }

  /** 登记一家（插件替主人领座位时调）。一个座位只能在一家里。 */
  addFamily(ids) {
    if (ids.some((id) => this.familyOf(id))) throw new Error('这个座位已经在别的一家里了')
    this.families.push({ members: ids.slice() })
    this.lobbyChanged()
  }

  dropFamily(id) {
    const before = this.families.length
    this.families = this.families.filter((f) => !f.members.includes(id))
    if (this.families.length !== before) this.lobbyChanged()
  }

  familyOf(id) {
    const i = this.families.findIndex((f) => f.members.includes(id))
    return i < 0 ? null : { ...this.families[i], n: i + 1 }
  }

  /** 公开的一家名单：[{ n, members: [座位号], names: [现在的名字] }]。 */
  familiesInfo() {
    return this.families.map((f, i) => ({ n: i + 1, members: f.members.slice(), names: f.members.map((id) => this.names[id]) }))
  }

  /** 一句话列出所有一家（给模型和命令行看）；没有就是空字符串。 */
  familiesText() { return familiesSentence(this.familiesInfo()) }

  lobbyChanged() {
    if (this.status === 'lobby') this.broadcast('lobby', this.lobbyInfo())
  }

  setReady(seat, ready) {
    if (this.status !== 'lobby') return { ok: false, status: 409, error: '已经开局了' }
    seat.ready = !!ready
    this.lobbyChanged()
    this.maybeStart()
    return { ok: true }
  }

  /** 大厅里改自己的昵称和颜色；开局后就不能改了（牌桌上要认得出谁是谁）。 */
  setProfile(seat, { name, color } = {}) {
    if (this.status !== 'lobby') return { ok: false, status: 409, error: '开局后不能改昵称' }
    if (name !== undefined) {
      const n = cleanName(name, seat.name)
      if (this.names.some((x, i) => i !== seat.id && x === n)) return { ok: false, status: 409, error: `“${n}”已经有人用了，换一个` }
      seat.name = n
      this.names[seat.id] = n
      this.seatInfo[seat.id].name = n
    }
    if (color !== undefined) this.seatInfo[seat.id].color = normalizeColor(color, this.seatInfo[seat.id].color)
    this.lobbyChanged()
    return { ok: true, name: seat.name, color: this.seatInfo[seat.id].color }
  }

  maybeStart() {
    if (this.status !== 'lobby') return
    if (!this.lobbyInfo().seats.every((s) => s.ready)) return
    this.status = 'playing'
    this.broadcast('lobby', this.lobbyInfo())
    this.note('四家都准备好了，开局')
    this.start()
  }

  start() {
    const rule = Majiang.rule({ ...(RULE_PRESETS[this.settings.rules] || {}), '場数': this.settings.length === '半庄' ? 2 : 1 })
    // 引擎在自己的 setTimeout 里推进：那里抛错会变成宿主进程的未捕获异常（可能带垮整个 DSH），
    // 所以座位、推进、延迟回调、view 钩子全部包一层，出错只结束这一桌。
    const guard = (fn) => (...a) => {
      if (this.status !== 'playing') return
      try { return fn(...a) } catch (e) { this.crash(e) }
    }
    const players = this.players.map((p) => ({ action: guard((msg, cb) => p.action(msg, cb && guard(cb))) }))
    const game = new Majiang.Game(players, guard((paipu) => this.finish(paipu)), rule, `${this.settings.length}战 ${new Date().toLocaleString('zh-CN')}`)
    const callPlayers = game.call_players.bind(game)
    game.call_players = (...a) => { this._stamp = Date.now(); return callPlayers(...a) }
    const next = game.next.bind(game), delay = game.delay.bind(game)
    game.next = guard(next)
    game.delay = (cb, t) => delay(guard(cb), t)
    game.model.player = this.names.slice()
    const hooks = this.viewHooks()
    game.view = Object.fromEntries(Object.entries(hooks).map(([k, f]) => [k, (...a) => { try { f(...a) } catch (e) { this.logger?.warn?.('riichi view hook', e) } }]))
    game.speed = 0 // 异步模式、不加延迟；慢座位由引擎自己等（调研 §8 表一）
    game.wait = 0
    this.game = game
    game.kaiju(this.qijia)
  }

  /**
   * 风位（10-28 实测：她只知道座位号，把 0 号当成了东家）。座位号只是入座顺序，风位每局跟着庄家转。
   * 开局前按东1局算（起家开房时已经定了）。
   */
  winds() {
    const md = this.game?.model
    const started = !!md?.shan
    const ids = started ? md.player_id : [0, 1, 2, 3].map((l) => (this.qijia + l) % 4)
    const round = started ? `${roundName(md.zhuangfeng, md.jushu)} ${md.changbang}本场` : '东1局（开局时）'
    const feng = []
    ids.forEach((id, l) => { feng[id] = FENG[l] })
    return { round, started, dealer: ids[0], feng }
  }

  /** 一句话写明某个座位这一局的风位、庄家、各家风位。 */
  windText(seatId) { return windSentence(this.winds(), this.names, seatId) }

  /**
   * 这一条引擎消息的时间（“思考中 N 秒”的起点）。引擎异步模式下把同一条消息用四个 setTimeout 分别发给四家，
   * 轮到出牌那家的影子 AI 还要先算一遍（0.1~0.2 秒），各家各取 Date.now() 会差出去。
   * 所以在引擎每次开始发消息（call_players）时记一次，四家共用；四家都回话之前引擎不会发下一条。
   */
  eventTime() { return this._stamp ?? Date.now() }

  moment(m) {
    for (const f of this.momentHooks) { try { f(m) } catch (e) { this.logger?.warn?.('riichi moment hook', e) } }
  }

  /** 代打写到桌上。鸣牌窗口里的先攒着，这一局结束时一起写（不说是哪一手）。 */
  takeoverNote(seat, reason, callWindow) {
    if (callWindow) this.deferredNotes.push(`${seat.name}（${reason}）`)
    else this.note(`${seat.name} 这手由机器人代打（${reason}）`)
  }

  flushDeferredNotes() {
    if (!this.deferredNotes.length) return
    const counts = new Map()
    for (const x of this.deferredNotes) counts.set(x, (counts.get(x) || 0) + 1)
    const total = this.deferredNotes.length
    this.deferredNotes = []
    this.note(`这一局里另有 ${total} 手由机器人代打：` + [...counts].map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join('、'))
  }

  /** Game.view 钩子：只记公开信息。 */
  viewHooks() {
    const room = this
    const idAt = (l) => room.game.model.player_id[l]
    const nameAt = (l) => room.names[idAt(l)]
    return {
      kaiju() { room.event('开局'); room.moment({ type: 'start' }) },
      redraw() {
        const md = room.game.model
        room.hands++
        room.event(`${roundName(md.zhuangfeng, md.jushu)} ${md.changbang}本场 开始，宝牌指示 ${tileName(md.shan.baopai[0])}`)
      },
      update(pp) {
        if (!pp) return
        room.lastActionAt = Date.now()
        if (pp.dapai) {
          const lz = pp.dapai.p.includes('*')
          room.event(`${nameAt(pp.dapai.l)} 打 ${tileName(pp.dapai.p)}${lz ? ' 立直' : ''}`)
          if (lz) room.moment({ type: 'lizhi', id: idAt(pp.dapai.l), tile: tileName(pp.dapai.p) })
        } else if (pp.fulou) room.event(`${nameAt(pp.fulou.l)} ${mianziName(pp.fulou.m)}`)
        else if (pp.gang) room.event(`${nameAt(pp.gang.l)} ${mianziName(pp.gang.m)}`)
        else if (pp.kaigang) room.event(`新宝牌指示 ${tileName(pp.kaigang.baopai)}`)
        else if (pp.hule) {
          const h = pp.hule
          const yaku = (h.hupai || []).map((x) => yakuName(x.name)).join('、')
          const how = h.baojia == null ? '自摸' : `荣和 ${nameAt(h.baojia)}`
          room.event(`${nameAt(h.l)} ${how}，${h.defen} 点（${yaku}）`)
          room.flushDeferredNotes()
          room.moment({ type: 'hule', id: idAt(h.l), from: h.baojia == null ? null : idAt(h.baojia), defen: h.defen, yaku })
        } else if (pp.pingju) {
          room.event(`流局：${pingjuName(pp.pingju.name)}`)
          room.flushDeferredNotes()
        }
      },
      summary() {},
      say() {},
    }
  }

  event(text) {
    this.events.push({ t: Date.now(), text })
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400)
  }

  /** 系统消息（代打、开局、结束这类）：也进聊天记录，重连能看到。 */
  note(text) {
    this.event(`【桌】${text}`)
    const c = { n: ++this.chatSeq, from: -1, name: '牌桌', text, kind: 'system', t: Date.now() }
    this.chatLog.push(c)
    if (this.chatLog.length > CHAT_KEEP) this.chatLog.shift()
    this.broadcast('chat', c)
  }

  /** kind：chat = 聊天框里说的；line = 出牌时顺带的台词。网页按类别给不同样式（web/样式.md）。 */
  chat(seatId, text, kind = 'chat') {
    // ju：说这句话时是哪一局（10-29 主人实测：上一局要的牌，她到下一局还记着）；开局前没有
    const md = this.game?.model
    const ju = md?.shan ? `${roundName(md.zhuangfeng, md.jushu)} ${md.changbang}本场` : null
    const c = { n: ++this.chatSeq, from: seatId, name: this.names[seatId], color: this.seatInfo[seatId]?.color, text, kind, ju, t: Date.now() }
    this.chatLog.push(c)
    if (this.chatLog.length > CHAT_KEEP) this.chatLog.shift()
    this.broadcast('chat', c)
    for (const f of this.chatHooks) { try { f(c) } catch (e) { this.logger?.warn?.('riichi chat hook', e) } }
  }

  broadcast(type, data) {
    for (const p of this.players) if (p instanceof ProtocolSeat) for (const s of p.subs) s.send(type, data)
    for (const w of this.watchers) w.send(type, data)
  }

  onActed() { this.lastActionAt = Date.now() }

  finish(paipu) {
    this.status = 'ended'
    this.endedAt = Date.now()
    this.flushDeferredNotes()
    for (const p of this.players) if (p instanceof ProtocolSeat) p.clearGone()
    this.result = { defen: paipu.defen, rank: paipu.rank, point: paipu.point, names: this.names }
    // 完整牌谱终局后才可以给出去（块 5 写盘）
    this.paipu = paipu
    const order = [0, 1, 2, 3].sort((a, b) => paipu.rank[a] - paipu.rank[b])
    this.event('终局：' + order.map((id) => `${paipu.rank[id]}位 ${this.names[id]} ${paipu.defen[id]}（${paipu.point[id]}）`).join(' / '))
    this.broadcast('end', this.result)
    if (this.onEnd) this.onEnd(this)
    this.runEndHooks()
  }

  runEndHooks() {
    for (const f of this.endHooks) { try { f(this) } catch (e) { this.logger?.warn?.('riichi end hook', e) } }
  }

  crash(e) {
    this.error = String(e?.stack || e)
    this.logger?.warn?.('riichi room crashed', e)
    this.abort(`引擎出错：${e?.message || e}`)
  }

  /** 中途放弃：停住引擎，所有等待中的座位作废。 */
  abort(reason = '房主关了这一桌', by = null) {
    if (this.status !== 'playing' && this.status !== 'lobby') return
    this.status = 'aborted'
    this.abortedBy = by // 'owner-web' = 主人在网页上点了“结束对局”
    this.endedAt = Date.now()
    try { this.game?.stop() } catch {}
    this.flushDeferredNotes()
    for (const p of this.players) {
      if (!(p instanceof ProtocolSeat)) continue
      p.clearGone()
      if (p.pending) { for (const t of p.pending.timers) clearTimeout(t); p.pending = null }
    }
    this.note(`这一桌结束了：${reason}`)
    this.broadcast('end', { aborted: true, reason })
    if (this.onEnd) this.onEnd(this)
    this.runEndHooks()
  }

  seatByToken(t) {
    if (!t) return null
    for (const p of this.players) if (p instanceof ProtocolSeat && safeEqual(p.token, t)) return p
    return null
  }

  /** 旁观令牌：只能看某一个座位的视角（只读）。 */
  watchToken(seatId) {
    const t = token()
    this.watchTokens.set(t, seatId)
    return t
  }

  watchSeat(t) {
    if (!t) return null
    for (const [k, v] of this.watchTokens) if (safeEqual(k, t)) return v
    return null
  }

  /** 牌桌公开信息（不含手牌），座位和调试页都能看。 */
  publicInfo() {
    const md = this.game?.model
    return {
      // 人设卡不公开（联机时会发到别人电脑上）
      code: this.code, status: this.status, settings: { ...this.settings, persona: undefined }, names: this.names,
      kinds: this.seatInfo.map((s) => s.kind),
      colors: this.seatInfo.map((s) => s.color),
      round: md?.shan ? `${roundName(md.zhuangfeng, md.jushu)} ${md.changbang}本场` : null,
      defen: md ? md.defen.slice() : null,
      paishu: md?.shan ? md.shan.paishu : null,
      hands: this.hands, result: this.result, error: this.error || null,
      online: this.online, families: this.familiesInfo(), winds: this.winds(),
    }
  }

  /** 调试页用：公开信息 + 座位连接状态 + 最近事件。 */
  debugInfo() {
    return {
      ...this.publicInfo(),
      createdAt: this.createdAt, endedAt: this.endedAt || null, lastActionAt: this.lastActionAt,
      seats: this.players.map((p, id) => (p instanceof ProtocolSeat
        // waiting 只报自己出牌的那种决定；鸣牌窗口里在想的不报（不泄露谁能鸣牌）
        ? { id, name: p.name, kind: p.kind, connected: p.subs.size, ready: p.ready, offline: p.offline, left: p.left, waiting: p.pending && !isCallWindow(p.pending) ? Math.round((Date.now() - p.pending.since) / 1000) : null, ...p.stats }
        : { id, name: this.names[id], kind: 'bot', level: this.seatInfo[id].level || this.settings.botLevel })),
      events: this.events.slice(-60),
    }
  }
}

/** 风位一句话：w = room.winds() 的形状 {round, dealer, feng}。联机时朋友那边没有 Room，用同一个函数（lib/remote-table.mjs）。 */
export function windSentence(w, names, seatId) {
  const order = [0, 1, 2, 3].sort((a, b) => FENG.indexOf(w.feng[a]) - FENG.indexOf(w.feng[b]))
  const me = seatId == null ? '' : `你（${names[seatId]}）是${w.feng[seatId]}家${w.dealer === seatId ? '，你坐庄' : ''}；`
  return `${w.round}：${me}庄家是 ${names[w.dealer]}；各家风位：${order.map((id) => `${w.feng[id]} ${names[id]}`).join(' / ')}`
}

/** 一家名单一句话（公开信息）。families = familiesInfo() 的形状。 */
export function familiesSentence(families) {
  if (!families?.length) return ''
  return '一家（主人和自家肥鱼，插件登记的）：' +families.map((f) => f.names.join(' + ')).join('；')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export { ProtocolSeat }
