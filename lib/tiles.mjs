// majiang 牌名 ↔ 中文。m/p/s = 万/筒/索，0 = 赤五，z1..z7 = 东南西北白发中。
const SUIT = { m: '万', p: '筒', s: '索' }
const ZI = ['', '东', '南', '西', '北', '白', '发', '中']
export const FENG = ['东', '南', '西', '北']

/** 'm0' → '赤5万'，'z1' → '东'；尾巴上的 _ * + = - 忽略。 */
export function tileName(p) {
  if (!p || p === '_') return '?'
  const s = p[0], n = +p[1]
  if (s === 'z') return ZI[n] || '?'
  return n === 0 ? `赤5${SUIT[s]}` : `${n}${SUIT[s]}`
}

/** 副露串 'm1-23' / 'p555=' / 's5550' → '吃 1索2索3索' 之类。 */
export function mianziName(m) {
  const s = m[0]
  const nums = m.match(/\d/g) || []
  const tiles = nums.map((n) => tileName(s + n)).join('')
  if (nums.length === 4) return (/[\+\=\-]/.test(m) ? '明杠 ' : '暗杠 ') + tiles
  const uniq = new Set(nums.map((n) => (n === '0' ? '5' : n)))
  return (uniq.size === 1 ? '碰 ' : '吃 ') + tiles
}

/**
 * 鸣牌选项的说法：'s067-' → '吃 7索，用手里的 赤5索 6索'；'m550=' → '碰 赤5万，用手里的 5万 5万'。
 * 被鸣的那张是后面跟着 +=- 的那个数字，其余是自己手里出的。同一张牌能用不同搭子吃时（34 吃 5、46 吃 5、67 吃 5，
 * 或者用不用赤五），靠“用手里的哪几张”分清。暗杠、加杠（自己摸牌时）也走这里。
 */
export function fulouLabel(m) {
  const s = m[0]
  const parts = [...m.slice(1).matchAll(/(\d)([+=\-]?)/g)]
  const nums = parts.map((x) => x[1])
  const called = parts.find((x) => x[2])
  if (nums.length === 4) {
    if (!called) return `暗杠 ${tileName(s + nums[0])}`
    // 加杠：碰过的那组后面再补一张（串的最后一位）；大明杠：串的最后才是方向记号
    if (!/[+=\-]$/.test(m)) return `加杠 ${tileName(s + nums[3])}`
    return `明杠 ${tileName(s + called[1])}，用手里的 ${nums.slice(0, 3).map((n) => tileName(s + n)).join(' ')}`
  }
  const own = parts.filter((x) => x !== called).map((x) => tileName(s + x[1]))
  const uniq = new Set(nums.map((n) => (n === '0' ? '5' : n)))
  return `${uniq.size === 1 ? '碰' : '吃'} ${tileName(s + (called ? called[1] : nums[0]))}，用手里的 ${own.join(' ')}`
}

/** Shoupai.toString() 的手牌部分 → 牌名数组（不含副露）。 */
export function handTiles(str) {
  const out = []
  const bing = String(str || '').split(',')[0]
  for (const part of bing.match(/[mpsz]\d+[\*_]?|_+/g) || []) {
    if (part[0] === '_') { for (const _ of part) out.push('?'); continue }
    const s = part[0]
    for (const n of part.slice(1).replace(/[\*_]/g, '')) out.push(s + n)
  }
  return out
}

/** 场风 + 局数，如 '东2局'。 */
export function roundName(zhuangfeng, jushu) {
  return `${FENG[zhuangfeng] || '?'}${jushu + 1}局`
}

// 役名：majiang-core 给的是日文（core/lib/hule.js），按雀魂中文服的叫法换成中文。
const YAKU_ZH = {
  '立直': '立直', 'ダブル立直': '两立直', '一発': '一发', '門前清自摸和': '门前清自摸和', '平和': '平和', '断幺九': '断幺九',
  '一盃口': '一杯口', '二盃口': '两杯口', '槍槓': '抢杠', '嶺上開花': '岭上开花', '海底摸月': '海底摸月', '河底撈魚': '河底捞鱼',
  '三色同順': '三色同顺', '一気通貫': '一气通贯', '混全帯幺九': '混全带幺九', '純全帯幺九': '纯全带幺九', '七対子': '七对子',
  '対々和': '对对和', '三暗刻': '三暗刻', '三槓子': '三杠子', '三色同刻': '三色同刻', '混老頭': '混老头', '小三元': '小三元',
  '混一色': '混一色', '清一色': '清一色', '国士無双': '国士无双', '国士無双十三面': '国士无双十三面', '四暗刻': '四暗刻',
  '四暗刻単騎': '四暗刻单骑', '大三元': '大三元', '小四喜': '小四喜', '大四喜': '大四喜', '字一色': '字一色', '緑一色': '绿一色',
  '清老頭': '清老头', '四槓子': '四杠子', '九蓮宝燈': '九莲宝灯', '純正九蓮宝燈': '纯正九莲宝灯', '天和': '天和', '地和': '地和',
  'ドラ': '宝牌', '赤ドラ': '赤宝牌', '裏ドラ': '里宝牌', '翻牌 白': '役牌 白', '翻牌 發': '役牌 发', '翻牌 中': '役牌 中',
}
const WIND_JA = { '東': '东', '南': '南', '西': '西', '北': '北' }
export function yakuName(n) {
  if (YAKU_ZH[n]) return YAKU_ZH[n]
  const m = /^(場風|自風) (.)$/.exec(n)
  if (m) return `${m[1] === '場風' ? '场风' : '自风'} ${WIND_JA[m[2]] || m[2]}`
  return n
}

// 流局名同样换成中文
const PINGJU_ZH = { '荒牌平局': '荒牌流局', '九種九牌': '九种九牌', '四風連打': '四风连打', '四家立直': '四家立直', '四開槓': '四杠散了', '三家和': '三家和了', '流し満貫': '流局满贯' }
export const pingjuName = (n) => PINGJU_ZH[n] || n
