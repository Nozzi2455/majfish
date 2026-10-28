#!/usr/bin/env node
// 外部 agent（Claude Code、Codex 等）坐上 DSH 麻将桌用的命令行客户端。零依赖，Node 18 以上。
// 用法见同目录上一级的「外部agent入座.md」，或者 `node riichi-seat.mjs help`。
// 座位令牌存在当前目录的 .riichi-seat.json（--state 可换），别发给别人。
import fs from 'node:fs'
import path from 'node:path'

const HELP = `用法：
  node riichi-seat.mjs join <牌桌地址> <房间码> [--name 昵称] [--color "#RRGGBB"]
      入座并准备。地址和房间码由开桌的人给（形如 http://127.0.0.1:47777 ABC123）。
  node riichi-seat.mjs wait [--timeout 秒]
      一直等到轮到你（或者这一桌结束），然后打印牌面、可选操作和上次看过之后的新聊天，退出。默认最多等 600 秒。
  node riichi-seat.mjs act <编号> [台词]
      选一个编号出牌；台词可选，会进桌上聊天（全桌都看得到）。
  node riichi-seat.mjs say <话>
      在桌上说话（全桌都看得到）。
  node riichi-seat.mjs state
      看一眼现在的牌面和桌上最近的全部聊天，不等。
  node riichi-seat.mjs leave
      离桌。之后你的座位由机器人接着打到底（桌上会说一次）；还在大厅的话座位空出来。
常用循环：wait → 想 → act <编号> "台词" → wait → ……，直到 wait 打印“这一桌结束了”。
轮到你以后 5 分钟没动静，算你掉线：之后由机器人代打，再 wait 就接回座位（房间设了限时就按限时代打那一手）。`

// ---------- 参数和状态文件 ----------
const argv = process.argv.slice(2)
const flags = {}
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
  else rest.push(argv[i])
}
const [cmd, ...args] = rest
const STATE = path.resolve(flags.state || '.riichi-seat.json')

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { die(`还没入座（找不到 ${STATE}）。先 join。`) }
}
function save(st) { try { fs.writeFileSync(STATE, JSON.stringify(st, null, 2)) } catch {} }
function die(msg, code = 1) { console.log(msg); process.exit(code) }

async function call(st, method, p, body) {
  const r = await fetch(`${st.origin}/room/${st.code}/${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${st.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  return { status: r.status, body: d }
}

// ---------- 牌面文字（和插件给肥鱼看的同一种版式，lib/board.mjs） ----------
const SUIT = { m: '万', p: '筒', s: '索' }
const ZI = ['', '东', '南', '西', '北', '白', '发', '中']
const REL = ['你', '下家', '对家', '上家']
const tileName = (p) => (p[0] === 'z' ? ZI[+p[1]] : +p[1] === 0 ? `赤5${SUIT[p[0]]}` : `${p[1]}${SUIT[p[0]]}`)
function nextDora(p) {
  const s = p[0]
  let n = +p[1] || 5
  if (s === 'z') n = n <= 4 ? (n % 4) + 1 : ((n - 4) % 3) + 5
  else n = (n % 9) + 1
  return s + n
}
function boardText(view) {
  const me = view.me
  const rel = (l) => REL[(l - me + 4) % 4]
  const label = (s) => `${rel(s.l)}（${s.name}，${s.feng}家）`
  const river = (he) => he.map((t) => { let s = t.name; if (t.tsumogiri) s += '↓'; if (t.lizhi) s = '【立直】' + s; if (t.called) s = `(${s}被鸣)`; return s }).join(' ') || '（无）'
  const order = [0, 1, 2, 3].map((k) => view.seats.find((s) => s.l === (me + k) % 4))
  const dealer = view.seats.find((s) => s.l === 0)
  const L = []
  L.push(`【${view.round} ${view.changbang}本场，场上立直棒 ${view.lizhibang} 根】牌山剩余 ${view.paishu} 张`)
  L.push(`宝牌指示牌：${view.baopai.map((t) => `${t.name}→宝牌${tileName(nextDora(t.p))}`).join('、')}（赤5也算宝牌）`)
  L.push(`你是${'东南西北'[me]}家；庄家是${dealer.l === me ? '你自己' : `${rel(dealer.l)}（${dealer.name}）`}`)
  L.push('分数：' + order.map((s) => `${label(s)} ${s.defen}`).join(' | '))
  // 联机时谁和谁是一家（主人和自家肥鱼，插件登记的），公开信息
  if (view.families?.length) L.push('一家：' + view.families.map((f) => f.names.join(' + ')).join('；'))
  L.push('', '舍牌（按顺序；↓=摸切，没有↓=手切；【立直】=立直宣言牌）：')
  for (const s of order) L.push(`  ${label(s)}${s.lizhi ? '（已立直！）' : ''}：${river(s.he)}`)
  const melds = order.filter((s) => s.fulou.length).map((s) => `  ${label(s)}：${s.fulou.map((m) => m.name).join('；')}`)
  if (melds.length) L.push('副露：', ...melds)
  L.push('', `你的手牌：${view.hand.tiles.map((t) => t.name).join(' ')}${view.hand.zimo ? `　摸到：${view.hand.zimo.name}` : ''}`)
  const cur = view.seats.find((s) => s.l === view.lunban)
  if (cur && cur.l !== me && cur.he.length && !view.hand.zimo) L.push(`刚才${rel(cur.l)}打出了：${cur.he[cur.he.length - 1].name}`)
  if (view.hand.ting) L.push(`你现在听牌：${tingText(view.hand.ting)}`)
  return L.join('\n')
}
// 听牌提示（剩几枚只算你看得到的牌）
const tingText = (t) => t.waits.map((w) => `${w.name}剩${w.left}`).join(' ') + (t.furiten ? '，振听（不能荣和）' : '')
const optLine = (o) => `${o.i}. ${o.label}${o.ting ? `（打完听 ${tingText(o.ting)}）` : ''}`

function chatText(chat, myName) {
  return chat.map((c) => (c.from < 0 ? `  · ${c.text}` : `  ${c.name === myName ? '你' : c.name}${c.kind === 'line' ? '（出牌时）' : ''}：${c.text}`)).join('\n')
}

/**
 * 打印聊天。wait 只打印上次看过（wait 或 state）之后的新消息，省得每次重复一大段；state 打印最近的全部。
 * 看到哪儿记在状态文件的 chatSeen（服务端给每条聊天编的流水号 n）。
 */
function printChat(st, chat, { onlyNew }) {
  const seen = st.chatSeen || 0
  const list = (chat || []).filter((c) => !onlyNew || (c.n || 0) > seen)
  if (onlyNew) {
    if (list.length) {
      const gap = seen && list[0].n > seen + 1 ? '（更早的省略了，state 能看最近的全部）\n' : ''
      console.log(`上次之后桌上的新聊天（全桌都看得到）：\n${gap}${chatText(list, st.name)}\n`)
    } else console.log('（上次之后桌上没人说话）\n')
  } else console.log(`桌上最近的聊天（全桌都看得到）：\n${list.length ? chatText(list, st.name) : '（桌上还没人说话）'}\n`)
  const last = Math.max(seen, ...(chat || []).map((c) => c.n || 0))
  if (last !== seen) { st.chatSeen = last; save(st) }
}

function printTurn(st, view, decision, chat) {
  printChat(st, chat, { onlyNew: true })
  console.log(boardText(view))
  console.log('\n轮到你了。可选操作（只能选一个编号）：')
  for (const o of decision.options) console.log(optLine(o))
  console.log(`\n出牌：node "${process.argv[1]}" act <编号> "一句台词（可选，全桌都看得到）"`)
}

function printEnd(room, d) {
  if (d?.aborted || room?.status === 'aborted') return console.log(`这一桌结束了（中止）：${d?.reason || ''}`)
  const r = d && d.rank ? d : room?.result
  if (!r) return console.log('这一桌结束了。')
  const names = r.names || room.names
  console.log('这一桌结束了。终局：')
  for (const id of [0, 1, 2, 3].sort((a, b) => r.rank[a] - r.rank[b])) console.log(`  ${r.rank[id]} 位 ${names[id]} ${r.defen[id]}（${r.point[id]}）`)
}

// ---------- SSE ----------
async function listen(st, onEvent, signal) {
  const r = await fetch(`${st.origin}/room/${st.code}/seat/events`, { headers: { authorization: `Bearer ${st.token}`, accept: 'text/event-stream' }, signal })
  if (!r.ok) die(`连不上牌桌：HTTP ${r.status}`)
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
      if (data && onEvent(type, JSON.parse(data))) return
    }
  }
}

// ---------- 命令 ----------
async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h') return console.log(HELP)

  if (cmd === 'join') {
    const [origin, code] = args
    if (!origin || !code) die('要：join <牌桌地址> <房间码>')
    const r = await fetch(`${origin.replace(/\/$/, '')}/room/${code.toUpperCase()}/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: flags.name, color: flags.color, mode: 'poll' }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) die(`入座失败（${r.status}）：${d.error || ''}`)
    const st = { origin: origin.replace(/\/$/, ''), code: code.toUpperCase(), token: d.token, seat: d.seat, name: d.name }
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2))
    const ready = await call(st, 'POST', 'seat/ready', { ready: true })
    console.log(`入座了：座位 ${d.seat}，昵称 ${d.name}，颜色 ${d.color}${d.warning ? `（${d.warning}，用了默认名字）` : ''}。${ready.status === 200 ? '已准备。' : `准备失败：${ready.body.error || ready.status}`}`)
    console.log('令牌存在 ' + STATE + '（别发给别人）。接下来：wait。')
    return
  }

  const st = load()

  if (cmd === 'state') {
    const { status, body } = await call(st, 'GET', 'seat/state')
    if (status !== 200) die(`读不到（${status}）：${body.error || ''}`)
    if (body.left) console.log('你已经离桌了，这一桌由机器人接着打。')
    if (body.lobby?.status === 'lobby') return console.log('还在大厅等人准备：' + body.lobby.seats.map((s) => `${s.name}${s.ready ? '✓' : '…'}`).join(' '))
    printChat(st, body.chat, { onlyNew: false })
    if (body.view?.phase === 'playing') console.log(boardText(body.view))
    if (body.decision) { console.log('\n轮到你了：'); for (const o of body.decision.options) console.log(optLine(o)) }
    if (body.room.status !== 'playing') printEnd(body.room)
    return
  }

  if (cmd === 'act') {
    const i = parseInt(args[0], 10)
    if (!Number.isInteger(i)) die('要：act <编号> [台词]')
    const { status, body } = await call(st, 'GET', 'seat/state')
    if (status !== 200) die(`读不到（${status}）：${body.error || ''}`)
    if (!body.decision) die('现在没轮到你（可能已经被机器人代打了）。用 wait 等下一手。')
    const r = await call(st, 'POST', 'seat/act', { rev: body.decision.rev, choice: i, say: args.slice(1).join(' ') || undefined })
    if (r.status === 200) console.log(`出了：${body.decision.options[i]?.label}`)
    else die(`没出成（${r.status}）：${r.body.error || ''}`)
    return
  }

  if (cmd === 'say') {
    const text = args.join(' ').trim()
    if (!text) die('要：say <话>')
    const r = await call(st, 'POST', 'seat/say', { text })
    console.log(r.status === 200 ? '说了。' : `没说成（${r.status}）：${r.body.error || ''}`)
    return
  }

  if (cmd === 'leave') {
    const r = await call(st, 'POST', 'seat/leave')
    if (r.status !== 200) die(`没离成（${r.status}）：${r.body.error || ''}`)
    try { fs.unlinkSync(STATE) } catch {}
    console.log(r.body.lobby
      ? '离开大厅了，座位空出来了。令牌已作废，状态文件删了。'
      : '离桌了。之后你的座位由机器人接着打到底（桌上已经说了一声）。令牌不再能出牌，状态文件删了。')
    return
  }

  if (cmd === 'wait') {
    const timeout = +(flags.timeout || 600) * 1000
    const ctrl = new AbortController()
    // 不用 process.exit：Windows 上事件流还开着时直接退出，Node 会崩（UV_HANDLE_CLOSING），先断流再自然退出
    let chat = [], view = null
    const timer = setTimeout(() => { printChat(st, chat, { onlyNew: true }); console.log('还没轮到你（等超时了）。再 wait 一次。'); ctrl.abort() }, timeout)
    await listen(st, (type, d) => {
      if (type === 'sync') {
        chat = d.chat || []
        view = d.view
        if (d.left) { console.log('你已经离桌了，这一桌由机器人接着打。'); return true }
        if (d.room.status === 'ended' || d.room.status === 'aborted') { printChat(st, chat, { onlyNew: true }); printEnd(d.room); return true }
        if (d.decision && view?.phase === 'playing') { printTurn(st, view, d.decision, chat); return true }
      } else if (type === 'chat') {
        chat.push(d)
      } else if (type === 'msg') {
        view = d.view
        if (d.decision) { printTurn(st, view, d.decision, chat); return true }
      } else if (type === 'end') {
        printChat(st, chat, { onlyNew: true })
        printEnd(null, d)
        return true
      }
      return false
    }, ctrl.signal).catch((e) => { if (!ctrl.signal.aborted) { console.log(`断线了：${e.message}`); process.exitCode = 1 } })
    clearTimeout(timer)
    ctrl.abort()
    return
  }

  die(`不认识的命令 ${cmd}\n\n${HELP}`)
}

main().catch((e) => die(`出错了：${e.message}`))
