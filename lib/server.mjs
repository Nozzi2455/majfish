// 牌桌服务：自己的 http.createServer、自己的端口，不挂在 DSH 主服务上（调研 §1.6）。
// 平时只监听 127.0.0.1；开联机房时（块 8）再额外开一个局域网监听，只认联机房，散场就关。
// 协议见 ../协议.md。
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Room } from './room.mjs'
import { defaultDir } from './memory.mjs'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
// 彩蛋音乐（主人 10-28 晚要的梗）：别人立直放「别人立直.*」，自己立直放「自己立直.*」。
// 先找 $DSH_HOME/dsh-riichi/彩蛋/（想换歌放这里），没有再用插件自带的 彩蛋/（主人定了：内置，公开发布也带上）。
export const EGG_FILES = { other: '别人立直', self: '自己立直' }
const BUNDLED_EGGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '彩蛋')
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' }
export const DEFAULT_PORT = 47777
const MAX_BODY = 16 * 1024
const KEEP_ENDED = 5
// 局域网那一路（块 8）：失败限流更严（10 分钟里失败 5 次就挡 10 分钟）；散场后再留一会儿，让朋友看完结算、说完话再关
export const LAN = { failLimit: 5, failWindowMs: 10 * 60_000, closeDelayMs: 60_000 }

/** 认得出来的虚拟局域网工具（按网卡名），开房时 UU 这类排前面，“自动”只开在 UU 网卡上。 */
const VLANS = [[/UU|Lanplay/i, 'UU'], [/ZeroTier/i, 'ZeroTier'], [/Radmin/i, 'Radmin VPN'], [/Tailscale/i, 'Tailscale'], [/Hamachi/i, 'Hamachi'], [/Oray|蒲公英|pgy/i, '蒲公英']]

/** 这台电脑现在的局域网 IPv4 地址（去掉 127.x 和没拿到地址的 169.254.x）：[{ name: 网卡名, address, vlan }]。 */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue
      out.push({ name, address: a.address, vlan: VLANS.find(([re]) => re.test(name))?.[1] || null })
    }
  }
  return out.sort((x, y) => (y.vlan === 'UU') - (x.vlan === 'UU') || !!y.vlan - !!x.vlan)
}

export class TableServer {
  constructor({ host = '127.0.0.1', port = DEFAULT_PORT, logger = console, eggDirs = [path.join(defaultDir(), '彩蛋'), BUNDLED_EGGS], bgmDir = path.join(defaultDir(), 'bgm') } = {}) {
    this.eggDirs = eggDirs
    // 自定义 BGM：主人往 $DSH_HOME/dsh-riichi/bgm/ 放 mp3/ogg 就随机循环放这些，不用网页合成的。插件包里不带。
    this.bgmDir = bgmDir
    this.host = host
    this.wantPort = port
    this.logger = logger
    this.rooms = new Map()
    this.adminKey = crypto.randomBytes(18).toString('base64url') // 调试页钥匙，每次启动换
    this.fails = new Map() // ip → [时间戳]，入座失败限流
    this.server = null
    this.sockets = new Set()
    this.lan = null // 局域网监听 { server, host, port, sockets }，只在有联机房时开
    this.lanCloseTimer = null
  }

  get origin() { return `http://${this.host}:${this.port}` }

  /** 在 host:port 上起一个监听；端口被占返回 null。lan = 这一路是局域网的（handle 里按它收紧）。 */
  async bind(host, port, sockets, lan) {
    const server = http.createServer((req, res) => this.handle(req, res, { lan }).catch((e) => {
      this.logger.warn?.('riichi table: request failed', e)
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) })
      else res.destroy()
    }))
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, host, () => resolve(true))
    })
    return ok ? server : null
  }

  /** 从默认端口起找一个空的（最多试 10 个）。 */
  async listen() {
    if (this.server) return this
    for (let i = 0; i < 10; i++) {
      const port = this.wantPort + i
      const server = await this.bind(this.host, port, this.sockets, false)
      if (server) { this.server = server; this.port = port; return this }
    }
    throw new Error(`牌桌服务起不来：${this.wantPort}~${this.wantPort + 9} 端口都被占了`)
  }

  async close() {
    for (const r of this.rooms.values()) r.abort('牌桌服务关闭')
    await this.closeLan()
    if (!this.server) return
    const s = this.server
    this.server = null
    for (const sock of this.sockets) sock.destroy()
    await new Promise((resolve) => s.close(() => resolve()))
  }

  /**
   * 开局域网监听（开联机房时调）。bind：'auto' = 有 UU 网卡就只开在它上面；没有 UU、但正好有一张认得出的
   * 虚拟局域网网卡（ZeroTier 这些）就开在它上面；都没有就报错，要主人明说（不悄悄开到所有网卡上）。
   * 'all' = 所有网卡（0.0.0.0）；或者一个具体的本机 IP。端口先试和本机那一路一样的，被占就往后找 9 个。
   */
  async openLan(bind = 'auto') {
    const host = this.lanHost(bind)
    clearTimeout(this.lanCloseTimer)
    this.lanCloseTimer = null
    if (this.lan?.host === host) return this.lanInfo()
    await this.closeLan()
    const sockets = new Set()
    for (let i = 0; i < 10; i++) {
      const port = this.port + i
      const server = await this.bind(host, port, sockets, true)
      if (server) { this.lan = { server, host, port, sockets }; return this.lanInfo() }
    }
    throw new Error(`局域网监听起不来：${host} 上 ${this.port}~${this.port + 9} 端口都被占了`)
  }

  /** openLan 的 bind 换成要监听的地址；不合适就抛错（不动任何东西，开房前可以先拿它检查）。 */
  lanHost(bind = 'auto') {
    const addrs = lanAddresses()
    const list = () => addrs.map((a) => `${a.address}（${a.name}${a.vlan ? `，${a.vlan}` : ''}）`).join('、') || '没有局域网地址'
    let host
    if (bind === 'all') host = '0.0.0.0'
    else if (bind && bind !== 'auto') {
      if (!addrs.some((a) => a.address === bind)) throw new Error(`这台电脑没有 ${bind} 这个地址。现在有：${list()}`)
      host = bind
    } else {
      const vlans = addrs.filter((a) => a.vlan)
      host = addrs.find((a) => a.vlan === 'UU')?.address || (vlans.length === 1 ? vlans[0].address : null)
      if (!host) throw new Error(`没找到 UU 云联机这类虚拟局域网的网卡（先进 UU 房间再开桌）。要用别的网卡就把 lan_ip 设成它的 IP，或者 all（所有网卡，家里局域网的设备也连得到）。这台电脑现在有：${list()}`)
    }
    return host
  }

  /** 局域网监听的情况：{ host, port, addresses: [{ name, address, vlan, origin }] }；没开是 null。 */
  lanInfo() {
    if (!this.lan) return null
    const { host, port } = this.lan
    const addrs = lanAddresses().filter((a) => host === '0.0.0.0' || a.address === host)
    return { host, port, addresses: addrs.map((a) => ({ ...a, origin: `http://${a.address}:${port}` })) }
  }

  async closeLan() {
    clearTimeout(this.lanCloseTimer)
    this.lanCloseTimer = null
    const lan = this.lan
    if (!lan) return
    this.lan = null
    for (const sock of lan.sockets) sock.destroy()
    await new Promise((resolve) => lan.server.close(() => resolve()))
  }

  /** 没有还在打的联机房了：过一会儿关掉局域网监听（散场后让朋友看完结算）。 */
  lanCheck() {
    if (!this.lan || this.lanCloseTimer) return
    if ([...this.rooms.values()].some((r) => r.online && (r.status === 'lobby' || r.status === 'playing'))) return
    this.lanCloseTimer = setTimeout(() => {
      this.lanCloseTimer = null
      if (![...this.rooms.values()].some((r) => r.online && (r.status === 'lobby' || r.status === 'playing'))) this.closeLan().catch(() => {})
    }, LAN.closeDelayMs)
    this.lanCloseTimer.unref?.()
  }

  /** 现有的彩蛋曲子：{ other: 文件路径, self: 文件路径 }（缺哪个就没有哪个）。前面的目录优先。 */
  eggs() {
    const out = {}
    for (const dir of this.eggDirs) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const [key, base] of Object.entries(EGG_FILES)) {
        if (out[key]) continue
        const f = names.find((n) => path.parse(n).name === base && AUDIO_TYPES[path.extname(n).toLowerCase()])
        if (f) out[key] = path.join(dir, f)
      }
    }
    return out
  }

  /** 自定义 BGM 文件（排好序的完整路径）；没有目录或没有音频就是空的，网页就用合成的。 */
  bgmFiles() {
    try {
      return fs.readdirSync(this.bgmDir).filter((n) => AUDIO_TYPES[path.extname(n).toLowerCase()]).sort().map((n) => path.join(this.bgmDir, n))
    } catch { return [] }
  }

  openRoom(opts) {
    const room = new Room({ logger: this.logger, ...opts, onEnd: () => { this.prune(); this.lanCheck() } })
    room.eggs = Object.keys(this.eggs())
    room.bgm = this.bgmFiles() // 开房时定下来，网页按编号要
    this.rooms.set(room.code, room)
    // 不马上开局：先进大厅，四家都准备了才开（机器人自动准备）
    room.maybeStart()
    return room
  }

  activeRoom() {
    for (const r of this.rooms.values()) if (r.status === 'playing' || r.status === 'lobby') return r
    return null
  }

  prune() {
    const ended = [...this.rooms.values()].filter((r) => r.status === 'ended' || r.status === 'aborted').sort((a, b) => a.endedAt - b.endedAt)
    while (ended.length > KEEP_ENDED) this.rooms.delete(ended.shift().code)
  }

  seatUrl(room, seat) { return `${this.origin}/room/${room.code}/?t=${seat.token}` }
  watchUrl(room, seatId) { return `${this.origin}/room/${room.code}/?w=${room.watchToken(seatId)}` }
  debugUrl() { return `${this.origin}/debug?k=${this.adminKey}` }

  /** 失败限流：本机那一路一分钟 8 次；局域网那一路（ip 带 lan: 前缀）更严，见 LAN。 */
  limited(ip) {
    const now = Date.now()
    const lan = ip.startsWith('lan:')
    const list = (this.fails.get(ip) || []).filter((t) => now - t < (lan ? LAN.failWindowMs : 60_000))
    this.fails.set(ip, list)
    return list.length >= (lan ? LAN.failLimit : 8)
  }

  fail(ip) { (this.fails.get(ip) || this.fails.set(ip, []).get(ip)).push(Date.now()) }

  async handle(req, res, { lan = false } = {}) {
    const url = new URL(req.url || '/', 'http://table.invalid')
    const parts = url.pathname.split('/').filter(Boolean)
    const ip = (lan ? 'lan:' : '') + (req.socket.remoteAddress || '?')
    const method = req.method || 'GET'

    if (parts.length === 0) return text(res, 200, 'riichi table server\n')
    if (lan && this.limited(ip)) return json(res, 429, { error: '失败次数太多，过一会儿再试' })
    if (parts[0] === 'debug') {
      // 调试页只给本机（钥匙在本机 DSH 里），局域网那一路一律当不存在
      if (lan) { this.fail(ip); return text(res, 404, 'not found') }
      if (!safeEq(url.searchParams.get('k'), this.adminKey)) { this.fail(ip); return text(res, 403, '钥匙不对') }
      if (parts[1] === 'state') return json(res, 200, { now: Date.now(), port: this.port, rooms: [...this.rooms.values()].map((r) => r.debugInfo()) })
      if (parts[1] === 'selftest' && method === 'POST') {
        const r = await this.onSelftest?.()
        return json(res, 200, r || { error: '没有接自测' })
      }
      return file(res, 'debug.html')
    }
    if (parts[0] !== 'room' || !parts[1]) return text(res, 404, 'not found')

    if (this.limited(ip)) return json(res, 429, { error: '失败次数太多，一分钟后再试' })
    const room = this.rooms.get(parts[1].toUpperCase())
    // 局域网那一路只认联机房：不联机的房间从外面看就是不存在
    if (!room || (lan && !room.online)) { this.fail(ip); return json(res, 404, { error: '没有这个房间' }) }
    const sub = parts[2] || ''

    if (sub === '' && method === 'GET') return file(res, 'table.html')

    if (sub === 'join' && method === 'POST') {
      // 房间码只用来入座；拿到座位令牌后，后续请求都看令牌
      const body = await readJson(req)
      if (room.status !== 'lobby') return json(res, 409, { error: '已经开局了，入不了座' })
      // owner：联机时朋友的插件替她和她的主人一起领座位，两人登记成“一家”（块 8）
      const owner = body?.owner && typeof body.owner === 'object' ? body.owner : null
      const free = room.players.filter((p) => p.slot && !p.claimed).length
      if (free < (owner ? 2 : 1)) return json(res, 409, { error: owner ? `空座不够：要 2 个（你和你的主人），只剩 ${free} 个` : '没有空座位' })
      // mode = 'poll'：命令行客户端，不常连着，掉线代打放宽到 5 分钟
      const a = room.claimSlot({ name: body?.name, color: body?.color, kind: body?.kind === 'agent' ? 'agent' : 'remote', poll: body?.mode === 'poll' })
      let ownerOut = null
      if (owner) {
        const o = room.claimSlot({ name: owner.name, color: owner.color, kind: 'human' })
        room.addFamily([a.seat.id, o.seat.id])
        ownerOut = { seat: o.seat.id, name: o.seat.name, color: room.seatInfo[o.seat.id].color, token: o.seat.token, ...(o.warning ? { warning: o.warning } : {}) }
      }
      // watch：她的主人不上桌、要旁观她的视角时，顺带要一个只读的旁观令牌
      const watch = body?.watch ? room.watchToken(a.seat.id) : null
      room.lobbyChanged()
      return json(res, 200, {
        seat: a.seat.id, name: a.seat.name, color: room.seatInfo[a.seat.id].color, token: a.seat.token, events: `/room/${room.code}/seat/events`,
        ...(a.warning ? { warning: a.warning } : {}), ...(ownerOut ? { owner: ownerOut } : {}), ...(watch ? { watch } : {}), room: room.publicInfo(),
      })
    }

    const auth = bearer(req) || url.searchParams.get('t')
    const watchT = url.searchParams.get('w')

    if (sub === 'egg' && method === 'GET') {
      // <audio> 加不了头，令牌走 ?t= / ?w=；座位和旁观都能听
      if (!room.seatByToken(auth) && room.watchSeat(watchT) == null) { this.fail(ip); return json(res, 401, { error: '令牌不对' }) }
      const f = this.eggs()[parts[3]]
      if (!f) return json(res, 404, { error: '没有这首' })
      return audioFile(req, res, f)
    }
    if (sub === 'bgm' && method === 'GET') {
      // 自定义 BGM 按编号要（文件名不出现在地址里）；鉴权同彩蛋
      if (!room.seatByToken(auth) && room.watchSeat(watchT) == null) { this.fail(ip); return json(res, 401, { error: '令牌不对' }) }
      const f = /^\d+$/.test(parts[3] || '') ? (room.bgm || [])[+parts[3]] : null
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: '没有这首' })
      return audioFile(req, res, f)
    }

    if (sub === 'seat' || sub === 'watch') {
      const action = parts[3] || ''
      if (sub === 'watch') {
        const seatId = room.watchSeat(watchT)
        if (seatId == null) { this.fail(ip); return json(res, 401, { error: '旁观令牌不对' }) }
        if (action !== 'events') return json(res, 404, { error: '旁观只能看' })
        const target = room.players[seatId]
        const s = sse(req, res)
        room.watchers.add(s)
        s.seat = seatId
        s.send('sync', { seat: seatId, watching: true, name: target.name, room: room.publicInfo(), lobby: room.lobbyInfo(), log: target.log, view: target.view?.(), decision: null, chat: room.chatLog.slice(-30), eggs: room.eggs || [], bgm: (room.bgm || []).length })
        req.on('close', () => room.watchers.delete(s))
        return
      }
      const seat = room.seatByToken(auth)
      if (!seat) { this.fail(ip); return json(res, 401, { error: '座位令牌不对' }) }
      if (action === 'events' && method === 'GET') {
        const s = sse(req, res)
        const off = seat.subscribe(s)
        req.on('close', off)
        return
      }
      if (action === 'act' && method === 'POST') {
        const body = await readJson(req)
        if (!body || !Number.isInteger(body.rev) || !Number.isInteger(body.choice)) return json(res, 400, { error: '要 {rev, choice}' })
        // proxy：座位客户端自己承认这手是机器人代打的（比如模型接口出错），桌上要写明
        const proxy = body.proxy ? String(body.proxy).slice(0, 40) : null
        if (seat.left) return json(res, 409, { error: '你已经离桌了，这一桌由机器人接着打' })
        const callWindow = !!seat.pending?.options.some((o) => o.kind === 'skip')
        const r = seat.act(body.rev, body.choice, body.say, proxy ? `代打·${proxy}` : 'seat')
        if (proxy && r.ok) { seat.stats.takeovers++; room.takeoverNote(seat, proxy, callWindow) }
        return json(res, r.ok ? 200 : r.status, r)
      }
      if (action === 'leave' && method === 'POST') {
        const r = seat.leave()
        return json(res, r.ok ? 200 : r.status, r)
      }
      if (action === 'close' && method === 'POST') {
        // 网页上的“结束对局”：只有房主本人的座位能点（联机时朋友本人也是真人座位，但不是房主）
        if (!seat.host) return json(res, 403, { error: '只有房主能结束对局' })
        if (room.status !== 'playing' && room.status !== 'lobby') return json(res, 409, { error: '这一桌已经结束了' })
        room.abort(`${seat.name} 结束了对局`, 'owner-web')
        return json(res, 200, { ok: true })
      }
      if (action === 'ready' && method === 'POST') {
        const body = await readJson(req)
        const r = room.setReady(seat, body?.ready !== false)
        return json(res, r.ok ? 200 : r.status, r)
      }
      if (action === 'profile' && method === 'POST') {
        const body = await readJson(req)
        if (!body) return json(res, 400, { error: '要 {name?, color?}' })
        const r = room.setProfile(seat, { name: body.name, color: body.color })
        return json(res, r.ok ? 200 : r.status, r)
      }
      if (action === 'say' && method === 'POST') {
        const body = await readJson(req)
        const t = String(body?.text || '').trim()
        if (!t) return json(res, 400, { error: '要 {text}' })
        room.chat(seat.id, t.slice(0, 200))
        return json(res, 200, { ok: true })
      }
      if (action === 'state' && method === 'GET') {
        if (seat.polling) seat.backOnline() // 命令行座位来看牌面，说明还活着
        return json(res, 200, { room: room.publicInfo(), lobby: room.lobbyInfo(), view: seat.view(), decision: seat.decision(), chat: room.chatLog.slice(-30), left: seat.left })
      }
    }
    return json(res, 404, { error: 'not found' })
  }
}

function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write(': hi\n\n')
  // 关掉以后（离桌时服务端主动断开）req 的 close 可能还没到，这期间别的广播还会来写：
  // 往已经结束的响应上写会抛到宿主进程（可能带垮 DSH），所以一律先看还能不能写
  const live = () => !res.writableEnded && !res.destroyed
  const ping = setInterval(() => { if (live()) res.write(': ping\n\n') }, 15_000)
  req.on('close', () => clearInterval(ping))
  return {
    send: (type, data) => { if (live()) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) },
    close: () => { clearInterval(ping); if (live()) res.end() },
  }
}

function bearer(req) {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function safeEq(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) return null
    chunks.push(c)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return null }
}

function json(res, status, body) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

function text(res, status, s) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

/** 放音频，支持 Range（浏览器拖进度、循环播放会用到）。 */
function audioFile(req, res, f) {
  const size = fs.statSync(f).size
  const type = AUDIO_TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream'
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  let start = 0, end = size - 1
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1) } else start = Math.max(0, size - +m[2])
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
  }
  res.writeHead(m && (m[1] || m[2]) ? 206 : 200, {
    'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    ...(m && (m[1] || m[2]) ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  fs.createReadStream(f, { start, end }).pipe(res)
}

function file(res, name) {
  const body = fs.readFileSync(path.join(WEB, name))
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    // 地址里有令牌：不带 referrer 出去
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}
