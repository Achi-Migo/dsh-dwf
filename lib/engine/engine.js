/**
 * 引擎 seam 挂接点（设计 §3.5，本插件的核心承诺面）：
 *   - DwfWorkflowEngine extends WorkflowEngine（cordis 以 'workflowEngine' 名发布）；
 *   - static inject 与 static Config 成对（官方 workflow-ptc/index.ts:103-122 同法）；
 *   - start() 六步流水线：validateMeta → compileWorkflow（B9 单编译路径，诊断非空
 *     同步抛 SCRIPT_PARSE）→ resolveSubagentProvider + 三帽收口（B10）→ 铸
 *     WorkflowRunId + journal.beginRun + workflow/start → new DwfWorkflowRun
 *     （编译产物经构造参数直接交给 run，不经过 seam 字段）→ 结算时 workflow/end
 *     （只带 WorkflowResultInfo，不带 value）。
 *
 * 官方骨架出处：workflow-ptc/index.ts:134-190（start 流水线）、meta.ts:76-82
 * （validateMeta，此处加 CAPS 的 phases 帽）、:83-95（resolveMaxTotalAgents，
 * B10 在其上加「缺省取 CAPS.maxSubagents=64 再与 ceiling 取小」）。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import z from '@deepseek-ai/schemastery';
import { WorkflowEngine, WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow';
import { compileWorkflow } from "../compile/compiler.js";
import { CAPS } from "../journal/caps.js";
import { initSchema } from "../journal/schema.js";
import { JournalStore } from "../journal/store.js";
import { snapshotJsonValue } from "../util/json.js";
import { DwfWorkflowRun } from "./run.js";
import { ModelPool } from "./pool.js";
/**
 * 从 Config 构造模型池（modelPool 为空 = 不启用，返回 undefined 保持单模型缺省）。
 * 策略值非法即抛（配置错误在装载期暴露，不带到 run 里）。
 */
export function createModelPool(config) {
    // 直构路径（测试/编程调用）可能缺省新字段；真实路径 schemastery 已填默认。
    const models = (config.modelPool ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (models.length === 0)
        return undefined;
    const policy = config.poolPolicy ?? 'spread';
    if (policy !== 'spread' && policy !== 'round-robin') {
        throw new Error(`poolPolicy must be 'spread' or 'round-robin' (got "${policy}")`);
    }
    return new ModelPool(models, { policy, cooldownMs: config.poolCooldownMs ?? 60_000 });
}
// Real schemastery: the default export is the schema factory (`z.object`,
// `.default` etc. per Schemastery.Static); the old stub's `z<T>` interface
// augmentation is retired with the stub. Official pattern:
// dsh-workflow-ptc index.d.ts `static Config: z<Config>` over the same
// default import.
export const Config = z.object({
    toolName: z.string().default('workflow'),
    dbPath: z.string().default(''),
    maxConcurrency: z.natural().default(4),
    maxTotalAgents: z.natural().default(1000),
    maxResultChars: z.natural().default(50000),
    enableRunInBackground: z.boolean().default(true),
    modelPool: z.string().default(''),
    poolPolicy: z.string().default('spread'),
    poolCooldownMs: z.natural().default(60000),
    failoverAttempts: z.natural().default(3),
});
/**
 * journal 数据库路径收口（P0-A 单一事实源）：apply（index.ts 的工具读侧）与引擎
 * 构造器（写侧）对同一 config.dbPath 都经此函数解析——非空原样返回，空串返回
 * './dwf.db'（node:sqlite 按进程 cwd 相对解析）。两侧拿到同一字符串才会落在
 * 同一个数据库文件上；引擎侧不再有 ':memory:' 兜底。
 */
export function resolveJournalPath(dbPath) {
    return dbPath !== '' ? dbPath : './dwf.db';
}
/**
 * meta 纯数据校验（官方 meta.ts:76-82 逐条对齐 + CAPS 帽）。
 * 抛 META_INVALID 点名每条违规；返回归一化副本（不别名调用方对象）。
 */
export function validateMeta(value) {
    const violations = [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new WorkflowError('invalid meta: meta must be an object', 'META_INVALID');
    }
    const record = value;
    const known = new Set(['name', 'description', 'whenToUse', 'phases']);
    for (const key of Object.keys(record)) {
        if (!known.has(key))
            violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`);
    }
    if (typeof record.name !== 'string' || record.name.length === 0)
        violations.push('meta.name must be a non-empty string');
    if (typeof record.description !== 'string' || record.description.length === 0)
        violations.push('meta.description must be a non-empty string');
    if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string')
        violations.push('meta.whenToUse must be a string');
    const phases = [];
    if (record.phases !== undefined) {
        if (!Array.isArray(record.phases)) {
            violations.push('meta.phases must be an array');
        }
        else {
            if (record.phases.length > CAPS.maxPhases)
                violations.push(`meta.phases exceeds the ${CAPS.maxPhases} phase cap`);
            record.phases.forEach((phase, index) => {
                if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
                    violations.push(`meta.phases[${index}] must be an object`);
                    return;
                }
                const entry = phase;
                for (const key of Object.keys(entry)) {
                    if (!['title', 'detail', 'provider', 'model'].includes(key))
                        violations.push(`meta.phases[${index}].${key} is not a recognized field`);
                }
                if (typeof entry.title !== 'string' || entry.title.length === 0)
                    violations.push(`meta.phases[${index}].title must be a non-empty string`);
                else if (entry.title.length > CAPS.maxPhaseNameLength)
                    violations.push(`meta.phases[${index}].title exceeds the ${CAPS.maxPhaseNameLength} character cap`);
                if (entry.detail !== undefined && typeof entry.detail !== 'string')
                    violations.push(`meta.phases[${index}].detail must be a string`);
                if (entry.provider !== undefined && typeof entry.provider !== 'string')
                    violations.push(`meta.phases[${index}].provider must be a string`);
                if (entry.model !== undefined && typeof entry.model !== 'string')
                    violations.push(`meta.phases[${index}].model must be a string`);
                if (violations.length === 0 && typeof entry.title === 'string') {
                    phases.push({
                        title: entry.title,
                        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
                        ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
                        ...(entry.model !== undefined ? { model: entry.model } : {}),
                    });
                }
            });
        }
    }
    if (violations.length > 0)
        throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID');
    return {
        name: record.name,
        description: record.description,
        ...(record.whenToUse !== undefined ? { whenToUse: record.whenToUse } : {}),
        ...(record.phases !== undefined ? { phases } : {}),
    };
}
/**
 * B10 三帽收口：runCap = min(请求值 ?? CAPS.maxSubagents（缺省 64）, ceiling 1000)。
 * 请求值超 ceiling → INVALID_ARGUMENT；两帽分工：1000 = 引擎生命周期总量、
 * 64 = 单 run 默认帽（设计 §3.5 第 3 步 / workflow-ptc/index.ts:83-95 同骨架）。
 */
export function resolveRunCap(requested, ceiling) {
    if (requested === undefined)
        return Math.min(CAPS.maxSubagents, ceiling);
    if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT');
    }
    if (requested > ceiling) {
        throw new WorkflowError(`workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`, 'INVALID_ARGUMENT');
    }
    return Math.min(requested, ceiling);
}
export class DwfWorkflowEngine extends WorkflowEngine {
    static inject = ['subagents', 'ptcRuntime', 'sandboxPolicy', 'workingDirectory'];
    static Config = Config;
    config;
    journal;
    pool;
    facadeSource;
    constructor(ctx, config) {
        super(ctx);
        // schemastery（static Config）已填好默认字段；断言记录解析事实，非隐藏兜底
        // （官方 workflow-ptc/index.ts:116-122 同注释语义）。
        this.config = config;
        // P0-A：路径经 resolveJournalPath 收口（与 index.ts 工具读侧同一字符串、同一
        // 数据库文件）；建库后立即 initSchema——DDL 全 `if not exists` 幂等（schema.ts），
        // 修前引擎侧从未建表，默认配置首 run 即 no such table: dwf_run。
        const db = new DatabaseSync(resolveJournalPath(this.config.dbPath));
        initSchema(db);
        this.journal = new JournalStore(db);
        this.pool = createModelPool(this.config);
    }
    /**
     * 校验并启动一个工作流。META_INVALID / SCRIPT_PARSE 在这里**同步抛**（seam 契约，
     * 注册层转 isError 结果）；一旦返回 run，一切失败都经 result.stopReason 折叠，
     * result 永不 reject。
     */
    start(request) {
        // 1. validateMeta（meta 纯数据校验）→ META_INVALID
        const meta = validateMeta(request.meta);
        // 2. 编译（B9：全插件只有这里有编译路径；tool 层原样透传用户源码）。
        //    诊断非空 → 同步抛 SCRIPT_PARSE（官方「start 时同步抛」契约，dsh-contract §3.3）。
        const compiled = compileWorkflow(request.script, this.facade());
        if (compiled.diagnostics.length > 0) {
            const listed = compiled.diagnostics.map(d => d.message).join('; ');
            throw new WorkflowError(`workflow script does not compile: ${listed}`, 'SCRIPT_PARSE');
        }
        // 3. provider 路由 + per-run 帽解析（B10）。
        const provider = resolveSubagentProvider(request.subagentProvider);
        const runCap = resolveRunCap(request.maxTotalAgents, this.config.maxTotalAgents);
        // 4. 铸 WorkflowRunId（官方运行时工厂函数，值导入）→ journal.beginRun → workflow/start
        const id = WorkflowRunId(randomUUID());
        const info = { id, meta };
        const args = this.losslessArgs(request.args);
        const writer = this.journal.writerFor(id);
        writer.beginRun({
            id,
            parentSessionId: request.parent.session.id,
            name: meta.name,
            script: request.script,
            args,
            capsMaxConcurrency: this.config.maxConcurrency,
        });
        // workingDirectory.ensure / sandboxPolicy.resolve（官方 host.ts:162 / index.ts:172 同法）。
        const cwd = this.ctx.workingDirectory.ensure(request.parent, request.signal);
        const policy = this.ctx.sandboxPolicy.resolve({ session: request.parent.session });
        // 5. new DwfWorkflowRun：编译产物（lowered body）经构造参数直接交给 run——
        //    run 内拼装 program = realm + channels + prelude + body，不经过 seam 字段。
        const limits = {
            maxConcurrentAgents: this.config.maxConcurrency,
            maxTotalAgents: runCap,
            // MVP 未在 Config 暴露这两项（guest prelude 暂不消费 limits）；
            // 字段按 protocol.ts WorkerInit 形状给满格。
            maxItemsPerCall: Number.MAX_SAFE_INTEGER,
            syncTimeoutMs: 0,
        };
        const run = new DwfWorkflowRun({
            ctx: this.ctx,
            subagents: this.ctx.subagents,
            ptcRuntime: this.ctx.ptcRuntime,
            policy,
            id,
            meta,
            parent: request.parent,
            provider,
            body: compiled.body,
            args,
            limits,
            writer,
            runCap,
            maxConcurrency: this.config.maxConcurrency,
            ...(this.pool === undefined ? {} : { pool: this.pool }),
            failoverAttempts: this.config.failoverAttempts,
            cwd,
            signal: request.signal,
            observer: {
                phase: title => {
                    this.emitWorkflowEvent('workflow/phase', info, title);
                },
                log: message => {
                    this.emitWorkflowEvent('workflow/log', info, message);
                },
                agentStart: agent => {
                    this.emitWorkflowEvent('workflow/agent-start', info, agent);
                },
                agentEnd: agent => {
                    this.emitWorkflowEvent('workflow/agent-end', info, agent);
                },
            },
        });
        this.emitWorkflowEvent('workflow/start', info);
        // 6. workflow/end 随（永不 reject 的）result 结算发出——只带 outcome 数据，
        //    刻意不含 value（seam 契约，dsh-contract §2.4）。
        void run.result.then(settled => {
            const end = {
                stopReason: settled.stopReason,
                ...(settled.error !== undefined ? { error: settled.error } : {}),
                agentsStarted: settled.agentsStarted,
            };
            this.emitWorkflowEvent('workflow/end', info, end);
        });
        return run;
    }
    /** facade.d.ts 全文（guest 脚本编译期声明的唯一事实源），读一次缓存。 */
    facade() {
        if (this.facadeSource === undefined) {
            const here = path.dirname(fileURLToPath(import.meta.url));
            this.facadeSource = readFileSync(path.resolve(here, '../../assets/facade.d.ts'), 'utf8');
        }
        return this.facadeSource;
    }
    /** seam 的 args: unknown 收口为无损 JSON（跨 PTC 边界强制；违规 → INVALID_ARGUMENT）。 */
    losslessArgs(args) {
        try {
            return snapshotJsonValue(args ?? {});
        }
        catch (error) {
            throw new WorkflowError(`workflow args must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_ARGUMENT');
        }
    }
}
/**
 * provider 路由（设计 §3.5 第 3 步）。R2 定稿：subagents.getProvider 无据不进桩，
 * 真实注册表校验待接入真实 dsh 后补；这里只做规范化校验（官方 index.ts:68-80 的
 * 字符串 half），缺省 provider 取 'spawn'（官方 config 默认；本插件 Config 未暴露
 * provider 字段）。
 */
function resolveSubagentProvider(override) {
    const provider = override ?? 'spawn';
    if (provider.length === 0 || provider !== provider.trim()) {
        throw new WorkflowError('workflow subagentProvider must be a non-empty normalized string', 'INVALID_ARGUMENT');
    }
    return provider;
}
