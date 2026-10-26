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
import { WorkflowError } from '@deepseek-ai/dsh-workflow';
import { classifyProviderError } from "./pool.js";
export class ActorRegistry {
    deps;
    /** label → actor 键 + 冻结 persona + 惰性解析的运行模型（池模式）。 */
    byLabel = new Map();
    /** 已发布（startActivation 成功）的 activation，dispose 全走这里。 */
    live = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * declare-actor 抵达时建册：persona 建即冻结一层（归一化纯 JSON，冻结即终）。
     * 重复 label 不在这里拒绝——查重是 run 层注册表的职责（B7，拍板表#8 双层守卫的
     * 宿主侧）；这里后到者不覆盖先到者。
     */
    register(label, siteId, persona) {
        const existing = this.byLabel.get(label);
        if (existing !== undefined)
            return existing.key;
        const frozen = this.freezePersona(persona);
        const key = { label, siteId };
        this.byLabel.set(label, { key, persona: frozen });
        return key;
    }
    lookup(label) {
        return this.byLabel.get(label)?.key;
    }
    /** 该 actor 当前实际使用的模型（effects 记 ask 节点 input 用；未解析 = undefined）。 */
    resolvedModelOf(label) {
        return this.byLabel.get(label)?.resolvedModel;
    }
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
    async ask(key, instructions, schema, onActivation) {
        const entry = this.byLabel.get(key.label);
        const persona = entry?.persona ?? {};
        const pool = this.deps.pool;
        const attempts = this.deps.failoverAttempts ?? 3;
        // 显式 persona.model = 硬绑定（用户点名，不参与换道）；池分摊的才可换。
        const explicit = persona.model !== undefined;
        let model = entry?.resolvedModel ?? persona.model ?? pool?.choose();
        if (entry !== undefined && entry.resolvedModel === undefined)
            entry.resolvedModel = model;
        let activation;
        let lastError;
        for (let attempt = 1; activation === undefined && attempt <= Math.max(1, attempts); attempt++) {
            try {
                activation = await this.deps.subagents.startActivation({
                    provider: this.deps.provider,
                    label: key.label,
                    delivery: 'caller',
                    signal: this.deps.signal,
                    request: {
                        cwd: await this.deps.cwd(),
                        prompt: [{ type: 'text', text: instructions }],
                        parent: this.deps.parent,
                        ...(schema === undefined ? {} : { outputSchema: schema }),
                        // R2：模型经 agentOptions 交给运行时校验（未知 model 在这里被拒）。
                        // p0-real-machine ④：真实 AgentOptions 是分字段 provider+model
                        // （dsh-agent runtime-types.d.ts:21-37），无 "provider/model" 复合串
                        // 语义；子代理链路按分字段继承（manager.js:327 → child-agent.js:74）。
                        // 模型池与 facade model("provider/model") 在这里拆串下发。
                        ...(model === undefined ? {} : { agentOptions: agentOptionsFor(model) }),
                    },
                });
            }
            catch (error) {
                lastError = error;
                // 无池 / 显式硬绑定 / 已到上限：保持 provider 类错误原样逃逸（scheduler 重试/终局）。
                if (pool === undefined || explicit || attempt >= attempts)
                    break;
                const kind = classifyProviderError(error);
                if (kind === 'deterministic') {
                    pool.markProviderFailure(model ?? '');
                    const next = pool.choose();
                    if (next === undefined || next === model)
                        break;
                    this.deps.onModelFailover?.({ actor: key.label, from: model ?? '(default)', to: next, reason: renderError(error) });
                    this.deps.onWarn?.(`model failover on "${key.label}": ${model ?? '(default)'} → ${next} (${renderError(error)})`);
                    model = next;
                    if (entry !== undefined)
                        entry.resolvedModel = next;
                }
                else {
                    // 瞬态：同模型指数退避（300ms*2^n），耗尽后换道。
                    await delay(300 * 2 ** (attempt - 1));
                    if (attempt + 1 >= attempts && model !== undefined) {
                        const next = pool.choose();
                        if (next !== undefined && next !== model) {
                            this.deps.onModelFailover?.({ actor: key.label, from: model, to: next, reason: `transient retries exhausted: ${renderError(error)}` });
                            model = next;
                            if (entry !== undefined)
                                entry.resolvedModel = next;
                        }
                    }
                }
            }
        }
        if (activation === undefined) {
            // startActivation 基础设施拒绝保持 provider 类错误原样逃逸（scheduler
            // 重试/终局；AGENT_START 折算发生在「未声明 actor」路径，见 effects）。
            throw lastError ?? new WorkflowError('startActivation failed without an error', 'AGENT_START');
        }
        this.live.set(activation, { label: key.label, activation });
        onActivation?.(activation.childId);
        // activation.result 仅在基础设施故障时 reject（contract-v2 types.ts :287-303
        // 同语义）——此时自行 dispose 该 activation 再让错误按 provider 类逃逸。
        return activation.result.catch(async (error) => {
            await this.dispose(activation);
            throw error;
        });
    }
    /** run 清理序两轮 dispose 的执行体：对所有已发布 activation 触发一次幂等 dispose。 */
    async disposeAll() {
        await Promise.all([...this.live.values()].map(record => this.dispose(record.activation)));
    }
    dispose(activation) {
        const record = this.live.get(activation);
        if (record === undefined)
            return Promise.resolve();
        record.disposal ??= Promise.resolve()
            .then(() => activation.dispose())
            .catch((error) => {
            this.deps.onWarn?.(`child dispose failed (${record.label}): ${renderError(error)}`);
        })
            .finally(() => {
            this.live.delete(activation);
        });
        return record.disposal;
    }
    /** 把 guest 传来的 persona 载荷收口为冻结的 {system?, model?}。 */
    freezePersona(persona) {
        if (persona === null || typeof persona !== 'object')
            return {};
        const record = persona;
        const frozen = {};
        if (typeof record.system === 'string')
            frozen.system = record.system;
        if (typeof record.model === 'string')
            frozen.model = record.model;
        return Object.freeze(frozen);
    }
}
function renderError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * p0-real-machine ④：把 ZCode 风格的 "provider/model" 复合串拆成真实
 * AgentOptions 的分字段形状；无斜杠 → 纯 model 覆盖（provider 走父级继承）。
 * 首个斜杠为界：provider 不含斜杠、model 保留其后的任何斜杠。
 */
export function agentOptionsFor(model) {
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1)
        return { model };
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
