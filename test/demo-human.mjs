// 手动看页面用：起一个有真人座位的房间，打印链接，一直跑到 Ctrl+C。
import { TableServer } from '../lib/server.mjs'
import { SeatClient, AiBrain } from '../lib/seat-client.mjs'
const s = await new TableServer({ port: 47791 }).listen()
// 想看台词气泡：0 号座位是机器人假扮的“测试台词机”，30% 的手随机说一句写死的话（只为看样式）。
// 不叫“肥鱼”：真的肥鱼 10-28 晚起出牌时不说话，别拿这个演示当成她（主人看截图误会过一次）。
const LINES = ['嗯……这张先打了', '别急别急', '这手有点意思', '你们小心点哦']
const room = s.openRoom({ settings: { length: '东风', rules: '雀魂', botLevel: '强', effort: 'low', timeLimitSec: null }, seats: [{ name: '测试台词机', kind: 'agent', color: '#5ec8f2' },{ name: '主人', kind: 'human', color: '#ffb454' }, { name: '机器人甲', kind: 'bot' }, { name: '机器人乙', kind: 'bot' }] })
new SeatClient({ origin: s.origin, code: room.code, token: room.players[0].token, brain: Object.assign(new AiBrain(), { decide(d) { const r = AiBrain.prototype.decide.call(this, d); if (Math.random() < 0.3) r.say = LINES[Math.floor(Math.random() * LINES.length)]; return r } }), name: '测试台词机' }).run()
console.log('SEAT', s.seatUrl(room, room.players[1]))
console.log('WATCH', s.watchUrl(room, 0))
console.log('DEBUG', s.debugUrl())
