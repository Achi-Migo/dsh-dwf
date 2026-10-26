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
/** 一个可调度任务：work() 只允许以 provider 类错误 reject，其余失败自行折叠进回包。 */
export interface AskTask {
    /** 任务体；resolve = 任务完成（成功或已折叠的确定性失败）。 */
    work(): Promise<void>;
    /** 错误分类钩子；缺省 = 非 WorkflowError 即 provider 类（可重试）。 */
    isProviderError?(error: unknown): boolean;
}
export interface SchedulerOptions {
    /** provider 类错误的最大尝试次数（首次 + 重试），缺省 3。 */
    attempts?: number;
    /** 指数退避基准毫秒（第 n 次重试等待 baseDelayMs * 2^n），缺省 400。 */
    baseDelayMs?: number;
    /** 重试耗尽或确定性失败后的终局回调（run 层用它以 'error' 结算）。 */
    onTerminal?(task: AskTask, error: unknown): void;
}
export declare class Scheduler {
    private readonly maxConcurrency;
    private readonly attempts;
    private readonly baseDelayMs;
    private readonly onTerminal;
    /** 同 actor 队列，Map 插入序 = actor 首次入队序（跨 actor 公平性）。 */
    private readonly queues;
    /** 有任务在飞的 actor：同 actor 串行的承重点（队头未结算，后续不得启动）。 */
    private readonly busy;
    /** 正在执行的任务数。 */
    private active;
    constructor(maxConcurrency: number, options?: SchedulerOptions);
    /** 同 actor FIFO 入队（actor 即 FIFO 键，run 层传 actor 标签）；入队即泵活。 */
    enqueue(actor: string, task: AskTask): void;
    /**
     * 泵活：在并发上限内启动每个非空 actor 队列的队头（同 actor 串行、
     * 跨 actor 并行）。幂等；入队与任务收割两处都会调用（mechanism-map §5 must）。
     */
    pumpAll(): void;
    /** 当前在飞任务数（观测用）。 */
    get running(): number;
    /** 等待全部任务离场（观测/测试用；正常泵活不需要它）。 */
    drain(): Promise<void>;
    private totalQueued;
    /** 取下一个可启动任务：各非空队列的队头，且该 actor 没有任务在飞（同 actor FIFO）。 */
    private takeNextEligible;
    /** 固定次数 + 指数退避的执行循环；runTask 永不 reject（错误到终局回调为止）。 */
    private runTask;
    private delay;
}
