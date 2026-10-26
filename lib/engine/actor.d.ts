/**
 * actor 注册表（设计 §3.5 actor 段）：
 *   - persona 建即冻结 {system, model}（facade.d.ts:14-19）——declare-actor
 *     事件抵达时由 run 层调 register()，guest 侧 personaOf 已把它归一成纯 JSON；
 *   - 同 actor 的 ask FIFO 由 scheduler 的同键队列承担，本层只管 persona 记账、
 *     一次 startActivation 的调用形状、已发布 activation 的 dispose 记账；
 *   - MVP 每 ask 一次独立 startActivation（无状态）；actor→持久子会话绑定
 *     只留接口（dwf_actor 行照建，sess_dwf-<runid>-actor_<n>_<k> 命名约定留注释，
 *     amend defer，设计 §3.5 / mechanism-map §6）。
 *
 * 调用形状出处（contract-v2 §5.2 + workflow-ptc/host.ts:199-229 逐字对齐）：
 *   subagents.startActivation({ provider, label, delivery:'caller', signal,
 *     request: { cwd, prompt:[{type:'text',text}], parent, outputSchema?, agentOptions? } })
 * R2 定稿：model 校验走 request.agentOptions（contract-v2 types.ts:169），
 * getProvider 不存在也不进桩；真实运行时的未知 model 会在 startActivation 处拒绝。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentRuntime, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import { ModelPool } from './pool.ts';
/** 一次换道事件（journal 'model-failover' 载荷的宿主侧形态）。 */
export interface ModelFailoverEvent {
    readonly actor: string;
    readonly from: string;
    readonly to: string;
    readonly reason: string;
}
/** actor 键：guest 侧 agent() 句柄的身份（declare-actor 事件的 siteId + 标签）。 */
export interface ActorKey {
    readonly label: string;
    /** guest 侧站点 id（"actor#<n>"），journal 的 dwf_actor.site_id 语义。 */
    readonly siteId: string;
}
/** 冻结后的 persona 快照（纯 JSON；facade AgentPersona 的宿主侧形态）。 */
export interface FrozenPersona {
    readonly system?: string;
    readonly model?: string;
}
export interface ActorRegistryDeps {
    subagents: SubagentRuntime;
    provider: string;
    parent: Agent;
    /** workingDirectory.ensure 的在途 promise（每 ask 取一次，官方 host.ts:203 同法）。 */
    cwd: () => Promise<string>;
    signal: AbortSignal;
    onWarn?(message: string): void;
    /** 模型池（配置了 modelPool 才有）：未显式绑模型的 actor 从池分摊 + 故障换道。 */
    pool?: ModelPool;
    /** 换道回调（run 层落 journal 'model-failover' 事件）。 */
    onModelFailover?(event: ModelFailoverEvent): void;
    /** 单次 ask 的换道尝试上限（含首次，缺省 3）。 */
    failoverAttempts?: number;
}
export declare class ActorRegistry {
    private readonly deps;
    /** label → actor 键 + 冻结 persona + 惰性解析的运行模型（池模式）。 */
    private readonly byLabel;
    /** 已发布（startActivation 成功）的 activation，dispose 全走这里。 */
    private readonly live;
    constructor(deps: ActorRegistryDeps);
    /**
     * declare-actor 抵达时建册：persona 建即冻结一层（归一化纯 JSON，冻结即终）。
     * 重复 label 不在这里拒绝——查重是 run 层注册表的职责（B7，拍板表#8 双层守卫的
     * 宿主侧）；这里后到者不覆盖先到者。
     */
    register(label: string, siteId: string, persona: unknown): ActorKey;
    lookup(label: string): ActorKey | undefined;
    /** 该 actor 当前实际使用的模型（effects 记 ask 节点 input 用；未解析 = undefined）。 */
    resolvedModelOf(label: string): string | undefined;
    /**
     * 一次 ask = 一次独立 startActivation（带模型池分摊与换道）：
     *   - 模型解析：显式 persona.model 优先（硬绑定）；否则池模式从池分摊
     *     （惰性解析、随后钉在该 actor 上——同 actor 的 ask 模型一致，journal
     *     input 里记实际模型）；无池保持缺省（不带 agentOptions）。
     *   - 换道：确定性 provider 故障（额度尽/401/403/模型不存在）→ 冷却该
     *     provider 立即换道；瞬态（限流/过载/网络）→ 同模型退避重试，耗尽后
     *     换道。上限 failoverAttempts（含首次）；池无可换或耗尽 → 原错误逃逸
     *     （scheduler/终局既有路径不变）。换道即 journal 'model-failover'。
     * 子代理确定性失败仍以 SubagentResult resolve（effects 折 AGENT_RESULT）。
     */
    ask(key: ActorKey, instructions: string, schema: ObjectJsonSchema | undefined, onActivation?: (childId: SessionId) => void): Promise<SubagentResult>;
    /** run 清理序两轮 dispose 的执行体：对所有已发布 activation 触发一次幂等 dispose。 */
    disposeAll(): Promise<void>;
    private dispose;
    /** 把 guest 传来的 persona 载荷收口为冻结的 {system?, model?}。 */
    private freezePersona;
}
/**
 * p0-real-machine ④：把 ZCode 风格的 "provider/model" 复合串拆成真实
 * AgentOptions 的分字段形状；无斜杠 → 纯 model 覆盖（provider 走父级继承）。
 * 首个斜杠为界：provider 不含斜杠、model 保留其后的任何斜杠。
 */
export declare function agentOptionsFor(model: string): {
    provider?: string;
    model: string;
};
