// 10-28 主人实测后的修补：轮到谁（鸣牌窗口不泄露）、鸣牌窗口里的代打攒到局末再说、掉线只报一次、
// 主人在网页上结束对局、风位、吃碰选项的说法、聊天流水号。
// 用法：node test/table-fixes.mjs
import assert from 'node:assert/strict'
import { TableServer } from '../lib/server.mjs'
import { SeatClient, AiBrain } from '../lib/seat-client.mjs'
import { TIMING } from '../lib/room.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fulouLabel, FENG } from '../lib/tiles.mjs'

// ---------- 吃碰杠选项：写明用手里的哪几张 ----------
assert.equal(fulouLabel('s067-'), '吃 7索，用手里的 赤5索 6索')
assert.equal(fulouLabel('s34-5'), '吃 4索，用手里的 3索 5索')
assert.equal(fulouLabel('s4-56'), '吃 4索，用手里的 5索 6索')
assert.notEqual(fulouLabel('m406-'), fulouLabel('m456-'), '用不用赤五要分得清')
assert.equal(fulouLabel('m550='), '碰 赤5万，用手里的 5万 5万')
assert.equal(fulouLabel('p5555+'), '明杠 5筒，用手里的 5筒 5筒 5筒')
assert.equal(fulouLabel('z7777'), '暗杠 中')
assert.equal(fulouLabel('m555=5'), '加杠 5万')

const SETTINGS = { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null }
// 彩蛋音乐放临时目录：只放“别人立直”，“自己立直”故意缺
const EGG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-egg-'))
fs.writeFileSync(path.join(EGG_DIR, '别人立直.mp3'), Buffer.from('0123456789'))
fs.writeFileSync(path.join(EGG_DIR, '无关.mp3'), 'x')
// 自定义 BGM 也放临时目录：两首 + 一个不是音频的文件
const BGM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-bgm-'))
fs.writeFileSync(path.join(BGM_DIR, 'b-第二首.ogg'), 'OGG2')
fs.writeFileSync(path.join(BGM_DIR, 'a-第一首.mp3'), 'MP3-1')
fs.writeFileSync(path.join(BGM_DIR, '说明.txt'), 'not audio')
const server = await new TableServer({ port: 47796, eggDirs: [EGG_DIR], bgmDir: BGM_DIR }).listen()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (room, token, p, body = {}) => fetch(`${server.origin}/room/${room.code}/seat/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))

/** 座位客户端，顺手把收到的事件都记下来。 */
function recorder(room, id, brain = new AiBrain()) {
  const c = new SeatClient({ origin: server.origin, code: room.code, token: room.players[id].token, brain, name: room.names[id], logger: { warn() {} } })
  c.events = []
  const on = c.onEvent.bind(c)
  c.onEvent = (type, data) => { c.events.push({ type, data }); return on(type, data) }
  c.run()
  return c
}

/** 旁观的事件流（只读）。 */
function watcher(room, seatId) {
  const ctrl = new AbortController(), events = []
  const url = `${server.origin}/room/${room.code}/watch/events?w=${room.watchToken(seatId)}`
  ;(async () => {
    const r = await fetch(url, { signal: ctrl.signal })
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let k
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2)
        const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1]
        if (type && data) events.push({ type, data: JSON.parse(data) })
      }
    }
  })().catch(() => {})
  return { events, stop: () => ctrl.abort() }
}

// ---------- 1. 轮到谁：只在摸牌/吃碰后要出牌时标出；鸣牌窗口里所有人看到的一样 ----------
{
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '甲', kind: 'agent' }, { name: '乙', kind: 'agent' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
  // 风位：开局前就按起家算好（东1局）
  const pre = room.winds()
  assert.equal(pre.dealer, room.qijia)
  assert.match(room.windText(0), /^东1局（开局时）：你（甲）是[东南西北]家/)
  const w = watcher(room, 0)
  const a = recorder(room, 0), b = recorder(room, 1)
  await a.ended
  await wait(200)
  w.stop()
  const actors = (c) => c.events.filter((e) => e.type === 'msg' && e.data.view?.phase === 'playing').map((e) => e.data.view.actor)
  assert.deepEqual(actors(a), actors(b), '两家看到的“轮到谁”一模一样（不管谁有鸣牌选项）')
  // “思考中 N 秒”的起点：两家看到的一样（同一条引擎消息，服务端几乎同一时刻记下），有没有都一致
  const clocks = (c) => c.events.filter((e) => e.type === 'msg' && e.data.view?.phase === 'playing').map((e) => [e.data.view.actorSince, e.data.view.waitSince])
  const ca = clocks(a), cb = clocks(b)
  assert.equal(ca.length, cb.length)
  ca.forEach(([s1, w1], i) => {
    const [s2, w2] = cb[i]
    assert.equal(s1 == null, s2 == null, '思考计时有没有，两家一样')
    assert.equal(w1 == null, w2 == null, '等待计时有没有，两家一样')
    if (s1 != null) assert.equal(s1, s2, '同一条消息，两家的思考计时起点完全一样')
    if (w1 != null) assert.equal(w1, w2, '同一条消息，两家的等待计时起点完全一样')
  })
  let calls = 0
  for (const { type, data } of a.events) {
    if (type !== 'msg') continue
    const m = data.msg
    if (m.dapai) {
      assert.equal(data.view.actor, null, '打出一张之后、下一次摸牌之前谁都不标')
      assert.equal(data.view.actorSince, null, '这时也没有“思考中”')
      assert.ok(data.view.waitSince > 0 && data.view.waitSince <= data.view.now, '只有所有人一样的“等待中”计时')
    }
    if (m.zimo) {
      assert.equal(data.view.actor, m.zimo.l)
      assert.ok(data.view.actorSince > 0 && data.view.actorSince <= data.view.now, '摸牌的那家开始计时')
      assert.equal(data.view.waitSince, null)
    }
    if (m.fulou && (m.fulou.m.match(/\d/g) || []).length === 3) assert.equal(data.view.actor, m.fulou.l, '吃碰完要打牌的那家')
    if (data.decision?.options.some((o) => o.kind === 'skip')) {
      calls++
      assert.equal(data.view.actor, null, '自己在鸣牌窗口里，自己的视角也不标人')
    }
    if (data.decision?.options.some((o) => o.kind === 'fulou' && o.label.startsWith('吃'))) {
      for (const o of data.decision.options.filter((x) => x.label.startsWith('吃'))) assert.match(o.label, /^吃 \S+，用手里的 \S+ \S+$/)
    }
  }
  console.log('座位甲遇到鸣牌窗口', calls, '次')
  // 听牌提示：手里 13 张听牌时 view.hand.ting；打牌选项里打完能听的带 ting；剩几枚在 0~4 之间、不含看不到的信息
  let handTing = 0, optTing = 0
  for (const c of [a, b]) for (const { type, data } of c.events) {
    if (type !== 'msg' || data.view?.phase !== 'playing') continue
    const t = data.view.hand.ting
    if (t) {
      handTing++
      assert.ok(!data.view.hand.zimo, '摸了牌（14 张）时不算听牌')
      for (const w of t.waits) assert.ok(/^[mpsz]\d$/.test(w.p) && w.left >= 0 && w.left <= 4 && w.name)
    }
    for (const o of data.decision?.options || []) if (o.ting) {
      optTing++
      assert.ok(o.reply.dapai, '只有打牌的选项才带听牌')
      assert.ok(o.ting.waits.length > 0)
    }
  }
  console.log('听牌提示：手牌', handTing, '次，打牌选项', optTing, '次')
  assert.ok(handTing > 0 && optTing > 0, '一整个东风战里总会听牌')
  assert.ok(!w.events.some((e) => e.type === 'acted'), '旁观收不到 acted')
  assert.ok(!w.events.some((e) => e.type === 'msg' && e.data.decision), '旁观收不到 decision')
  assert.ok(w.events.some((e) => e.type === 'msg'), '旁观照样看得到牌面')
  // 聊天流水号
  const ns = room.chatLog.map((c) => c.n)
  assert.ok(ns.every((n, i) => i === 0 || n > ns[i - 1]), '聊天流水号递增')
  // 开局后风位跟着模型走
  const md = room.game.model
  assert.equal(room.winds().feng[md.player_id[0]], '东')
}

// ---------- 2. 鸣牌窗口里超时代打：不当场说是哪一手，攒到这一局结束 ----------
{
  const room = server.openRoom({ settings: { ...SETTINGS, timeLimitSec: 1 }, seats: [{ name: '慢鸣', kind: 'agent' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }, { name: '机器人丙', kind: 'bot' }] })
  // 能鸣牌时故意想 1.5 秒（超过 1 秒限时），自己出牌时马上出
  const brain = new AiBrain()
  const decide = brain.decide.bind(brain)
  brain.decide = async (d) => { if (d.options.some((o) => o.kind === 'skip')) await wait(1500); return decide(d) }
  const c = recorder(room, 0, brain)
  // 鸣牌窗口里在想的时候，调试页的 waiting 也不报
  let sawCallPending = false
  const poll = setInterval(() => {
    const p = room.players[0]
    if (p.pending?.options.some((o) => o.kind === 'skip')) { sawCallPending = true; assert.equal(room.debugInfo().seats[0].waiting, null) }
  }, 50)
  await c.ended
  clearInterval(poll)
  const notes = room.chatLog.filter((x) => x.kind === 'system').map((x) => x.text)
  console.log('代打', room.players[0].stats.takeovers, '手；', notes.filter((t) => t.includes('代打')))
  assert.ok(!notes.some((t) => t.includes('这手由机器人代打')), '鸣牌窗口的代打不能当场写')
  if (room.players[0].stats.takeovers) assert.ok(notes.some((t) => /^这一局里另有 \d+ 手由机器人代打：慢鸣（超时）/.test(t)), '局末一起写明')
  assert.ok(sawCallPending || room.players[0].stats.takeovers === 0)
}

// ---------- 3. 掉线：掉线那一刻说一次、重连说一次，中间不刷屏 ----------
{
  TIMING.graceMs = 300
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '肥鱼', kind: 'agent' }, { name: '主人', kind: 'human' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
  const fish = recorder(room, 0)
  let h = recorder(room, 1)
  while (room.players[1].stats.decisions < 6) await wait(50)
  h.stop()
  const t0 = room.players[1].stats.takeovers
  while (room.players[1].stats.takeovers < t0 + 4 && room.status === 'playing') await wait(50)
  assert.equal(room.players[1].offline, true)
  h = recorder(room, 1)
  await wait(300)
  assert.equal(room.players[1].offline, false)
  // 重连：sync 里的计时起点就是服务端记着的那个（不是重连那一刻），所以“思考中 N 秒”接得上
  const sync = h.events.find((e) => e.type === 'sync')
  if (sync.data.view?.phase === 'playing') {
    const v = sync.data.view
    assert.ok('actorSince' in v && 'waitSince' in v && v.now > 0)
    if (v.actorSince != null) assert.ok(v.actorSince <= v.now)
  }
  await fish.ended
  const notes = room.chatLog.filter((x) => x.kind === 'system').map((x) => x.text)
  console.log(notes.filter((t) => /掉线|连上/.test(t)))
  assert.equal(notes.filter((t) => t.includes('主人 掉线了')).length, 1, '掉线只说一次')
  assert.equal(notes.filter((t) => t.includes('主人 重新连上了')).length, 1, '重连说一次')
  assert.ok(!notes.some((t) => t.includes('代打（掉线）')), '不再每一手都写“代打（掉线）”')
  assert.ok(room.players[1].stats.takeovers >= 4)
  TIMING.graceMs = 20_000
}

// ---------- 4. 主人在网页上结束对局（只有真人座位能点） ----------
{
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '肥鱼', kind: 'agent' }, { name: '主人', kind: 'human' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
  const fish = recorder(room, 0)
  const h = recorder(room, 1)
  await wait(500)
  assert.equal(room.status, 'playing')
  assert.equal((await post(room, room.players[0].token, 'close')).status, 403, 'agent 座位不能结束对局')
  const r = await post(room, room.players[1].token, 'close')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(room.status, 'aborted')
  assert.equal(room.abortedBy, 'owner-web')
  assert.ok(room.chatLog.some((c) => c.text === '这一桌结束了：主人 结束了对局'))
  assert.equal((await post(room, room.players[1].token, 'close')).status, 409)
  const end = await fish.ended
  assert.equal(end.aborted, true)
  h.stop()
  // state 带聊天（命令行的 state 打印全部用）
  const st = await (await fetch(`${server.origin}/room/${room.code}/seat/state?t=${room.players[1].token}`)).json()
  assert.ok(st.chat.length > 0 && st.chat.every((c) => Number.isInteger(c.n)))
  // 结束后 view 里 actor 字段还在（网页不会因为缺字段出错）
  assert.ok('actor' in st.view || st.view.phase !== 'playing')
}

// ---------- 5. 关键时刻钩子：立直、和了（含放铳的人） ----------
{
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '机器人甲', kind: 'bot' }, { name: '测试', kind: 'agent' }, { name: '机器人乙', kind: 'bot' }, { name: '机器人丙', kind: 'bot' }] })
  const moments = []
  room.momentHooks.add((m) => moments.push(m))
  const c = recorder(room, 1)
  await c.ended
  assert.equal(moments[0].type, 'start')
  const hule = moments.filter((m) => m.type === 'hule')
  assert.ok(hule.length >= 1)
  for (const m of hule) assert.ok(Number.isInteger(m.id) && (m.from === null || Number.isInteger(m.from)) && m.defen > 0)
  console.log('关键时刻', moments.map((m) => m.type).join(' '))
  assert.ok(FENG.length === 4)
}

// ---------- 6. 立直彩蛋音乐：要令牌、缺的曲子 404、支持 Range、sync 里告诉网页有哪几首 ----------
{
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '甲', kind: 'agent' }, { name: '主人', kind: 'human' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
  assert.deepEqual(room.eggs, ['other'])
  const u = (key, q) => `${server.origin}/room/${room.code}/egg/${key}${q}`
  assert.equal((await fetch(u('other', '?t=wrong'))).status, 401, '没令牌不能听')
  assert.equal((await fetch(u('self', `?t=${room.players[1].token}`))).status, 404, '缺的曲子 404')
  const full = await fetch(u('other', `?t=${room.players[1].token}`))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'audio/mpeg')
  assert.equal(await full.text(), '0123456789')
  const part = await fetch(u('other', `?w=${room.watchToken(0)}`), { headers: { range: 'bytes=2-5' } })
  assert.equal(part.status, 206, '旁观也能听，支持 Range')
  assert.equal(await part.text(), '2345')
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10')
  let sync = null
  const off = room.players[1].subscribe({ send: (type, d) => { if (type === 'sync') sync = d } })
  assert.deepEqual(sync.eggs, ['other'], 'sync 里告诉网页有哪几首')
  off()
  room.abort('测试结束')
}

// ---------- 7. 自定义 BGM：$DSH_HOME/dsh-riichi/bgm/ 里的 mp3/ogg 按编号放，要令牌；没有就是 0（网页用合成的） ----------
{
  const room = server.openRoom({ settings: SETTINGS, seats: [{ name: '甲', kind: 'agent' }, { name: '主人', kind: 'human' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
  assert.equal(room.bgm.length, 2, '只认音频文件')
  const u = (i, q) => `${server.origin}/room/${room.code}/bgm/${i}${q}`
  const tok = `?t=${room.players[1].token}`
  assert.equal((await fetch(u(0, '?t=wrong'))).status, 401, '没令牌不能听')
  assert.equal(await (await fetch(u(0, tok))).text(), 'MP3-1', '按文件名排序编号')
  const r1 = await fetch(u(1, `?w=${room.watchToken(0)}`))
  assert.equal(r1.headers.get('content-type'), 'audio/ogg')
  assert.equal(await r1.text(), 'OGG2')
  assert.equal((await fetch(u(2, tok))).status, 404)
  assert.equal((await fetch(u('..%2F说明.txt', tok))).status, 404, '只能按编号要，不能拿别的文件')
  let sync = null
  const off = room.players[1].subscribe({ send: (type, d) => { if (type === 'sync') sync = d } })
  assert.equal(sync.bgm, 2, 'sync 里告诉网页有几首自定义 BGM')
  off()
  room.abort('测试结束')
  const empty = new TableServer({ port: 47797, bgmDir: path.join(BGM_DIR, '没有这个目录') })
  assert.deepEqual(empty.bgmFiles(), [], '没有 bgm 目录就是空的')
}

await server.close()
fs.rmSync(EGG_DIR, { recursive: true, force: true })
fs.rmSync(BGM_DIR, { recursive: true, force: true })
console.log('牌桌修补自测通过')
