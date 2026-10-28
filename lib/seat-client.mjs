// 座位客户端：通过协议（HTTP + SSE）坐一个座位。本机肥鱼、测试客户端、以后远端朋友的肥鱼都用它，
// 本地就连 127.0.0.1，联机只是换个地址（调研 §1.6）。
// "脑子"可换：块 1 用 majiang-ai（AiBrain）；块 3 换成走 ctx.llm 的肥鱼脑子。
import { AI, sameReply } from './shadow.mjs'

/** 用 majiang-ai 出牌的脑子：吃下座位收到的每条引擎消息，同步牌面，轮到时按 AI 的回复找编号。 */
export class AiBrain {
  constructor(Bot = AI) { this.Bot = Bot; this.reset() }
  reset() { this.ai = new this.Bot(); this.last = undefined }
  /** 重连时整份补发：从开局消息起重建。 */
  sync(log) {
    this.reset()
    for (const m of log) this.feed(m)
  }
  feed(msg) {
    this.last = undefined
    this.ai.action(msg, (r) => { this.last = r })
  }
  decide(decision) {
    const i = decision.options.findIndex((o) => sameReply(o.reply, this.last))
    return { choice: i >= 0 ? i : decision.options.length - 1 }
  }
}

export class SeatClient {
  /**
   * @param {object} o
   * @param {string} o.origin 牌桌服务地址，如 http://127.0.0.1:47777
   * @param {string} o.code 房间码
   * @param {string} o.token 座位令牌
   * @param {object} o.brain 有 sync(log) / feed(msg) / decide(decision) 的对象（decide 可以是 async）
   */
  constructor({ origin, code, token, brain, logger = console, name = '座位', maxOfflineMs = null }) {
    Object.assign(this, { origin, code, token, brain, logger, name })
    // 联机时房主那边可能整个关掉了：连不上超过这么久就放弃（null = 一直重连，本机座位用）
    this.maxOfflineMs = maxOfflineMs
    this.hooks = new Set() // (type, data) => void：事件先给它们看一眼（联机时朋友那边靠它镜像牌桌，lib/remote-table.mjs）
    this.stopped = false
    this.ctrl = null
    this.chat = [] // 桌上最近的聊天（肥鱼脑子出牌时也看得到）
    this.ended = new Promise((resolve) => { this._resolveEnd = resolve })
  }

  base(p) { return `${this.origin}/room/${this.code}/${p}` }

  async post(p, body) {
    const r = await fetch(this.base(p), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  /** 连上就一直听；断了 2 秒后重连（拿原令牌接回座位）。 */
  async run() {
    let downSince = null // 从什么时候起一直没连上
    while (!this.stopped) {
      const before = this.connectedAt
      try {
        await this.listen()
      } catch (e) {
        if (this.stopped) break
        this.logger.warn?.(`riichi ${this.name}: 断线，2 秒后重连`, e?.message || e)
      }
      if (this.stopped) break
      // 这一轮连上过（之后才断的）就从现在算；一直没连上就接着从上次算
      downSince = this.connectedAt !== before ? Date.now() : downSince ?? Date.now()
      if (this.maxOfflineMs != null && Date.now() - downSince > this.maxOfflineMs) {
        this.stopped = true
        this._resolveEnd({ error: 'lost' })
        break
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    return this.ended
  }

  stop() {
    this.stopped = true
    this.brain.stop?.()
    this.ctrl?.abort()
    this._resolveEnd(null)
  }

  async listen() {
    this.ctrl = new AbortController()
    const r = await fetch(this.base('seat/events'), { headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, signal: this.ctrl.signal })
    if (r.status === 401 || r.status === 404) { this.stopped = true; this._resolveEnd({ error: r.status }); return }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    this.connectedAt = Date.now()
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let k
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k)
        buf = buf.slice(k + 2)
        let type = 'message', data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7)
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (data) await this.onEvent(type, JSON.parse(data))
        if (this.stopped) return
      }
    }
  }

  async onEvent(type, data) {
    for (const f of this.hooks) { try { f(type, data) } catch (e) { this.logger.warn?.(`riichi ${this.name}: hook`, e?.message || e) } }
    if (type === 'sync') {
      // 在大厅里就点“准备”（agent 座位不用等人）
      if (data.lobby?.status === 'lobby' && this.autoReady !== false) {
        const r = await this.post('seat/ready', { ready: true })
        if (r.status !== 200) this.logger.warn?.(`riichi ${this.name}: 准备失败 ${r.status}`, r.body)
      }
      this.brain.sync(data.log)
      this.view = data.view
      this.chat = (data.chat || []).slice(-60)
      if (data.decision) await this.answer(data.decision)
    } else if (type === 'msg') {
      this.brain.feed(data.msg)
      this.view = data.view
      if (data.decision) await this.answer(data.decision)
    } else if (type === 'chat') {
      this.chat.push(data)
      if (this.chat.length > 60) this.chat.shift() // 留多一点：这一局主人和她说过的话出牌时要一直看得到
    } else if (type === 'end') {
      this.stopped = true
      this.ctrl?.abort()
      this._resolveEnd(data)
    }
  }

  async answer(decision) {
    // 脑子可以拿到当前视角（肥鱼脑子要用它写牌面）；proxy = 这手是机器人代打的，写明原因
    const { choice, say, proxy } = await this.brain.decide(decision, this.view, this.chat.slice())
    if (this.stopped) return
    const r = await this.post('seat/act', { rev: decision.rev, choice, say, proxy })
    // 409 = 局面已经变了（比如超时被代打），丢掉这一手即可
    if (r.status !== 200 && r.status !== 409) this.logger.warn?.(`riichi ${this.name}: 出牌被拒 ${r.status}`, r.body)
  }
}
