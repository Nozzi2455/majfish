// 自测局：3 个机器人座位 + 1 个走协议的测试客户端（127.0.0.1，和肥鱼座位同一条路）。
import { SeatClient, AiBrain } from './seat-client.mjs'

export function startSelftest(server, { length = '东风', logger = console } = {}) {
  const room = server.openRoom({
    settings: { length, rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null },
    seats: [
      { name: '机器人甲', kind: 'bot' },
      { name: '测试客户端', kind: 'agent' },
      { name: '机器人乙', kind: 'bot' },
      { name: '机器人丙', kind: 'bot' },
    ],
  })
  const seat = room.players[1]
  const client = new SeatClient({ origin: server.origin, code: room.code, token: seat.token, brain: new AiBrain(), logger, name: '测试客户端' })
  client.run()
  return { room, client }
}
