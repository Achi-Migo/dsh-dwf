/**
 * 并发调度器（设计 §3.5 scheduler 段 / mechanism-map §5）：
 *   - 全局并发上限 maxConcurrency + pumpAll 泵活（must）；
 *   - 同 actor FIFO：同一 actor 的 ask 先到先结算（facade.d.ts:25-33）；
 *   - provider 侧错误重试固定次数 + 指数退避；确定性错误交给 onTerminal
 *     （run 以 'error' 结算等人）——**任何情况下错误对象不进脚本**：
 *     脚本侧只看到 promise 未决或折叠后的失败结果（设计 §4 硬规则 2）。
 *
 * 错误分类约定：任务的 work() 抛出的错误先问 task.isProviderError ——
 *   - provider 类（限流/过载/网络/startActivation 基础设施拒绝）→ 重试；
 *   - 确定性类（WorkflowError，宿主 realm 内 instanceof 可判）→ 不重试，
 *     直接 onTerminal；调用方（effects）会把确定性失败折叠进 guest 回包。
 */

/** WorkflowError 的宿主侧判定（@deepseek-ai/dsh-workflow，值导入经替身解析）。 */
import { WorkflowError } from '@deepseek-ai/dsh-workflow'

/** 一个可调度任务：work() 只允许以 provider 类错误 reject，其余失败自行折叠进回包。 */
export interface AskTask {
  /** 任务体；resolve = 任务完成（成功或已折叠的确定性失败）。 */
  work(): Promise<void>
  /** 错误分类钩子；缺省 = 非 WorkflowError 即 provider 类（可重试）。 */
  isProviderError?(error: unknown): boolean
}

export interface SchedulerOptions {
  /** provider 类错误的最大尝试次数（首次 + 重试），缺省 3。 */
  attempts?: number
  /** 指数退避基准毫秒（第 n 次重试等待 baseDelayMs * 2^n），缺省 400。 */
  baseDelayMs?: number
  /** 重试耗尽或确定性失败后的终局回调（run 层用它以 'error' 结算）。 */
  onTerminal?(task: AskTask, error: unknown): void
}

export class Scheduler {
  private readonly maxConcurrency: number
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly onTerminal: (task: AskTask, error: unknown) => void
  /** 同 actor 队列，Map 插入序 = actor 首次入队序（跨 actor 公平性）。 */
  private readonly queues = new Map<string, AskTask[]>()
  /** 有任务在飞的 actor：同 actor 串行的承重点（队头未结算，后续不得启动）。 */
  private readonly busy = new Set<string>()
  /** 正在执行的任务数。 */
  private active = 0

  constructor(maxConcurrency: number, options: SchedulerOptions = {}) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('Scheduler maxConcurrency must be a positive safe integer')
    }
    this.maxConcurrency = maxConcurrency
    this.attempts = options.attempts ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 400
    this.onTerminal = options.onTerminal ?? (() => {})
  }

  /** 同 actor FIFO 入队（actor 即 FIFO 键，run 层传 actor 标签）；入队即泵活。 */
  enqueue(actor: string, task: AskTask): void {
    const queue = this.queues.get(actor)
    if (queue === undefined) this.queues.set(actor, [task])
    else queue.push(task)
    void this.pumpAll()
  }

  /**
   * 泵活：在并发上限内启动每个非空 actor 队列的队头（同 actor 串行、
   * 跨 actor 并行）。幂等；入队与任务收割两处都会调用（mechanism-map §5 must）。
   */
  pumpAll(): void {
    while (this.active < this.maxConcurrency) {
      const next = this.takeNextEligible()
      if (next === undefined) break
      this.active += 1
      void this.runTask(next.actor, next.task)
    }
  }

  /** 当前在飞任务数（观测用）。 */
  get running(): number {
    return this.active
  }

  /** 等待全部任务离场（观测/测试用；正常泵活不需要它）。 */
  async drain(): Promise<void> {
    while (this.active > 0 || this.totalQueued() > 0) {
      this.pumpAll()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }

  private totalQueued(): number {
    let total = 0
    for (const queue of this.queues.values()) total += queue.length
    return total
  }

  /** 取下一个可启动任务：各非空队列的队头，且该 actor 没有任务在飞（同 actor FIFO）。 */
  private takeNextEligible(): { actor: string; task: AskTask } | undefined {
    for (const [actor, queue] of this.queues) {
      const head = queue[0]
      if (head === undefined) {
        if (queue.length === 0) this.queues.delete(actor)
        continue
      }
      if (this.busy.has(actor)) continue
      queue.shift()
      if (queue.length === 0) this.queues.delete(actor)
      this.busy.add(actor)
      return { actor, task: head }
    }
    return undefined
  }

  /** 固定次数 + 指数退避的执行循环；runTask 永不 reject（错误到终局回调为止）。 */
  private async runTask(actor: string, task: AskTask): Promise<void> {
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await task.work()
          return
        } catch (error: unknown) {
          const providerClass = task.isProviderError?.(error) ?? !(error instanceof WorkflowError)
          if (providerClass && attempt < this.attempts) {
            await this.delay(this.baseDelayMs * 2 ** attempt)
            continue
          }
          // 确定性错误或重试耗尽 → 终局回调（run 以 'error' 结算）；错误对象到此为止。
          this.onTerminal(task, error)
          return
        }
      }
    } finally {
      this.active -= 1
      this.busy.delete(actor)
      // 收割后立即补位。
      this.pumpAll()
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
