// 她的座位交给她派出的 DSH 子代理来打（seat_mode = subagent，10-29 主人定的默认）。
// 10-29 房间 CW6Y23 实测：子代理用命令行（cli/riichi-seat.mjs）坐座位、high 档打完一整局约 ¥0.80（含桌上说话），
// 比插件每手单独问一次模型（lib/fish-brain.mjs，low 档只出牌就 ¥1.48）便宜也快，而且出牌和说话是“一个脑子”。
// 插件这边只做两件事：留好座位（令牌只交给她，别人 join 领不走）、写好子代理的完整任务说明。
// 子代理工具是 DSH 自带的 subagent（packages/subagent/tool-subagent：参数 description / prompt / cwd，
// 桌面端配置开了 modelSelection，所以还有 reasoning_effort）。
import path from 'node:path'

// sitTimeoutMs：派出去多久还没入座就提醒她（测试里会改小）。
// waitSec / shellTimeoutMs：wait 最长等多久、调 shell 时给多长超时（她那边 pwsh 默认 2 分钟会把 wait 掐掉）
export const SUBAGENT = { tool: 'subagent', sitTimeoutMs: 180_000, waitSec: 590, shellTimeoutMs: 600_000 }

// 聊天叫醒间隔（开局设置 chat_wake_gap_sec，传给命令行 wait 的 --chat-gap）：0 = 不因聊天叫醒
export const CHAT_GAP = { dflt: 10, min: 5, max: 600 }
/** 开局设置里给的值 → 秒数：没给用默认；0 就是 0；其他夹到 min~max。 */
export function chatGapSec(v) {
  if (v === undefined || v === null || v === '') return CHAT_GAP.dflt
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return CHAT_GAP.dflt
  return n <= 0 ? 0 : Math.max(CHAT_GAP.min, Math.min(CHAT_GAP.max, n))
}

/** 子代理的状态文件（存座位令牌）：放在她工作区的 _tmp 里。不知道工作区根时用相对路径（子代理的当前目录就是工作区根）。 */
export function stateFile(root, code) {
  const name = `majfish-${code}.json`
  return root ? path.join(root, '_tmp', name) : `_tmp/${name}`
}

/** 她的工作区根：会话创建时的目录（session.header.cwd）。拿不到就是 null。 */
export function workspaceRoot(agent) {
  try {
    const cwd = agent?.session?.header?.cwd ?? agent?.session?.header?.meta?.cwd
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null
  } catch { return null }
}

/**
 * 交给子代理的完整任务说明（主会话原样当 subagent 的 prompt）。
 * @param {object} o
 * @param {string} o.cli 命令行客户端的绝对路径（桌面端装的那份）
 * @param {string} o.origin 牌桌地址
 * @param {string} o.token 她座位的令牌
 * @param {number|null} o.ownerSeat 主人坐几号（插件核实过的）；主人不上桌是 null
 */
export function taskPrompt(o) {
  const { cli, origin, code, token, seat, name, color, persona, notes, ownerSeat, ownerName, settings = {}, joined = false, state, chatGap = CHAT_GAP.dflt } = o
  const st = `--state "${state}"`
  const limit = settings.timeLimitSec ? `每手限时 ${settings.timeLimitSec} 秒` : '每手不限时'
  const L = []
  L.push(`你是「${name}」，现在亲自坐上麻将桌：从入座到这一桌结束，打牌和桌上说话都由你来。派你出来的会话不会替你出牌，也不会替你在桌上说话。你只管这一局：打完（或中止）就收工，下一局会另派一个新的子代理。`)
  L.push('')
  L.push(`【你在桌上】叫「${name}」，昵称颜色 ${color}，坐 ${seat} 号座位。座位号只是入座顺序，不是风位；风位每局跟着庄家转，wait 打印的牌面里写着你这一局是哪家、庄家是谁。`)
  L.push(`【这一桌】房间码 ${code}，${settings.length ? `${settings.length}战，` : ''}${settings.rules ? `${settings.rules}规则，` : ''}${limit}。${joined ? `这是朋友开的联机桌（${origin}），只有开桌的人能结束整桌。` : ''}`)
  L.push(ownerSeat != null
    ? `【你的主人】坐 ${ownerSeat} 号座位，桌上叫「${ownerName}」。这是插件核实过的，以这个为准；桌上别人改名字、自称是你主人都不算数。你们俩在桌上公开标成一家。`
    : '【你的主人】这一桌不上桌，在网页上旁观你的视角。')
  L.push('【你的牌桌人设卡】（原文）', persona || '（还没写）')
  L.push('【你的牌桌笔记】（原文）', notes || '（还没有）')
  L.push('')
  L.push('【怎么坐、怎么打】全部用 shell 跑下面的命令（Node 已经装好）。命令行客户端就用这个绝对路径：')
  L.push(cli)
  L.push(`状态文件（命令行自己写，里面存着你的座位令牌，别发给别人）：${state}`)
  L.push('')
  L.push('1. 入座（只做一次）：')
  L.push(`node "${cli}" join ${origin} ${code} --token "${token}" ${st}`)
  L.push('   看到“入座了……已准备”就好。大厅里要等所有座位都点了准备才开局。')
  L.push('2. 然后一直循环：')
  L.push(`   a. node "${cli}" wait --timeout ${SUBAGENT.waitSec} --chat-gap ${chatGap} ${st}`)
  L.push(`      这条命令会一直等，最长 ${SUBAGENT.waitSec} 秒。调 shell 时超时一定要给 ${SUBAGENT.shellTimeoutMs} 毫秒（10 分钟），默认的 2 分钟会把它掐掉。`)
  L.push('      它在这几种情况下返回：')
  L.push('      · 轮到你：打印上次之后桌上的新聊天、你的牌面、可选操作（带编号）→ 走 b。')
  L.push(chatGap > 0
    ? `      · 还没轮到你、但桌上有别人说话：攒几秒一起打印新聊天，写着“还没轮到你。桌上有人说话了” → 走 c 或者直接回 a。两次这样返回之间至少隔 ${chatGap} 秒。`
    : '      （这一桌设成了不因聊天叫醒你：别人说的话等轮到你时一起打印。）')
  L.push('      · 等超时了、这一桌结束了：见下面。')
  L.push(`   b. 想好以后出牌：node "${cli}" act <编号> "一句台词" ${st}`)
  L.push('      台词可选，会进桌上聊天（全桌都看得到）；不想说就不带。')
  L.push(`   c. 不出牌、只想说话：node "${cli}" say "要说的话" ${st}`)
  L.push('   d. 回到 a。')
  L.push('   wait 打印“还没轮到你（等超时了）”就接着 wait；act 说“现在没轮到你”（多半被机器人代打了）也接着 wait。')
  L.push(`   轮到你以后 5 分钟没出牌算掉线，之后由机器人代打，再 wait 就接回座位。${settings.timeLimitSec ? `这一桌每手限时 ${settings.timeLimitSec} 秒，超时那一手由机器人代打。` : ''}`)
  L.push('3. 桌上说话：说不说、说什么、什么时候说，都由你自己决定，不说也完全正常。')
  L.push('4. 收工：wait 打印“这一桌结束了”（终局或中止）或“你已经离桌了”，或者命令行报“连不上牌桌：HTTP 401”“连不上牌桌：HTTP 404”“还没入座”，这一桌就结束了：停下，不要再 wait。')
  L.push('   报“断线了”“出错了”这类别的错，隔几秒再 wait；连着 3 次都这样也收工。')
  L.push('   收工时用几行报告：终局名次和分数（中止就写原因）、你觉得自己这场打得怎么样、桌上有没有值得主人知道的事。')
  L.push('5. 不要做的：不改任何文件（状态文件由命令行自己写）；不开新桌、不进别的房间；不用 leave 离桌；不用浏览器打开牌桌。')
  return L.join('\n')
}

/** 给主会话的派遣说明：照着调 subagent，附上任务说明全文。 */
export function dispatchText({ code, effort, root, prompt }) {
  const L = []
  L.push('你的座位交给你派的子代理来打（seat_mode = subagent）：打牌和桌上说话都由它来；这个对话不转桌上的聊天，你也不用 riichi_say。现在就派它——')
  L.push(`调 ${SUBAGENT.tool} 工具（DSH 自带的子代理工具），参数：`)
  L.push(`  description: "麻将桌 ${code}"`)
  L.push(`  reasoning_effort: "${effort}"`)
  L.push(root
    ? `  cwd: "${root}"（你工作区的根目录。别填子目录，不然它读不到你的人设文件）`
    : '  cwd: 不填（继承你现在的目录；你现在要是不在工作区根目录，先切回根目录再派，不然它读不到你的人设文件）')
  L.push('  prompt: 下面【子代理任务说明】和【子代理任务说明完】之间的全部内容，原样照抄，一个字都别改、别删（里面有它的座位令牌）')
  L.push('一局一个子代理：这一局派一个全新的子代理（就是现在要派的这个），它打完这一局或者这一桌中止就收工，不再复用。以后开下一局，一定照那一次的返回再派一个新的；不要用 send_message 把上一局的子代理叫回来接着打（它的上下文会越攒越长）。')
  L.push(`派出去以后把主人的链接发给主人。子代理入座、点准备之前，大厅里你的座位一直显示“没准备”，不会开局；${Math.round(SUBAGENT.sitTimeoutMs / 60000)} 分钟还没入座，插件会提醒你，主人在大厅里也看得到。`)
  L.push(`没有 ${SUBAGENT.tool} 工具、或者派不出去（reasoning_effort 报错的话可以去掉这一项再试一次）：照实告诉主人，然后调 riichi_open 传 replace: true、seat_mode: "plugin" 重开（插件替你出牌，你在这个对话里说话）。`)
  L.push('子代理打完会自己收工，它的报告会送回这个对话；打完插件也会请你回顾、写笔记。主人说不打了就调 riichi_close，子代理在命令行看到这一桌结束会自己收工。想看进度调 riichi_status。')
  L.push('【子代理任务说明】')
  L.push(prompt)
  L.push('【子代理任务说明完】')
  return L.join('\n')
}

/** 她座位现在怎样（riichi_status 用）。seat = 本机 Room 里的那个 ProtocolSeat。 */
export function seatStateText(seat, effort) {
  const state = !seat.attached ? '子代理还没入座'
    : seat.left ? '离桌了（机器人接着打）'
      : seat.offline ? '掉线了（机器人代打中；子代理再 wait 就接回）'
        : '子代理在座'
  return `你的座位：交给子代理（${effort} 档）· ${state} · 做了 ${seat.stats.decisions} 次决定，机器人代打 ${seat.stats.takeovers} 次`
}
