// 不进 DSH 的自测：起牌桌服务，用测试客户端（走协议）+ 3 个机器人打一局，再验几条鉴权和隐藏信息。
// 用法：node test/selftest.mjs [东风|半庄]
import assert from 'node:assert/strict'
import { TableServer } from '../lib/server.mjs'
import { startSelftest } from '../lib/selftest.mjs'

const server = await new TableServer({ port: 47790 }).listen()
const t0 = Date.now()
const { room, client } = startSelftest(server, { length: process.argv[2] || '东风' })
const code = room.code
const seat = room.players[1]

// 鉴权：错令牌、错房间码、旁观不能出牌
const r1 = await fetch(`${server.origin}/room/${code}/seat/state?t=wrong`)
assert.equal(r1.status, 401)
const r2 = await fetch(`${server.origin}/room/ZZZZZZ/seat/state?t=${seat.token}`)
assert.equal(r2.status, 404)
const r3 = await fetch(`${server.origin}/debug/state?k=nope`)
assert.equal(r3.status, 403)

// 隐藏信息：座位视角里别家手牌拿不到，只有自己的
const st = await (await fetch(`${server.origin}/room/${code}/seat/state?t=${seat.token}`)).json()
if (st.view.phase === 'playing') {
  assert.ok(!JSON.stringify(st.view).includes('shoupai'), '视角里不该有别家手牌字段')
  assert.equal(st.view.seats.filter((s) => s.me).length, 1)
}

const end = await client.ended
const ms = Date.now() - t0
const dbg = await (await fetch(`${server.origin}/debug/state?k=${server.adminKey}`)).json()
const info = dbg.rooms.find((r) => r.code === code)
console.log('终局', end)
console.log('局数', info.hands, '用时', ms, 'ms', '测试客户端', info.seats[1])
console.log(info.events.slice(-4).map((e) => e.text).join('\n'))
assert.equal(info.status, 'ended')
assert.equal(info.seats[1].takeovers, 0, '测试客户端不该被代打')
assert.ok(info.seats[1].decisions > 10)
assert.equal(end.defen.reduce((a, b) => a + b, 0), 100000)
await server.close()
console.log('自测通过')
