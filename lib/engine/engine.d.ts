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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { WorkflowEngine } from '@deepseek-ai/dsh-workflow';
import type { WorkflowMeta, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow';
import { ModelPool } from './pool.ts';
/**
 * 从 Config 构造模型池（modelPool 为空 = 不启用，返回 undefined 保持单模型缺省）。
 * 策略值非法即抛（配置错误在装载期暴露，不带到 run 里）。
 */
export declare function createModelPool(config: ResolvedConfig): ModelPool | undefined;
/** 插件 Config（设计 §1.3；schemastery 在 apply 前填好默认值）。 */
export interface Config {
    toolName: string;
    dbPath: string;
    maxConcurrency: number;
    maxTotalAgents: number;
    maxResultChars: number;
    enableRunInBackground: boolean;
    /** 模型池：逗号分隔的 "provider/model" 清单（空 = 不启用池，保持单模型缺省）。 */
    modelPool: string;
    /** 池分摊策略：spread（默认）= 按 provider 累计分配最少优先；round-robin = 轮转。 */
    poolPolicy: string;
    /** 确定性 provider 故障后的冷却毫秒（换道期间跳过该 provider）。 */
    poolCooldownMs: number;
    /** 单次 ask 的换道尝试上限（含首次）。 */
    failoverAttempts: number;
}
export type ResolvedConfig = Required<Config>;
export declare const Config: z<Config>;
/**
 * journal 数据库路径收口（P0-A 单一事实源）：apply（index.ts 的工具读侧）与引擎
 * 构造器（写侧）对同一 config.dbPath 都经此函数解析——非空原样返回，空串返回
 * './dwf.db'（node:sqlite 按进程 cwd 相对解析）。两侧拿到同一字符串才会落在
 * 同一个数据库文件上；引擎侧不再有 ':memory:' 兜底。
 */
export declare function resolveJournalPath(dbPath: string): string;
/**
 * meta 纯数据校验（官方 meta.ts:76-82 逐条对齐 + CAPS 帽）。
 * 抛 META_INVALID 点名每条违规；返回归一化副本（不别名调用方对象）。
 */
export declare function validateMeta(value: unknown): WorkflowMeta;
/**
 * B10 三帽收口：runCap = min(请求值 ?? CAPS.maxSubagents（缺省 64）, ceiling 1000)。
 * 请求值超 ceiling → INVALID_ARGUMENT；两帽分工：1000 = 引擎生命周期总量、
 * 64 = 单 run 默认帽（设计 §3.5 第 3 步 / workflow-ptc/index.ts:83-95 同骨架）。
 */
export declare function resolveRunCap(requested: number | undefined, ceiling: number): number;
export declare class DwfWorkflowEngine extends WorkflowEngine {
    static inject: readonly ["subagents", "ptcRuntime", "sandboxPolicy", "workingDirectory"];
    static Config: z<Config>;
    private readonly config;
    private readonly journal;
    private readonly pool;
    private facadeSource;
    constructor(ctx: Context, config: Config);
    /**
     * 校验并启动一个工作流。META_INVALID / SCRIPT_PARSE 在这里**同步抛**（seam 契约，
     * 注册层转 isError 结果）；一旦返回 run，一切失败都经 result.stopReason 折叠，
     * result 永不 reject。
     */
    start(request: WorkflowStartRequest): WorkflowRun;
    /** facade.d.ts 全文（guest 脚本编译期声明的唯一事实源），读一次缓存。 */
    private facade;
    /** seam 的 args: unknown 收口为无损 JSON（跨 PTC 边界强制；违规 → INVALID_ARGUMENT）。 */
    private losslessArgs;
}
