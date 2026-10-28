// 肥鱼脑子（块 3）：解析、牌面文字、假模型打完一局（含接口出错、乱回复 → 重试 → 代打并标明）。
// 用法：node test/fish-brain.mjs
import assert from 'node:assert/strict'
import { TableServer } from '../lib/server.mjs'
import { SeatClient } from '../lib/seat-client.mjs'
import { FishBrain, parseReply, chatText, selfText, juOf, RULES_PROMPT, callModel } from '../lib/fish-brain.mjs'
import { SessionLink } from '../lib/session-link.mjs'
import { nextDora } from '../lib/board.mjs'

// 解析
// 10-28 起出牌这一路不说话：就算模型多给了 say 也丢掉
assert.deepEqual(parseReply('{"choice": 2, "say": "打这张"}', 5), { choice: 2 })
assert.deepEqual(parseReply('想了想……\n```json\n{"choice":"1"}\n```', 5), { choice: 1 })
assert.deepEqual(parseReply('好吧 {"choice": 0, "thought": "旧字段"}', 3), { choice: 0 })
assert.ok(!/"say"/.test(RULES_PROMPT) &&RULES_PROMPT.includes('riichi_say'), '规则提示里不再让她在出牌时说话')
assert.equal(parseReply('{"choice": 9, "say": "越界"}', 3), null)
assert.equal(parseReply('我不知道', 3), null)
assert.equal(nextDora('m9'), 'm1'); assert.equal(nextDora('m0'), 'm6'); assert.equal(nextDora('z4'), 'z1'); assert.equal(nextDora('z7'), 'z5')

// off 档（10-28 晚加，默认档）：模型报了支持 off 就把 reasoningEffort: 'off' 传过去；不支持就不传（用模型自己的默认）
{
  const sentEfforts = []
  const fake = (efforts) => ({
    async prepareCall(config, signal, configure) {
      const c = { ...config, ...configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: efforts.map((id) => ({ id })) } }) }
      return { config: c, async *stream(o) { sentEfforts.push(o.reasoningEffort ?? '(不传)'); yield { type: 'text-delta', index: 0, text: '{"choice":0}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  })
  await callModel(fake(['off', 'low', 'high', 'max']), { route: { provider: 'deepseek', model: 'v4' }, effort: 'off', system: 's', user: 'u' })
  await callModel(fake(['low', 'high']), { route: { provider: 'x', model: 'y' }, effort: 'off', system: 's', user: 'u' })
  await callModel(fake(['off', 'low']), { route: { provider: 'deepseek', model: 'v4' }, system: 's', user: 'u' })
  assert.deepEqual(sentEfforts, ['off', '(不传)', 'off'], '支持 off 就传 off，不支持就不传；不给档位时默认 off')
}

// 出牌时带上桌上最近的聊天（不含系统消息，自己的话显示成“你”，不加身份提示）
const ct = chatText([{ from: -1, kind: 'system', text: '开局' }, { from: 1, name: '小主', kind: 'chat', text: '放个铳给我' }, { from: 0, name: '肥鱼', kind: 'line', text: '想得美' }], '肥鱼')
assert.ok(ct.includes('小主：放个铳给我') && ct.includes('你（出牌时）：想得美') && !ct.includes('开局'), ct)
assert.equal(chatText([], '肥鱼'), '')
// 10-29：每手带一句理由（只记给她会话那一半看）
assert.deepEqual(parseReply('{"choice": 1, "why": "主人要七万，手里没有"}', 3), { choice: 1, why: '主人要七万，手里没有' })
assert.ok(RULES_PROMPT.includes('"why"'))
// 10-29：聊天标着哪一局；之前那一局说的话标出来，这一局主人和她自己说的话不会被挤出最近 8 条
{
  const ju = '东2局 0本场'
  const chat = [
    { from: 1, name: '小主', kind: 'chat', text: '打七万我就和了', ju: '东1局 0本场' },
    { from: 1, name: '小主', kind: 'chat', text: '这局要四万', ju },
    { from: 0, name: '肥鱼', kind: 'chat', text: '四万记下了', ju },
    ...Array.from({ length: 9 }, (_, i) => ({ from: 2, name: '路人', kind: 'chat', text: `刷屏${i}`, ju })),
  ]
  const t = chatText(chat, '肥鱼', 1, ju)
  assert.ok(t.includes('小主（你的主人）：这局要四万') && t.includes('你：四万记下了'), t)
  assert.ok(!t.includes('打七万'), '挤出去的上一局的话不用再给')
  const t2 = chatText(chat.slice(0, 3), '肥鱼', 1, ju)
  assert.ok(t2.includes('小主（你的主人）（之前那一局 东1局 0本场 说的）：打七万我就和了'), t2)
}

// 假模型：按 DSH ctx.llm 的样子（prepareCall → {config, stream}）。第 7 次调用抛错、每 11 次回乱码。
let n = 0
const seen = []
const mid = {}
const llm = {
  async prepareCall(config, signal, configure) {
    const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
    const resolved = { provider: config.provider, model: config.model, ...controls }
    return {
      config: resolved,
      async *stream(options) {
        n++
        seen.push(options)
        assert.equal(options.reasoningEffort, 'low')
        if (n === 7) throw new Error('假的接口错误')
        const opts = options.messages[0].content[0].text.split('可选操作')[1].trim().split('\n').slice(1)
        // 有“打”就打最后一张（摸切），否则选第一个
        const k = opts.findLastIndex((l) => /\. 打 /.test(l))
        if (n === 15) { mid.self = selfText(client.view, brain.recent); mid.ju = juOf(client.view); mid.view = client.view; room.chat(1, '中途说一句', 'chat') }
        const text = n % 11 === 0 || n === 30 || n === 31 ? '嗯嗯我觉得吧' : `{"choice": ${k >= 0 ? k : 0}, "why": "第${n}手的理由", "say": "${n % 5 === 0 ? '第' + n + '手，就这张' : ''}"}`
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 30, cacheReadTokens: 100 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const server = await new TableServer({ port: 47793 }).listen()
const room = server.openRoom({
  settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
  seats: [{ name: '肥鱼', kind: 'agent' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }, { name: '机器人丙', kind: 'bot' }],
})
const brain = new FishBrain({ llm, route: { provider: 'fake', model: 'fake-1' }, effort: 'low', persona: '我是测试用的肥鱼，爱摸切。', name: '肥鱼', logger: { warn() {} } })
const client = new SeatClient({ origin: server.origin, code: room.code, token: room.players[0].token, brain, name: '肥鱼' })
client.run()
const end = await client.ended
const sum = brain.summary()
console.log('终局', end.defen, '肥鱼', sum)
assert.ok(seen[0].system.includes('我是测试用的肥鱼'), '人设卡要进系统提示')
assert.ok(seen[0].messages[0].content[0].text.includes('你的手牌：'))
assert.ok(seen.every((o) => /你是[东南西北]家；庄家是/.test(o.messages[0].content[0].text)), '牌面里要写明她的风位和庄家')
assert.ok(sum.hands > 10)
assert.ok(sum.retries >= 1, '出错/乱码要重试')
const lines = room.chatLog.filter((c) => c.kind === 'line' && c.from === 0)
assert.equal(lines.length, 0, '出牌这一路不说话：假模型给了 say 也不能进桌上聊天')
const seat = room.players[0]
assert.ok(sum.proxied >= 1, '连着两次失败要代打')
assert.equal(seat.stats.takeovers, sum.proxied, '代打次数要对得上')
// 鸣牌窗口里代打的那手攒到这一局结束才写，写法不一样（不说是哪一手）
assert.ok(room.chatLog.some((c) => c.kind === 'system' && c.text.includes('代打') && c.text.includes('回复解析不出来')), '代打要在桌上写明')
// 10-29：给她会话那一半看的自己的牌：手牌 + 这一局出牌那一路最近几手和理由；聊天标着哪一局
assert.ok(mid.self.includes('你现在的手牌（只有你看得到）：'), mid.self)
assert.match(mid.self, /最近打的几手[\s\S]*（第\d+手的理由）/, mid.self)
assert.ok(brain.recent.length > 0 && brain.recent.every((r) => /^[东南]\d局 \d+本场$/.test(r.ju)), JSON.stringify(brain.recent.slice(-2)))
assert.equal(brain.recent.length, 30, '最近几手只留 30 条')
assert.equal(room.chatLog.find((c) => c.text === '中途说一句').ju, mid.ju)
// 送进她会话的消息：带上自己的牌；换了局写明上一局的事都过去了
{
  const sent = []
  let view = mid.view
  const fakeRoom = { code: 'TEST', status: 'playing', names: ['肥鱼', '小主', '甲', '乙'], publicInfo: () => ({ names: ['肥鱼', '小主', '甲', '乙'], families: [], defen: null }), windText: () => '东1局：你是东家' }
  const link = new SessionLink({ agent: { status: 'running', inject: (m) => sent.push(m.content[0].text) }, room: fakeRoom, seatId: 0, ownerSeat: 1, peek: () => ({ view, recent: brain.recent }), logger: { warn() {} }, opts: { debounceMs: 1, minWakeGapMs: 0, maxBatch: 12 } })
  link.push({ from: 1, name: '小主', kind: 'chat', text: '要七万', ju: mid.ju })
  link.flush()
  assert.ok(sent[0].includes('你现在的手牌') && !sent[0].includes('换局了'), sent[0])
  fakeRoom.events = [{ t: Date.now() + 5, text: '甲 打 七万' }, { t: Date.now() + 5, text: '必须 赢 自摸，18000 点（立直、三暗刻）' }]
  view = { ...mid.view, round: '南4局', changbang: 3 }
  link.push({ from: 1, name: '小主', kind: 'chat', text: '还要七万吗', ju: mid.ju })
  link.flush()
  assert.ok(sent[1].includes('桌上的结果：\n  必须 赢 自摸，18000 点') && !sent[1].includes('打 七万'), sent[1])
  link.push({ from: 1, name: '小主', kind: 'chat', text: '再说一句', ju: mid.ju })
  link.flush()
  assert.ok(!sent[2].includes('桌上的结果'), '说过的结果不重复')
  assert.ok(sent[1].includes('换局了：现在是 南4局 3本场') && sent[1].includes(`（之前那一局 ${mid.ju} 说的）：还要七万吗`), sent[1])
  link.stop()
}
console.log('台词', lines.length, '条；代打', sum.proxied, '手；系统消息：', room.chatLog.filter((c) => c.kind === 'system' && c.text.includes('代打')).map((c) => c.text))
await server.close()
console.log('肥鱼脑子自测通过')
