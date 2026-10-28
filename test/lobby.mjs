// 大厅（改进 2/3）：有真人座位时不准备就不开局；昵称颜色在大厅里能改、重名拒收、太暗的颜色调亮；开局后不能再改。
// 用法：node test/lobby.mjs
import assert from 'node:assert/strict'
import { TableServer } from '../lib/server.mjs'
import { SeatClient, AiBrain } from '../lib/seat-client.mjs'
import { normalizeColor } from '../lib/room.mjs'

const server = await new TableServer({ port: 47792 }).listen()
const room = server.openRoom({
  settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
  seats: [{ name: '肥鱼', kind: 'agent', color: '#5ec8f2' }, { name: '主人', kind: 'human', color: '#101010' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }],
})
const human = room.players[1]
const post = (p, body) => fetch(`${server.origin}/room/${room.code}/seat/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${human.token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }))
const state = () => fetch(`${server.origin}/room/${room.code}/seat/state?t=${human.token}`).then((r) => r.json())

assert.equal(room.status, 'lobby')
assert.notEqual(room.seatInfo[1].color, '#101010', '太暗的颜色要调亮')
assert.equal(normalizeColor('not a color', '#abcdef'), '#abcdef')
assert.equal(normalizeColor('#ffb454', null), '#ffb454', '够亮的颜色不动')

const fish = new SeatClient({ origin: server.origin, code: room.code, token: room.players[0].token, brain: new AiBrain(), name: '肥鱼' })
fish.run()
await new Promise((r) => setTimeout(r, 400))
let st = await state()
assert.equal(st.lobby.status, 'lobby', '真人没准备，不该开局')
assert.deepEqual(st.lobby.seats.map((s) => s.ready), [true, false, true, true], '肥鱼座位和机器人自动准备')
assert.equal(st.view.phase, 'lobby')

assert.equal((await post('profile', { name: '肥鱼' })).status, 409, '重名要拒收')
const pr = await post('profile', { name: '  小主<b>  ', color: '#ff66aa' })
assert.equal(pr.status, 200)
assert.equal(pr.body.name, '小主b')
assert.equal(pr.body.color, '#ff66aa')
st = await state()
assert.equal(st.lobby.seats[1].name, '小主b')

assert.equal((await post('ready', { ready: true })).status, 200)
await new Promise((r) => setTimeout(r, 300))
assert.equal(room.status, 'playing')
assert.equal((await post('profile', { name: '改名' })).status, 409, '开局后不能改名')
assert.equal((await post('ready', { ready: false })).status, 409)
st = await state()
assert.equal(st.view.phase, 'playing')
assert.ok(room.chatLog.some((c) => c.kind === 'system' && c.text.includes('开局')))

room.abort('测试结束')
fish.stop()
await server.close()
console.log('大厅自测通过')
