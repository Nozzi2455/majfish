// 给模型看的牌面文字：照搬 rtable/tracker.py 的版式（调研 §5），数据来源换成座位视角 view。
// view 由 room.mjs ProtocolSeat.view() 生成，本来就只有这个座位看得到的东西。
import { tileName } from './tiles.mjs'

const REL = ['你', '下家', '对家', '上家']
const FENG_OF = (l) => '东南西北'[l] // 座位视角的 l：0 = 东家（庄家）

/** 宝牌指示牌 → 宝牌。 */
export function nextDora(p) {
  const s = p[0]
  let n = +p[1] || 5
  if (s === 'z') n = n <= 4 ? (n % 4) + 1 : ((n - 4) % 3) + 5
  else n = (n % 9) + 1
  return s + n
}

function riverText(he) {
  return he.map((t) => {
    let s = t.name
    if (t.tsumogiri) s += '↓'
    if (t.lizhi) s = '【立直】' + s
    if (t.called) s = `(${s}被鸣)`
    return s
  }).join(' ') || '（无）'
}

/** 听牌提示（和网页上主人看到的一样）：'3索剩2 6索剩0，振听'。 */
export function tingText(t) {
  return t.waits.map((w) => `${w.name}剩${w.left}`).join(' ') + (t.furiten ? '，振听（不能荣和）' : '')
}

/**
 * @param {object} view 座位视角（phase = playing）
 * @param {object} decision {options:[{i, label}]}
 * @returns {string}
 */
export function boardText(view, decision) {
  const me = view.me
  const rel = (l) => REL[(l - me + 4) % 4]
  const label = (s) => `${rel(s.l)}（${s.name}，${s.feng}家）`
  const lines = []
  lines.push(`【${view.round} ${view.changbang}本场，场上立直棒 ${view.lizhibang} 根】牌山剩余 ${view.paishu} 张`)
  lines.push(`宝牌指示牌：${view.baopai.map((t) => `${t.name}→宝牌${tileName(nextDora(t.p))}`).join('、')}（赤5也算宝牌）`)
  const order = [0, 1, 2, 3].map((k) => view.seats.find((s) => s.l === (me + k) % 4))
  const dealer = view.seats.find((s) => s.l === 0)
  lines.push(`你是${FENG_OF(me)}家；庄家是${dealer.l === me ? '你自己' : `${rel(dealer.l)}（${dealer.name}）`}`)
  lines.push('分数：' + order.map((s) => `${label(s)} ${s.defen}`).join(' | '))
  lines.push('')
  lines.push('舍牌（按顺序；↓=摸切，没有↓=手切；【立直】=立直宣言牌）：')
  for (const s of order) lines.push(`  ${label(s)}${s.lizhi ? '（已立直！）' : ''}：${riverText(s.he)}`)
  const melds = order.filter((s) => s.fulou.length).map((s) => `  ${label(s)}：${s.fulou.map((m) => m.name).join('；')}`)
  if (melds.length) lines.push('副露：', ...melds)
  lines.push('')
  const hand = view.hand
  lines.push(`你的手牌：${hand.tiles.map((t) => t.name).join(' ')}${hand.zimo ? `　摸到：${hand.zimo.name}` : ''}`)
  const cur = view.seats.find((s) => s.l === view.lunban)
  if (cur && cur.l !== me && cur.he.length && !hand.zimo) lines.push(`刚才${rel(cur.l)}打出了：${cur.he[cur.he.length - 1].name}`)
  lines.push('')
  if (hand.ting) lines.push(`你现在听牌：${tingText(hand.ting)}`)
  lines.push('可选操作（只能选一个编号）：')
  for (const o of decision.options) lines.push(`${o.i}. ${o.label}${o.ting ? `（打完听 ${tingText(o.ting)}）` : ''}`)
  return lines.join('\n')
}
