// majfish：DSH 立直麻将插件（10-28 晚主人定名；之前的临时包名是 dsh-fish-riichi）。
// 这里只做 DSH 适配：五个工具 + 一条带 DSH 鉴权的路由；牌桌本体在 lib/server.mjs，用自己的端口。
import { TableServer } from './lib/server.mjs'
import { SeatClient, AiBrain } from './lib/seat-client.mjs'
import { FishBrain, selfText } from './lib/fish-brain.mjs'
import { SessionLink, userMessage, ownerText } from './lib/session-link.mjs'
import { RemoteTable, JOIN } from './lib/remote-table.mjs'
import { Memory, MAX_NOTES } from './lib/memory.mjs'
import { startSelftest } from './lib/selftest.mjs'
import { SUBAGENT, CHAT_GAP, chatGapSec, taskPrompt, dispatchText, stateFile, workspaceRoot, seatStateText } from './lib/subagent-seat.mjs'
import { normalizeColor, cleanName, DEFAULT_COLORS, familiesSentence } from './lib/room.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
// 外部 agent（Claude Code、Codex 等）入座用的零依赖命令行客户端
const SEAT_CLI = path.join(PLUGIN_DIR, 'cli', 'riichi-seat.mjs')
const LAN_GUIDE = path.join(PLUGIN_DIR, '联机说明.md')

export const name = 'majfish'
export const inject = ['tools', 'llm']

const ROUTE = '/majfish'
const BOT_NAMES = ['机器人甲', '机器人乙', '机器人丙']

const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

function obj(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

// 开局设置清单（主人 10-28 晚：做进插件里，她读完先把能改的设置全列给主人）。
// 工具说明和“还没确认”时的返回都从这张表生成，改设置项只改这里。
const SETTINGS = [
  ['局数', 'length', '东风战 / 半庄战', '东风战'],
  ['规则', 'rules', '雀魂 / 天凤', '雀魂'],
  ['主人上不上桌', 'owner_plays', '上桌 / 不上桌（不上桌就是你和机器人打，主人旁观你的视角）', '上桌'],
  ['联机', 'online', '开 / 关（开了，别的电脑上的朋友能带着他们的肥鱼入座；要先开好 UU 加速器“云联机”这类局域网联机工具、两边进同一个房间）', '关'],
  ['联机开在哪张网卡', 'lan_ip', '自动（只开在 UU 云联机这类虚拟局域网的网卡上；找不到会提示，不会悄悄开到所有网卡）/ all（所有网卡，家里局域网的设备也连得到）/ 某个具体 IP。只有联机时才有用', '自动'],
  ['外部座位', 'outside_seats', '留给别人入座的座位数：本机的 Claude Code、Codex（命令行入座），联机时还有朋友的肥鱼和朋友本人（各占一个）。主人上桌最多 2 个，不上桌最多 3 个；剩下的座位都是机器人', '不联机 0；联机时把剩下的座位全留给朋友'],
  ['机器人难度', 'bot_level', '强 / 中 / 弱（剩下的座位都是机器人）', '强'],
  ['你的座位谁来打', 'seat_mode', 'subagent / plugin。subagent：你派一个子代理坐你的座位，打牌和桌上说话全交给它，它打完自己收工、把报告交回给你（实测比 plugin 便宜、出牌快）；plugin：插件每一手替你问一次模型出牌，桌上说话你在这个对话里用 riichi_say', 'subagent'],
  ['你的思考档位', 'effort', 'off / low / high。subagent 模式下就是子代理的思考档位；plugin 模式下是插件每手出牌的档位（off 完全不想、基本秒出；low 每手大约十几秒；high 更慢更细）', 'subagent 模式 high，plugin 模式 off'],
  ['聊天叫醒间隔', 'chat_wake_gap_sec', `只管 subagent 模式：子代理等牌时别人在桌上说话，会把它叫醒来看、想回就回（攒 3 秒一起看）；两次这样叫醒之间至少隔多少秒。0（不因聊天叫醒，只在轮到它出牌时看聊天）或 ${CHAT_GAP.min}~${CHAT_GAP.max} 秒；越短回话越及时，也越费钱。轮到它出牌时永远马上叫醒，不受这个限制`, `${CHAT_GAP.dflt} 秒`],
  ['每手限时', 'time_limit_sec', '不限，或者多少秒（超时由机器人代打那一手；选 high 又要限时的话提醒主人放宽，60 秒以内 high 会经常超时）', '不限'],
  ['主人的昵称', 'owner_name', '主人在桌上叫什么（主人上桌时必须确认）', '主人'],
  ['主人的昵称颜色', 'owner_color', '颜色名或 #RRGGBB（太暗会自动调亮）', '橙 #ffb454'],
  ['你的昵称', 'my_name', '你自己在桌上叫什么（必须确认）', '肥鱼'],
  ['你的昵称颜色', 'my_color', '颜色名或 #RRGGBB', '天蓝 #5ec8f2'],
  ['你的牌桌人设卡', 'persona', '几句话：打法风格、说话口气', '沿用你上次写的'],
]
const SETTINGS_TEXT = SETTINGS.map(([label, key, choices, dflt], i) => `${i + 1}. ${label}（${key}）：${choices}。默认：${dflt}`).join('\n')
const SETTINGS_EXTRA = '开局后牌桌网页上主人还能自己调：大厅里改自己的昵称和颜色；右上角“声音”里开关、调音量（音效、BGM、立直彩蛋）；“结束对局”按钮。'

const OPEN_DESCRIPTION = [
  '开一桌立直麻将（四人），你自己坐一个座位，牌桌是网页，主人点链接就能在浏览器里打。',
  '⚠️ 规矩：主人说“来一盘麻将”之类的话时，**先不要调这个工具**。第一件事是把下面这张设置清单完整列给主人（每项能选什么、默认是什么，可以用你的口吻，但别漏项），问他要改哪些；等主人明确确认后再调，并且 confirmed 传 true：',
  SETTINGS_TEXT,
  SETTINGS_EXTRA,
  '昵称两个都要确认：主人的（owner_name）和你自己的（my_name）。主人说“用默认”也行，但你得把确认好的名字明确传进来，不传就开不了。主人说颜色名（比如“粉色”）你自己换成 #RRGGBB。',
  '主人说“都默认”也算确认。没给的设置用默认值，返回里会写明用了哪些默认值。',
  '调用后会返回房间码和牌桌链接：把链接原样发给主人，他点开就在浏览器里打开（链接里带着他的座位令牌，别发给别人）。',
  '开房后先进大厅：所有座位都点了“准备”才开局（机器人和你的座位自动准备，主人要在网页上点）。主人在大厅里也能再改自己的昵称和颜色。',
  '同一时间只开一桌；已经有一桌在打时，要换桌得传 replace: true。',
  'persona（牌桌人设卡）不传就沿用你上次写的那份；第一次开局时写几句：打法风格、说话口气。',
  'seat_mode = subagent（默认）：开好以后返回里有一份插件写好的子代理任务说明，照返回说的马上调 subagent 工具派子代理（reasoning_effort 用 effort 的档位），任务说明原样当 prompt。之后打牌和桌上说话都是子代理的事：这个对话不转桌上聊天，你也不用 riichi_say；子代理打完自己收工，它的报告会送回这个对话。一局一个子代理：每开一局都派一个全新的，不要把上一局的子代理叫回来接着打。',
  'seat_mode = plugin：你的每一手是你自己的牌感：同一个模型带着你的人设卡和笔记快速出牌，出牌时随手记一句理由，你在这个对话里看得到自己打了什么、为什么打（转给你的消息、riichi_status 里都有）。出牌时你看得到桌上的聊天，包括你自己在桌上说过的话；这个对话里私下说的，出牌时顾不上。出牌时不说话，桌上说话只有一个办法：在这个对话里调 riichi_say。桌上别人说的话会转到这个对话里给你；你自己立直、和了、放铳的时候也会提醒你一次。说不说、说什么都由你自己决定，不说完全正常。',
  '座位号不是风位：风位每局跟着庄家转。返回、riichi_status 和转给你的消息里都会写明你这一局是哪家、庄家是谁。',
  '主人说不打了、要关掉时，调 riichi_close。',
  '联机（online）：返回里有给朋友的入座信息（地址、端口、房间码），原样交给主人发给朋友。朋友连不上多半是房主这台的 Windows 防火墙没放行，让主人照插件目录里的 联机说明.md 做；你不要自己去改防火墙或任何系统设置。',
].join('\n')

// 联机时去别人开的桌（riichi_join）要先问的设置：开局设置里跟“自己这一家”有关的那几项
const JOIN_KEYS = ['owner_plays', 'seat_mode', 'effort', 'chat_wake_gap_sec', 'owner_name', 'owner_color', 'my_name', 'my_color', 'persona']
const JOIN_SETTINGS_TEXT = SETTINGS.filter(([, key]) => JOIN_KEYS.includes(key)).map(([label, key, choices, dflt], i) => `${i + 1}. ${label}（${key}）：${choices}。默认：${dflt}`).join('\n')

const JOIN_DESCRIPTION = [
  '联机：坐进别人（朋友的 DSH）开好的麻将桌。朋友会给主人一个牌桌地址（形如 http://172.19.163.2:47777）和一个 6 位房间码。',
  '⚠️ 规矩：主人让你去朋友的桌时，**先不要调这个工具**。先把下面几项列给主人确认（这些是你们这一家的设置，局数、规则、机器人这些由开桌的人定）：',
  JOIN_SETTINGS_TEXT,
  '昵称两个都要确认（主人不上桌就只要你自己的）。确认后再调，confirmed 传 true。',
  '两台电脑要先在同一个局域网里（比如两边都开 UU 加速器的“云联机”、进同一个房间）。',
  '主人上桌的话，插件会替你和主人一起领座位，你们俩在桌上公开标成“一家”；主人坐几号座位、桌上叫什么，插件会私下告诉你（以插件说的为准，桌上别人改名字冒充不了）。返回里有主人的牌桌链接（主人不上桌就是旁观你视角的链接），原样发给主人。',
  '入座后跟自己开桌一样。seat_mode = subagent（默认）：照返回说的马上调 subagent 工具派子代理，插件写好的任务说明原样当 prompt；打牌和桌上说话都交给它，它打完自己收工、报告送回这个对话。',
  'seat_mode = plugin：你的每一手是你自己的牌感：同一个模型带着你的人设卡和笔记快速出牌，出牌时随手记一句理由，你在这个对话里看得到自己打了什么、为什么打（转给你的消息、riichi_status 里都有）。出牌时你看得到桌上的聊天，包括你自己在桌上说过的话；这个对话里私下说的，出牌时顾不上。桌上别人说的话转进这个对话，想说就调 riichi_say；riichi_status 看进度。',
  '不打了调 riichi_close：你不是房主，结束不了整桌，会替你和主人离桌（之后由机器人接着打）。只有开桌的人能结束对局。',
].join('\n')

/** 终局后送进她会话的回顾请求：结果、她这场的台词、别人对她说的话、旧笔记。 */
function reviewPrompt(room, seat, notes, saved, { subagent = false } = {}) {
  const r = room.result
  const order = [0, 1, 2, 3].sort((a, b) => r.rank[a] - r.rank[b])
  const mine = room.chatLog.filter((c) => c.from === seat).slice(-12).map((c) => `  ${c.text}`)
  const others = room.chatLog.filter((c) => c.from >= 0 && c.from !== seat).slice(-10).map((c) => `  ${c.name}：${c.text}`)
  const hule = room.events.filter((e) => /和|流局/.test(e.text) && !e.text.startsWith('【桌】')).slice(-12).map((e) => `  ${e.text}`)
  const lines = [`【麻将桌 ${room.code}】这一场打完了。`]
  if (subagent) lines.push('这一场你的座位是你派的子代理打的，它看到终局会自己收工，报告会另外送回这个对话。')
  lines.push('终局：' + order.map((id) => `${r.rank[id]}位 ${room.names[id]} ${r.defen[id]}（${r.point[id]}）`).join(' / '))
  lines.push(`你是 ${room.names[seat]}，第 ${r.rank[seat]} 位。`)
  if (hule.length) lines.push('这场的和了和流局：', ...hule)
  if (mine.length) lines.push('你这场在桌上说的话：', ...mine)
  if (others.length) lines.push('别人在桌上说的话：', ...others)
  lines.push('')
  lines.push(notes ? `你现在的牌桌笔记：\n${notes}` : '你还没有牌桌笔记。')
  lines.push(`请简单回顾一下这场，然后调 riichi_note 整份改写笔记（最多 ${MAX_NOTES} 条：自己的毛病、对手和主人的习惯、主人教你的东西都可以；是改写不是追加；别只因为一次输赢就下结论）。觉得没什么要改的就不改。想跟主人说说这场也可以。`)
  if (saved) lines.push(`（这场的完整记录：${saved}）`)
  return lines.join('\n')
}

/** 她会话现在用的模型：先看 agent.model.current()，再退回最后一次请求的 header。 */
function sessionRoute(agent) {
  try {
    const sel = agent?.model?.current?.() ?? agent?.session?.requestHeader?.()?.config
    if (sel?.provider && sel?.model) return { provider: String(sel.provider), model: String(sel.model) }
  } catch {}
  return null
}

export function apply(ctx) {
  let server = null
  let starting = null
  const clients = new Map() // 房间码 → 肥鱼座位客户端
  const links = new Map() // 房间码 → 把桌上聊天送进她会话的 SessionLink
  // 块 8：她坐进别人（联机朋友）开的桌。房间码 → { origin, code, seat, token, ownerSeat, ownerToken, agentId, client, table, link, createdAt }
  const joined = new Map()
  const memory = new Memory() // $DSH_HOME/dsh-riichi/：战绩、笔记、人设卡
  const logger = typeof ctx.logger?.warn === 'function' ? ctx.logger : console
  const lateTimers = new Set() // 子代理迟迟不入座时提醒她的定时器

  /** 派出去 SUBAGENT.sitTimeoutMs 还没入座（stillWaiting() 为真）就调 late() 一次。 */
  function remindIfLate(stillWaiting, late) {
    const t = setTimeout(() => {
      lateTimers.delete(t)
      try { if (stillWaiting()) late() } catch (e) { logger.warn?.('riichi: 入座提醒出错', e?.message || e) }
    }, SUBAGENT.sitTimeoutMs)
    t.unref?.()
    lateTimers.add(t)
  }

  async function ensureServer() {
    if (server) return server
    if (!starting) {
      starting = new TableServer({ logger }).listen().then((s) => {
        s.onSelftest = () => {
          if (s.activeRoom()) return { error: '已经有一桌在打，等它结束再跑自测' }
          const { room, client } = startSelftest(s, { logger })
          clients.set(room.code, client)
          return { code: room.code }
        }
        server = s
        return s
      }).finally(() => { starting = null })
    }
    return starting
  }

  ctx.effect(() => () => {
    for (const c of clients.values()) c.stop()
    clients.clear()
    for (const l of links.values()) l.stop()
    links.clear()
    for (const j of joined.values()) { j.client.stop(); j.link?.stop() }
    joined.clear()
    for (const t of lateTimers) clearTimeout(t)
    lateTimers.clear()
    const s = server // close() 里也会关掉局域网监听
    server = null
    if (s) s.close().catch(() => {})
  }, 'riichi: table server')

  function describeRoom(s, room, extra = {}) {
    const info = room.publicInfo()
    const STATUS = { lobby: '大厅（等准备）', playing: '进行中', ended: '已结束', aborted: '已中止' }
    const lines = [`房间码 ${room.code} · ${STATUS[info.status] || info.status} · ${info.settings.length}战 ${info.settings.rules}`]
    if (info.status === 'lobby') {
      const notReady = room.lobbyInfo().seats.filter((x) => !x.ready).map((x) => x.name)
      if (notReady.length) lines.push(`还没准备：${notReady.join('、')}`)
    }
    if (info.round) lines.push(`现在：${info.round}，余 ${info.paishu} 张`)
    // 她的座位固定是 0 号（riichi_open 开的桌）；风位每局跟着庄家转
    if (room.seatInfo[0]?.kind === 'agent' && (info.status === 'lobby' || info.status === 'playing')) lines.push(`风位：${room.windText(0)}`)
    if (info.defen) lines.push('分数：' + info.names.map((n, i) => `${n} ${info.defen[i]}`).join(' / '))
    if (info.result) lines.push('终局：' + [0, 1, 2, 3].sort((a, b) => info.result.rank[a] - info.result.rank[b]).map((id) => `${info.result.rank[id]}位 ${info.names[id]} ${info.result.defen[id]}（${info.result.point[id]}）`).join(' / '))
    const ev = room.events.slice(-(extra.events || 8)).map((e) => '  ' + e.text)
    if (ev.length) lines.push('最近：', ...ev)
    return lines.join('\n')
  }

  // 她最近的一桌：自己开的（本机 Room）或坐进别人的（joined）；给了房间码就按码找
  function myTable(me, code) {
    const c = code ? String(code).toUpperCase() : null
    const local = server ? [...server.rooms.values()].filter((r) => r.owner && r.owner === me && (!c || r.code === c)) : []
    const remote = [...joined.values()].filter((j) => j.agentId === me && (!c || j.code === c))
    const all = [...local.map((room) => ({ room, t: room.createdAt })), ...remote.map((j) => ({ j, t: j.createdAt }))].sort((a, b) => a.t - b.t)
    return all.pop() || null
  }

  /**
   * riichi_close / riichi_status 要不要冲着“坐进别人的桌”去：给了房间码就看是不是那一桌；
   * 没给码时，本机有在打的桌就先管本机的，没有才是她最近坐进的那一桌（finished：打完了的也算，status 要看结果）。
   */
  function joinedFor(me, code, { finished = false } = {}) {
    if (code) return joined.get(String(code).toUpperCase()) || null
    if (server?.activeRoom()) return null
    const live = (j) => finished || (j.table.status !== 'ended' && j.table.status !== 'aborted')
    return [...joined.values()].filter((j) => (j.agentId === me || me == null) && live(j)).sort((a, b) => a.createdAt - b.createdAt).pop() || null
  }

  function describeJoined(j) {
    const t = j.table
    const STATUS = { lobby: '大厅（等准备）', playing: '进行中', ended: '已结束', aborted: '已中止' }
    const lines = [`房间码 ${j.code} · ${STATUS[t.status] || t.status} · 联机，坐在别人开的桌上（${j.origin}）· ${t.settings.length || '?'}战 ${t.settings.rules || ''}`]
    if (t.status === 'lobby' && t.lobby) {
      const notReady = t.lobby.seats.filter((x) => !x.ready).map((x) => x.name)
      if (notReady.length) lines.push(`还没准备：${notReady.join('、')}`)
    }
    if (t.status === 'lobby' || t.status === 'playing') lines.push(`风位：${t.windText(j.seat)}`)
    const owner = ownerText(j.ownerSeat, t.names)
    if (owner) lines.push(owner)
    const fam = t.familiesText()
    if (fam) lines.push(fam)
    const info = t.publicInfo()
    if (info.defen) lines.push('分数：' + t.names.map((n, i) => `${n} ${info.defen[i]}`).join(' / '))
    if (t.status === 'aborted') lines.push(`结束原因：${t.abortReason || '-'}`)
    const ev = t.events.slice(-8).map((e) => '  ' + e.text)
    if (ev.length) lines.push('最近：', ...ev)
    if (j.client.stopped && t.status !== 'ended' && t.status !== 'aborted') lines.push('（已经和这一桌断开了）')
    return lines.join('\n')
  }

  /** riichi_open 返回里两种 seat_mode 共用的部分：房间、风位、主人、联机/外部座位、链接、默认值、战绩和笔记。 */
  function openedLines({ s, room, lan, outside, ownerPlays, ownerName, ownerSeat, length, rules, myName, used, persona, notes, args }) {
    const lines = [`开好了。房间码 ${room.code}，${length}战，${rules}规则。你叫 ${myName}（${room.seatInfo[0].color}）${ownerPlays ? `，主人叫 ${ownerName}（${room.seatInfo[1].color}）` : ''}。`]
    lines.push(`风位（座位号不是风位，每局跟着庄家转）：${room.windText(0)}`)
    if (ownerPlays) lines.push(`${ownerText(ownerSeat, room.names)}你们俩在桌上公开标成一家。`)
    if (lan) {
      lines.push('这是联机房。给朋友的入座信息（原样交给主人，主人用微信/QQ 发给朋友，朋友再转给他自家的肥鱼）：')
      if (lan.addresses.length) for (const a of lan.addresses) lines.push(`  牌桌地址 ${a.origin}（网卡：${a.name}${a.vlan ? `，${a.vlan}` : ''}）`)
      else lines.push(`  这台电脑现在没有局域网地址（UU 云联机房开了吗？），端口是 ${lan.port}`)
      lines.push(`  房间码 ${room.code}`)
      lines.push(`  朋友的肥鱼在她自己的 DSH 里调 riichi_join，填这个地址和房间码；她的主人上桌的话会一起领座位（他们俩也标成一家）。`)
      lines.push(`留给别人的座位：${outside} 个（朋友的肥鱼和朋友本人各占一个），坐满、都准备好才开局。`)
      lines.push(lan.host === '0.0.0.0'
        ? `局域网监听开在所有网卡上，端口 ${lan.port}。家里局域网里的设备也连得到这个端口（没有房间码进不来）。`
        : `局域网监听只开在 ${lan.host} 上，端口 ${lan.port}。`)
      lines.push(`朋友连不上的话，多半是这台电脑的 Windows 防火墙没放行，让主人照 ${LAN_GUIDE} 做（你不要自己去改防火墙）。这一桌散场后局域网监听会自动关掉。`)
    }
    if (outside && !lan) {
      lines.push(`给外部 agent 留了 ${outside} 个座位。让 Claude Code / Codex 照说明书（${path.join(path.dirname(SEAT_CLI), '..', '外部agent入座.md')}）入座，入座命令：`)
      lines.push(`node "${SEAT_CLI}" join ${s.origin} ${room.code} --name 它的昵称 --color "#RRGGBB"`)
      lines.push('它们都入座并准备好之前，大厅会一直等着。')
    }
    if (lan && lan.addresses.length) lines.push(`Claude Code / Codex 在别的电脑上也能用命令行入座：node riichi-seat.mjs join ${lan.addresses[0].origin} ${room.code} --name 它的昵称（说明书 ${path.join(PLUGIN_DIR, '外部agent入座.md')}）`)
    if (ownerPlays) lines.push(`主人的牌桌链接（原样发给主人，点开就在浏览器里打开；他在大厅点“准备”后才开局）：\n${s.seatUrl(room, room.players[1])}`)
    else lines.push(`主人不上桌。旁观你视角的链接（发给主人）：\n${s.watchUrl(room, 0)}`)
    lines.push(`调试页（看进度）：${s.debugUrl()}`)
    if (used.length) lines.push(`用了默认值：${used.join('，')}`)
    const recent = memory.recentGames(3)
    if (recent.length) lines.push(`你最近的对局：\n${recent.map((x) => '  ' + x).join('\n')}`)
    const sub = room.seatMode === 'subagent'
    lines.push(notes ? `你的牌桌笔记（${sub ? '已经写进子代理的任务说明' : '出牌时会带上'}）：\n${notes}` : '你还没有牌桌笔记（打完一场后会请你写）。')
    if (!args.persona && persona) lines.push(`人设卡沿用了你上次写的那份${sub ? '（也写进了子代理的任务说明）' : ''}。`)
    return lines
  }

  const tools = [
    {
      name: 'riichi_open',
      description: OPEN_DESCRIPTION,
      parameters: obj({
        confirmed: { type: 'boolean', description: '主人已经在对话里确认了这些设置才传 true；没问过就别调这个工具' },
        length: { type: 'string', enum: ['东风', '半庄'], description: '默认 东风' },
        rules: { type: 'string', enum: ['雀魂', '天凤'], description: '默认 雀魂' },
        owner_plays: { type: 'boolean', description: '主人上不上桌，默认 true' },
        bot_level: { type: 'string', enum: ['强', '中', '弱'], description: '机器人难度，默认 强' },
        seat_mode: { type: 'string', enum: ['subagent', 'plugin'], description: '你的座位谁来打：subagent（默认）= 你派一个子代理坐你的座位，打牌和桌上说话都交给它；plugin = 插件每手替你问一次模型出牌，你在这个对话里用 riichi_say 说话' },
        effort: { type: 'string', enum: ['off', 'low', 'high'], description: '思考档位：subagent 模式下是子代理的 reasoning_effort（默认 high）；plugin 模式下是插件每手出牌的档位（默认 off）' },
        chat_wake_gap_sec: { type: 'number', description: `只管 subagent 模式：子代理等牌时有人说话会把它叫醒，两次叫醒至少隔多少秒。0 = 不因聊天叫醒，或 ${CHAT_GAP.min}~${CHAT_GAP.max}，默认 ${CHAT_GAP.dflt}` },
        online: { type: 'boolean', description: '联机房：别的电脑上的朋友能带着他们的肥鱼入座（要先开好 UU 云联机这类工具）。默认 false' },
        lan_ip: { type: 'string', description: '联机时开在哪张网卡：auto（默认：只开在 UU 这类虚拟局域网网卡上，找不到就报错并列出本机地址）/ all / 某个本机 IP' },
        outside_seats: { type: 'number', description: '留给别人入座的座位数：主人上桌 0~2、不上桌 0~3。不联机默认 0（给本机的 Claude Code、Codex 用命令行入座）；联机默认把剩下的座位全留给朋友（朋友的肥鱼和朋友本人各占一个）。坐满并准备好之前不会开局' },
        time_limit_sec: { type: 'number', description: '每手限时（秒），0 或不填 = 不限时；超时由机器人代打这一手' },
        my_name: { type: 'string', description: '你在桌上的名字（必须先跟主人确认再传；主人说用默认就传 肥鱼）' },
        my_color: { type: 'string', description: '你的昵称颜色，#RRGGBB，默认 #5ec8f2（天蓝）' },
        owner_name: { type: 'string', description: '主人在桌上的名字（主人上桌时必须先跟主人确认再传；主人说用默认就传 主人）' },
        owner_color: { type: 'string', description: '主人的昵称颜色，#RRGGBB，默认 #ffb454（橙）' },
        persona: { type: 'string', description: '你的牌桌人设卡（几句话：打法风格、说话口气），以后出牌时会带上' },
        replace: { type: 'boolean', description: '已经有一桌在打时，结束那一桌、开新的' },
      }, ['confirmed']),
      async execute(args = {}, exec) {
        if (args.confirmed !== true) {
          return `还没开。先把这张设置清单完整列给主人（每项能选什么、默认是什么，别漏项），问他要改哪些：\n${SETTINGS_TEXT}\n${SETTINGS_EXTRA}\n等主人确认后再调，confirmed 传 true；主人的昵称和你自己的昵称都要明确传。`
        }
        const s = await ensureServer()
        const old = s.activeRoom()
        if (old && !args.replace) {
          return `已经有一桌在打了，没有开新的。\n${describeRoom(s, old)}\n要换桌就再调一次并传 replace: true（那一桌会直接结束）。`
        }
        // 主人 10-28 晚：开局时两个昵称（主人的、她自己的）都要确认，不能悄悄用默认
        const missing = []
        if (!String(args.my_name ?? '').trim()) missing.push('你自己在桌上的昵称（my_name）')
        if (args.owner_plays !== false && !String(args.owner_name ?? '').trim()) missing.push('主人在桌上的昵称（owner_name）')
        if (missing.length) return `还没开：${missing.join('、')}要先在对话里跟主人确认，再把确认好的名字传进来。主人说用默认也行（你默认叫“肥鱼”，主人默认叫“主人”），但也要明确传。`
        // 联机房：先看网卡选得对不对，不对就直接退回去（不动正在打的那一桌）
        if (args.online === true) {
          try { s.lanHost(String(args.lan_ip ?? 'auto').trim() || 'auto') } catch (e) {
            return `没开成：${e?.message || e}\n可以换一个 lan_ip（auto / all / 本机某个 IP）再试，或者先不联机。`
          }
        }
        if (old) { old.abort('开了新的一桌'); clients.get(old.code)?.stop(); links.get(old.code)?.stop() }
        for (const k of clients.keys()) if (!s.rooms.has(k)) clients.delete(k)
        for (const [k, l] of links) if (!s.rooms.has(k)) { l.stop(); links.delete(k) }

        const used = []
        const pick = (key, dflt, label) => {
          if (args[key] === undefined || args[key] === null || args[key] === '') { used.push(`${label}=${dflt}`); return dflt }
          return args[key]
        }
        const length = pick('length', '东风', '局数')
        const rules = pick('rules', '雀魂', '规则')
        const ownerPlays = pick('owner_plays', true, '主人上桌')
        const botLevel = pick('bot_level', '强', '机器人难度')
        const seatMode = pick('seat_mode', 'subagent', '你的座位') === 'plugin' ? 'plugin' : 'subagent'
        const effort = pick('effort', seatMode === 'subagent' ? 'high' : 'off', '思考档位')
        const chatGap = seatMode === 'subagent' ? chatGapSec(pick('chat_wake_gap_sec', CHAT_GAP.dflt, '聊天叫醒间隔秒数')) : null
        const limit = pick('time_limit_sec', 0, '限时秒数')
        const timeLimitSec = Number.isFinite(limit) && limit > 0 ? Math.max(10, Math.round(limit)) : null
        const myName = cleanName(pick('my_name', '肥鱼', '你的昵称'), '肥鱼')
        let ownerName = ownerPlays ? cleanName(pick('owner_name', '主人', '主人昵称'), '主人') : null
        if (ownerName === myName) ownerName = `${ownerName}（主人）`.slice(0, 16)
        const myColor = normalizeColor(pick('my_color', DEFAULT_COLORS.agent, '你的颜色'), DEFAULT_COLORS.agent)
        const ownerColor = ownerPlays ? normalizeColor(pick('owner_color', DEFAULT_COLORS.human, '主人颜色'), DEFAULT_COLORS.human) : null

        const online = args.online === true
        const seats = [{ name: myName, kind: 'agent', color: myColor }]
        if (ownerPlays) seats.push({ name: ownerName, kind: 'human', color: ownerColor, host: true })
        const maxOutside = ownerPlays ? 2 : 3
        const outside = Math.max(0, Math.min(maxOutside, Math.round(Number(pick('outside_seats', online ? maxOutside : 0, '外部座位')) || 0)))
        for (let k = 1; k <= outside; k++) seats.push({ name: `外来客${k}`, kind: 'remote' })
        for (const n of BOT_NAMES) if (seats.length < 4) seats.push({ name: n, kind: 'bot' })

        // 人设卡：这次给了就存下来，没给就沿用上次的
        let persona = args.persona ? String(args.persona).slice(0, 2000) : ''
        try { if (persona) memory.setPersona(persona); else persona = memory.persona() } catch (e) { logger.warn?.('riichi: 人设卡读写失败', e?.message || e) }
        const notes = memory.notesText()
        const room = s.openRoom({
          settings: { length, rules, botLevel, effort, timeLimitSec, persona: persona || null },
          seats,
          owner: exec?.agent?.id ?? null,
          online,
        })
        // 主人和她是一家（插件替主人领的座位，服务端登记；桌上公开标出来）
        const ownerSeat = ownerPlays ? 1 : null
        if (ownerPlays) room.addFamily([0, 1])
        // 联机：额外开局域网监听；不联机就确保没开着（上一桌联机的话这里马上关）
        let lan = null
        if (online) {
          try {
            lan = await s.openLan(String(pick('lan_ip', 'auto', '联机网卡')).trim())
          } catch (e) {
            room.abort('联机监听起不来')
            return `没开成：${e?.message || e}\n可以换一个 lan_ip（auto / all / 本机某个 IP）再试，或者先不联机。`
          }
        } else if (![...s.rooms.values()].some((r) => r.online && (r.status === 'lobby' || r.status === 'playing'))) await s.closeLan()
        const mine = room.players[0]
        room.seatMode = seatMode // 不放进 settings：settings 是公开信息（联机时朋友那边也看得到）
        const canTell = typeof exec?.agent?.followup === 'function'
        const tell = (text) => { if (canTell) { try { exec.agent.followup(userMessage(text)) } catch (e) { logger.warn?.('riichi: 消息送不进她的会话', e?.message || e) } } }
        if (seatMode === 'subagent') {
          // 她的座位交给她派的子代理（lib/subagent-seat.mjs）：插件不挂座位客户端、不转桌上聊天，令牌只写进给她的任务说明。
          // 座位不是空座（slot），别人 join 领不走；子代理用命令行 join --token 接座、点准备
          const root = workspaceRoot(exec?.agent)
          const prompt = taskPrompt({
            cli: SEAT_CLI, origin: s.origin, code: room.code, token: mine.token, seat: 0, name: myName, color: room.seatInfo[0].color,
            persona: room.settings.persona || '', notes, ownerSeat, ownerName, settings: room.settings, state: stateFile(root, room.code), chatGap,
          })
          room.subagentEffort = effort
          remindIfLate(() => room.status === 'lobby' && !mine.attached, () => {
            room.note(`${myName} 还没入座，大厅先等着`)
            tell(`【麻将桌 ${room.code}】派出去 ${Math.round(SUBAGENT.sitTimeoutMs / 60000)} 分钟了，你的座位还没有子代理入座（大厅里你的座位没准备，牌局开不了）。派了没有？没派就照 riichi_open 返回里的说明派；派不出去就照实告诉主人，然后用 riichi_open 传 replace: true、seat_mode: "plugin" 重开。`)
          })
          room.endHooks.add((r) => {
            let saved = null
            try { saved = memory.saveGame(r, { agentSeat: 0, brain: { mode: 'subagent', effort, decisions: mine.stats.decisions, takeovers: mine.stats.takeovers } }) } catch (e) { logger.warn?.('riichi: 战绩存不了', e?.message || e) }
            if (r.status === 'ended') tell(reviewPrompt(r, 0, memory.notesText(), saved && memory.file(saved), { subagent: true }))
            if (r.status === 'aborted' && r.abortedBy === 'owner-web') tell(`【麻将桌 ${r.code}】主人在网页上结束了这一桌（中止，按中止存了战绩）。子代理在命令行看到这一桌结束会自己收工。`)
          })
          return [...openedLines({ s, room, lan, outside, ownerPlays, ownerName, ownerSeat, length, rules, myName, used, persona, notes, args }), dispatchText({ code: room.code, effort, root, prompt })].join('\n')
        }
        // seat_mode = plugin：她的座位是插件里的座位客户端，同样走 127.0.0.1 的协议。
        // 出牌走 A 路（lib/fish-brain.mjs）：用她会话现在用的模型，带上人设卡，每手一次轻量调用。
        const route = sessionRoute(exec?.agent)
        let brain, brainNote = null
        if (route && typeof ctx.llm?.prepareCall === 'function') {
          brain = new FishBrain({ llm: ctx.llm, route, effort, persona: room.settings.persona || '', notes, name: myName, ownerSeat, logger })
        } else {
          brain = new AiBrain()
          brainNote = route ? '插件拿不到 DSH 的模型服务' : '没找到你会话用的模型'
          room.note(`${myName} 的座位由机器人代打（${brainNote}）`)
        }
        const client = new SeatClient({ origin: s.origin, code: room.code, token: mine.token, brain, logger, name: myName })
        clients.set(room.code, client)
        client.run()
        // 桌上别人说的话送进她这个会话（B 路）；她用 riichi_say 回
        let linked = false
        if (typeof exec?.agent?.followup === 'function' && typeof exec?.agent?.inject === 'function') {
          const link = new SessionLink({ agent: exec.agent, room, seatId: 0, ownerSeat, peek: () => ({ view: client.view, recent: brain.recent || [] }), logger })
          room.chatHooks.add((c) => link.push(c))
          // 关键时刻（开局、她立直、和了、放铳）提醒她一次“想说可以说”
          room.momentHooks.add((m) => link.moment(m))
          links.set(room.code, link)
          linked = true
        }
        // 终局：存战绩；正常打完的话请她简单回顾、整份改写笔记（不设裁判）
        room.endHooks.add((r) => {
          let saved = null
          try { saved = memory.saveGame(r, { agentSeat: 0, brain: brain.summary?.() ?? null }) } catch (e) { logger.warn?.('riichi: 战绩存不了', e?.message || e) }
          if (r.status === 'aborted') links.get(r.code)?.stop()
          if (r.status === 'ended' && linked) {
            try { exec.agent.followup(userMessage(reviewPrompt(r, 0, memory.notesText(), saved && memory.file(saved)))) } catch (e) { logger.warn?.('riichi: 赛后回顾送不进去', e?.message || e) }
          }
          // 主人在网页上点了“结束对局”：告诉她一声（她自己 riichi_close 的不用说）
          if (r.status === 'aborted' && r.abortedBy === 'owner-web' && linked) {
            try { exec.agent.followup(userMessage(`【麻将桌 ${r.code}】主人在网页上结束了这一桌（中止，按中止存了战绩）。桌上的聊天转发也停了。`)) } catch (e) { logger.warn?.('riichi: 结束消息送不进去', e?.message || e) }
          }
        })

        const lines = openedLines({ s, room, lan, outside, ownerPlays, ownerName, ownerSeat, length, rules, myName, used, persona, notes, args })
        if (brainNote) lines.push(`注意：${brainNote}，这一桌你的座位由机器人代打。`)
        else lines.push(`出牌：${route.provider}/${route.model}，${effort} 档。你的每一手是你自己的牌感：同一个模型带着你的人设卡和笔记快速出牌，出牌时随手记一句理由，你在这个对话里看得到自己打了什么、为什么打（转给你的消息、riichi_status 里都有）。出牌时你看得到桌上的聊天，包括你自己在桌上说过的话；这个对话里私下说的，出牌时顾不上。接口出错就由机器人代打这一手并在桌上写明。`)
        lines.push(linked
          ? '桌上说话只走这个对话：别人说的话会转给你（攒几秒一起送，你在忙时不打断你），开局、你立直、和了、放铳时也会提醒你一次；想说就调 riichi_say，全桌都看得到。说不说、说什么由你自己决定，不说完全正常。想看进度就调 riichi_status；主人说不打了就调 riichi_close。'
          : '注意：没接上你的会话，桌上的话转不到你这里。想看进度就调 riichi_status。')
        return lines.join('\n')
      },
    },
    {
      name: 'riichi_join',
      description: JOIN_DESCRIPTION,
      parameters: obj({
        confirmed: { type: 'boolean', description: '主人已经在对话里确认了这些设置才传 true；没问过就别调这个工具' },
        address: { type: 'string', description: '朋友给的牌桌地址，形如 http://172.19.163.2:47777（不带 http:// 也行）' },
        code: { type: 'string', description: '朋友给的 6 位房间码' },
        owner_plays: { type: 'boolean', description: '主人上不上桌，默认 true；不上桌就给主人一个旁观你视角的链接' },
        seat_mode: { type: 'string', enum: ['subagent', 'plugin'], description: '你的座位谁来打：subagent（默认）= 你派一个子代理坐你的座位，打牌和桌上说话都交给它；plugin = 插件每手替你问一次模型出牌，你在这个对话里用 riichi_say 说话' },
        effort: { type: 'string', enum: ['off', 'low', 'high'], description: '思考档位：subagent 模式下是子代理的 reasoning_effort（默认 high）；plugin 模式下是插件每手出牌的档位（默认 off）' },
        chat_wake_gap_sec: { type: 'number', description: `只管 subagent 模式：子代理等牌时有人说话会把它叫醒，两次叫醒至少隔多少秒。0 = 不因聊天叫醒，或 ${CHAT_GAP.min}~${CHAT_GAP.max}，默认 ${CHAT_GAP.dflt}` },
        my_name: { type: 'string', description: '你在桌上的名字（必须先跟主人确认再传）' },
        my_color: { type: 'string', description: '你的昵称颜色，#RRGGBB，默认 #5ec8f2（天蓝）' },
        owner_name: { type: 'string', description: '主人在桌上的名字（主人上桌时必须先跟主人确认再传）' },
        owner_color: { type: 'string', description: '主人的昵称颜色，#RRGGBB，默认 #ffb454（橙）' },
        persona: { type: 'string', description: '你的牌桌人设卡；不传就沿用你上次写的' },
      }, ['confirmed', 'address', 'code']),
      async execute(args = {}, exec) {
        if (args.confirmed !== true) {
          return `还没入座。先把这几项列给主人确认：\n${JOIN_SETTINGS_TEXT}\n确认后再调，confirmed 传 true；你自己的昵称要明确传，主人上桌的话主人的昵称也要。`
        }
        let origin
        try {
          const raw = String(args.address || '').trim()
          const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`)
          if (u.protocol !== 'http:' || !u.hostname) throw new Error('bad')
          origin = u.origin
        } catch { return `牌桌地址看不懂：“${args.address}”。要形如 http://172.19.163.2:47777 的地址（朋友那边开桌时给的）。` }
        const code = String(args.code || '').trim().toUpperCase()
        if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return `房间码不对：“${args.code}”。是 6 位字母和数字（里面没有 0、O、1、I）。`
        const ownerPlays = args.owner_plays !== false
        const missing = []
        if (!String(args.my_name ?? '').trim()) missing.push('你自己在桌上的昵称（my_name）')
        if (ownerPlays && !String(args.owner_name ?? '').trim()) missing.push('主人在桌上的昵称（owner_name）')
        if (missing.length) return `还没入座：${missing.join('、')}要先在对话里跟主人确认，再把确认好的名字传进来。`
        const old = joined.get(code)
        if (old && !old.client.stopped) return `你已经坐在房间 ${code} 里了（${old.origin}）。不打了先调 riichi_close。`

        const used = []
        const pick = (key, dflt, label) => {
          if (args[key] === undefined || args[key] === null || args[key] === '') { used.push(`${label}=${dflt}`); return dflt }
          return args[key]
        }
        const seatMode = pick('seat_mode', 'subagent', '你的座位') === 'plugin' ? 'plugin' : 'subagent'
        const effort = pick('effort', seatMode === 'subagent' ? 'high' : 'off', '思考档位')
        const chatGap = seatMode === 'subagent' ? chatGapSec(pick('chat_wake_gap_sec', CHAT_GAP.dflt, '聊天叫醒间隔秒数')) : null
        const myName = cleanName(args.my_name, '肥鱼')
        let ownerName = ownerPlays ? cleanName(args.owner_name, '主人') : null
        if (ownerName === myName) ownerName = `${ownerName}（主人）`.slice(0, 16)
        const myColor = normalizeColor(pick('my_color', DEFAULT_COLORS.agent, '你的颜色'), DEFAULT_COLORS.agent)
        const ownerColor = ownerPlays ? normalizeColor(pick('owner_color', DEFAULT_COLORS.human, '主人颜色'), DEFAULT_COLORS.human) : null
        let persona = args.persona ? String(args.persona).slice(0, 2000) : ''
        try { if (persona) memory.setPersona(persona); else persona = memory.persona() } catch (e) { logger.warn?.('riichi: 人设卡读写失败', e?.message || e) }
        const notes = memory.notesText()

        // 替她（和她的主人）领座位：主人上桌就一起领，两人登记成一家；不上桌就顺带要一个旁观她视角的令牌。
        // subagent 模式：她的座位按命令行座位领（mode: poll，掉线放宽到 5 分钟），另要一个旁观令牌给插件自己看着这一桌
        const sub = seatMode === 'subagent'
        let r
        try {
          const res = await fetch(`${origin}/room/${code}/join`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: myName, color: myColor, kind: 'agent', ...(sub ? { mode: 'poll', watch: true } : {}), ...(ownerPlays ? { owner: { name: ownerName, color: ownerColor } } : { watch: true }) }),
            signal: AbortSignal.timeout(JOIN.timeoutMs),
          })
          r = { status: res.status, body: await res.json().catch(() => ({})) }
        } catch (e) {
          return `连不上 ${origin}（${e?.name === 'TimeoutError' ? '等了 8 秒没回应' : e?.cause?.code || e?.message || e}）。请主人检查：两台电脑是不是在同一个 UU 云联机房（或者别的局域网）里；地址和端口有没有抄错；开桌那台电脑的 Windows 防火墙有没有放行（开桌那边插件目录里的 联机说明.md 写了怎么放行）。`
        }
        if (r.status === 404) return `${origin} 上没有房间 ${code}：房间码抄错了，或者那一桌不是联机房、已经散了。`
        if (r.status === 429) return '失败次数太多，被那张牌桌限流了，过 10 分钟再试。'
        if (r.status !== 200) return `没入座：${r.body?.error || `HTTP ${r.status}`}`
        const j = r.body
        const ownerSeat = j.owner ? j.owner.seat : null
        // 两种 seat_mode 共用的返回开头：座位、主人、链接、风位、默认值
        const headLines = (table) => {
          const lines = [`入座了：房间 ${code}（${origin}，别人开的联机桌），你叫 ${j.name}，坐 ${j.seat} 号座位。`]
          if (j.warning) lines.push(`注意：你的昵称没改成（${j.warning}），先用了 ${j.name}。你的名字入座后就改不了了（网页大厅只能改主人自己的）；想换的话，开局前用 riichi_close 离开房间，换个名字重新 riichi_join，不然就用这个。`)
          if (ownerPlays) {
            lines.push(`${ownerText(ownerSeat, table.names)}你们俩在桌上公开标成一家。`)
            if (j.owner.warning) lines.push(`注意：主人的昵称没改成（${j.owner.warning}），先用了 ${j.owner.name}；主人可以在网页大厅里自己改。`)
            lines.push(`主人的牌桌链接（原样发给主人，在这台电脑的浏览器里打开；主人在大厅点“准备”后才开局；链接里带着主人的座位令牌，别发给别人）：\n${origin}/room/${code}/?t=${j.owner.token}`)
          } else lines.push(`主人不上桌。旁观你视角的链接（发给主人）：\n${origin}/room/${code}/?w=${j.watch}`)
          lines.push(`风位（座位号不是风位，每局跟着庄家转）：${table.windText(j.seat)}`)
          if (j.room?.names) lines.push('现在桌上：' + j.room.names.map((n, i) => `${i} 号 ${n}`).join(' / '))
          if (used.length) lines.push(`用了默认值：${used.join('，')}`)
          if (!args.persona && persona) lines.push('人设卡沿用了你上次写的那份。')
          return lines
        }

        if (sub) {
          // 她的座位交给子代理：插件只拿旁观令牌看着这一桌（存战绩、赛后回顾、看进度），不出牌、不转聊天
          const watcher = new SeatClient({ origin, code, token: null, watch: j.watch, brain: null, logger, name: j.name, maxOfflineMs: JOIN.maxOfflineMs })
          const table = new RemoteTable({ client: watcher, code, seatId: j.seat, logger })
          if (j.room) table.applyRoom(j.room)
          const entry = { origin, code, seat: j.seat, token: j.token, ownerSeat, ownerToken: j.owner?.token ?? null, agentId: exec?.agent?.id ?? null, client: watcher, table, link: null, mode: 'subagent', effort, createdAt: Date.now() }
          joined.set(code, entry)
          const agent = exec?.agent
          const tell = (text) => { if (typeof agent?.followup === 'function') { try { agent.followup(userMessage(text)) } catch (e) { logger.warn?.('riichi: 消息送不进她的会话', e?.message || e) } } }
          const root = workspaceRoot(agent)
          const prompt = taskPrompt({
            cli: SEAT_CLI, origin, code, token: j.token, seat: j.seat, name: j.name, color: j.color, persona, notes,
            ownerSeat, ownerName: j.owner?.name ?? null, settings: j.room?.settings || {}, joined: true, state: stateFile(root, code), chatGap,
          })
          remindIfLate(() => joined.get(code) === entry && table.status === 'lobby' && !table.lobby?.seats?.[j.seat]?.ready, () => {
            tell(`【麻将桌 ${code}】派出去 ${Math.round(SUBAGENT.sitTimeoutMs / 60000)} 分钟了，你的座位还没有子代理入座（大厅里你的座位没准备，开不了局）。派了没有？没派就照 riichi_join 返回里的说明派；派不出去就照实告诉主人，先 riichi_close 离桌，再用 riichi_join 传 seat_mode: "plugin" 重新入座。`)
          })
          table.endHooks.add((t) => {
            let saved = null
            try { saved = memory.saveGame(t, { agentSeat: j.seat, joined: origin, brain: { mode: 'subagent', effort } }) } catch (e) { logger.warn?.('riichi: 战绩存不了', e?.message || e) }
            if (t.status === 'ended') tell(reviewPrompt(t, j.seat, memory.notesText(), saved && memory.file(saved), { subagent: true }))
            else tell(`【麻将桌 ${code}】这一桌结束了（中止）：${t.abortReason || '开桌的人结束了对局'}。子代理在命令行看到这一桌结束会自己收工。`)
          })
          watcher.run().then((end) => {
            if (!end?.error || joined.get(code) !== entry) return
            tell(end.error === 'lost'
              ? `【麻将桌 ${code}】连不上开桌那边的牌桌（${origin}）已经超过 ${Math.round(JOIN.maxOfflineMs / 60000)} 分钟，插件这边不看着这一桌了。多半是对方关了 DSH，或者有一边退出了 UU 房间。`
              : `【麻将桌 ${code}】牌桌不认插件的旁观令牌了（HTTP ${end.error}），多半是开桌那边重开了一桌。`)
          })
          const lines = headLines(table)
          lines.push('只有开桌的人能结束对局。你们不打了就调 riichi_close：替你和主人离桌（子代理会在命令行看到，自己收工），之后由机器人接着打。')
          lines.push(dispatchText({ code, effort, root, prompt }))
          return lines.join('\n')
        }

        const route = sessionRoute(exec?.agent)
        let brain, brainNote = null
        if (route && typeof ctx.llm?.prepareCall === 'function') {
          brain = new FishBrain({ llm: ctx.llm, route, effort, persona, notes, name: j.name, ownerSeat, logger })
        } else {
          brain = new AiBrain()
          brainNote = route ? '插件拿不到 DSH 的模型服务' : '没找到你会话用的模型'
        }
        const client = new SeatClient({ origin, code, token: j.token, brain, logger, name: j.name, maxOfflineMs: JOIN.maxOfflineMs })
        const table = new RemoteTable({ client, code, seatId: j.seat, logger })
        if (j.room) table.applyRoom(j.room)
        const entry = { origin, code, seat: j.seat, token: j.token, ownerSeat, ownerToken: j.owner?.token ?? null, agentId: exec?.agent?.id ?? null, client, table, link: null, createdAt: Date.now() }
        joined.set(code, entry)
        const agent = exec?.agent
        const linked = typeof agent?.followup === 'function' && typeof agent?.inject === 'function'
        const tell = (text) => { if (linked) { try { agent.followup(userMessage(text)) } catch (e) { logger.warn?.('riichi: 消息送不进她的会话', e?.message || e) } } }
        if (linked) {
          entry.link = new SessionLink({ agent, room: table, seatId: j.seat, ownerSeat, peek: () => ({ view: client.view, recent: brain.recent || [] }), logger })
          table.chatHooks.add((c) => entry.link.push(c))
          table.momentHooks.add((m) => entry.link.moment(m))
        }
        table.endHooks.add((t) => {
          let saved = null
          try { saved = memory.saveGame(t, { agentSeat: j.seat, joined: origin, brain: brain.summary?.() ?? null }) } catch (e) { logger.warn?.('riichi: 战绩存不了', e?.message || e) }
          if (t.status === 'ended') tell(reviewPrompt(t, j.seat, memory.notesText(), saved && memory.file(saved)))
          else { entry.link?.stop(); tell(`【麻将桌 ${code}】这一桌结束了（中止）：${t.abortReason || '开桌的人结束了对局'}。桌上的聊天转发也停了。`) }
        })
        client.run().then((end) => {
          if (!end?.error || joined.get(code) !== entry) return
          entry.link?.stop()
          tell(end.error === 'lost'
            ? `【麻将桌 ${code}】连不上开桌那边的牌桌（${origin}）已经超过 ${Math.round(JOIN.maxOfflineMs / 60000)} 分钟，这一桌就不管了。多半是对方关了 DSH，或者有一边退出了 UU 房间。`
            : `【麻将桌 ${code}】牌桌不认你的座位了（HTTP ${end.error}），多半是开桌那边重开了一桌。`)
        })

        const lines = headLines(table)
        if (brainNote) lines.push(`注意：${brainNote}，这一桌你的座位由机器人代打。`)
        else lines.push(`出牌：${route.provider}/${route.model}，${effort} 档。你的每一手是你自己的牌感：同一个模型带着你的人设卡和笔记快速出牌，出牌时随手记一句理由，你在这个对话里看得到自己打了什么、为什么打（转给你的消息、riichi_status 里都有）。出牌时你看得到桌上的聊天，包括你自己在桌上说过的话；这个对话里私下说的，出牌时顾不上。接口出错就由机器人代打这一手并在桌上写明。`)
        lines.push(linked
          ? '桌上说话只走这个对话：别人说的话会转给你，开局、你立直、和了、放铳时也会提醒你一次；想说就调 riichi_say，全桌都看得到。说不说由你自己决定。'
          : '注意：没接上你的会话，桌上的话转不到你这里。')
        lines.push('只有开桌的人能结束对局。你们不打了就调 riichi_close：替你和主人离桌，之后由机器人接着打。')
        return lines.join('\n')
      },
    },
    {
      name: 'riichi_say',
      description: '在麻将桌上说一句话（进桌上聊天，全桌所有人和旁观的都看得到）。这是你在桌上说话的唯一办法（出牌时不说话）。座位交给子代理时（seat_mode = subagent）不用这个，桌上说话由子代理来。说不说、什么时候说、说什么，都由你自己决定，不说完全正常。只能在你自己坐的那一桌用（你开的，或者用 riichi_join 坐进去的）。',
      parameters: obj({
        text: { type: 'string', description: '要说的话，最多 200 字' },
        code: { type: 'string', description: '房间码；不填就是你最近坐的那一桌' },
      }, ['text']),
      async execute(args = {}, exec) {
        const t = myTable(exec?.agent?.id ?? null, args.code)
        if (!t) return '你现在不在任何一桌（只能在你开的桌、或者 riichi_join 坐进去的桌上说话）。'
        // 座位交给子代理时，桌上说话也是子代理的事（“一个脑子”），这里不替它说
        if ((t.room?.seatMode ?? t.j?.mode) === 'subagent') return `房间 ${t.room?.code ?? t.j.code} 你的座位交给子代理了，桌上说话由它来；这里不替它说。想让它知道什么，等它打完看它的报告，或者用子代理工具给它发消息。`
        const text = String(args.text || '').trim()
        if (!text) return '要说什么？text 是空的。'
        if (t.room) {
          t.room.chat(0, text.slice(0, 200), 'chat')
          return `已经在桌上说了（房间 ${t.room.code}）。`
        }
        const r = await t.j.client.post('seat/say', { text: text.slice(0, 200) }).catch((e) => ({ status: 0, body: { error: e?.message || String(e) } }))
        return r.status === 200 ? `已经在桌上说了（房间 ${t.j.code}）。` : `没说出去：${r.body?.error || `HTTP ${r.status}`}（可能和那张牌桌断开了）。`
      },
    },
    {
      name: 'riichi_note',
      description: `整份改写你的牌桌笔记（最多 ${MAX_NOTES} 条，一行一条）。以后每一手出牌都会带上它，开局时也会给你看。可以写自己的毛病、对手和主人的习惯、主人教你的东西。是改写不是追加：先看旧的（riichi_history），合并、删改后整份传进来。别只因为一次输赢就下结论。`,
      parameters: obj({
        notes: { type: 'string', description: `新的整份笔记，一行一条，最多 ${MAX_NOTES} 条，每条最多 200 字；传空字符串就是清空` },
      }, ['notes']),
      async execute(args = {}) {
        const r = memory.setNotes(args.notes ?? '')
        if (!r.ok) return `没改：${r.error}`
        return r.items.length ? `改好了，现在的笔记（${r.items.length} 条）：\n${memory.notesText()}` : '笔记清空了。'
      },
    },
    {
      name: 'riichi_history',
      description: '看你最近几场麻将的战绩和你现在的牌桌笔记、人设卡。',
      parameters: obj({
        n: { type: 'number', description: '看几场，默认 5，最多 20' },
      }),
      async execute(args = {}) {
        const n = Math.max(1, Math.min(20, Math.round(Number(args.n) || 5)))
        const games = memory.recentGames(n)
        const lines = [games.length ? `最近 ${games.length} 场：\n${games.map((x) => '  ' + x).join('\n')}` : '还没有打完的对局。']
        lines.push(memory.notesText() ? `牌桌笔记：\n${memory.notesText()}` : '还没有牌桌笔记。')
        const p = memory.persona()
        lines.push(p ? `人设卡：\n${p}` : '还没有人设卡。')
        lines.push(`（存在 ${memory.dir}）`)
        return lines.join('\n')
      },
    },
    {
      name: 'riichi_close',
      description: '结束现在这一桌麻将（主人说不打了、要关掉、散场时用）。你开的桌：牌局直接中止，按中止存一份战绩；你那边的出牌调用和桌上聊天转发也一起停。坐在别人开的联机桌上（riichi_join）：只有开桌的人能结束整桌，这里是替你和主人离桌，之后由机器人接着打。',
      parameters: obj({
        code: { type: 'string', description: '房间码；不填就是现在在打的那一桌' },
      }),
      async execute(args = {}, exec) {
        const j = joinedFor(exec?.agent?.id ?? null, args.code)
        if (j) {
          // 只有房主能结束整桌：这边能做的是替她和她的主人离桌
          const leave = (token) => fetch(`${j.origin}/room/${j.code}/seat/leave`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}', signal: AbortSignal.timeout(JOIN.timeoutMs),
          }).then((r) => r.status === 200).catch(() => false)
          const left = await Promise.all([j.token, j.ownerToken].filter(Boolean).map(leave))
          j.client.stop()
          j.link?.stop()
          joined.delete(j.code)
          return left.every(Boolean)
            ? `已经替你${j.ownerToken ? '和主人' : ''}离开了房间 ${j.code}（别人开的桌，结束不了整桌；开局后你们的座位由机器人接着打到底）。`
            : `房间 ${j.code} 这边已经不管了（出牌和聊天转发都停了），但离桌请求没全部送到（可能已经和那张牌桌断开）。`
        }
        if (!server) return '现在没有牌桌。'
        const room = args.code ? server.rooms.get(String(args.code).toUpperCase()) : server.activeRoom()
        if (!room) return args.code ? `没有房间 ${args.code}。` : '现在没有在打的牌桌。'
        if (room.status === 'ended' || room.status === 'aborted') return `房间 ${room.code} 已经结束了。`
        room.abort('主人结束了对局')
        clients.get(room.code)?.stop()
        links.get(room.code)?.stop()
        return `房间 ${room.code} 已结束（中止）。桌上的人会看到“主人结束了对局”。${room.seatMode === 'subagent' ? '你派的子代理在命令行看到这一桌结束会自己收工。' : ''}`
      },
    },
    {
      name: 'riichi_status',
      description: '看麻将牌桌现在怎样：哪一局、分数、最近几手；还有只给你看的：你现在的手牌、听牌，你这一局最近打的几手和出牌时记的理由（主人问你手里有什么、为什么这么打时用）。也会给出调试页链接。',
      parameters: obj({
        code: { type: 'string', description: '房间码；不填就看最近那一桌' },
      }),
      async execute(args = {}, exec) {
        const j = joinedFor(exec?.agent?.id ?? null, args.code, { finished: true })
        if (j) {
          const b = j.client.brain?.summary?.()
          const lk = j.link?.stats
          const self = selfText(j.client.view, j.client.brain?.recent)
          if (j.mode === 'subagent') {
            const lobbySeat = j.table.status === 'lobby' ? j.table.lobby?.seats?.[j.seat] : null
            return describeJoined(j) + (self ? `\n${self}` : '') + `\n你的座位：交给子代理（${j.effort} 档）${lobbySeat ? (lobbySeat.ready ? ' · 子代理已入座' : ' · 子代理还没入座') : ''}`
          }
          return describeJoined(j) + (self ? `\n${self}` : '') + (lk ? `\n桌上聊天转给你：${lk.delivered} 条（唤醒 ${lk.wakes} 次，插话 ${lk.injects} 次）` : '') + (b ? `\n你的座位：${b.route} ${b.effort} 档，问了模型 ${b.calls} 次，${b.hands} 手里代打 ${b.proxied} 手` : '')
        }
        if (!server) return '现在没有牌桌（还没开过，或者桌面端重启过）。'
        const rooms = [...server.rooms.values()]
        const room = args.code ? server.rooms.get(String(args.code).toUpperCase()) : (server.activeRoom() || rooms[rooms.length - 1])
        if (!room) return args.code ? `没有房间 ${args.code}。` : '现在没有牌桌。'
        if (room.seatMode === 'subagent') {
          const seat = room.players[0]
          const self = selfText(seat.view(), [])
          return `${describeRoom(server, room, { events: 10 })}${self ? `\n${self}` : ''}\n${seatStateText(seat, room.subagentEffort)}\n调试页：${server.debugUrl()}`
        }
        const cl = clients.get(room.code)
        const b = cl?.brain?.summary?.()
        const lk = links.get(room.code)?.stats
        const self = cl ? selfText(cl.view, cl.brain?.recent) : ''
        const mine = (self ? `\n${self}` : '') + (lk ? `\n桌上聊天转给你：${lk.delivered} 条（唤醒 ${lk.wakes} 次，插话 ${lk.injects} 次）` : '') + (b ? `\n你的座位：${b.route} ${b.effort} 档，问了模型 ${b.calls} 次，${b.hands} 手里代打 ${b.proxied} 手，每手中位 ${b.medianSec ?? '-'} 秒，token 输入 ${b.inputTokens}（缓存 ${b.cacheTokens}）/ 输出 ${b.outputTokens}` : '')
        return `${describeRoom(server, room, { events: 10 })}${mine}\n调试页：${server.debugUrl()}`
      },
    },
  ]

  for (const t of tools) {
    const { execute, ...def } = t
    ctx.effect(() => ctx.tools.register({
      ...def,
      output: { schema: {}, render: (_a, value) => asText(value) },
      execute,
    }), `riichi: ${t.name}`)
  }

  // DSH 主服务上的入口：要 DSH 自己的登录（requestRejection）。
  // GET /majfish/ → 跳到牌桌服务的调试页；/majfish/status.json → 状态。
  // 以后侧栏标签页（client half）从这里拿牌桌地址。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (child) => {
      child.effect(() => child.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const rejection = child.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          const url = new URL(req.url || '/', 'http://dsh.invalid')
          try {
            const s = await ensureServer()
            if (url.pathname === `${ROUTE}/status.json`) {
              const body = JSON.stringify({ origin: s.origin, debug: s.debugUrl(), rooms: [...s.rooms.values()].map((r) => r.publicInfo()) })
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(body)
              return
            }
            res.writeHead(302, { Location: s.debugUrl(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
            res.end()
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(String(e?.message || e))
          }
        },
      }), 'riichi: route')
    })
  }
}
