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
import { CHANNEL_PRIMITIVES_SOURCE } from "../guest/channels.js";
import { GUEST_PRELUDE_SOURCE } from "../guest/prelude.js";
import { REALM_BANS_SOURCE } from "../guest/realm.js";
import { snapshotJsonValue } from "../util/json.js";
import { ActorRegistry } from "./actor.js";
import { ArtifactSink } from "./artifacts.js";
import { EffectHandlers } from "./effects.js";
import { Scheduler } from "./scheduler.js";
import { WorkflowError } from '@deepseek-ai/dsh-workflow';
/**
 * per-run 子代理账本（B4）：seq 从 1 起单调分配；childId 取自 startActivation
 * 返回的 activation.childId；end 已 end 的 seq 幂等跳过——「每条 stop 路径恰好
 * 一次」由幂等守卫保证（seam 契约，workflow-seam/index.ts:79）。
 * 签名注记：DESIGN 写 begin(label, phase?)，但其注释自明 childId 来自 activation，
 * 故 childId 作显式入参；返回形状 {seq, childId} 不变。
 */
export class AgentLedger {
    onStart;
    onEnd;
    nextSeq = 1;
    ended = new Set();
    startedCount = 0;
    constructor(onStart, onEnd) {
        this.onStart = onStart;
        this.onEnd = onEnd;
    }
    begin(label, childId, phase) {
        const seq = this.nextSeq;
        this.nextSeq += 1;
        this.startedCount += 1;
        const info = { seq, label, childId, ...(phase === undefined ? {} : { phase }) };
        this.started.set(seq, info);
        this.onStart(info);
        return { seq, childId };
    }
    /** 幂等配对：同一 seq 的第二条 end（无论 outcome）被跳过。 */
    end(seq, outcome) {
        const info = this.started.get(seq);
        if (info === undefined || this.ended.has(seq))
            return;
        this.ended.add(seq);
        this.onEnd({ ...info, outcome });
    }
    /** 全程被接受的 agent() 调用数（seam 契约：终止路径退化为宿主侧计数）。 */
    get agentsStarted() {
        return this.startedCount;
    }
    /** begin 时的信息快照（end 合成 cancelled agent-end 时展开用）。 */
    started = new Map();
}
export class DwfWorkflowRun {
    id;
    meta;
    result;
    deps;
    controller = new AbortController();
    pending = new Set();
    liveAgents = new Map();
    ledger;
    scheduler;
    actors;
    sink;
    effects;
    /**
     * B7：run 级显式名查重集（#7 定稿后仅司显式名查重、不再承载序号）——
     * declare-actor 抵达时对 named !== false（缺省按显式，旧事件保形）的 label 查重。
     */
    agentNames = new Map();
    /**
     * #4/#7：本 run 已抵达的 declare-actor 声明计数。双职：① runCap 执法（先判后计，
     * 进入时已 >= runCap 即第 runCap+1 个声明 → fail，恰 runCap 个放行）；② ordinal
     * 的唯一来源（recordActor 与 actor-created 事件同源）——自动 label（named:false）
     * 不进 agentNames，序号若仍取 agentNames.size 会冻结错位。
     */
    declaredActors = 0;
    externalAbort;
    terminal = false;
    completeReceived = false;
    cancelReason;
    failReason;
    completePayload;
    disposed;
    constructor(deps) {
        this.deps = deps;
        this.id = deps.id;
        this.meta = deps.meta;
        this.externalAbort = () => {
            this.cancel('workflow signal aborted');
        };
        const signal = deps.signal;
        if (signal?.aborted === true)
            this.externalAbort();
        else
            signal?.addEventListener('abort', this.externalAbort, { once: true });
        this.ledger = new AgentLedger(info => {
            this.liveAgents.set(info.seq, info);
            deps.observer.agentStart(info);
        }, info => {
            this.liveAgents.delete(info.seq);
            deps.observer.agentEnd(info);
        });
        this.scheduler = new Scheduler(deps.maxConcurrency, {
            onTerminal: (_task, error) => {
                this.fail(renderMessage(error));
            },
        });
        this.sink = new ArtifactSink({ runId: deps.id, writer: deps.writer, workspaceRoot: deps.policy.workspaceRoot });
        this.actors = new ActorRegistry({
            subagents: deps.subagents,
            provider: deps.provider,
            parent: deps.parent,
            cwd: () => deps.cwd,
            signal: this.controller.signal,
            onWarn: message => deps.ctx.logger.warn(`dwf: ${message}`),
            ...(deps.pool === undefined ? {} : { pool: deps.pool }),
            failoverAttempts: deps.failoverAttempts,
            onModelFailover: event => {
                deps.writer.appendEvent({
                    type: 'model-failover',
                    payload: snapshotJsonValue({ runId: deps.id, ...event }),
                });
            },
        });
        this.effects = new EffectHandlers({
            runId: deps.id,
            writer: deps.writer,
            scheduler: this.scheduler,
            actors: this.actors,
            sink: this.sink,
            workspaceRoot: deps.policy.workspaceRoot,
            signal: this.controller.signal,
            onRunFailure: message => {
                this.fail(message);
            },
            // ask 成功起步 → ledger.begin（设计 §3.5：每次 ask 成功起步都经 ledger.begin）。
            onAgentAccepted: (label, childId) => this.ledger.begin(label, childId),
            onAgentSettled: (seq, outcome) => this.ledger.end(seq, outcome),
        });
        // Consumers attach durable run recording after start() returns（官方同语义）。
        this.result = Promise.resolve().then(() => this.drive());
    }
    /**
     * 取消 run 及其子代理（seam 契约）。首个请求胜出；后续 cancel/dispose 幂等。
     */
    cancel(reason = 'workflow cancelled') {
        if (this.terminal || this.cancelReason !== undefined)
            return;
        this.cancelReason = reason;
        this.controller.abort(reason);
        void this.actors.disposeAll();
    }
    /** 取消未竟工作并等待脚本与子代理清理；幂等，共享同一个完成 promise。 */
    dispose() {
        this.cancel('workflow disposed');
        this.disposed ??= this.result.then(() => { });
        return this.disposed;
    }
    // ============ 内部驱动 ============
    async drive() {
        let result;
        try {
            result = await this.runProgram();
        }
        catch (error) {
            // 已 fail（如 P0-B 失败 complete / 宿主终局）时用 failReason 结算，避免 abort
            // 后 PTC 侧笼统错误（AbortError 等）盖掉 guest 的 Deadlock/失败文案。
            result =
                this.cancelReason !== undefined
                    ? this.cancelled()
                    : this.failReason !== undefined
                        ? this.errored(this.failReason)
                        : { value: null, stopReason: 'error', error: renderMessage(error), agentsStarted: this.ledger.agentsStarted };
        }
        // 清理序照抄官方 finally（dsh-contract.md §4.1 / workflow-ptc/host.ts:307-317），
        // 放在结算之后、result 返回之前——观察面先看到 agent-end 合成，再看到 workflow/end。
        await this.cleanup(result);
        return result;
    }
    /** 程序执行段：沙箱硬门 → resolve → run（失败是 result.error 字段，非 reject）。 */
    async runProgram() {
        const cwd = await this.deps.cwd;
        this.controller.signal.throwIfAborted();
        // 沙箱硬门（workflow-ptc/host.ts:287-289）：runtime 不支持文件约束、
        // 策略又不是全放开 → 拒绝执行。
        if (this.deps.ptcRuntime.sandboxMode === undefined && this.deps.policy.mode !== 'danger-full-access') {
            throw new Error(`workflow runtime cannot enforce the ${this.deps.policy.mode} file policy`);
        }
        const spec = this.deps.ptcRuntime.resolve({
            program: assembleProgram(this.deps.body, this.deps.ptcRuntime.programFormat),
            bindings: [
                {
                    global: 'dwfHost',
                    functions: this.bindings(),
                    errorClass: { name: 'DwfError', memberNameProperty: 'code' },
                },
            ],
            cwd,
            // 官方同款条件：runtime 不支持文件约束时不传 policy（host.ts:294）。
            ...(this.deps.ptcRuntime.sandboxMode === undefined ? {} : { sandboxPolicy: this.deps.policy }),
            timeoutMs: null, // 停跑永不超时是设计（对齐 workflow-ptc/host.ts:296）
            signal: this.controller.signal,
        });
        const outcome = await this.deps.ptcRuntime.run(spec);
        // t3-epipe-clean-error：outcome.logs 是 worker 捕获输出（其 stderr 文本也被
        // admit 进去，dsh-ptc-runtime-node lib/index.js:1663-1671），此前在此被整体
        // 丢弃——worker 非正常退出时 journal 只剩裸传输错误（run 07770553 首例
        // 「worker-exit: write EPIPE」，dwf_node 0 行）。logs 随错误折叠进消息。
        return this.settleFrom(outcome.value, outcome.error, outcome.logs ?? []);
    }
    /** 清理段自身绝不让 result reject：任何清理失败降级为 warn。 */
    async cleanup(result) {
        try {
            this.terminal = true;
            this.deps.signal?.removeEventListener('abort', this.externalAbort);
            this.controller.abort('workflow settled');
            // ① dispose 全部已发布子代理
            await this.actors.disposeAll();
            // ② Promise.allSettled 排空 pending（在飞 request 回包收尾）
            while (this.pending.size > 0)
                await Promise.allSettled([...this.pending]);
            // ③ 再 dispose 一轮
            await this.actors.disposeAll();
            // ④ 对仍在 liveAgents 的成员合成 outcome:'cancelled' 的 agent-end（每条 stop 路径恰一次）
            for (const info of [...this.liveAgents.values()])
                this.ledger.end(info.seq, 'cancelled');
            // ⑤ journal 结账
            this.settleJournal(result);
        }
        catch (error) {
            this.deps.ctx.logger.warn(`dwf: run cleanup failed: ${renderMessage(error)}`);
        }
    }
    /** 结算优先级：宿主 fail > guest complete > PTC result.error > 程序返回值。 */
    settleFrom(value, error, logs = []) {
        if (this.cancelReason !== undefined)
            return this.cancelled();
        if (this.failReason !== undefined)
            return this.errored(this.failReason);
        if (this.completePayload !== undefined) {
            if (this.completePayload.ok)
                return this.completed(snapshotJsonValue(this.completePayload.value ?? null));
            return this.errored(this.completePayload.error ?? 'workflow script failed');
        }
        if (error !== undefined) {
            return this.errored(error.kind === 'worker-exit'
                ? cleanWorkerExitMessage(error.message, logs)
                : `workflow execution failed (${error.kind}): ${error.message}`);
        }
        return this.completed(snapshotJsonValue(value ?? null));
    }
    /** 清理后的 journal 结账（settleRun 内部会补 run-settled 事件；journal status 词表是 failed，seam 词表是 error）。 */
    settleJournal(result) {
        this.deps.writer.settleRun({
            status: result.stopReason === 'error' ? 'failed' : result.stopReason,
            ...(result.stopReason === 'completed' ? { result: snapshotJsonValue(result.value ?? null) } : {}),
            ...(result.error !== undefined ? { failure: result.error } : {}),
        });
    }
    completed(value) {
        return { value, stopReason: 'completed', agentsStarted: this.ledger.agentsStarted };
    }
    errored(message) {
        return { value: null, stopReason: 'error', error: message, agentsStarted: this.ledger.agentsStarted };
    }
    cancelled() {
        return {
            value: null,
            stopReason: 'cancelled',
            error: `workflow run cancelled: ${this.cancelReason}`,
            agentsStarted: this.ledger.agentsStarted,
        };
    }
    /** 宿主侧确定性终局（report caps / 重名 / scheduler 终局）：run 以 'error' 结算等人。 */
    fail(message) {
        if (this.terminal || this.cancelReason !== undefined || this.failReason !== undefined)
            return;
        this.failReason = message;
        this.controller.abort(message);
    }
    track(task) {
        this.pending.add(task);
        void task.then(() => {
            this.pending.delete(task);
        }, () => {
            this.pending.delete(task);
        });
        return task;
    }
    // ============ dwfHost 绑定面（就此四个，设计 §3.5） ============
    bindings() {
        return {
            begin: () => {
                this.controller.signal.throwIfAborted();
                return Promise.resolve(this.initPayload());
            },
            request: value => this.track(this.onRequest(value)),
            event: value => {
                this.onEvent(value);
                return Promise.resolve(null);
            },
            complete: value => {
                this.onComplete(value);
                return Promise.resolve(null);
            },
        };
    }
    /** begin 回包：WorkerInit（meta/args/limits；评审 B7 的承载通道）。 */
    initPayload() {
        return {
            meta: { name: this.meta.name, description: this.meta.description },
            args: snapshotJsonValue(this.deps.args ?? {}),
            limits: this.deps.limits,
        };
    }
    /** request 通道：六操作路由进 effects（dispatch 的 resolve/reject 即 guest 回包）。 */
    async onRequest(value) {
        const req = parseRequest(value);
        if (this.terminal)
            throw new Error('the run has already settled');
        const outcome = await this.effects.dispatch(req);
        return snapshotJsonValue(outcome);
        // 确定性失败以 rejection 折回 guest（脚本可 catch）；错误对象到此为止。
    }
    /** event 通道：即发即忘，与 request 共享 FIFO（guest-template-01:14-19 承重语义）。 */
    onEvent(value) {
        const event = parseEvent(value);
        switch (event.type) {
            case 'log': {
                const message = typeof event.args.message === 'string' ? event.args.message : '';
                this.deps.writer.appendEvent({ type: 'log', payload: { message } });
                this.deps.observer.log(message);
                return;
            }
            case 'phase-entered': {
                const name = typeof event.args.name === 'string' ? event.args.name : '';
                this.deps.writer.appendEvent({ type: 'phase-entered', payload: { name } });
                this.deps.observer.phase(name);
                return;
            }
            case 'declare-artifact':
                // 预置产物声明（chart/table/metrics/board）defer（设计 §6.2）：不落 journal
                // 词表、不产事件；数据都在 report 流里。
                return;
            case 'declare-actor':
                this.onDeclareActor(event.args);
                return;
            default:
                this.deps.ctx.logger.warn(`dwf: unknown guest event "${event.type}" ignored`);
        }
    }
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
    onDeclareActor(args) {
        const label = typeof args.label === 'string' ? args.label : '';
        const siteId = typeof args.siteId === 'string' ? args.siteId : '';
        if (this.declaredActors >= this.deps.runCap) {
            const error = new WorkflowError(`subagent cap exceeded: more than ${this.deps.runCap} agents in one run`, 'AGENT_START');
            this.fail(error.message);
            return;
        }
        this.declaredActors += 1;
        const ordinal = this.declaredActors;
        if (args.named !== false) {
            if (this.agentNames.has(label)) {
                const error = new WorkflowError(`duplicate subagent name "${label}": names are identities within a run; give loop-created agents computed names`, 'AGENT_START');
                this.fail(error.message);
                return;
            }
            this.agentNames.set(label, ordinal);
        }
        this.actors.register(label, siteId, args.persona);
        const persona = snapshotJsonValue(args.persona ?? {});
        this.deps.writer.recordActor(siteId, ordinal, label, persona);
    }
    /** complete 通道：幂等结算（首个 complete 胜出，与 prelude __settled 双保险）。 */
    onComplete(value) {
        if (this.completeReceived || this.terminal)
            return;
        const record = value !== null && typeof value === 'object' ? value : {};
        const ok = record.ok === true;
        this.completeReceived = true;
        this.completePayload = {
            ok,
            ...(ok ? { value: record.value } : {}),
            ...(!ok && typeof record.error === 'object' && record.error !== null
                ? { error: typeof record.error.message === 'string' ? record.error.message : 'workflow script failed' }
                : {}),
        };
        // P0-B：失败 complete 走现成失败链（fail → controller.abort → signal）唤醒挂死在
        // await ptcRuntime.run（run.ts:266）的真实 PTC——对齐 dispatchReport 拒收 →
        // onRunFailure → fail → abort（run.ts:195 / run.ts:330-334）；停滞/死锁脚本的
        // 唯一唤醒源是这条 signal。成功路径零改动（结算仍由 PTC 返回值走 settleFrom，
        // completePayload 优先级见 run.ts:291-301），fake PTC 立即 return 的既有断言不受影响。
        if (!ok)
            this.fail(this.completePayload.error ?? 'workflow script failed');
    }
}
// ============ 模块级小件 ============
/**
 * 程序拼装：realm 禁令 + channel/future 原语 + prelude + 启动调用（P0-C）。
 * 修前 body 裸拼无人调 __start → begin 绑定永不被调、args 恒 {}；修后 body 包进
 * `return await __start(async () => {…})`，由 prelude 取 WorkerInit 后再装配用户体。
 * 两种 programFormat 兼容：function-body 本身是 async 函数体（顶层 await/return 合法），
 * repl 外层已是 async IIFE（return 在 IIFE 内合法）；body 抛错由 __start 的
 * `.then(undefined, …)` 折成 __complete(false,…)（prelude.ts）→ P0-B 失败链结算。
 * 成功路径按拍板表不补 __complete(true,value)——成功仍由 PTC 返回值结算
 * （settleFrom 双结算通道竞态面，P0-C 拍板）。
 */
function assembleProgram(body, programFormat) {
    const base = `${REALM_BANS_SOURCE}\n${CHANNEL_PRIMITIVES_SOURCE}\n${GUEST_PRELUDE_SOURCE}\n`;
    const boot = `return await __start(async () => {\n${body}\n})\n`;
    return programFormat === 'repl' ? `await (async () => {\n${base}${boot}})()` : `${base}${boot}`;
}
const KNOWN_OPS = ['ask', 'world-read', 'world-run', 'hole', 'report', 'publish-artifact'];
function parseRequest(value) {
    if (value === null || typeof value !== 'object')
        throw new Error('dwfHost.request requires an object');
    const record = value;
    if (typeof record.siteId !== 'string' || record.siteId.length === 0)
        throw new Error('dwfHost.request requires a siteId');
    if (!KNOWN_OPS.includes(record.op))
        throw new Error(`dwfHost.request: unknown op "${String(record.op)}"`);
    return { siteId: record.siteId, op: record.op, args: snapshotJsonValue(record.args ?? null) };
}
/**
 * event 类型按 string 收口：protocol.ts 的 GuestEventType 尚缺 'declare-actor'
 * 成员（T2 收口项，gap-audit §3.1）——这里不阻塞在其类型上，落码语义按
 * prelude.ts:112 实际发射的四值处理。
 */
function parseEvent(value) {
    if (value === null || typeof value !== 'object')
        throw new Error('dwfHost.event requires an object');
    const record = value;
    const type = record.type;
    if (type !== 'log' && type !== 'phase-entered' && type !== 'declare-artifact' && type !== 'declare-actor') {
        throw new Error(`dwfHost.event: unknown type "${String(type)}"`);
    }
    const args = record.args !== null && typeof record.args === 'object' ? record.args : {};
    return { type, args };
}
/** D3：worker-exit 两形态折叠消息的统一前缀（journal failure_json 可 grep 的钉死契约）。 */
export const WORKER_EXIT_PREFIX = 'workflow worker exited before settling: ';
/** worker 输出摘录上限（journal 单条体积友好；超出只保留尾部并注明截断）。 */
const WORKER_OUTPUT_EXCERPT_LIMIT = 500;
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
export function cleanWorkerExitMessage(message, logs = []) {
    // ①退出汇总形态：stderr 已在原文内嵌，前缀即可。
    if (message.includes('Node process exited'))
        return `${WORKER_EXIT_PREFIX}${message}`;
    // ②裸传输/流错误形态：折入 logs 里实际捕获的 worker 输出尾部。
    const output = logs.filter(line => line.trim().length > 0).join('\n').trim();
    if (output.length > 0) {
        const excerpt = output.length > WORKER_OUTPUT_EXCERPT_LIMIT
            ? `…${output.slice(-WORKER_OUTPUT_EXCERPT_LIMIT)} (truncated)`
            : output;
        return `${WORKER_EXIT_PREFIX}${message}; worker output tail: ${excerpt}`;
    }
    return `${WORKER_EXIT_PREFIX}${message} (worker-side parse crash or in-worker model rejection; no worker output was captured for this failure mode — see the dsh web log)`;
}
function renderMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
