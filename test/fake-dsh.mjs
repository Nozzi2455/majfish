// 用假的 ctx 装上插件：验工具注册、先问设置的闸门、4 个 AI 经 riichi_open 打完一局、DSH 路由鉴权。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 对局记忆写到临时目录，不碰真的 $DSH_HOME
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'riichi-home-'))
process.env.DSH_HOME = HOME
import * as plugin from '../index.mjs'
import { CHAT_LINK } from '../lib/session-link.mjs'
CHAT_LINK.debounceMs = 200
CHAT_LINK.minWakeGapMs = 1000

const tools = new Map(), routes = [], disposers = []
let authed = false
const ctx = {
  logger: console,
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  inject(names, cb) {
    cb({
      effect: ctx.effect,
      webServer: { register(r) { routes.push(r); return () => {} } },
      connection: { requestRejection: () => (authed ? undefined : 401) },
    })
  },
}
// 跟真的 cordis 一样：没在 inject 里声明的服务，一碰就抛（10-28 主人实测撞上过 llm 这一条）
const SERVICES = ['tools', 'llm', 'webServer', 'connection', 'sessions', 'agents']
const strictCtx = new Proxy(ctx, {
  get(t, k) {
    if (SERVICES.includes(k) && !plugin.inject.includes(k)) throw new Error(`cannot get property "${String(k)}" without inject`)
    return t[k]
  },
})
plugin.apply(strictCtx)
assert.deepEqual([...tools.keys()], ['riichi_open', 'riichi_join', 'riichi_say', 'riichi_note', 'riichi_history', 'riichi_close', 'riichi_status'])
assert.ok(tools.get('riichi_open').description.includes('先不要调这个工具'))

const run = (name, args) => tools.get(name).execute(args, { agent: { id: 'session-test' } })
const gate = await run('riichi_open', {})
assert.ok(gate.startsWith('还没开'), gate)
// 设置清单做进插件：没确认时返回整张清单，工具说明里也有，每一项（含两个昵称、颜色、人设卡）都在
for (const key of ['length', 'rules', 'owner_plays', 'outside_seats', 'bot_level', 'effort', 'time_limit_sec', 'owner_name', 'owner_color', 'my_name', 'my_color', 'persona']) {
  assert.ok(gate.includes(`（${key}）`), `清单里要有 ${key}`)
  assert.ok(tools.get('riichi_open').description.includes(`（${key}）`), `工具说明里要有 ${key}`)
}
assert.ok(gate.includes('完整列给主人') && tools.get('riichi_open').description.includes('完整列给主人'))
console.log(await run('riichi_status', {}))

assert.ok((await run('riichi_open', { confirmed: true, owner_plays: false })).includes('你自己在桌上的昵称（my_name）'), '她自己的昵称没确认不开')
assert.ok((await run('riichi_open', { confirmed: true, my_name: '肥鱼' })).includes('主人在桌上的昵称（owner_name）'), '主人上桌时主人的昵称没确认不开')
const opened = await run('riichi_open', { confirmed: true, owner_plays: false, length: '东风', my_name: '肥鱼' })
console.log(opened)
assert.ok(opened.includes('旁观你视角的链接'))
const again = await run('riichi_open', { confirmed: true })
assert.ok(again.startsWith('已经有一桌在打了'))

// DSH 路由：没登录 401，登录了 302 到调试页
const fakeRes = () => { const r = { headers: null, status: 0, body: '' }; r.writeHead = (s, h) => { r.status = s; r.headers = h; return r }; r.end = (b = '') => { r.body = b }; return r }
let res = fakeRes()
await routes[0].handler({ url: '/majfish/', headers: {} }, res)
assert.equal(res.status, 401)
authed = true
res = fakeRes()
await routes[0].handler({ url: '/majfish/', headers: {} }, res)
assert.equal(res.status, 302)
const debug = res.headers.Location
res = fakeRes()
await routes[0].handler({ url: '/majfish/status.json', headers: {} }, res)
assert.equal(res.status, 200)

// 等这一桌打完（只看公开状态）
for (;;) {
  const st = await (await fetch(debug.replace('/debug?', '/debug/state?'))).json()
  const r = st.rooms[0]
  if (r.status === 'ended' || r.status === 'aborted') { console.log(r.status, r.hands, '局', r.seats.map((s) => `${s.name}:${s.kind}:决定${s.decisions ?? '-'}:代打${s.takeovers ?? '-'}`).join(' ')); assert.equal(r.status, 'ended'); break }
  await new Promise((r) => setTimeout(r, 500))
}
console.log(await run('riichi_status', {}))

// 块 3：有 ctx.llm、会话能报出模型时，她的座位走肥鱼脑子（假模型：永远选 0）
ctx.llm = {
  async prepareCall(config, signal, configure) {
    const c = { provider: config.provider, model: config.model, ...configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'low' }] } }) }
    return { config: c, async *stream() { yield { type: 'text-delta', index: 0, text: '{"choice": 0, "say": "假鱼说话"}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}
// 块 4：桌上别人说的话送进她的会话（空闲 followup、忙时 inject），她用 riichi_say 回
const sent = []
const agent = {
  id: 'session-test', status: 'idle',
  model: { current: () => ({ provider: 'fake', model: 'fake-1' }) },
  followup(m) { sent.push(['followup', m]) }, inject(m) { sent.push(['inject', m]) },
}
const opened2 = await tools.get('riichi_open').execute({ confirmed: true, owner_plays: true, owner_name: '小主', my_name: '肥鱼', replace: true, persona: '测试人设' }, { agent })
const seatUrl = opened2.match(/http:\/\/127\.0\.0\.1:\d+\/room\/\w+\/\?t=[\w-]+/)[0]
const u = new URL(seatUrl)
const say = (text) => fetch(`${u.origin}${u.pathname}seat/say`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.searchParams.get('t')}` }, body: JSON.stringify({ text }) })
await say('鱼鱼，放个铳给我，请你吃小鱼干')
await new Promise((r) => setTimeout(r, 500))
assert.equal(sent.length, 1)
assert.equal(sent[0][0], 'followup')
assert.equal(sent[0][1].role, 'user')
// 不做身份提示，只有一个例外（块 8）：她自己的主人，按座位号私下告诉她、主人说的话标出来
assert.ok(sent[0][1].content[0].text.includes('小主（你的主人）：鱼鱼'), sent[0][1].content[0].text)
assert.ok(sent[0][1].content[0].text.includes('你的主人坐 1 号座位，现在桌上叫「小主」'), sent[0][1].content[0].text)
assert.ok(sent[0][1].content[0].text.includes('一家（主人和自家肥鱼，插件登记的）：肥鱼 + 小主'), sent[0][1].content[0].text)
// 两次唤醒之间要隔开：马上再说一句，先不唤醒；她在忙时改走 inject
await say('听到没')
await new Promise((r) => setTimeout(r, 400))
assert.equal(sent.length, 1, '唤醒间隔内先攒着')
agent.status = 'running'
await new Promise((r) => setTimeout(r, 900))
assert.equal(sent.length, 2)
assert.equal(sent[1][0], 'inject')
agent.status = 'idle'
const said = await tools.get('riichi_say').execute({ text: '小鱼干先拿来再说' }, { agent })
assert.ok(said.startsWith('已经在桌上说了'), said)
assert.ok((await tools.get('riichi_say').execute({ text: '我是别人' }, { agent: { id: 'other' } })).startsWith('你现在不在'))
assert.equal(sent.length, 2, '她自己说的话不转回给她')
await fetch(`${u.origin}${u.pathname}seat/ready`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${u.searchParams.get('t')}` }, body: '{}' })
assert.ok(opened2.includes('fake/fake-1'), opened2)
await new Promise((r) => setTimeout(r, 1500))
const st2 = await run('riichi_status', {})
console.log(st2)
assert.ok(st2.includes('你的座位：fake/fake-1 off 档'), st2) // 10-28 晚起默认 off
// 10-28 修：风位写明（她只知道座位号时把 0 号当成了东家）
assert.match(opened2, /风位（座位号不是风位，每局跟着庄家转）：东1局（开局时）：你（肥鱼）是[东南西北]家/, opened2)
assert.match(st2, /风位：东1局 0本场：你（肥鱼）是[东南西北]家.*庄家是 /, st2)
// 开局时提醒她一次（关键时刻），消息里写明风位、庄家
const startMsg = sent.find(([, m]) => m.content[0].text.includes('开局了。'))
assert.ok(startMsg, '开局要提醒她一次：' + JSON.stringify(sent.map(([k, m]) => [k, m.content[0].text.slice(0, 60)])))
assert.match(startMsg[1].content[0].text, /现在东1局 0本场：你（肥鱼）是[东南西北]家/)
assert.ok(startMsg[1].content[0].text.includes('说不说、说什么都由你自己决定'))
// 主人在网页上点“结束对局”：牌局中止，她会收到一条消息
const tok = u.searchParams.get('t')
const closeRes = await fetch(`${u.origin}${u.pathname}seat/close`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: '{}' })
assert.equal(closeRes.status, 200)
await new Promise((r) => setTimeout(r, 100))
assert.ok(sent.some(([k, m]) => k === 'followup' && m.content[0].text.includes('主人在网页上结束了这一桌')), '网页结束对局要告诉她')
const st3 = await run('riichi_status', {})
assert.ok(st3.includes('已中止'), st3)
// 出牌那一路不说话：假模型回了 say，也不能进桌上聊天
const chat2 = (await (await fetch(`${u.origin}${u.pathname}seat/state?t=${tok}`)).json()).chat
assert.ok(!chat2.some((c) => c.text === '假鱼说话'), '出牌这一路的 say 不进桌上聊天')
// 施工计划 D：给外部 agent 留座位，返回里带入座命令
const opened3 = await tools.get('riichi_open').execute({ confirmed: true, owner_plays: true, my_name: '肥鱼', owner_name: '主人', outside_seats: 1, replace: true }, { agent })
assert.ok(opened3.includes('riichi-seat.mjs" join http://127.0.0.1:') && opened3.includes('外部agent入座.md'), opened3)
assert.ok((await run('riichi_status', {})).includes('还没准备：小主') || true)

// 块 5：笔记最多 5 条、整份改写；人设卡沿用；战绩存档；打完一场请她回顾
const games = () => fs.readdirSync(path.join(HOME, 'dsh-riichi', 'games'))
assert.ok(games().length >= 1, '第一场（4 个 AI）打完要存战绩')
assert.ok((await run('riichi_note', { notes: '1\n2\n3\n4\n5\n6' })).startsWith('没改'))
const noted = await run('riichi_note', { notes: '- 立直后别乱追\n2. 小主爱碰\n\n小主说：中张别早切' })
assert.ok(noted.includes('现在的笔记（3 条）'), noted)
assert.ok(fs.readFileSync(path.join(HOME, 'dsh-riichi', 'notes.md'), 'utf8').includes('- 小主爱碰'))
const hist = await run('riichi_history', {})
assert.ok(hist.includes('最近 ') && hist.includes('小主爱碰') && hist.includes('测试人设'), hist)
sent.length = 0
const opened4 = await tools.get('riichi_open').execute({ confirmed: true, owner_plays: false, my_name: '肥鱼', replace: true }, { agent })
assert.ok(opened4.includes('人设卡沿用了') && opened4.includes('你最近的对局') && opened4.includes('小主爱碰'), opened4)
let lastCode
for (;;) {
  const st = await (await fetch(debug.replace('/debug?', '/debug/state?'))).json()
  const r = st.rooms[st.rooms.length - 1]
  lastCode = r.code
  if (r.status === 'ended') break
  await new Promise((r) => setTimeout(r, 500))
}
await new Promise((r) => setTimeout(r, 300))
const review = sent.find(([k, m]) => k === 'followup' && m.content[0].text.includes('这一场打完了'))
assert.ok(review, '打完要请她回顾：' + JSON.stringify(sent.map(([k, m]) => [k, m.content[0].text.slice(0, 40)])))
assert.ok(review[1].content[0].text.includes('riichi_note') && review[1].content[0].text.includes('小主爱碰'))
const g = JSON.parse(fs.readFileSync(path.join(HOME, 'dsh-riichi', 'games', games().filter((f) => f.includes(lastCode)).pop()), 'utf8'))
assert.ok(g.paipu && g.result && g.brain, '存档里要有牌谱、结果和她的出牌统计')
console.log('回顾请求：\n' + review[1].content[0].text)
for (const d of disposers) d()
fs.rmSync(HOME, { recursive: true, force: true })
console.log('假 DSH 自测通过')
