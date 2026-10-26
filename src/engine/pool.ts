/**
 * 模型池（用户需求 2026-10-25：多供应商接入摊负载 + 故障自动换道）：
 *   - 配置一批模型（"provider/model" 复合或裸模型名），未显式绑模型的 actor
 *     由池按策略分摊——跨 provider 摊开并发，降低单家限流概率；
 *   - 确定性 provider 故障（额度尽/401/403/模型不存在）→ 该 provider 进冷却窗，
 *     在窗内 choose 跳过；换道后 journal 记 'model-failover' 事件；
 *   - 分摊策略 'spread'：按 provider 累计分配数最少优先（确定性、可重放，
 *     不依赖在途计数）；'round-robin'：轮转。
 *
 * 纯逻辑、零官方包依赖（宿主侧可用 Date.now；禁令只作用于 guest realm）。
 */

export interface ModelPoolOptions {
  /** 分摊策略：spread=最少分配优先（默认），round-robin=轮转。 */
  policy?: 'spread' | 'round-robin'
  /** 确定性故障后的冷却毫秒数，缺省 60000。 */
  cooldownMs?: number
  /** 可注入时钟（测试用），缺省 Date.now。 */
  now?: () => number
}

interface ProviderState {
  /** 该 provider 的模型清单（池内）。 */
  readonly models: string[]
  /** 累计分配次数（spread 的依据；只增不减，确定性保证重放一致）。 */
  assignments: number
  /** 冷却截止时间戳（毫秒）；0 = 健康。 */
  cooledUntil: number
}

export class ModelPool {
  private readonly providers = new Map<string, ProviderState>()
  private readonly providerOrder: string[] = []
  private readonly policy: 'spread' | 'round-robin'
  private readonly cooldownMs: number
  private readonly now: () => number
  private rrCursor = 0

  constructor(models: readonly string[], options: ModelPoolOptions = {}) {
    if (models.length === 0) throw new RangeError('ModelPool requires at least one model')
    for (const raw of models) {
      const model = raw.trim()
      if (model.length === 0) continue
      const provider = providerOf(model)
      let state = this.providers.get(provider)
      if (state === undefined) {
        state = { models: [], assignments: 0, cooledUntil: 0 }
        this.providers.set(provider, state)
        this.providerOrder.push(provider)
      }
      state.models.push(model)
    }
    if (this.providerOrder.length === 0) throw new RangeError('ModelPool requires at least one non-empty model id')
    this.policy = options.policy ?? 'spread'
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  /** 模型串的 provider 键：'/' 前缀；无前缀（裸模型名）归 'default' 桶。 */
  static providerKey(model: string): string {
    return providerOf(model)
  }

  /**
   * 选一个模型：跳过冷却中的 provider；spread 取累计分配最少者（平手取
   * providerOrder 在前），选中即计一次分配。全部冷却/无可用 → undefined
   * （调用方回落到原模型并走既有失败路径，绝不静默假装成功）。
   */
  choose(): string | undefined {
    const t = this.now()
    const healthy = this.providerOrder.filter(p => (this.providers.get(p)?.cooledUntil ?? 0) <= t)
    if (healthy.length === 0) return undefined
    let picked: string
    if (this.policy === 'round-robin') {
      for (let i = 0; i < this.providerOrder.length; i++) {
        const provider = this.providerOrder[(this.rrCursor + i) % this.providerOrder.length]
        if (!healthy.includes(provider)) continue
        this.rrCursor = (this.rrCursor + i + 1) % this.providerOrder.length
        picked = provider
        break
      }
    } else {
      picked = healthy.reduce((best, p) =>
        (this.providers.get(p)?.assignments ?? 0) < (this.providers.get(best)?.assignments ?? 0) ? p : best,
      )
    }
    const state = this.providers.get(picked!)
    if (state === undefined) return undefined
    state.assignments += 1
    // 同 provider 多模型：轮转取，避免永远只用第一个。
    return state.models[state.assignments % state.models.length] ?? state.models[0]
  }

  /**
   * 标记一次确定性 provider 故障：该 provider 进入冷却窗。
   * 未知模型（不在池内）只记 warn 语义，不冷却任何桶。
   */
  markProviderFailure(model: string): void {
    const state = this.providers.get(providerOf(model))
    if (state === undefined) return
    state.cooledUntil = this.now() + this.cooldownMs
  }

  /** 当前快照（观测/测试）：provider → {模型数, 分配数, 冷却剩余毫秒}。 */
  snapshot(): Array<{ provider: string; models: number; assignments: number; cooldownRemainMs: number }> {
    const t = this.now()
    return this.providerOrder.map(provider => {
      const state = this.providers.get(provider)!
      return {
        provider,
        models: state.models.length,
        assignments: state.assignments,
        cooldownRemainMs: Math.max(0, state.cooledUntil - t),
      }
    })
  }
}

function providerOf(model: string): string {
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash) : 'default'
}

/**
 * provider 错误分类（actor 换道循环用）：确定性 = 额度尽/鉴权/模型不存在
 * 这类换模型（或换 provider）才有意义的失败；其余（限流/过载/网络/超时）
 * 视为瞬态——同模型退避重试优先，耗尽后再换道。
 * 启发式基于 message/code 关键词（subagent 错误无统一类型面，如实标注）。
 */
export function classifyProviderError(error: unknown): 'deterministic' | 'transient' {
  const text = `${error instanceof Error ? `${error.message} ${error.name}` : String(error)} ${(error as { code?: unknown } | null)?.code ?? ''}`.toLowerCase()
  if (/quota|insufficient|balance|401|403|unauthorized|forbidden|not.?found|404|no.?such.?model|invalid.?model|expired|plan/.test(text)) {
    return 'deterministic'
  }
  return 'transient'
}
