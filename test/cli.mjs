// 外部 agent 座位（施工计划 D，改进 6）：用命令行客户端 cli/riichi-seat.mjs 像 Claude Code 那样一条条命令入座、等牌、出牌、说话，打完一个东风战。
// 用法：node test/cli.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TableServer } from '../lib/server.mjs'
import { SeatClient, AiBrain } from '../lib/seat-client.mjs'

const run = promisify(execFile)
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'riichi-seat.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-cli-'))
const cli = async (...a) => (await run(process.execPath, [CLI, ...a], { cwd: dir })).stdout

const server = await new TableServer({ port: 47795 }).listen()
const room = server.openRoom({
  settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
  seats: [{ name: '肥鱼', kind: 'agent' }, { name: '外来客1', kind: 'remote' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }],
})
new SeatClient({ origin: server.origin, code: room.code, token: room.players[0].token, brain: new AiBrain(), name: '肥鱼' }).run()
await new Promise((r) => setTimeout(r, 300))
assert.equal(room.status, 'lobby', '外部座位没入座前不开局')

const joined = await cli('join', server.origin, room.code, '--name', '炸鱼', '--color', '#ff7043')
console.log(joined.trim())
assert.ok(joined.includes('昵称 炸鱼') && joined.includes('已准备'))
assert.ok(fs.existsSync(path.join(dir, '.riichi-seat.json')))
assert.match(await cli('say', '我是来炸鱼的'), /说了/)

let turns = 0, ended = '', saidLine = false, chiLabels = []
const waits = []
for (;;) {
  const out = await cli('wait', '--timeout', '60')
  waits.push(out)
  if (out.includes('这一桌结束了')) { ended = out; break }
  assert.ok(out.includes('你的手牌：') && out.includes('可选操作'), out)
  assert.match(out, /你是[东南西北]家；庄家是/, '牌面写明风位和庄家')
  const opts = out.split('可选操作（只能选一个编号）：')[1].trim().split('\n').filter((l) => /^\d+\. /.test(l))
  chiLabels.push(...opts.filter((l) => /^\d+\. 吃 /.test(l)))
  // 能和就和，能打就摸切最后一张，否则跳过
  let pick = opts.find((l) => /自摸|荣和|抢杠/.test(l)) || opts.findLast((l) => /\. 打 /.test(l)) || opts.find((l) => /跳过/.test(l)) || opts[0]
  const i = parseInt(pick, 10)
  const line = !saidLine && /\. 打 /.test(pick)
  if (line) saidLine = true
  const acted = await cli('act', String(i), line ? '这张给你们' : '')
  assert.ok(acted.startsWith('出了') || acted.includes('没轮到你'), acted)
  turns++
}
// wait 只打印上次看过之后的新聊天：同一句话只在一次 wait 里出现
assert.equal(waits.filter((o) => o.includes('我是来炸鱼的')).length, 1, 'wait 不重复打印旧聊天')
assert.ok(waits.some((o) => o.includes('（上次之后桌上没人说话）')))
for (const l of chiLabels) assert.match(l, /^\d+\. 吃 \S+，用手里的 \S+ \S+$/, '吃的选项写明用手里哪两张')
console.log('吃的选项样例：', chiLabels.slice(0, 3))
// state 打印最近的全部聊天
assert.ok((await cli('state')).includes('我是来炸鱼的'), 'state 打印全部聊天')
console.log(ended.trim())
console.log('外部座位做了', turns, '次决定；', room.debugInfo().seats[1])
assert.ok(turns > 10)
assert.equal(room.players[1].stats.takeovers, 0, '不该被代打')
assert.equal(room.names[1], '炸鱼')
assert.ok(room.chatLog.some((c) => c.from === 1 && c.text === '我是来炸鱼的' && c.kind === 'chat'))
assert.ok(room.chatLog.some((c) => c.from === 1 && c.text === '这张给你们' && c.kind === 'line'))

// leave：开局后离桌 → 桌上说一次，之后机器人接着打到底，不再每手写代打；大厅里离开 → 座位空出来
const room2 = server.openRoom({
  settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
  seats: [{ name: '肥鱼', kind: 'agent' }, { name: '外来客1', kind: 'remote' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }],
})
const fish2 = new SeatClient({ origin: server.origin, code: room2.code, token: room2.players[0].token, brain: new AiBrain(), name: '肥鱼' })
fish2.run()
assert.ok((await cli('join', server.origin, room2.code, '--name', '路过的')).includes('已准备'))
for (let k = 0; k < 3; k++) {
  const out = await cli('wait', '--timeout', '60')
  const opts = out.split('可选操作（只能选一个编号）：')[1].trim().split('\n').filter((l) => /^\d+\. /.test(l))
  await cli('act', String(parseInt(opts.findLast((l) => /\. 打 /.test(l)) || opts.find((l) => /跳过/.test(l)) || opts[0], 10)))
}
const left = await cli('leave')
assert.ok(left.includes('离桌了'), left)
assert.ok(!fs.existsSync(path.join(dir, '.riichi-seat.json')), '离桌后状态文件删掉')
await fish2.ended
assert.equal(room2.status, 'ended', '离桌后机器人接着打完')
const notes2 = room2.chatLog.filter((c) => c.kind === 'system').map((c) => c.text)
assert.equal(notes2.filter((t) => t.includes('路过的 离桌了')).length, 1)
assert.ok(!notes2.some((t) => t.includes('路过的 这手由机器人代打')), '离桌后不再每手刷代打')
assert.ok(room2.players[1].stats.takeovers > 5)

const room3 = server.openRoom({
  settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
  seats: [{ name: '肥鱼', kind: 'agent' }, { name: '外来客1', kind: 'remote' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }],
})
await cli('join', server.origin, room3.code, '--name', '先来的')
assert.ok((await cli('leave')).includes('离开大厅了'))
assert.equal(room3.status, 'lobby')
assert.equal(room3.players[1].claimed, false, '大厅里离开，座位空出来')
assert.ok((await cli('join', server.origin, room3.code, '--name', '后来的')).includes('昵称 后来的'), '空出来的座位别人能再领')
room3.abort('测试结束')
await server.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('外部座位自测通过')
