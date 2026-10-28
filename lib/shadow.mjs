// 影子 AI：协议座位在服务端的"替身"。
// 1) 跟着这个座位收到的每条消息同步牌面（它就是一个 majiang-ai 玩家）；
// 2) 在要做决定的那一刻，按引擎规则列出这个座位全部合法选项（编号）；
// 3) 它自己的选择就是"代打"时用的那一手（超时、掉线、客户端出错）。
// 选项必须在 action_* 里当场算：Player 在 action 之后会更新振听等状态（core/lib/player.js dapai()）。
import { createRequire } from 'node:module'
import { tileName, fulouLabel } from './tiles.mjs'

const require = createRequire(import.meta.url)
const Majiang = require('@kobalab/majiang-core')
const AI = require('@kobalab/majiang-ai')

const CHANKAN_ONLY = /^[mpsz]\d{4}$/ // 暗杠：不能抢

function dapaiOptions(self, shoupai, withLizhi) {
  const opts = []
  for (const p of self.get_dapai(shoupai) || []) {
    const t = p.replace(/_$/, '')
    const label = p.endsWith('_') ? `打 ${tileName(t)}（摸切）` : `打 ${tileName(t)}`
    opts.push({ kind: 'dapai', label, reply: { dapai: p } })
  }
  if (withLizhi) {
    const lizhi = self.allow_lizhi(shoupai)
    for (const p of lizhi || []) {
      const t = p.replace(/_$/, '')
      opts.push({ kind: 'lizhi', label: `立直 打 ${tileName(t)}${p.endsWith('_') ? '（摸切）' : ''}`, reply: { dapai: p + '*' } })
    }
  }
  return opts
}

export class ShadowAI extends AI {
  /** 最近一次要做决定时的选项；没有决定则为 null。读走后由调用方清空。 */
  pending = null

  action_zimo(zimo, gangzimo) {
    if (zimo.l === this._menfeng) {
      const sp = this.shoupai
      const opts = []
      if (this.allow_hule(sp, null, gangzimo)) opts.push({ kind: 'hule', label: '自摸', reply: { hule: '-' } })
      if (this.allow_pingju(sp)) opts.push({ kind: 'pingju', label: '九种九牌（流局）', reply: { daopai: '-' } })
      for (const m of this.get_gang_mianzi(sp) || []) opts.push({ kind: 'gang', label: fulouLabel(m), reply: { gang: m } })
      opts.push(...dapaiOptions(this, sp, true))
      this.pending = opts
    }
    super.action_zimo(zimo, gangzimo)
  }

  action_dapai(dapai) {
    if (dapai.l !== this._menfeng) {
      const sp = this.shoupai
      const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4]
      const p = dapai.p.slice(0, 2) + d
      const opts = []
      if (this.allow_hule(sp, p)) opts.push({ kind: 'hule', label: `荣和 ${tileName(p)}`, reply: { hule: '-' } })
      for (const m of this.get_gang_mianzi(sp, p) || []) opts.push({ kind: 'fulou', label: fulouLabel(m), reply: { fulou: m } })
      for (const m of this.get_peng_mianzi(sp, p) || []) opts.push({ kind: 'fulou', label: fulouLabel(m), reply: { fulou: m } })
      for (const m of this.get_chi_mianzi(sp, p) || []) opts.push({ kind: 'fulou', label: fulouLabel(m), reply: { fulou: m } })
      if (opts.length) {
        opts.push({ kind: 'skip', label: '跳过', reply: {} })
        this.pending = opts
      }
    }
    super.action_dapai(dapai)
  }

  action_fulou(fulou) {
    // 吃/碰之后要打一张；大明杠之后是岭上摸牌，不在这里打
    if (fulou.l === this._menfeng && !/^[mpsz]\d{4}/.test(fulou.m)) {
      this.pending = dapaiOptions(this, this.shoupai, false)
    }
    super.action_fulou(fulou)
  }

  action_gang(gang) {
    if (gang.l !== this._menfeng && !CHANKAN_ONLY.test(gang.m)) {
      const d = ['', '+', '=', '-'][(4 + this._model.lunban - this._menfeng) % 4]
      const p = gang.m[0] + gang.m.slice(-1) + d
      if (this.allow_hule(this.shoupai, p, true)) {
        this.pending = [
          { kind: 'hule', label: `抢杠 ${tileName(p)}`, reply: { hule: '-' } },
          { kind: 'skip', label: '跳过', reply: {} },
        ]
      }
    }
    super.action_gang(gang)
  }
}

/** 难度 → 机器人类。强 = 当前版，中/弱 = 作者留下的旧版思考程序。 */
export function botClass(level) {
  if (level === '弱') return require('@kobalab/majiang-ai/legacy')('0000')
  if (level === '中') return require('@kobalab/majiang-ai/legacy')('0301')
  return AI
}

/** 回复对象比较：AI 回 undefined 等于跳过。 */
export function sameReply(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {})
}

export { Majiang, AI }
