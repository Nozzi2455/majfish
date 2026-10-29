// seat_mode = subagent（10-29 主人定的默认）：她的座位交给她派的 DSH 子代理。
// 假子代理照插件写好的任务说明，一条条跑命令行（cli/riichi-seat.mjs）入座、等牌、出牌、说话，打完一个东风战。顺带验：
// 默认就是 subagent、effort 默认 high；返回里有 subagent 工具的参数和完整任务说明（人设卡、笔记、主人座位、命令行路径、
// 入座命令、wait 超时）；座位别人 join 领不走、令牌不对接不了；插件不挂座位客户端、不转桌上聊天、riichi_say 不替它说；
// 迟迟不入座会提醒她；终局请她回顾、战绩照存；riichi_close 后子代理的 wait 看到中止；riichi_join 也能交给子代理。
// 不跑真 DeepSeek，也不需要假模型。用法：node test/subagent-seat.mjs
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.mjs'
import { SUBAGENT } from '../lib/subagent-seat.mjs'
import { SeatClient, AiBrain } from '../lib/seat-client.mjs'

SUBAGENT.sitTimeoutMs = 700
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'riichi-seat.mjs')
const exec = promisify(execFile)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { warn() {}, info() {}, error() {} }
const tmp = []
const mkdtemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d }

// ---------- 假 DSH（跟 test/lan.mjs 一样：一份插件实例、自己的 $DSH_HOME；会话带工作区根目录） ----------
function fakeDsh(label) {
  const home = mkdtemp(`riichi-sub-${label}-`)
  process.env.DSH_HOME = home
  const ws = mkdtemp(`riichi-ws-${label}-`) // 她的工作区根（会话创建时的目录）
  const tools = new Map(), disposers = []
  const ctx = {
    logger: quiet,
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    inject(names, cb) { cb({ effect: ctx.effect, webServer: { register() { return () => {} } }, connection: { requestRejection: () => undefined } }) },
  }
  plugin.apply(ctx)
  const sent = []
  const agent = {
    id: `session-${label}`, status: 'idle',
    session: { header: { cwd: ws } },
    model: { current: () => ({ provider: 'fake', model: `fake-${label}` }) },
    followup(m) { sent.push(m.content[0].text) }, inject(m) { sent.push(m.content[0].text) },
  }
  return { home, ws, tools, sent, agent, run: (name, args) => tools.get(name).execute(args, { agent }), unload: () => { for (const d of disposers.splice(0)) d() } }
}

/** 从返回里抠出任务说明和入座命令。 */
function brief(text) {
  const prompt = text.split('【子代理任务说明】\n')[1]?.split('\n【子代理任务说明完】')[0]
  assert.ok(prompt, text)
  const m = prompt.match(/^node "([^"]+)" join (\S+) (\w{6}) --token "([^"]+)" --state "([^"]+)"$/m)
  assert.ok(m, prompt)
  return { prompt, cli: m[1], origin: m[2], code: m[3], token: m[4], state: m[5] }
}

/** 跑一条命令行（假子代理的 shell）。失败（退出码不是 0）也把输出拿回来。 */
const sh = (args, cwd) => exec(process.execPath, [CLI, ...args], { cwd }).then((r) => r.stdout, (e) => e.stdout || String(e))

/** 假子代理：照任务说明入座，wait → act 循环到这一桌结束；第一次出牌带一句台词，中途单独说一句。 */
async function fakeSubagent(b, cwd, { line = '这张给你们', say = '我来了' } = {}) {
  const st = ['--state', b.state]
  const joined = await sh(['join', b.origin, b.code, '--token', b.token, ...st], cwd)
  assert.ok(joined.includes('入座了') && joined.includes('已准备'), joined)
  if (say) assert.match(await sh(['say', say, ...st], cwd), /说了/)
  let turns = 0, said = false
  for (;;) {
    const out = await sh(['wait', '--timeout', '60', ...st], cwd)
    if (out.includes('这一桌结束了')) return { turns, end: out }
    if (out.includes('还没轮到你')) continue // 有人说话把它叫醒了，或者等超时了
    assert.ok(out.includes('可选操作'), out)
    const opts = out.split('可选操作（只能选一个编号）：')[1].trim().split('\n').filter((l) => /^\d+\. /.test(l))
    const pick = opts.find((l) => /自摸|荣和|抢杠/.test(l)) || opts.findLast((l) => /\. 打 /.test(l)) || opts.find((l) => /跳过/.test(l)) || opts[0]
    const withLine = !said && /\. 打 /.test(pick)
    if (withLine) said = true
    const acted = await sh(['act', String(parseInt(pick, 10)), ...(withLine ? [line] : []), ...st], cwd)
    assert.ok(acted.startsWith('出了') || acted.includes('没轮到你'), acted)
    turns++
  }
}

const A = fakeDsh('A')

// ---------- 1. 设置清单里有 seat_mode；默认 subagent、effort 默认 high ----------
assert.ok(A.tools.get('riichi_open').description.includes('（seat_mode）'))
assert.ok(A.tools.get('riichi_join').description.includes('（seat_mode）'))
assert.ok((await A.run('riichi_open', {})).includes('（seat_mode）'))
await A.run('riichi_note', { notes: '立直后别乱追\n主人爱碰' })
const opened = await A.run('riichi_open', { confirmed: true, owner_plays: false, my_name: '肥鱼', persona: '测试人设：爱摸切，说话短' })
console.log(opened)
assert.ok(opened.includes('你的座位=subagent') && opened.includes('思考档位=high'), '默认值写明：' + opened)
assert.ok(opened.includes('调 subagent 工具') && opened.includes('reasoning_effort: "high"') && opened.includes(`cwd: "${A.ws}"`), opened)
assert.ok(opened.includes('description: "麻将桌 '), opened)
assert.ok(opened.includes('旁观你视角的链接'), opened)
assert.ok(!opened.includes('出牌：fake/'), '子代理模式不走插件出牌')
const b1 = brief(opened)
assert.equal(b1.cli, CLI, '命令行用插件自己目录里的那份（桌面端里就是装进 profile 的那份）')
assert.ok(path.isAbsolute(b1.state) && b1.state.startsWith(path.join(A.ws, '_tmp')), '状态文件在她工作区的临时目录：' + b1.state)
assert.ok(opened.includes('一局一个子代理') && opened.includes('不要用 send_message 把上一局的子代理叫回来'), opened)
assert.ok(opened.includes('聊天叫醒间隔秒数=10') && b1.prompt.includes(' --chat-gap 10 ') && b1.prompt.includes('两次这样返回之间至少隔 10 秒'), b1.prompt)
for (const s of ['测试人设：爱摸切，说话短', '你只管这一局', '1. 立直后别乱追', '2. 主人爱碰', '叫「肥鱼」', '坐 0 号座位', `--timeout ${SUBAGENT.waitSec}`, `${SUBAGENT.shellTimeoutMs} 毫秒`, '说不说、说什么、什么时候说，都由你自己决定', '这一桌不上桌', '不改任何文件', '这一桌结束了']) {
  assert.ok(b1.prompt.includes(s), `任务说明里要有“${s}”`)
}

// ---------- 2. 入座前：大厅等着、座位领不走、令牌不对接不了、迟迟不入座会提醒她 ----------
const debug = opened.match(/调试页（看进度）：(\S+)/)[1]
const state = async () => (await (await fetch(debug.replace('/debug?', '/debug/state?'))).json()).rooms.find((r) => r.code === b1.code)
assert.equal((await state()).status, 'lobby')
assert.equal((await state()).seats[0].ready, false, '子代理入座前她的座位没准备')
const other = mkdtemp('riichi-other-')
assert.ok((await sh(['join', b1.origin, b1.code, '--name', '路人'], other)).includes('没有空座位'), '别人 join 领不走她的座位')
assert.ok((await sh(['join', b1.origin, b1.code, '--token', 'not-the-token'], other)).includes('入座失败（401）'), '令牌不对接不了')
const sayRefused = await A.run('riichi_say', { text: '我替它说一句' })
assert.ok(sayRefused.includes('交给子代理了'), sayRefused)
assert.ok((await A.run('riichi_status', {})).includes('子代理还没入座'))
await wait(SUBAGENT.sitTimeoutMs + 300)
assert.ok(A.sent.some((t) => t.includes('还没有子代理入座') && t.includes('seat_mode: "plugin"')), '迟迟不入座要提醒她：' + JSON.stringify(A.sent))
console.log('2. 入座前：领不走、令牌不对不行、迟迟不入座提醒她 ✓')

// ---------- 3. 假子代理照说明打完一局 ----------
A.sent.length = 0
const r1 = await fakeSubagent(b1, A.ws)
console.log(r1.end.trim())
console.log('子代理做了', r1.turns, '次决定')
assert.ok(r1.turns > 10)
const st1 = await state()
assert.equal(st1.status, 'ended')
assert.equal(st1.seats[0].takeovers, 0, '不该被代打')
assert.ok(fs.existsSync(b1.state), '状态文件写在任务说明给的位置')
await wait(200)
const review = A.sent.find((t) => t.includes('这一场打完了'))
assert.ok(review && review.includes('子代理打的') && review.includes('riichi_note'), '打完请她回顾：' + JSON.stringify(A.sent))
assert.ok(review.includes('这张给你们'), '回顾里有她（子代理）这场在桌上说的话')
assert.ok(!A.sent.some((t) => t.includes('我来了') && !t.includes('这一场打完了')), '桌上的聊天不转给主会话')
const games = fs.readdirSync(path.join(A.home, 'dsh-riichi', 'games')).filter((f) => f.includes(b1.code))
const g = JSON.parse(fs.readFileSync(path.join(A.home, 'dsh-riichi', 'games', games[0]), 'utf8'))
assert.equal(g.brain.mode, 'subagent')
assert.ok(g.chat.some((c) => c.from === 0 && c.text === '我来了'))
console.log('3. 假子代理打完一局，回顾、战绩照旧 ✓')

// ---------- 4. 主人上桌：任务说明里写明主人坐几号；riichi_close 后子代理的 wait 看到中止 ----------
const opened2 = await A.run('riichi_open', { confirmed: true, owner_plays: true, owner_name: '小主', my_name: '肥鱼', effort: 'low', time_limit_sec: 90, chat_wake_gap_sec: 30 })
const b2 = brief(opened2)
assert.ok(opened2.includes('reasoning_effort: "low"'), opened2)
// 同一个会话开第二局：还是要求派一个全新的子代理（一局一个），令牌也是新的
assert.ok(opened2.includes('一局一个子代理') && opened2.includes('再派一个新的') && opened2.includes('调 subagent 工具'), opened2)
assert.notEqual(b2.token, b1.token)
assert.ok(b2.prompt.includes(' --chat-gap 30 '), b2.prompt)
assert.ok(b2.prompt.includes('坐 1 号座位（插件核实过的）') && b2.prompt.includes('公开标成一家') && b2.prompt.includes('每手限时 90 秒'), b2.prompt)
assert.ok((await sh(['join', b2.origin, b2.code, '--token', b2.token, '--state', b2.state], A.ws)).includes('已准备'))
assert.ok((await A.run('riichi_status', {})).includes('子代理在座'))
const waiting = spawn(process.execPath, [CLI, 'wait', '--timeout', '60', '--state', b2.state], { cwd: A.ws })
let waitOut = ''
waiting.stdout.on('data', (d) => { waitOut += d })
const waitDone = new Promise((r) => waiting.on('exit', r))
await wait(500)
const closed = await A.run('riichi_close', {})
assert.ok(closed.includes('已结束（中止）') && closed.includes('子代理'), closed)
await waitDone
assert.ok(waitOut.includes('这一桌结束了（中止）'), waitOut)
console.log('4. riichi_close 后子代理的 wait 看到中止 ✓')

// ---------- 5. 旧模式照旧：seat_mode = plugin 时不出子代理说明，effort 默认 off ----------
const opened3 = await A.run('riichi_open', { confirmed: true, owner_plays: false, my_name: '肥鱼', seat_mode: 'plugin', replace: true })
assert.ok(!opened3.includes('【子代理任务说明】') && opened3.includes('思考档位=off') && !opened3.includes('聊天叫醒间隔'), opened3)
await A.run('riichi_close', {})
// 聊天叫醒间隔：0 = 不因聊天叫醒；太小夹到 5 秒
const b0 = brief(await A.run('riichi_open', { confirmed: true, owner_plays: false, my_name: '肥鱼', chat_wake_gap_sec: 0 }))
assert.ok(b0.prompt.includes(' --chat-gap 0 ') && b0.prompt.includes('不因聊天叫醒你'), b0.prompt)
const b5 = brief(await A.run('riichi_open', { confirmed: true, owner_plays: false, my_name: '肥鱼', chat_wake_gap_sec: 2, replace: true }))
assert.ok(b5.prompt.includes(' --chat-gap 5 '), b5.prompt)
await A.run('riichi_close', {})
console.log('5. seat_mode = plugin 照旧 ✓')

// ---------- 6. riichi_join 也能交给子代理 ----------
// A 开桌（插件模式、没有模型 → 机器人代打她），留 2 个外部座位；B 带着主人来，她的座位交给子代理
const opened4 = await A.run('riichi_open', { confirmed: true, owner_plays: false, my_name: '肥鱼', seat_mode: 'plugin', outside_seats: 2, replace: true })
const code4 = opened4.match(/房间码 (\w{6})/)[1]
const origin4 = opened4.match(/调试页（看进度）：(http:\/\/[\d.]+:\d+)/)[1]
const B = fakeDsh('B')
const j4 = await B.run('riichi_join', { confirmed: true, address: origin4, code: code4, my_name: '鱼丸', owner_name: '阿明' })
console.log(j4)
assert.ok(j4.includes('入座了') && j4.includes('你的主人坐 2 号座位') && j4.includes('reasoning_effort: "high"') && j4.includes(`cwd: "${B.ws}"`), j4)
const b4 = brief(j4)
assert.equal(b4.origin, origin4)
assert.ok(b4.prompt.includes('朋友开的联机桌') && b4.prompt.includes('坐 2 号座位（插件核实过的）'), b4.prompt)
assert.ok((await B.run('riichi_say', { text: 'x' })).includes('交给子代理了'))
// 阿明在网页上打（替身：机器人座位客户端）
const ownerUrl = new URL(j4.match(/http:\/\/[\d.]+:\d+\/room\/\w+\/\?t=[\w-]+/)[0])
const amin = new SeatClient({ origin: ownerUrl.origin, code: code4, token: ownerUrl.searchParams.get('t'), brain: new AiBrain(), name: '阿明', logger: quiet })
amin.run()
const r4 = await fakeSubagent(b4, B.ws, { line: '鱼丸来了', say: null })
assert.ok(r4.turns > 10)
await wait(300)
assert.ok(B.sent.some((t) => t.includes('这一场打完了') && t.includes('子代理打的')), '联机桌打完也请她回顾：' + JSON.stringify(B.sent))
const st4 = await B.run('riichi_status', { code: code4 })
assert.ok(st4.includes('已结束') && st4.includes('交给子代理'), st4)
assert.ok(fs.readdirSync(path.join(B.home, 'dsh-riichi', 'games')).some((f) => f.includes(code4)), 'B 那边存了战绩')
console.log('6. riichi_join 交给子代理打完一局 ✓')

A.unload()
B.unload()
amin.stop()
for (const d of tmp) fs.rmSync(d, { recursive: true, force: true })
console.log('子代理座位自测通过')
