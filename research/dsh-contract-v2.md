# DSH 能力五包 · 契约取证 v2（真实源码形状）

> 取证范围：`E:\os\.dsh-src\` 下 `ptc-runtime/`、`sandbox/`、`sandbox-policy/`、`working-directory/`、`subagent/`、`tools/`、`jobs/`，包版本统一 `0.2.1-rc.3`（各 package.json `version` 字段，如 jobs/package.json:4、tools/package.json:4）。与 [dsh-contract.md](dsh-contract.md)（v1，workflow 三包）互补；本文全部行号来自 2026-10-24 直接读取的源码文件。

## 0. 取证方法与局限

- **文件确认**（已执行）：`ls E:/os/.dsh-src/` + 逐包 `ls`。7 个包目录全部在位；但 **`jobs/` 目录只有 `package.json` 一个文件**（`find E:/os/.dsh-src/jobs -type f` 仅返回它），源码未抓到。`tools/` 只有 `package.json` + `types.ts`。
- **REA 证据：不采用**。`python -c "...('summary','statistics','limitations')..."` 对 `E:\os\.rea-dsh.json`（subject 确为 `.dsh-src`，sha256 `2c3738c5…91d0e5de`）抽出的 summary/statistics 全是 **Electron IPC 维度**（`browser_windows:0`、`ipc.operations:0`、`main_handlers:0` 等，`findings:1031` 但分类口径不适用），limitations 亦为 Electron/静态 AST 口径。对 TS 接口形状**无用**，本文不引用 REA，全部结论来自直接读源码。
- 「已核实」= 本镜像文件内逐行读过；跨包引用类型（如 `SessionId`、`ContentBlock`、`ObjectJsonSchema`）的定义体不在镜像内，标注为**外部假设**。

---

## 1. ptcRuntime（`@deepseek-ai/dsh-ptc-runtime`）

### 1.1 服务形状：`PtcRuntime` 抽象类（ptc-runtime/index.ts:104-163）

cordis 槽位 `ctx.ptcRuntime`（index.ts:91-95 的 `declare module`）。`constructor(ctx)` 调 `super(ctx, 'ptcRuntime')`（index.ts:145-147）。

| 成员 | 形状 | 行号 | 说明 |
|---|---|---|---|
| `language` | `abstract readonly language: string` | index.ts:114 | 小写标识符；已知值 `'typescript'` / `'python'`，仅信息性 |
| `isolation` | `abstract readonly isolation: string` | index.ts:122 | 已知值 `'worker-thread'` / `'process'` / `'container'` |
| `programFormat` | `get programFormat(): 'function-body' \| 'repl'` | index.ts:125 | 默认 `'function-body'` |
| `release` | `release(owner: object): Promise<void>` | index.ts:134 | 默认 no-op；释放 stateOwner 的保留环境 |
| `executionInstructions` | `get executionInstructions(): string` | index.ts:137 | 默认 `''` |
| `sandboxMode` | `get sandboxMode(): SandboxMode \| undefined` | index.ts:140 | 默认 `undefined` = 不支持文件约束 |
| `timeout` | `get timeout(): { defaultMs: number; maxMs: number } \| undefined` | index.ts:143 | 默认 `undefined` = 不支持每调用覆盖 |
| `resolve` | `abstract resolve(request: PtcRunRequest): PtcRunSpec` | index.ts:155 | 校验并补全 cwd/deadline/policy；非法显式选项抛错 |
| `run` | `abstract run(spec: PtcRunSpec): Promise<PtcRunResult>` | index.ts:162 | 程序结果以字段形式 resolve，**从不 reject**（除契约误用） |

### 1.2 词汇类型（ptc-runtime/types.ts，全文 169 行已读）

`PtcRunRequest`（types.ts:73-105）——调用方输入：

| 字段 | 类型 | 行号 |
|---|---|---|
| `program` | `string` | :81 |
| `stateOwner?` | `object`（对象身份，缺省=全新环境） | :87 |
| `bindings` | `PtcBindingNamespace[]` | :89 |
| `cwd?` | `string` | :91 |
| `timeoutMs?` | `number \| null`（null=无期限） | :96 |
| `sandboxPolicy?` | `SandboxExecutionPolicy`（import 自 dsh-sandbox，types.ts:9） | :98 |
| `signal?` | `AbortSignal` | :104 |

`PtcRunSpec extends PtcRunRequest`（types.ts:108-113）：`cwd: string` 必填绝对路径（:110）、`timeoutMs: number \| null` 必填（:112）。

`PtcRunResult`（types.ts:151-169）：

| 字段 | 类型 | 行号 |
|---|---|---|
| `sandbox?` | `PtcRunSandbox` | :153 |
| `value?` | `PtcJsonValue`（完成值，lossless JSON） | :160 |
| `logs` | `string[]`（必填） | :166 |
| `error?` | `PtcRunFailure` | :168 |

`PtcRunSandbox`（types.ts:116-123）：`mode: SandboxMode`（:118）、`denied: boolean`（:120）、`enforcement?: SandboxEnforcement`（:122）。

`PtcRunFailure`（types.ts:139-144）：`kind` 八值（:141）= `'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'`；`message: string`（:143）。失败是 **result 的字段而非 reject**（types.ts:146-150 注释明确）。

绑定侧：

| 类型 | 形状要点 | 行号 |
|---|---|---|
| `PtcBindingFunction` | `(args: unknown) => Promise<PtcJsonValue>`；参数与返回值必须 lossless JSON | types.ts:20 |
| `PtcJsonValue` | `null \| boolean \| number \| string \| PtcJsonValue[] \| { [k: string]: PtcJsonValue }` | types.ts:23 |
| `PtcBindingErrorClass` | `{ name: string; memberNameProperty: string }` | types.ts:32-42 |
| `PtcBindingNamespace` | `{ global: string; functions: Record<string, PtcBindingFunction>; errorClass? }`；`global` 须匹配可移植标识符 `[A-Za-z_][A-Za-z0-9_]*` | types.ts:51-67 |

共享常量（index.ts）：`RESERVED_BINDING_GLOBALS = {console, __dsh_main__, __builtins__, __name__, __debug__}`（:42-45）；`RESERVED_ERROR_MEMBERS = {name, message, stack, args, with_traceback, add_note}`（:57-60）；`DUNDER_MEMBER = /^__.+__$/`（:66）；`PORTABLE_RESERVED_WORDS` = ECMAScript ∪ Python 关键字并集（:78-89）。

---

## 2. sandbox（`@deepseek-ai/dsh-sandbox`）—— ptcRuntime 的 policy 词汇来源

文件 sandbox/index.ts（全文 182 行已读）。

| 类型/值 | 形状 | 行号 |
|---|---|---|
| `SandboxMode` | `'read-only' \| 'workspace-write' \| 'danger-full-access'` | :30 |
| `ConfinedSandboxMode` | `Exclude<SandboxMode,'danger-full-access'>` | :33 |
| `SandboxExecutionPolicy` | `{ mode: SandboxMode; workspaceRoot: string; sessionId?: SessionId }` | :40-53（mode:42、workspaceRoot:44、sessionId:52；sessionId 为 dsh-session 品牌 id，**外部假设**） |
| `SandboxEnforcement` | `'full' \| 'partial'` | :60 |
| `SandboxPolicy` | `extends SandboxExecutionPolicy`，仅把 `mode` 收窄为 `ConfinedSandboxMode` | :70-73 |
| `RunnerFailureRule` | `{ allowedExitCodes?: readonly number[]; fatalSignatures: readonly string[]; informationalLines?: readonly string[] }` | :82-89 |
| `ConfinedArgv` | `{ argv: string[]; enforcement: SandboxEnforcement; denialSignatures: readonly string[]; runnerFailureRules: readonly RunnerFailureRule[] }` | :96-117 |
| `SANDBOX_UNAVAILABLE` | `const = 'SANDBOX_UNAVAILABLE'` | :125 |
| `SandboxUnavailableError` | `extends HarnessError`（dsh-llm，**外部假设**），构造参数 `(mode, detail?)` | :132-145 |
| `SandboxProvider` | `abstract class extends Service`（cordis），`constructor` 调 `super(ctx,'sandbox')`（:161-163） | :159-178 |
| `SandboxProvider.confine` | `abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>` | :177 |

re-export 面：escalation 家族（`ESCALATION_TARGETS`、`approveEscalation` 等 + `EscalationApproval/Approver/Outcome/Request` 类型）:12-21；`canonicalPath`/`writableRoots`（roots.ts）:22；`classifyRunnerFailure`/`isRunnerSpawnFailure`/`matchesSignature`（diagnostics.ts）:182。escalation.ts / roots.ts / diagnostics.ts 的内部形状**本包内未逐行读**（不在本次 200 行片段预算内）。

---

## 3. sandboxPolicy（`@deepseek-ai/dsh-sandbox-policy`）—— `ctx.sandboxPolicy`

文件 sandbox-policy/index.ts（全文 183 行已读）。

`Config`（:71-79，全部可选，defaults 补齐）：

| 字段 | 类型 | 行号 | 默认 |
|---|---|---|---|
| `mode?` | `SandboxMode` | :73 | `'read-only'`（fail-safe，:113 schema `.default('read-only')`） |
| `workspaceRoot?` | `string` | :78 | `process.cwd()`（:131，schema 无默认、构造器解析，:114-115 注释） |

`SandboxPolicyRequest`（:82-87）：`session?: Session`（:84，dsh-session **外部假设**）、`mode?: SandboxMode`（:86，已批准的显式覆盖）。

`SandboxPolicyService extends Service`（:110-181，cordis 槽位 `sandboxPolicy`，:58-62）：

| 成员 | 形状 | 行号 |
|---|---|---|
| `static Config` | `z<Config>`：`mode` union+default、`workspaceRoot: z.string()`（无 schema 默认） | :112-117 |
| `static inject` | `['sessionProjections']` | :119 |
| `defaultMode` | `readonly SandboxMode` | :122 |
| `workspaceRoot` | `readonly string`（必须绝对，`resolveWorkspaceRoot` :36-39 非绝对即抛） | :124, :131 |
| 构造副作用 | 注册会话投影 `sandboxMode`（key/stateVersion:1/stateSchema 三值∪null/init `()=>null`/apply 认 `sandbox/mode` 事件，:133-139）；注入 systemPrompt 段 `sandbox:policy`（:141-152） | :133-152 |
| `resolve` | `resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy`；优先级 **显式 mode > 会话 sandboxMode 投影 > defaultMode**（:167）；`workspaceRoot = session.header.cwd ?? this.workspaceRoot`（:168）；`sessionId` 仅当有 session 时携带（:169） | :164-171 |
| `overrideOf` | `(session: Session): SandboxMode \| undefined`，读投影不落默认 | :178-180 |

辅助：`renderPolicyContext(policy)` 产出三段固定英文模型上下文（:42-56）；re-export `SANDBOX_MODES, setSandboxMode`（来自 ./session-mode.ts，其内部**未读**）:33。

---

## 4. workingDirectory（`@deepseek-ai/dsh-working-directory`）—— `ctx.workingDirectory`

文件 working-directory/index.ts（全文 225 行已读）。

`Config`（:56-59）：`defaultDirectory?: string`（:58，缺省 `process.cwd()` :77，必须绝对 :78）。

`WorkingDirectoryService extends Service`（:62-223，cordis 槽位 :17-21）：

| 成员/副作用 | 形状 | 行号 |
|---|---|---|
| `static inject` | `['fs', 'sessionProjections', 'systemPrompt']` | :63 |
| `static Config` | `z.object({ defaultDirectory: z.string() })` | :65-67 |
| `defaultDirectory` | `readonly string` | :70 |
| `get(session)` | `(session: Session) => string`，纯投影读取，无 IO：`stateOf(...) ?? defaultDirectory` | :122-124 |
| `ensure(agent, signal?)` | `Promise<string>`；校验当前目录存在，目录消失则回退 `header.cwd ?? defaultDirectory` 并 commit 恢复 | :134-152 |
| `set(agent, path, signal?)` | `Promise<string>`；相对路径相对当前目录解析（:166→:176-184），提交后返回规范绝对目录 | :163-170 |
| 私有 `commit` | 追加事件 + 向 agent 注入 `createUserMessage` 通知（dsh-llm，**外部假设**）；通知失败仅 warn 不回滚 | :186-206 |
| 私有 `serialize` | per-session Promise 链串行 + `AbortSignal.any` 生命周期合并 | :208-222 |
| 构造副作用① | 注册投影 `workingDirectory`：`stateVersion:1`、schema `string.min(1).refine(isAbsolute).nullable()`、`init: header.cwd ?? null`、apply 认 change 事件、wire view 同 schema | :82-89 |
| 构造副作用② | systemPrompt 段 `working-directory:current`（`required: true`、`interpolate: false`，text = `Current working directory: <JSON 字符串>.`） | :90-96, :172-174 |
| 构造副作用③ | `system-prompt/assemble` 前置钩子：装配前 `ensure(agent)`，并把 `working-directory:current` 段 upsert 到 contexts 首位 | :97-110 |

持久词汇（模块扩充声明）：

| 位置 | 形状 | 行号 |
|---|---|---|
| `MessageSourceMap['working-directory']` | `{ kind: 'working-directory' }` | :23-31 |
| `SessionEventMap['working-directory/change']` | `{ cwd: string }`（绝对目录） | :33-41 |
| `SessionProjectionMap/StateMap.workingDirectory` | `string \| null` | :43-53 |

---

## 5. subagent（`@deepseek-ai/dsh-subagent`）—— `ctx.subagents`

### 5.1 服务：`SubagentRuntime extends TypertRemoteService`（index.ts:194）

注意：本镜像版本的 subagent 基类是 **`TypertRemoteService`**（dsh-typert-protocol，**外部假设**，基类形状未在镜像内），不是 v1 workflow 包那种裸 `Service`。

| 成员 | 形状 | 行号 |
|---|---|---|
| cordis 槽位 | `ctx.subagents: SubagentRuntime` | index.ts:131-135 |
| `static Config` | `maxDepth: z.number().step(1).min(0).default(1).volatile()`；`maxActiveSubagents: …min(1).default(8).volatile()` | index.ts:195-198 |
| `Config` 接口 | `{ maxActiveSubagents: Volatile<number>; maxDepth: Volatile<number> }`（`Volatile<T>` **外部假设**，dsh 内部工具型） | index.ts:186-191 |
| `static inject` | `['workingDirectory']` | index.ts:199 |
| 构造副作用① | 注入 `agents` → 建 `SubagentManager`（`startExternal`/`prepareContinuable`/`observeActivation` 三个回调桥到 provider，容量取 `config.maxActiveSubagents.get()`） | index.ts:212-226 |
| 构造副作用② | 注入 `sessionProjections` → 注册 catalog/timing/identity 三个投影（定义体在 projection-types.ts / catalog.ts，**未逐行读**） | index.ts:227-231 |
| 构造副作用③ | 注入 `agents` → `installSubagentArchiveAdmission` | index.ts:234 |
| `resolveMaxDepth` | `(configured?: number \| 'provider-managed') => number \| undefined`；`'provider-managed'`→undefined、显式数直通、否则取配置值 | index.ts:242-248 |
| `startActivation` | 双重载：带保留 `childId` → `Promise<SubagentActivation & { messageId: MessageId }>`（要求 local 后端）；一般 → `Promise<SubagentActivation>` | index.ts:255-269 |

cordis `Events`（index.ts:136-167）：`subagent/provider-added(provider)`（:142）、`subagent/provider-removed(name)`（:148）、`subagent/start(info: SubagentRunInfo)`（:158）、`subagent/end(info: SubagentRunEndInfo)`（:166）——后两个按委派父作用域过滤（`Scoped<SubagentRuntime>`）。

导出面（index.ts:80-129）：control-types 全量 type re-export（:126）、`SubagentRunInfo/SubagentRunEndInfo`（:128）、`ChildComposition, DelegatedPolicyOverrides`（:124）等；`SubagentManager`（manager.ts，1493 行）本体**未逐行读**。

### 5.2 Provider 契约（subagent/types.ts，全文 356 行已读）

`SubagentProvider`（types.ts:313-356）——注册到 `ctx.subagents` 的后端：

| 字段/方法 | 类型 | 行号 |
|---|---|---|
| `name` | `readonly string`（如 `spawn`/`fork`/`acp`） | :315 |
| `capabilities` | `SubagentCapabilities` | :317 |
| `inheritsParentContext` | `readonly boolean`（描述性，非校验能力） | :323 |
| `agentRouteDefaults?` | `Readonly<{ provider: string; model: string }>`（需 agentOptions 能力） | :330 |
| `start?` | `(request: ResolvedSubagentStartRequest) => Promise<SubagentRun>`（外部执行路径） | :340 |
| `prepareContinuable?` | `(request: ContinuableCreateRequest) => Promise<ContinuableCreateSpec>`（**方法存在与否**选择 local continuable 路径；:345-355 注释明确 manager 拥有后续全部生命周期） | :355 |

`SubagentCapabilities`（types.ts:123-129）：四个 `readonly boolean`——`agentOptions`(:125)、`agentPreset`(:126)、`outputSchema`(:127)、`depthLimit`(:128)。

`SubagentStartRequest`（types.ts:136-183）：

| 字段 | 类型 | 行号 |
|---|---|---|
| `cwd?` | `string`（相对路径相对父当前目录；缺省继承） | :138 |
| `agentPreset?` | `string`（需 capabilities.agentPreset） | :144 |
| `label?` | `string` | :146 |
| `prompt` | `ContentBlock[]`（必填，dsh-llm **外部假设**） | :148 |
| `parent` | `Agent`（必填，dsh-agent **外部假设**） | :153 |
| `signal` | `AbortSignal`（唯二必填之一；启动前后统一的取消通道） | :161 |
| `agentOptions?` | `AgentOptions`（需 agentOptions 能力） | :169 |
| `outputSchema?` | `ObjectJsonSchema`（dsh-tools **外部假设**；成功时产出 `SubagentResult.structured`） | :175 |
| `maxDepth?` | `number`（非负安全整数，需 depthLimit 能力） | :182 |

`ResolvedSubagentStartRequest = SubagentStartRequest & { cwd: string }`（types.ts:186-189）。

运行结果与生命周期：

| 类型 | 要点 | 行号 |
|---|---|---|
| `SubagentRunId` | `Branded<'SubagentRunId'>` + 品牌函数 | :19-28 |
| `SubagentRun` | `{ id: SessionId; result: Promise<SubagentResult>; dispose(): Promise<void> }`；`result` 在子级失败时 **resolve** `stopReason:'error'`，仅基础设施故障才 reject | :287-303 |
| `SubagentResult` | `{ output: readonly ContentBlock[]; structured?: unknown; diagnostic?: string; stopReason: SubagentStopReason }`；`diagnostic` 限 4096 UTF-8 字节、不得含敏感负载 | :252-278（diagnostic 上限 :274） |
| `SubagentStopReasonMap` | 已知五值 `completed / aborted / error / max-tokens / refusal`；merge-extensible（后端可并新变体） | :233-247 |
| `SubagentActivationSpec` | `{ provider; label; childId?; request: Omit<SubagentStartRequest,'label'\|'signal'>; signal; delivery: 'parent'\|'caller' }` | :31-44 |
| `SubagentActivation` | `{ childId; messageId?; result: Promise<SubagentResult>; dispose() }` | :47-59 |
| `SubagentRunInfo` / `SubagentRunEndInfo` | start/end 事件载荷；end 多 `stopReason` 与 `lastAssistantMessage?` | :80-92 / :98-115 |
| `SubagentInterruptAuthority` | `{ kind:'user'; parentSessionId } \| { kind:'ancestor'; agent: Agent }` | :66-68 |
| `ContinuableCreateRequest` / `ContinuableCreateSpec` | manager→provider 的创建输入 / 纯数据产出（`seed?: readonly SessionEvent[]`） | :198-210 / :218-225 |

### 5.3 控制面（subagent/control-types.ts，全文 149 行已读）

| 类型 | 要点 | 行号 |
|---|---|---|
| `SubagentPromptRequestId` | `Branded<'session-request-id'>` | :22 |
| `SubagentCatalogRow` | `{ id; activity:'running'\|'inactive' } & (one-shot \| external \| continuable)`；continuable 的 `label` 必填，另两模式可选 | :25-53 |
| `SubagentListEntry` | `child`（带 `hasChildren`）\| `diagnostic`（`corrupt\|unsupported\|unavailable`） | :59-76 |
| `SubagentAddress` | `{ parentSessionId; childSessionId } & (one-shot\|continuable\|unknown)` | :79-88 |
| `SubagentPromptRequest` | `{ requestId; parentSessionId; childSessionId; mode:'continuable'; delivery:'queue'\|'steer'; content: readonly PromptContentPart[]; clientTimeZone? }` | :94-111 |
| receipts | `SubagentPromptReceipt { messageId }`（:114-116）、`SubagentInterruptReceipt { accepted: true }`（:119-121） | |
| `SessionActivityKindMap.subagent` | `true`（任一深度子代理在 turn 内） | :127-132 |
| `RemoteErrorDetailsMap` | 六个 `subagent/*` 错误：`invalid-time-zone` / `parent-unavailable` / `not-resumable` / `unauthorized` / `attachment-invalid` / `delivery-unavailable` | :134-149 |

### 5.4 持久描述符（subagent/descriptor.ts，关键段 :29-98 已读）

`SessionEventMap['subagent/descriptor']: SubagentDescriptorData`（:38，log-only、不过模型上下文、**可过压缩存活**）。`SUBAGENT_DESCRIPTOR_VERSION = 3`（:48，fold 时逐字校验）。

| 字段 | OneShot（:61-69） | Continuable（:72-86） |
|---|---|---|
| `version` | 必填 =3（:53） | 同 |
| `mode` | `'one-shot'` | `'continuable'` |
| `provider` | 必填（:57） | 同 |
| `label` | 可选（:68） | **必填**（:75） |
| `agentProvider?`/`agentModel?`/`agentReasoningEffort?` | — | 可选（:77/:79/:81） |
| `persona?` / `toolFilter?` | — | 可选（:83/:85，resume 时复用） |

入口函数：`snapshotSubagentDescriptor`（:230）、`foldSubagentDescriptor(events): SubagentDescriptorData \| undefined`（:263）——函数体未逐行读。

### 5.5 tools（`@deepseek-ai/dsh-tools/types.ts`，全文 63 行已读）

仅事件词汇，模块扩充 `@deepseek-ai/dsh-session/types` 的 `SessionEventMap`（types.ts:30-63）：

| 事件/载荷 | 字段 | 行号 |
|---|---|---|
| `'tool/ptc-dispatch-start'` → `PtcDispatchStartEventData` | `rootCallId / parentCallId / subCallId / name / arguments`（`ToolCallId` 为 dsh-llm/brand **外部假设**）；`subCallId` 新格式 `<parent>:ptc:<n>` | :12-18（格式 :36-37） |
| `'tool/ptc-dispatch'` → `PtcDispatchEventData` | 上述全部 + `isError: boolean` + `content: ContentBlock[]` + `meta?: JsonValue` + `error?: { name; code; reason? }` | :21-28 |

两个事件均 **log-only**（`deriveMessages()` 忽略，不进模型上下文；:41-43、:55-56 注释）。配对键 = `subCallId`。运行时/注册表本体（`lib/index.js` 对应源码）**不在镜像内**。

### 5.6 jobs（`@deepseek-ai/dsh-jobs`）—— ⛔ 无源码

目录内仅 `package.json`。可核实事实：name（:2）、description「Background job registry (ctx.jobs) … shared ids, owner isolation, polling, cancellation, and completion listeners」（:3）、version `0.2.1-rc.3`（:4）、exports `.` / `./brand` / `./view`（:16-31）、peers `dsh-agent`/`dsh-brand`/`dsh-session`/`dsh-workspace`(optional)/`cordis`（:38 起）。**接口形状全部仍属调用点反推**；`ctx.jobs` 的具体 API 面未取证。

---

## 6. 已核实 vs 仍属反推

**已核实（本镜像逐行读过的形状）**：
- `ptc-runtime`：`PtcRuntime` 全部 9 个成员 + `PtcRunRequest/Spec/Sandbox/Failure/Result` 全字段 + 4 个绑定类型 + 4 个常量（index.ts/types.ts 全文）。
- `sandbox`：`SandboxMode/ExecutionPolicy/Enforcement/Policy/RunnerFailureRule/ConfinedArgv` 全字段、`confine` 签名、错误类型（index.ts 全文）；escalation/roots/diagnostics 三个内部模块**仅见 re-export 名**。
- `sandbox-policy`：`Config/SandboxPolicyRequest/SandboxPolicyService` 全成员与 resolve 优先级、投影注册、systemPrompt 段（index.ts 全文）。
- `working-directory`：`Config/WorkingDirectoryService` 公有 3 方法全签名、事件/投影/消息源声明（index.ts 全文）。
- `subagent`：`SubagentRuntime` 公有面、`SubagentProvider/StartRequest/Run/Result/StopReason/ActivationSpec/Activation/RunInfo/RunEndInfo/InterruptAuthority/Continuable*` 全字段、控制面 8 类型、描述符三接口（types.ts / control-types.ts 全文 + index.ts/descriptor.ts 关键段）。
- `tools`：types.ts 全文（两个 PTC 派发事件）。

**仍属反推 / 未取证**：
1. `jobs` 包全部 API（源码缺失，仅 package.json）。
2. `tools` 运行时（工具注册表、执行管线、`ObjectJsonSchema` 定义体）——types.ts 只是事件词汇。
3. `subagent/manager.ts`（1493 行）、`lifecycle.ts`、`catalog.ts`、`child-agent.ts`、`activation.ts`、`depth.ts`、`client.ts`、`projection-types.ts`、`list-children.ts` 的内部形状。
4. `sandbox` 的 `escalation.ts`/`roots.ts`/`diagnostics.ts` 与 `sandbox-policy/session-mode.ts` 内部。
5. `ptc-runtime/ptc-runtime-node/`（bindings/bootstrap/channel/config/environment/launch 等 10 文件）——Node 后端实现，本包接口契约不依赖它。
6. 全部跨包品牌类型（`SessionId`、`MessageId`、`ToolCallId`、`ContentBlock`、`AgentOptions`、`ObjectJsonSchema`、`Session`、`Agent`、`Volatile`、`TypertRemoteService`）的定义体不在镜像内，本文按其用途引用。

## 7. 跨包依赖（由各文件 import 语句归纳）

```
ptc-runtime ──类型──▶ sandbox(SandboxMode/ExecutionPolicy/Enforcement)
sandbox ──▶ cordis, dsh-llm(HarnessError), dsh-session(SessionId)
sandbox-policy ──类型──▶ sandbox; ──▶ cordis, zod, schemastery, dsh-agent/session/session-projection/system-prompt(类型)
working-directory ──▶ cordis, schemastery, zod, dsh-agent, dsh-fs, dsh-llm, dsh-session
subagent ──类型──▶ dsh-agent, dsh-brand, dsh-llm, dsh-session, dsh-tools(ObjectJsonSchema),
                   dsh-attachment/types(PromptContentPart), dsh-typert-protocol, dsh-workspace/types
tools/types ──▶ dsh-llm(brand+types), dsh-util-values(JsonValue), dsh-session
jobs ──peers──▶ dsh-agent, dsh-brand, dsh-session, dsh-workspace(optional), cordis
```

## 8. 真机回填（p0b-backfill，2026-10-25）

> 事实源：npx 缓存真实包 `<NX> = <npm-cache>/node_modules/@deepseek-ai`（同镜像包版本 `0.2.1-rc.3` 系）。逐组对照 §6「仍属反推/未取证」清单（组号取 out/dsh-dwf-integration-notes.md §7 的 7 组表）。判语：**实证一致** = 反推形状与真实 `.d.ts` 相符；**修正** = 以真实形状覆盖旧文；**补全** = 反推未落形状、现补。本节行号均为本轮实际读取的 `.d.ts` 行号；未跑 dsh 宿主（按任务边界）。

### 组1 jobs（§5.6）——补全（原「无源码、API 面未取证」现全取证）

`ctx.jobs: JobRegistry`（cordis 槽位，dsh-jobs/lib/types/index.d.ts:16-20）。`JobRegistry extends Service`（abstract，:59），公有抽象面：

| 成员 | 形状 | 行号 |
|---|---|---|
| `events` | `abstract readonly events: JobEvents`（`subscribe(filter, listener): () => void`） | :62; types.d.ts:277-288 |
| `start` | `(spec: JobSpec): JobId`（同步；preflight 拒绝则无注册；返回 `<kind>-<short-uuid>`） | :71 |
| `list` | `(caller?: SessionId): JobView[]` | :77 |
| `get` | `(id: JobId, caller?: SessionId): JobView` | :85 |
| `read` | `(id, caller?): JobRead`（消费模型游标；结算后首读携带 `result`） | :94 |
| `readAt` | `(id, from: number, caller?): JobOutputRead`（非消费按绝对字节偏移读） | :105 |
| `kill` | `(id, caller?, reason?): 'requested' \| 'already-finished'` | :116 |
| `wait` | `(id, timeoutMs: number, caller?, signal?): Promise<JobView>` | :128 |
| `remove` | `(id, caller?): void`（仅 settled 可删） | :137 |
| `attachController` | `(name: string): () => void`（无控制器服务该 owner 时 `start` 拒绝） | :145 |

核心词汇（dsh-jobs/lib/types/types.d.ts）：`JobSpec { kind; label; owner?: SessionId; toolCall?; outputLimitBytes?; output?: readonly JobOutputSource[]; run(job: JobHandle): JobHooks }`（:166-200）；`JobHandle { id; append(text, {channel?,gapBefore?}); updateProgress(line) }` 全同步（:128-144）；`JobHooks { cancel(reason?); done: Promise<JobOutcome> }`（:146-159）；`JobOutcome { status:'completed'|'killed'|'failed'; detail?; result? }`（:62-77）；`JobSourceRead { text; nextOffset; lossy; spillPath? }`（:79-92）；Session 事件 `job/registered`（JobRegisteredData）/`job/settled`（JobSettledData，多 finishedAt/status/cause/producerReported/detail）均 log-only（:47-60）；`JobEventFilter = {owner} | {owners:'all'|'scope'}`（types.d.ts:269-273）。

### 组2 tools 运行时（§6.2、§5.5）——补全

`dsh-tools/lib/types/index.d.ts`（852 行）：

- `ToolRuntime extends Service`（:527），公有面：`presentAs(mode)`（:610）、`register(definition: ToolDefinition): () => void`（:637）、`restrict(filter: ToolRestriction)`（:645）、`guard(guard: ToolGuard)`（:656）、`get(name, scope?): ToolDefinition \| undefined`（:691）、`schemas(scope?)`（:712）、`executionMode(exec): ToolExecutionMode`（:724）、`execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>`（:766）。
- `ToolDefinition extends ToolSchema`：**必填** `output: ToolOutputDefinition`（schema+render+presentationMeta?，:106-113）、`execute(args, exec: ToolRunContext): Promise<unknown>`（只返回 canonical 值，:128）、可选 `projectContent?/finalizeContent?/timeoutMs?/isConcurrencySafe?/presentCall?/presentResult?`（:138-190）。
- `defineTool<const S, const O>(options: DefineToolOptions<S,O>): ToolDefinition`（schema.d.ts:248）；options = `{name, description, parameters: S, output:{schema,render,presentationMeta?}, deferLoading?, timeoutMs?, …}`（schema.d.ts:178 起）。
- **`ObjectJsonSchema`（原外部假设，现实证）** = `JsonSchemaNode & { type: 'object' }`（json-schema.d.ts:51-53）；`JsonSchemaNode` 是**强制子集**：`type?/oneOf?/properties?/required?/additionalProperties?/items?/enum?/const?/description?/title?/default?/examples?`，越界关键字拒绝（:24-49）；伴 `assertSupportedJsonSchema/assertObjectJsonSchema/validateJsonSchemaValue/JsonSchemaError`（:58-105）。
- Config `{ mode?: 'native'|'ptc'; maxParallelSubCalls? }`（:483-503）。§5.5 两个 PTC 派发事件 re-export 于 index.d.ts:26，实证一致。

### 组3 subagent manager 内部（§6.3）——实证一致 + 修正

`dsh-subagent/lib/types/manager.d.ts`（246 行）`SubagentManager` 公有面：`interrupt(targetSessionId, authority)`（:57）、`drain()`（:63）、`waitForChildren(parent)`（:69）、`drainDescendants(parents)`（:74）、`drainChildren(parent, childIds)`（:80）、`startLocal(spec): Promise<SubagentActivation & {messageId}>`（:88，**实证**）、`startExternal(spec): Promise<SubagentActivation>`（:96）、`sendMessage(sender,targetId,content,options)`（:109）、`queuePrompt/steerPrompt`（:119/:129）。**修正**：`materialize` 是 **private**（:174），不是公有 API；创建-发布路径经 `materializeTracked`（private，:194）。`SUBAGENT_DESCRIPTOR_VERSION = 3` 实证（descriptor.d.ts:44）。

### 组4 sandbox escalation/roots/diagnostics + session-mode（§6.4）——补全（re-export 名单实证一致）

- escalation.d.ts：除 §2 列的 `ESCALATION_TARGETS/approveEscalation` 外，公有面还有 `WIDER_MODES`（:25）、`validateEscalationArgs(sandboxPermissions?, justification?)`（:43）、`sandboxDenialMarker(mode)`（:52）、`escalationHintMarker(subject)`（:62）、`sandboxPermissionsDescription(subject)`（:70）。`EscalationOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`（:76）；`EscalationRequest { requestedMode: string; justification; effectiveMode: SandboxMode; subject }`（:122-130）；`approveEscalation<A,C>(request, approval): Promise<SandboxMode>`（:142，泛型双参，与 §2 反推的单参构造形状不同——**修正**：approveEscalation 是自由函数、泛型 approval 参数，非类方法）。
- roots.d.ts：`canonicalPath(path: string): string`（:26）、`writableRoots(policy: SandboxExecutionPolicy): string[]`（:36）。
- diagnostics.d.ts：`isRunnerSpawnFailure(error, runnerProgram, workdir)`（:16）、`classifyRunnerFailure(exitCode, stderr, rules): RunnerFailureMatch \| undefined`（:32）、`matchesSignature(exitCode, stderr, signatures)`（:40）。
- sandbox-policy/session-mode.d.ts：事件 `SessionEventMap['sandbox/mode'] = { mode: SandboxMode; source?: 'delegation' }`（log-only，非 surface 事件）；`SANDBOX_MODES: readonly SandboxMode[]`；`setSandboxMode(session: Session, mode: SandboxMode): void`——「THE write path」，切换即一条事件，无带外状态。

### 组5 ptc-runtime-node 后端（§6.5）——补全 + 修正（文件数）

**修正**：真实包 `lib/types/*.d.ts` 共 **18** 个文件（非 §6.5 所记 10；本轮 `ls | wc -l` 实测），多出 persistent*/output*/json-wire/policy-processes/process* 簇。

公有面（index.d.ts）：`NodePtcRuntime extends PtcRuntime`（:9），`readonly language = "typescript"`（:12）、`readonly isolation = "process"`（:13）、`get sandboxMode(): SandboxMode \| undefined`、`release(owner)`、`get timeout(): {defaultMs; maxMs}`、`resolve`/`run` 与 §1.1 抽象签名一致（:24-31 区段）——**§1 反推的基类契约实证成立**。`Config`（config.d.ts）：`launch?`、`executionMode?: 'per-call' | 'persistent-in-memory'`、`timeoutMs?/maxTimeoutMs?/maxOutputBytes?/maxOldGenerationSizeMb?/maxMessageBytes?/maxPendingCalls?/graceMs?`（全可选）。`LaunchConfig = {kind:'node-script'; executable; bootstrapPath?} | {kind:'embedded'; executable}`（launch.d.ts:4-15）。

### 组6 SubagentRuntime 公有面补遗（§5.1）——修正（重要）

真实 `dsh-subagent/lib/types/index.d.ts:105` `SubagentRuntime extends TypertRemoteService`（基类实证，见组7）。§5.1 表只列 `resolveMaxDepth/startActivation`，**漏列**的公有成员（index.d.ts:135-298 区段逐条实证）：

| 成员 | 形状 | 行号段 |
|---|---|---|
| `interrupt(targetSessionId, authority)` | `void`，UNAUTHORIZED 抛错 | :197 |
| `drainDescendants(parents: readonly Agent[])` | `Promise<void>` | :211 |
| `drainChildren(parent, childIds)` | `Promise<void>` | :222 |
| `listChildren(parentSessionId, signal?)` | `Promise<SubagentCatalogEntry[]>`（不加载/恢复 Agent） | :231 |
| `listDescendants(rootSessionId, signal?)` | `Promise<SubagentDescendantListEntry[]>`（pre-order） | :247 |
| `prompt(request: SubagentPromptRequest, signal)` | `Promise<SubagentPromptReceipt>` | :269 |
| `interruptByParent(childSessionId, parentSessionId, mode:'continuable')` | `SubagentInterruptReceipt` | :286 |
| `registerProvider(provider): () => void` | effect-scoped，缺执行方法抛 UNSUPPORTED_CAPABILITY | :288-293 |
| `getProvider(name): SubagentProvider \| undefined` | | :294-298 |
| `list(): string[]` | 注册名插入序 | :299-303 |

（与 gap-audit §7 #3 报告的 `getProvider` 存在性一致；私有 `prepareContinuable/expectProvider/requireManager` 等不外露。）

### 组7 跨包品牌/假设类型（§6.6、§0）——补全（全部定义体已取证）

| 类型 | 真实定义 | 出处 |
|---|---|---|
| `AgentOptions` | `{ provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }`——**分字段，无 `"provider/model"` 复合串语义**（与 notes §7 ④ 的结论一致） | dsh-agent/lib/types/runtime-types.d.ts:21-32 |
| `resolveChildAgentOptions` | `(parent: Agent, requested: AgentOptions \| undefined, childDepth: number): AgentOptions`（child-agent.d.ts:50，经 index.d.ts:53 re-export） | dsh-subagent/lib/types/child-agent.d.ts:50 |
| `ContentBlock` | `ContentBlockMap[ContentBlockType]`，map 七键 `text/reasoning/image/file/tool-call/tool-addition/tool-removal`，merge-extensible | dsh-llm/lib/types/types.d.ts:114-126 |
| `Session` | `class Session`：`header: SessionHeader`（cwd/lineage/格式版本，深冻结）、`get id(): SessionId`、`get surface(): SessionSurface`、seq 偏移族 | dsh-session/lib/types/index.d.ts:135 起 |
| `Volatile<T>` | `{ get(): VolatileSnapshot<T> }`（稳定引用取不可变快照；cordis 自 cosmokit re-export，cordis/lib/types/index.d.ts:16） | cosmokit/lib/types/volatile.d.ts:3-10 |
| `TypertRemoteService<T>` | `abstract extends Service<T>`，`readonly typertRemote: TypertGatewayBinding<this>`，protected 构造 `(ctx, serviceKey, options?)`；伴 `Remote()/RemoteScope()` 方法装饰器 | dsh-typert-protocol/lib/types/index.d.ts:105-117 |
| `ObjectJsonSchema` | 见组2 | dsh-tools/lib/types/json-schema.d.ts:51-53 |

### 组判语汇总

| # | 组 | 判语 |
|---|---|---|
| 1 | jobs | **补全**（原「无源码」；现 JobRegistry 10 抽象成员 + 全词汇实证） |
| 2 | tools 运行时 | **补全**（ToolRuntime 8 公有方法 + ToolDefinition + ObjectJsonSchema 定义体实证） |
| 3 | subagent manager | **实证一致**（startLocal 等）；修正：materialize 为 private、descriptor version=3 证实 |
| 4 | sandbox 内部模块 | **补全**；修正：approveEscalation 为泛型自由函数非类方法 |
| 5 | ptc-runtime-node | **补全 + 修正**（类型文件实测 18 个而非 §6.5 所记 10；NodePtcRuntime 面与 §1 契约一致） |
| 6 | SubagentRuntime 公有面 | **修正**（公有成员远多于 §5.1 所列，含 registerProvider/getProvider/list/interrupt/prompt/listChildren/listDescendants 等 10 项） |
| 7 | 品牌类型 | **补全**（七个外部假设全部取得定义体；AgentOptions 分字段证实） |

**recap**：7 组反推接口真机回填完成，jobs/tools/品牌类型由反推转实证。
