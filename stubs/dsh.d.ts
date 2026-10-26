/**
 * 单文件 ambient 类型桩（DESIGN §2/§5.2）——dsh-dwf 编译期顶替 @deepseek-ai/* 官方包。
 *
 * 已删除 stubs/dsh-inline-shapes.d.ts（gap-audit §3.13 的相对 declare module 断裂链），
 * workflow 词汇整体内联进下方 `declare module '@deepseek-ai/dsh-workflow'`。
 * 四个 specifier（ptc-runtime / sandbox / sandbox-policy / working-directory）与
 * subagent 段为 research/dsh-contract-v2.md 的**核实形状**（E:\os\.dsh-src v0.2.1-rc.3，
 * 注释逐段标 contract-v2 行号）；workflow 词汇转写自 workflow-seam/{index,types,runtime-types}.ts。
 *
 * 桩只含声明——运行时值一律来自真实官方包；接入真实 dsh 时把 stubs/ 移出
 * tsconfig include 即可（src 的 import specifier 是真实 specifier，一字不改）。
 * 标注「外部假设」的成员：contract-v2 §0/§6 明示定义体不在镜像内，接入时必须校。
 */

declare module '@deepseek-ai/cordis' {
  export interface Events {
    [name: string]: (...args: never[]) => void
  }
  export interface Context {
    readonly logger: { warn(message: string): void; info(message: string): void }
    events: { dispatch(mode: 'emit', args: unknown[]): Array<(...payload: unknown[]) => unknown> }
    on<K extends string>(name: K, listener: (...args: never[]) => void): () => void
    get<T>(name: string): T | undefined
    /**
     * DESIGN §5.2 点名的装载入口；cordis 真实签名镜像内不可考（R5），
     * 此为占位签名，接入真实 cordis 时校。
     */
    plugin(plugin: abstract new (ctx: Context, ...args: never[]) => Service, config?: unknown): void
    tools: import('@deepseek-ai/dsh-tools').ToolsService
    systemPrompt: import('@deepseek-ai/dsh-system-prompt').SystemPromptService
    /** workflow-seam/index.ts:31-34 的模块扩充。 */
    workflowEngine: import('@deepseek-ai/dsh-workflow').WorkflowEngine
    /** contract-v2 §5.1：cordis 槽位（subagent/index.ts:131-135）。 */
    subagents: import('@deepseek-ai/dsh-subagent').SubagentRuntime
    /** contract-v2 §1：cordis 槽位（ptc-runtime/index.ts:91-95 的 declare module）。 */
    ptcRuntime: import('@deepseek-ai/dsh-ptc-runtime').PtcRuntime
    /** contract-v2 §2：cordis 槽位（sandbox/index.ts:147-151）。 */
    sandbox: import('@deepseek-ai/dsh-sandbox').SandboxProvider
    /** contract-v2 §3：cordis 槽位（sandbox-policy/index.ts:58-62）。 */
    sandboxPolicy: import('@deepseek-ai/dsh-sandbox-policy').SandboxPolicyService
    /** contract-v2 §4：cordis 槽位（working-directory/index.ts:17-21）。 */
    workingDirectory: import('@deepseek-ai/dsh-working-directory').WorkingDirectoryService
    jobs?: import('@deepseek-ai/dsh-jobs').JobsService
  }
  export abstract class Service {
    constructor(ctx: Context, name: string)
    protected readonly ctx: Context
  }
}

declare module '@deepseek-ai/dsh-workflow' {
  import { Service } from '@deepseek-ai/cordis'
  import { HarnessError } from '@deepseek-ai/dsh-llm'

  /** 原 stubs/dsh-inline-shapes.d.ts 词汇整体内联于此（gap-audit §3.13 合并单文件）。 */

  /** 品牌化 run id；官方为运行时工厂函数（值导入，DESIGN §5.1）。 */
  export type WorkflowRunId = string & { readonly __brand: 'WorkflowRunId' }
  export function WorkflowRunId(id: string): WorkflowRunId

  export interface WorkflowPhase {
    title: string
    detail?: string
    provider?: string
    model?: string
  }

  export interface WorkflowMeta {
    name: string
    description: string
    whenToUse?: string
    phases?: WorkflowPhase[]
  }

  export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

  export interface WorkflowResult {
    value: unknown
    stopReason: WorkflowStopReason
    error?: string
    agentsStarted: number
  }

  export interface WorkflowRunInfo {
    id: WorkflowRunId
    meta: WorkflowMeta
  }

  export interface WorkflowAgentInfo {
    seq: number
    label: string
    phase?: string
    childId: import('@deepseek-ai/dsh-session').SessionId
  }

  export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

  export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
    outcome: WorkflowAgentOutcome
  }

  export interface WorkflowResultInfo {
    stopReason: WorkflowStopReason
    error?: string
    agentsStarted: number
  }

  /** workflow-seam/index.ts:108-119。 */
  export type WorkflowErrorCode =
    | 'SCRIPT_PARSE'
    | 'META_INVALID'
    | 'INVALID_ARGUMENT'
    | 'UNSUPPORTED_OPTION'
    | 'UNSUPPORTED_SCHEMA'
    | 'AGENT_CAP'
    | 'ITEM_CAP'
    | 'AGENT_START'
    | 'AGENT_RESULT'
    | 'RESULT_UNSERIALIZABLE'
    | 'CANCELLED'

  /** workflow-seam/index.ts:93-100（emitWorkflowEvent 的合法事件名）。 */
  export type WorkflowEventName =
    | 'workflow/start'
    | 'workflow/phase'
    | 'workflow/log'
    | 'workflow/agent-start'
    | 'workflow/agent-end'
    | 'workflow/end'

  /** 官方 extends HarnessError（workflow-seam/index.ts:130-139）。 */
  export class WorkflowError extends HarnessError {
    readonly code: WorkflowErrorCode
    readonly fatal: boolean
    constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean })
  }

  export interface WorkflowStartRequest {
    script: string
    meta: WorkflowMeta
    args?: unknown
    subagentProvider?: string
    maxTotalAgents?: number
    parent: import('@deepseek-ai/dsh-agent').Agent
    signal?: AbortSignal
  }

  export interface WorkflowRun {
    readonly id: WorkflowRunId
    readonly meta: WorkflowMeta
    readonly result: Promise<WorkflowResult>
    cancel(reason?: string): void
    dispose(): Promise<void>
  }

  /** workflow-seam/index.ts:157-187。 */
  export abstract class WorkflowEngine extends Service {
    constructor(ctx: Context)
    abstract start(request: WorkflowStartRequest): WorkflowRun
    protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void
  }
}

declare module '@deepseek-ai/dsh-agent' {
  export interface Agent {
    readonly id: string
    readonly session: import('@deepseek-ai/dsh-session').Session
  }
  /** 外部假设：定义体不在镜像内（contract-v2 §7），占位形状，接入真实 dsh-agent 时校。 */
  export interface AgentOptions {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-session' {
  export type SessionId = string & { readonly __brand: 'SessionId' }
  export function SessionId(id: string): SessionId
  export interface SessionEventMap {
    /**
     * contract-v2 §4 持久词汇（working-directory/index.ts:33-41）：cwd 为绝对目录。
     * 注意：本插件的 run/agent 生命周期事件不在桩内预置——官方 dsh-session
     * 无此词汇，由 src/tool/recorder.ts 自带 declare module 扩充
     * （PLAN T7④ 防双处声明，桩内计数须为 0）。
     */
    'working-directory/change': { cwd: string }
  }
  export interface Session {
    readonly id: SessionId
    append<Type extends keyof SessionEventMap>(type: Type, value: SessionEventMap[Type]): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export class HarnessError extends Error {
    constructor(message: string, code: string, options?: ErrorOptions)
    readonly code: string
  }
  /** 外部假设：定义体不在镜像内（contract-v2 §7），占位形状，接入真实 dsh-llm 时校。 */
  export type MessageId = string & { readonly __brand: 'MessageId' }
  /** 外部假设：定义体不在镜像内（contract-v2 §7，SubagentStartRequest.prompt 引用），占位形状。 */
  export interface ContentBlock {
    readonly type: string
    readonly [key: string]: unknown
  }
  /** contract-v2 §4 持久词汇（working-directory/index.ts:23-31）；后续包可再扩充。 */
  export interface MessageSourceMap {
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-subagent' {
  import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
  import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
  import type { SessionId } from '@deepseek-ai/dsh-session'
  import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

  /** contract-v2 §5.2（subagent/types.ts:136-183）：prompt/signal 必填，label 可选。 */
  export interface SubagentStartRequest {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly label?: string
    /** 必填（types.ts:148，dsh-llm ContentBlock 外部假设）。 */
    readonly prompt: ContentBlock[]
    readonly parent: Agent
    /** 必填（types.ts:161，统一取消通道）。 */
    readonly signal: AbortSignal
    readonly agentOptions?: AgentOptions
    readonly outputSchema?: ObjectJsonSchema
    readonly maxDepth?: number
  }

  /** contract-v2 §5.2（types.ts:233-247）：已知五值，merge-extensible。 */
  export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

  /** contract-v2 §5.2（types.ts:252-278）。 */
  export interface SubagentResult {
    readonly output: readonly ContentBlock[]
    readonly structured?: unknown
    readonly diagnostic?: string
    readonly stopReason: SubagentStopReason
  }

  /** contract-v2 §5.2（types.ts:47-59）。 */
  export interface SubagentActivation {
    readonly childId: SessionId
    readonly messageId?: MessageId
    readonly result: Promise<SubagentResult>
    dispose(): Promise<void>
  }

  /** contract-v2 §5.2（types.ts:31-44）：label/signal/delivery 由 spec 携带，request 除外。 */
  export interface SubagentActivationSpec {
    readonly provider: string
    readonly label: string
    readonly childId?: SessionId
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
    readonly signal: AbortSignal
    readonly delivery: 'parent' | 'caller'
  }

  /**
   * contract-v2 §5.1（subagent/index.ts:242-269）：公有面只有 resolveMaxDepth/startActivation。
   * 基类 TypertRemoteService（dsh-typert-protocol）为外部假设，桩按公有面落。
   * **getProvider 不进桩**（PLAN §5 风险 R2：DESIGN §3.5 的引用无据，T8 回写）。
   */
  export interface SubagentRuntime {
    resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
    startActivation(
      spec: SubagentActivationSpec & { readonly childId: SessionId },
    ): Promise<SubagentActivation & { readonly messageId: MessageId }>
    startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** 反推形状（ctx.tools.register 用法，DESIGN §3.1；工具注册表本体不在镜像，contract-v2 §6.6）。 */
  export interface ToolsService {
    register(tool: unknown): void
  }
  export interface ToolCallView { card: string; title?: string; rawInput?: string }
  export interface ToolResultView { card: string }
  /**
   * 占位形状（拍板表#15）：DESIGN §5.1 import 表无来源 specifier，contract-v2 §6.2/§6.6
   * 明示定义体不在镜像内——**外部假设，接入真实 dsh-tools 时校**。T5 的 schema 下沉与
   * T6 的 outputSchema 从它取型。
   */
  export interface ObjectJsonSchema {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
  export interface ToolExec {
    agent?: import('@deepseek-ai/dsh-agent').Agent
    signal: AbortSignal
    callId: string
    rootCallId: string
    parent?: unknown
  }
  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, unknown>
    output?: {
      schema?: unknown
      render?: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
    }
    execute(args: unknown, exec: ToolExec): Promise<unknown>
  }
  export function defineTool(definition: ToolDefinition): ToolDefinition
  export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema
}

declare module '@deepseek-ai/dsh-system-prompt' {
  /** 反推形状（tool-workflow/index.ts:325-330 用法；定义体不在镜像，外部假设）。 */
  export interface SystemPromptService {
    getSectionOrder(slot: string): number
    section(section: { name: string; order: number; text: string }): void
  }
}

/**
 * R3 预修（PLAN §5）：原 `export = z` 在 nodenext 无 esModuleInterop 下
 * `import { z }` 必报 TS2595（本会话 /tmp 探针实测）；官方源用默认导入
 * （tool-workflow/index.ts:16），T3 探针用命名导入——interface+function+namespace
 * 三方合并使两种导入风格与 `z<Config>` 类型位同时可用，语义不变。
 */
declare module '@deepseek-ai/schemastery' {
  interface z<T> {
    (value: unknown): T
  }
  namespace z {
    function object<T>(shape: Record<string, unknown>): z<T>
    function string(): z<string>
    function boolean(): z<boolean>
    function natural(): z<number>
  }
  function z<T>(schema: unknown): z<T>
  export default z
  export { z }
}

declare module '@deepseek-ai/dsh-jobs' {
  export type JobId = string & { readonly __brand: 'JobId' }
  export interface JobOutcome {
    status: 'completed' | 'killed' | 'failed'
    detail?: string
    result?: string
  }
  export interface JobHandle {
    append(line: string): void
    updateProgress(label: string): void
  }
  export interface JobsService {
    start(init: {
      kind: string
      label: string
      owner: string
      toolCall: { callId: string; rootCallId: string }
      run(job: JobHandle): { cancel(reason?: string): void; done: Promise<JobOutcome> }
    }): JobId
  }
  /** tool-workflow/index.ts:34-38 的模块扩充（后台 run 的 kind 词表）。 */
  export interface JobKindMap {
    workflow: 'workflow'
  }
}

declare module '@deepseek-ai/dsh-ptc-runtime' {
  import { Service } from '@deepseek-ai/cordis'
  import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

  /** contract-v2 §1.2（ptc-runtime/types.ts:23）：无损 JSON 值。 */
  export type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }
  /** contract-v2 §1.2（types.ts:20）：参数与返回值必须无损 JSON。 */
  export type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>
  /** contract-v2 §1.2（types.ts:32-42）。 */
  export interface PtcBindingErrorClass {
    name: string
    memberNameProperty: string
  }
  /** contract-v2 §1.2（types.ts:51-67）：global 须匹配可移植标识符 [A-Za-z_][A-Za-z0-9_]*。 */
  export interface PtcBindingNamespace {
    global: string
    functions: Record<string, PtcBindingFunction>
    errorClass?: PtcBindingErrorClass
  }
  /** contract-v2 §1.2（types.ts:73-105）：调用方输入。 */
  export interface PtcRunRequest {
    program: string
    stateOwner?: object
    bindings: PtcBindingNamespace[]
    cwd?: string
    timeoutMs?: number | null
    sandboxPolicy?: SandboxExecutionPolicy
    signal?: AbortSignal
  }
  /** contract-v2 §1.2（types.ts:108-113）：resolve 之后的必填 cwd/timeoutMs。 */
  export interface PtcRunSpec extends PtcRunRequest {
    cwd: string
    timeoutMs: number | null
  }
  /** contract-v2 §1.2（types.ts:116-123）。 */
  export interface PtcRunSandbox {
    mode: SandboxMode
    denied: boolean
    enforcement?: SandboxEnforcement
  }
  /** contract-v2 §1.2（types.ts:139-144）：失败是 result 的字段而非 reject（types.ts:146-150）。 */
  export interface PtcRunFailure {
    kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
    message: string
  }
  /** contract-v2 §1.2（types.ts:151-169）。 */
  export interface PtcRunResult {
    sandbox?: PtcRunSandbox
    value?: PtcJsonValue
    logs: string[]
    error?: PtcRunFailure
  }
  /** contract-v2 §1.1：PtcRuntime 抽象类 9 成员（ptc-runtime/index.ts:104-163）。 */
  export abstract class PtcRuntime extends Service {
    constructor(ctx: Context)
    abstract readonly language: string
    abstract readonly isolation: string
    get programFormat(): 'function-body' | 'repl'
    release(owner: object): Promise<void>
    get executionInstructions(): string
    get sandboxMode(): SandboxMode | undefined
    get timeout(): { defaultMs: number; maxMs: number } | undefined
    abstract resolve(request: PtcRunRequest): PtcRunSpec
    abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
  }
}

declare module '@deepseek-ai/dsh-sandbox' {
  import { Service } from '@deepseek-ai/cordis'
  import { HarnessError } from '@deepseek-ai/dsh-llm'
  import type { SessionId } from '@deepseek-ai/dsh-session'

  /** contract-v2 §2（sandbox/index.ts:30）。 */
  export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
  /** sandbox/index.ts:33。 */
  export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
  /** contract-v2 §2（sandbox/index.ts:40-53）：sessionId 为 dsh-session 品牌 id（外部假设）。 */
  export interface SandboxExecutionPolicy {
    mode: SandboxMode
    workspaceRoot: string
    sessionId?: SessionId
  }
  /** sandbox/index.ts:60。 */
  export type SandboxEnforcement = 'full' | 'partial'
  /** contract-v2 §2（sandbox/index.ts:70-73）：仅把 mode 收窄为 ConfinedSandboxMode。 */
  export interface SandboxPolicy extends SandboxExecutionPolicy {
    mode: ConfinedSandboxMode
  }
  /** sandbox/index.ts:82-89。 */
  export interface RunnerFailureRule {
    allowedExitCodes?: readonly number[]
    fatalSignatures: readonly string[]
    informationalLines?: readonly string[]
  }
  /** sandbox/index.ts:96-117。 */
  export interface ConfinedArgv {
    argv: string[]
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
  }
  /** sandbox/index.ts:125。 */
  export const SANDBOX_UNAVAILABLE: 'SANDBOX_UNAVAILABLE'
  /** sandbox/index.ts:132-145。 */
  export class SandboxUnavailableError extends HarnessError {
    constructor(mode: ConfinedSandboxMode, detail?: string)
  }
  /** contract-v2 §2：SandboxProvider.confine（sandbox/index.ts:159-178）。 */
  export abstract class SandboxProvider extends Service {
    constructor(ctx: Context)
    abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>
  }
}

declare module '@deepseek-ai/dsh-sandbox-policy' {
  import { Service } from '@deepseek-ai/cordis'
  import z from '@deepseek-ai/schemastery'
  import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
  import type { Session } from '@deepseek-ai/dsh-session'

  /** contract-v2 §3（sandbox-policy/index.ts:71-79）：全部可选，defaults 补齐。 */
  export interface Config {
    mode?: SandboxMode
    workspaceRoot?: string
  }
  /** sandbox-policy/index.ts:82-87：session 为 dsh-session Session（外部假设）。 */
  export interface SandboxPolicyRequest {
    session?: Session
    mode?: SandboxMode
  }
  /**
   * contract-v2 §3：SandboxPolicyService 全成员（sandbox-policy/index.ts:110-181）。
   * resolve 优先级：显式 mode > 会话 sandboxMode 投影 > defaultMode（:167）；
   * workspaceRoot = session.header.cwd ?? this.workspaceRoot（:168）。
   */
  export class SandboxPolicyService extends Service {
    constructor(ctx: Context, config: Config)
    static Config: z<Config>
    static inject: readonly string[]
    readonly defaultMode: SandboxMode
    readonly workspaceRoot: string
    resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
    overrideOf(session: Session): SandboxMode | undefined
  }
}

declare module '@deepseek-ai/dsh-working-directory' {
  import { Service } from '@deepseek-ai/cordis'
  import z from '@deepseek-ai/schemastery'
  import type { Agent } from '@deepseek-ai/dsh-agent'
  import type { Session } from '@deepseek-ai/dsh-session'

  /** contract-v2 §4（working-directory/index.ts:56-59）：缺省 process.cwd() 且必须绝对。 */
  export interface Config {
    defaultDirectory?: string
  }
  /**
   * contract-v2 §4：类名 **WorkingDirectoryService**（working-directory/index.ts:62-223）。
   * 拍板表#14：DESIGN §5.1:607 的 `WorkingDirectory` 是 v1 转写残名，照写必 TS2305；
   * get/ensure/set 三方法签名 :122-170。
   */
  export class WorkingDirectoryService extends Service {
    constructor(ctx: Context, config: Config)
    static inject: readonly string[]
    static Config: z<Config>
    readonly defaultDirectory: string
    get(session: Session): string
    ensure(agent: Agent, signal?: AbortSignal): Promise<string>
    set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
  }
}
