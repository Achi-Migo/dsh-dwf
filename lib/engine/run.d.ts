/**
 * 宿主侧 run（设计 §3.5 run.ts 段 / dsh-contract.md §4.1）：
 *   - result 永不 reject（seam 契约）：取消折叠 'cancelled'、错误折叠 'error'；
 *   - 清理序照抄官方（workflow-ptc/host.ts:307-317）：abort controller →
 *     dispose 全部已发布子代理 → Promise.allSettled 排空 pending → 再 dispose
 *     一轮 → 对仍在 liveAgents 的成员合成 outcome:'cancelled' 的 agent-end
 *     （每条 stop 路径恰好一次）；
 *   - AgentLedger：agent-start/agent-end 事件与 agentsStarted 的唯一归属地（B4）；
 *   - 宿主侧 run 级 Map<name, seq> 名字注册表在 declare-actor 事件抵达时查重
 *     （B7 定稿）：computed 名字重复 → WorkflowError('AGENT_START', fatal) →
 *     run 以 error 结算（facade.d.ts:37-38）；guest 守卫保留作双保险（拍板表#8）；
 *   - ptcRuntime 调用按 contract-v2 §1 核实形状：resolve(PtcRunRequest{program,
 *     bindings, timeoutMs:null, signal, sandboxPolicy}) → run(spec)；失败是
 *     result.error 字段而非 reject（ptc-runtime/types.ts:146-150）。
 *
 * 宿主函数面（PTC bindings）：{ global:'dwfHost', functions:{begin, request,
 * event, complete} } 就此四个（设计 §3.5）；model()/channel() 等 guest 本地
 * 原语由 prelude/channels 提供，不占绑定面。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowAgentOutcome, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow';
import type { WorkerInit } from '../guest/protocol.ts';
import type { RunWriter } from '../journal/store.ts';
import type { ModelPool } from './pool.ts';
/** 引擎事件回接（engine.start 构造 observer 时逐一经 emitWorkflowEvent 转发）。 */
export interface RunObserver {
    phase(title: string): void;
    log(message: string): void;
    agentStart(info: WorkflowAgentInfo): void;
    agentEnd(info: WorkflowAgentEndInfo): void;
}
export interface RunDeps {
    ctx: Context;
    subagents: SubagentRuntime;
    ptcRuntime: PtcRuntime;
    /** 引擎已 resolve 的会话沙箱策略（SandboxPolicyService.resolve 的产物）。 */
    policy: SandboxExecutionPolicy;
    id: WorkflowRunId;
    meta: WorkflowMeta;
    parent: Agent;
    /** resolveSubagentProvider 的产物（request.subagentProvider ?? 默认）。 */
    provider: string;
    /** 编译产物：lowering 后的脚本体（engine.start 第 2 步；B9 单编译路径）。 */
    body: string;
    args: unknown;
    limits: WorkerInit['limits'];
    writer: RunWriter;
    /** B10 收口后的本 run 总帽（min(请求值 ?? 64, ceiling 1000)）。 */
    runCap: number;
    maxConcurrency: number;
    /** 模型池（配置了 modelPool 才有；未配 = undefined，保持单模型缺省行为）。 */
    pool?: ModelPool;
    /** 单次 ask 的换道尝试上限（engine Config 透传）。 */
    failoverAttempts: number;
    /** workingDirectory.ensure(parent, signal) 的在途 promise（官方 host.ts:162 同法）。 */
    cwd: Promise<string>;
    signal?: AbortSignal;
    observer: RunObserver;
}
/**
 * per-run 子代理账本（B4）：seq 从 1 起单调分配；childId 取自 startActivation
 * 返回的 activation.childId；end 已 end 的 seq 幂等跳过——「每条 stop 路径恰好
 * 一次」由幂等守卫保证（seam 契约，workflow-seam/index.ts:79）。
 * 签名注记：DESIGN 写 begin(label, phase?)，但其注释自明 childId 来自 activation，
 * 故 childId 作显式入参；返回形状 {seq, childId} 不变。
 */
export declare class AgentLedger {
    private readonly onStart;
    private readonly onEnd;
    private nextSeq;
    private readonly ended;
    private startedCount;
    constructor(onStart: (info: WorkflowAgentInfo) => void, onEnd: (info: WorkflowAgentEndInfo) => void);
    begin(label: string, childId: SessionId, phase?: string): {
        seq: number;
        childId: SessionId;
    };
    /** 幂等配对：同一 seq 的第二条 end（无论 outcome）被跳过。 */
    end(seq: number, outcome: WorkflowAgentOutcome): void;
    /** 全程被接受的 agent() 调用数（seam 契约：终止路径退化为宿主侧计数）。 */
    get agentsStarted(): number;
    /** begin 时的信息快照（end 合成 cancelled agent-end 时展开用）。 */
    private readonly started;
}
export declare class DwfWorkflowRun implements WorkflowRun {
    readonly id: WorkflowRunId;
    readonly meta: WorkflowMeta;
    readonly result: Promise<WorkflowResult>;
    private readonly deps;
    private readonly controller;
    private readonly pending;
    private readonly liveAgents;
    private readonly ledger;
    private readonly scheduler;
    private readonly actors;
    private readonly sink;
    private readonly effects;
    /**
     * B7：run 级显式名查重集（#7 定稿后仅司显式名查重、不再承载序号）——
     * declare-actor 抵达时对 named !== false（缺省按显式，旧事件保形）的 label 查重。
     */
    private readonly agentNames;
    /**
     * #4/#7：本 run 已抵达的 declare-actor 声明计数。双职：① runCap 执法（先判后计，
     * 进入时已 >= runCap 即第 runCap+1 个声明 → fail，恰 runCap 个放行）；② ordinal
     * 的唯一来源（recordActor 与 actor-created 事件同源）——自动 label（named:false）
     * 不进 agentNames，序号若仍取 agentNames.size 会冻结错位。
     */
    private declaredActors;
    private readonly externalAbort;
    private terminal;
    private completeReceived;
    private cancelReason;
    private failReason;
    private completePayload;
    private disposed;
    constructor(deps: RunDeps);
    /**
     * 取消 run 及其子代理（seam 契约）。首个请求胜出；后续 cancel/dispose 幂等。
     */
    cancel(reason?: string): void;
    /** 取消未竟工作并等待脚本与子代理清理；幂等，共享同一个完成 promise。 */
    dispose(): Promise<void>;
    private drive;
    /** 程序执行段：沙箱硬门 → resolve → run（失败是 result.error 字段，非 reject）。 */
    private runProgram;
    /** 清理段自身绝不让 result reject：任何清理失败降级为 warn。 */
    private cleanup;
    /** 结算优先级：宿主 fail > guest complete > PTC result.error > 程序返回值。 */
    private settleFrom;
    /** 清理后的 journal 结账（settleRun 内部会补 run-settled 事件；journal status 词表是 failed，seam 词表是 error）。 */
    private settleJournal;
    private completed;
    private errored;
    private cancelled;
    /** 宿主侧确定性终局（report caps / 重名 / scheduler 终局）：run 以 'error' 结算等人。 */
    private fail;
    private track;
    private bindings;
    /** begin 回包：WorkerInit（meta/args/limits；评审 B7 的承载通道）。 */
    private initPayload;
    /** request 通道：六操作路由进 effects（dispatch 的 resolve/reject 即 guest 回包）。 */
    private onRequest;
    /** event 通道：即发即忘，与 request 共享 FIFO（guest-template-01:14-19 承重语义）。 */
    private onEvent;
    /**
     * B7 定稿：宿主侧查重（#7：仅对显式名——args.named !== false，缺省按显式保旧形）。
     * computed 名字重复 → WorkflowError('AGENT_START', fatal) → run 以 error 结算
     * （facade.d.ts:37-38）；字面量重复已在编译期拦截。
     * #4：runCap 在此执法（先判后计：进入时计数已 >= runCap 即第 runCap+1 个声明 →
     * fail run，恰 runCap 个放行；先增后判会拒掉恰第 runCap 个，off-by-one），
     * 错误定性对齐 B7 重名的 AGENT_START fatal。
     * #7/#4 联动：ordinal（recordActor 与 actor-created 事件 payload 同源）改由
     * 声明计数承载——agentNames 不再承载序号；actors.register 对自动 label 照常
     * （ask 路由不变；撞名时后到不覆盖先到）。
     * dwf_actor 行照建（recordActor；拍板表#17 收编进 RunWriter）。
     */
    private onDeclareActor;
    /** complete 通道：幂等结算（首个 complete 胜出，与 prelude __settled 双保险）。 */
    private onComplete;
}
/** D3：worker-exit 两形态折叠消息的统一前缀（journal failure_json 可 grep 的钉死契约）。 */
export declare const WORKER_EXIT_PREFIX = "workflow worker exited before settling: ";
/**
 * D3/t3-epipe-clean-error 修复（仅 settleFrom error 分支 kind==='worker-exit' 调用）：
 * 运行时两形态须区分但统一前缀——
 * ①正常 worker 退出路径的退出汇总已内嵌退出码+stderr 摘录（dsh-ptc-runtime-node
 *   lib/index.js `Node process exited (code, signal): <stderr>` /
 *   `Node process exited before completing (code): <stderr>`）→ 前缀 + 运行时原文
 *   （stderr 已在原文里，不再重复摘录）；
 * ②流/通道 error 路径（其 stdout/stderr.on("error") 与 JsonChannel io failure，
 *   先结算者胜，抢在带退出码的汇总之前）只剩裸消息，如裸 'write EPIPE'
 *   （run 07770553 首例）→ 前缀 + error.message 全文（'write EPIPE' 字面不得改写
 *   删除）+ 可用诊断：worker 捕获输出尾部摘录（其 stderr 文本被运行时 admit 进
 *   PtcRunResult.logs，types.d.ts:158）；logs 为空则如实说明未捕获（绝不伪造 stderr）。
 *   两种形态消息都不以裸 EPIPE 结尾。
 */
export declare function cleanWorkerExitMessage(message: string, logs?: readonly string[]): string;
