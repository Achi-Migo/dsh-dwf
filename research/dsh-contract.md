# DSH 官方工作流三包 · 契约取证

> 取证范围：`E:\os\.dsh-src\` 下全部 22 个文件（workflow-seam\ 3 个 .ts、workflow-ptc\ 10 个 .ts、tool-workflow\ 3 个 .ts，三份 package.json，一份 tsdown 配置，两份 docs）。全部逐行读完，以下每条结论标注来源文件与行号。包版本统一为 `0.2.1-rc.3`（三份 package.json 的 `version` 字段：tool-workflow_package.json:4、workflow-ptc_package.json:4、workflow_package.json:4）。

包名对照（本报告行号以镜像文件名为准）：
- `@deepseek-ai/dsh-workflow` = **workflow-seam**（seam 包，`ctx.workflowEngine` + 词汇表 + 事件）
- `@deepseek-ai/dsh-workflow-ptc` = **workflow-ptc**（PTC 引擎实现）
- `@deepseek-ai/dsh-tool-workflow` = **tool-workflow**（模型侧工具）

---

## 1) 插件 package.json / manifest 结构

### 1.1 三份清单的共同骨架

三份 package.json 结构完全同构（tool-workflow_package.json:1-67、workflow-ptc_package.json:1-77、workflow_package.json:1-49）：

| 字段 | 值/说明 | 来源 |
|---|---|---|
| `name` | `@deepseek-ai/dsh-*` 域内包名 | tool-workflow_package.json:2 |
| `description` | 一句话职责（workflow 包："Workflow capability seam: ctx.workflowEngine service, run vocabulary, and workflow/* events"，workflow_package.json:3） | workflow_package.json:3 |
| `type` | `"module"`（全部 ESM） | workflow_package.json:13 |
| `main` / `types` | `lib/index.js` / `lib/types/index.d.ts` | workflow_package.json:14-15 |
| `exports` | 见 1.2 | tool-workflow_package.json:16-28 |
| `files` | 发布白名单（lib 产物 + `locale/*.json`） | tool-workflow_package.json:29-34 |
| `license` | `MIT` | tool-workflow_package.json:35 |
| `peerDependencies` | 同仓 workspace 包，`workspace:*`（硬依赖）或 `workspace:~`（宽松，多为 cordis/schemastery） | tool-workflow_package.json:36-45 |
| `dependencies` | 仅极少数运行时依赖（如 tool-workflow 只依赖 `@deepseek-ai/schemastery`） | tool-workflow_package.json:46-48 |

### 1.2 exports 与"bundle 声明"

- 标准出口四件套（tool-workflow_package.json:16-28，workflow-ptc_package.json:16-24，workflow_package.json:16-27）：
  - `"."` → `lib/index.js`（运行时入口）+ `lib/types/index.d.ts`（类型）；
  - `"./types"` → 词汇表/类型子入口（仅 workflow-seam 与 tool-workflow 有）；
  - `"./src/*"` → 源码直出（`"./src/*": "./src/*"`），即**发布产物里带未打包源码**；
  - `"./package.json"`、（tool-workflow / workflow-ptc 另有）`"./locale/*.json"`。
- 没有名为 `bundle` 的 manifest 字段。构建产物声明方式是：`files` 白名单（如 workflow-ptc_package.json:25-29 只发布 `locale/*.json`、`lib/index.js`、`lib/types/**/*.d.ts`）+ 构建 config。本镜像里唯一的构建配置是 `workflow-ptc_tsdown.config.ts:3-12`：`entry: ['lib/types/index.js']`、`format: ['esm']`、`platform: 'node'`、`target: 'es2024'`、`dts: false`——即先由常规编译产出 `lib/`，tsdown 只做一次 ESM 再打包。
- 各包零散依赖极少：tool-workflow 直接依赖仅 `@deepseek-ai/schemastery`（tool-workflow_package.json:46-48）；workflow-ptc 直接依赖 `dsh-brand`、`dsh-util-values`、`schemastery`（workflow-ptc_package.json:44-48）。其余全是 peerDependencies（引擎实现按 cordis 服务注入取依赖，不走 import 硬绑定）。

### 1.3 engines 区间

**三份 package.json 均未声明 `engines` 字段**（三份文件全文通读，无此键）。唯一的运行环境约束以代码形式存在：workflow-ptc 构造器校验 `ctx.ptcRuntime.language !== 'typescript'` 即抛错（workflow-ptc/index.ts:118）；tsdown `target: 'es2024'`（workflow-ptc_tsdown.config.ts:8）是唯一可考的 ES 版本区间信号。若插件要写 engines，本镜像没有官方先例可抄。

### 1.4 config 字段怎么暴露（不在 package.json，而在插件代码里）

DSH 的插件 config 暴露模式是 **TypeScript interface + schemastery schema + 框架注入**，双形态：

1. **工具插件（apply 形态）**：导出 `interface Config` + 同名 `export const Config: z<Config> = z.object({...})`（schemastery，非 zod），每个字段带 `.default(...)`（tool-workflow/index.ts:44-63）。框架先跑 schema 填默认值，再把**已解析完的 config** 传进 `apply(ctx, config)`；apply 里用 `config as ResolvedConfig` 断言并注明"schemastery 已填好默认值，断言只是记录这一事实，不是隐藏兜底"（tool-workflow/index.ts:318-321）。
2. **服务插件（class 形态）**：引擎类上挂 `static Config: z<Config> = z.object({...})`，字段全 `.default()`（workflow-ptc/index.ts:106-112），构造器同样断言已解析（workflow-ptc/index.ts:116-122）。

Config 字段实例：
- tool-workflow：`toolName`（默认 `'workflow'`）、`maxResultChars`（默认 50000）、`enableRunInBackground`（默认 true，关闭时连 `run_in_background` 参数都不进 schema，tool-workflow/index.ts:371-376）（tool-workflow/index.ts:44-63）。
- workflow-ptc：`provider`（默认 `'spawn'`）、`maxConcurrentAgents`（0=自动 `min(16, max(1, cores-2))`）、`maxTotalAgents`（1000）、`maxItemsPerCall`（4096）、`syncTimeoutMs`（5000）（workflow-ptc/index.ts:33-44）。

---

## 2) `ctx.workflowEngine` seam 的精确类型

### 2.1 Context 挂载与 Service Definition

seam 包用 cordis 模块扩充把服务写进 Context（workflow-seam/index.ts:31-34）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { workflowEngine: WorkflowEngine }
}
```

`WorkflowEngine` 是抽象 Service，构造时以 `'workflowEngine'` 名注册（workflow-seam/index.ts:157-160），契约：非法请求在**发布前同步抛**；活 run 归持有者所有、`result` 永不 reject；dispose 等脚本与子代理静默（workflow-seam/index.ts:151-156）。公开面只有两个方法：

- `abstract start(request: WorkflowStartRequest): WorkflowRun`（workflow-seam/index.ts:168）
- `protected emitWorkflowEvent(name, ...args)`：逐监听器容错派发，监听器抛错/拒绝只 `logger.warn` 不传播（workflow-seam/index.ts:175-186）

### 2.2 WorkflowStartRequest 字段（workflow-seam/runtime-types.ts:19-34）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `script` | `string` | ✅ | 纯 JS 脚本体（允许顶层 await，以 `return <json-value>` 结尾） |
| `meta` | `WorkflowMeta` | ✅ | 身份块，纯 JSON 数据，引擎先校验 |
| `args` | `unknown` | ❌ | 原样暴露给脚本的 `args` 全局 |
| `subagentProvider` | `string` | ❌ | 本次 run 的子代理 provider 覆盖 |
| `maxTotalAgents` | `number` | ❌ | 本次 run 的子代理总量上限 |
| `parent` | `Agent` | ✅ | 发起 run 的 Agent，脚本每个子代理都归它 |
| `signal` | `AbortSignal` | ❌ | abort 即取消 run |

`meta` 的形状 `WorkflowMeta`（workflow-seam/types.ts:46-55）：`name`（必，kebab-case）、`description`（必）、`whenToUse?`、`phases?: WorkflowPhase[]`；`WorkflowPhase = { title, detail?, provider?, model? }`（types.ts:28-37）。文档明确 phases 只是进度词汇，无执行结构（docs-subsystems_workflow.md:41）。

### 2.3 WorkflowRun 句柄（workflow-seam/runtime-types.ts:40-49）

```ts
interface WorkflowRun {
  readonly id: WorkflowRunId          // Branded<'WorkflowRunId'>（types.ts:13）
  readonly meta: WorkflowMeta          // 脚本体执行前即已校验
  readonly result: Promise<WorkflowResult>   // 永不 reject
  cancel(reason?: string): void        // 取消 run 及其子代理
  dispose(): Promise<void>             // 按需取消并等待脚本+子代理清理；幂等
}
```

`WorkflowResult`（workflow-seam/types.ts:72-87）：`value: unknown`（脚本物化返回值，纯宿主 JSON，无 return 时 `null`）、`stopReason: 'completed' | 'cancelled' | 'error'`（封闭联合，types.ts:63）、`error?: string`（仅非 completed 时）、`agentsStarted: number`（全程被接受的 `agent()` 调用数；终止路径退化为宿主侧计数）。

### 2.4 workflow/* 事件 payload（workflow-seam/index.ts:36-90）

六个 emit 事件，全部 observe-only，**第一个参数永远是 `WorkflowRunInfo`（id + meta 快照，绝不给活 run，订阅者拿不到 cancel/dispose）**（types.ts:89-95；docs-subsystems_workflow.md:120）：

| 事件 | 签名 | 行号 |
|---|---|---|
| `workflow/start` | `(info: WorkflowRunInfo)` | index.ts:43 |
| `workflow/phase` | `(info, title: string)` | index.ts:51 |
| `workflow/log` | `(info, message: string)` | index.ts:58 |
| `workflow/agent-start` | `(info, agent: WorkflowAgentInfo)` | index.ts:68 |
| `workflow/agent-end` | `(info, agent: WorkflowAgentEndInfo)`，按 `agent.seq` 配对、每条 stop 路径恰好一次（终止路径由引擎合成 outcome `'cancelled'`） | index.ts:79 |
| `workflow/end` | `(info, result: WorkflowResultInfo)`，**刻意不含 value**（防止监听者拿到调用方结果值的可变别名） | index.ts:89 |

payload 结构：
- `WorkflowAgentInfo`：`seq`（run 内 1 起序号）、`label`、`phase?`、`childId: SessionId`（types.ts:98-107）
- `WorkflowAgentEndInfo`：上述 + `outcome: 'completed' | 'failed' | 'cancelled'`（types.ts:110-116）
- `WorkflowResultInfo`：`WorkflowResult` 去掉 `value`（types.ts:124-131）

错误词汇：`WorkflowEventName` 六值联合（index.ts:94-100）；`WorkflowErrorCode` 11 个机器可路由码（index.ts:108-119）；`WorkflowError extends HarnessError` 携带 `fatal` 标志（默认 true），`parallel()/pipeline()` 对 fatal 错误重抛而非把该项折成 `null`（index.ts:130-139）；`isFatalWorkflowError` 用宿主侧 `instanceof` 判定，脚本 realm 内无法伪造（index.ts:146-148）。

---

## 3) 官方 tool-workflow 的模型侧工具注册模式

### 3.1 插件形态与注入

```ts
export const name = 'tool-workflow'
export const inject = ['tools', 'workflowEngine', 'systemPrompt']
export function apply(ctx: Context, config: Config): void { ... }
```
（tool-workflow/index.ts:40-41、318）——注入声明即拿到 `ctx.tools` / `ctx.workflowEngine` / `ctx.systemPrompt` 三个服务句柄。工具内部还通过 `declare module '@deepseek-ai/dsh-jobs'` 给 `JobKindMap` 增补 `'workflow'` kind（tool-workflow/index.ts:34-38）。

### 3.2 参数 schema（是 schemastery 风格 DSL，不是 zod）

工具参数用 `defineTool` 的 `parameters` **JSON-Schema 风格对象 DSL**（逐参数 `{ type, required, description, properties }`），不是 zod；z 一词只出现在插件级 Config 上且实为 `@deepseek-ai/schemastery`（tool-workflow/index.ts:16、59-63）。**若上游只有 zod，本文件的参数 DSL 可直接平移**（两者都是 JSON Schema 子集）。参数表（tool-workflow/index.ts:334-377）：

- `script`（string，必）：纯 JS 体、无 `export const meta`、顶层 await 允许、以 `return <value>` 结尾；
- `meta`（object，必，`additionalProperties: true`）：`name`/`description` 必填，`whenToUse?`，`phases[]`（`title` 必填 + `detail?/provider?/model?`）——与 seam 的 `WorkflowMeta` 同词汇；
- `args`（object，可选）：`{"files": [...]}` 这类包装建议写进 description；
- `run_in_background`（boolean，可选）：仅当 `enableRunInBackground` 为真才拼进 schema（:371-376）。

输出 schema 是 `oneOf` 判别联合：`{kind:'background', jobId, runId}` 或 `{kind:'foreground', runId, agentsStarted, result:<json>}`，配 `output.render(args, value)` 返回模型可见文本（背景分支给 jobId 提示，前景分支走 `renderResult`——meta 名 + agent 数 + 50000 字符封顶的 JSON 缩进文本，:378-407、239-246）。

### 3.3 execute 生命周期（tool-workflow/index.ts:409-483）

前台路径（:436-482）：
1. 校验 `exec.agent` 存在（无父 Agent 直接抛，不给子代理归属留猜测空间，:410-416）；
2. `ctx.workflowEngine.start({ script, meta, args?, parent, signal: exec.signal })`——META_INVALID/SCRIPT_PARSE 在这里同步抛出，注册层转 isError 结果，模型看到违规清单可自我纠正（:436-442）；
3. `recorder.start(parent.session, run)` 持久化 run-start（仅顶层调用，嵌套 transport 调用 `exec.parent !== undefined` 不记录，:443-445）；
4. 把 `exec.signal` 的 abort 桥接到 `run.cancel('parent step aborted')`（引擎虽也接 signal，本地桥保证工具契约独立成立，:447-451）;
5. `await run.result` → `stopReasonError(result)` 非 completed 即 throw（注册层转 isError，只报原因不报半成品输出，:453-461、197-210）；
6. `finally`：摘掉监听、`await run.dispose()`、`recorder.finish/abandon`（:468-482）。

后台路径（:417-430 → `startBackgroundRun` :263-316）：
- `ctx.get('jobs')` 缺席时抛出并点名缺的包（:271-274）；
- `jobs.start({ kind:'workflow', label: meta.name, owner: parent.id, toolCall, run })`，**引擎 start 放在 job starter 内部执行**——同步拒绝（META_INVALID/SCRIPT_PARSE）会传出 starter，注册表什么都没登记，模型看到普通工具错误（:281-290）；
- starter 返回 `{ cancel: reason => run.cancel(...), done }`：done 在 `run.result` 结算后先 `run.dispose()`（dispose 失败只 warn，done 永不 reject）、停镜像、落 recorder，再把 `WorkflowResult` 经 `jobOutcomeOf` 映射到 JobOutcome（completed→result 渲染文本；cancelled→killed；error→failed+detail，:293-313、219-236）；
- 立即返回 `{ kind:'background', jobId, runId }`（:315）。

### 3.4 系统提示词段

用法指引作为工具自己的 prompt section 注册，**不放部署 persona**（:325-330）：

```ts
ctx.systemPrompt.section({
  name: `tool:${toolName}`,
  order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
  text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: ...`,
})
```

order 从保留键 `TOOL_WORKFLOW` 查询而非写死数字。工具 description（DESCRIPTION 常量，:158-166）才是脚本契约的完整文档：`agent/pipeline/parallel/phase/log/args` 钩子语义、schema 子集（仅 type/properties/required/additionalProperties/items/enum/const/oneOf）、"误用钩子整脚本终止而非 null"、"脚本无文件系统/网络/定时器/Node API"。

### 3.5 后台任务的观察面：recorder 与 mirror

- **Recorder**（session 持久记录，:93-151）：把引擎事件投影成父 Session 的四个 `tool-workflow/*` 日志事件（types.ts:41-64 的 `SessionEventMap` 模块扩充）；任何一次 append 失败即永久禁用该 run 的后续记录（日志只能是合法前缀），记录故障绝不影响工具执行（:106-113）。
- **Mirror**（record.ts:37-64）：后台 run 时把 `workflow/phase|log|agent-start|agent-end` 流进持有 job 的输出环（`job.append(..., {channel:'log'})` + `job.updateProgress(title)`），纯观察叙述，`job_output` 不渲染；run 结算后 `stop()` 摘除。

### 3.6 哪些代码可整段借用

- `tool-workflow/index.ts` 的 `apply()` 全体（:318-487）——参数 DSL、output oneOf schema、render、双路径 execute、prompt section，是"一个会产出后台任务的工具"的完整模板；
- `DESCRIPTION`（:158-166）、`stopReasonError`（:197-210）、`renderResult`（:239-246）、`jobOutcomeOf`（:219-236）、`startBackgroundRun`（:263-316）可原样搬；
- `record.ts` 整文件（64 行）与 `types.ts` 的 SessionEventMap 扩充（types.ts:41-64）可整段借用，只需替换事件类型定义；
- 前提替换面：`@deepseek-ai/dsh-tools` 的 `defineTool`、`ctx.systemPrompt.section/getSectionOrder`、`ctx.jobs.start` 这三个平台 API 需在上游有等价物。

---

## 4) workflow-ptc 如何把引擎挂上 seam

### 4.1 host / guest / PTC 三方分工

**Host（主进程侧，`host.ts` + `index.ts`）——拥有取消、子代理生命周期、事件发布：**

- `PtcWorkflowEngine extends WorkflowEngine`，`static inject = ['subagents','ptcRuntime','sandboxPolicy','workingDirectory']`（workflow-ptc/index.ts:103-104）。挂上 seam 的方式就是**继承抽象 Service 并实现 start()**，cordis 自动以 `'workflowEngine'` 名发布（基类构造 `super(ctx, 'workflowEngine')`，workflow-seam/index.ts:158-160）。
- `start()` 流水线（workflow-ptc/index.ts:134-189）：`validateMeta`（meta.ts:76-82，纯数据校验、返回归一化副本）→ `assertBodyParses`（宿主侧 `new vm.Script('(async () => {...})()')` **只 parse 不执行**，`lineOffset: -1` 对齐 guest 行号；同时拒绝 `export const meta` 头——meta 只能走 seam 数据字段，index.ts:49-65）→ `resolveSubagentProvider`（provider 必须已在 `ctx.subagents` 注册，index.ts:68-80）→ `resolveMaxTotalAgents`（per-run 上限不得超引擎 ceiling，:83-95）→ 铸 `WorkflowRunId(randomUUID())` → 组 `WorkerInit{meta, body, args: structuredClone, limits}` → `new PtcWorkflowRun(...)` → `emitWorkflowEvent('workflow/start')` → `run.result` 结算时发 `workflow/end`（只带 outcome 数据，:177-186）。
- `PtcWorkflowRun`（host.ts:113-320）实现 seam 的 `WorkflowRun`：宿主函数面 `bindings()` 暴露五个 JSON 回调 `begin / startChild / childResult / disposeChild / progress`（:178-189）；`startChild` 走 `subagents.startActivation({provider, delivery:'caller', signal, request:{cwd, prompt, parent, outputSchema?, agentOptions?}})`（:200-229）；`drive()` 里 `runtime.resolve({program, bindings:[{global:'workflowHost', functions}], cwd, sandboxPolicy, timeoutMs: null, signal})` 后 `runtime.run(...)`（:290-297）；沙箱硬门：`runtime.sandboxMode === undefined && policy.mode !== 'danger-full-access'` 时拒绝执行（:287-289）。清理序（finally，:307-317）：abort controller → dispose 全部已发布子代理 → `Promise.allSettled` 排空 pending → 再 dispose 一轮 → 对仍在 `liveAgents` 的成员合成 `outcome:'cancelled'` 的 agent-end（满足 seam"每条 stop 路径恰好配对一次"契约）。

**Guest（沙箱进程内，`guest.ts` + `runtime.ts` + `realm.ts`，经 `guest-source.ts` 生成的自包含 ESM 字符串以 data: URL 注入，host.ts:26-27）——拥有 VM 钩子、并发限、序列化：**

- `runWorkflowGuest(workflowHost)`（guest.ts:16-75）：`host.begin()` 取 init → 进度批量发送（单飞行批次 + drain，进度错误降级为脚本 error 结果）→ `ChildPort.startAgent` 包 `host.startChild/childResult/disposeChild` → `WorkflowExecution.drive()`。
- `WorkflowExecution`（runtime.ts:56-367）：`vm.createContext` + 注入六个全局 `agent/parallel/pipeline/phase/log/args`（函数全部 `Object.freeze`，:85-99）；`runInContext` 带 `syncTimeoutMs` 只限初始同步切片（:107）；`contain()` 给每个钩子 Promise 挂 no-op reject 消费者，脚本丢弃 promise 不会变成 unhandled rejection 杀进程（:122-125）；`agent()` 实现 FIFO 并发槽 + 总量帽 + `readAgentOptions`（支持集 `label/phase/schema/provider/model`，deferred 集 `effort/isolation/agentType` 显式点名拒绝，:33-35、231-282）；`parallel/pipeline` 中 `isFatalWorkflowError` 重抛、普通错误折 `null`（:285-340）；返回值经 `materializeFromRealm` 物化，违规→`RESULT_UNSERIALIZABLE`（:128-140）。
- `realm.ts` 的物化器（:62-147）只接受纯 JSON：拒绝 bigint/function/symbol/undefined、循环、稀疏数组、非索引数组属性、symbol 键、异型原型；用 `Object.defineProperty` 写副本防 `__proto__` 原型污染（:136-145）。

**PTC（共享沙箱 Node 进程运行时，`dsh-ptc-runtime`）——拥有进程禁闭与取消：** 传输面只过无损 JSON（`json()` 用 `snapshotJsonValue` 校验，host.ts:39-43；types.ts:3 头注）；脚本拿到的全是拷贝，`workflowHost` 绑定函数是脚本与宿主之间的唯一通道（host.ts:290-297）。

### 4.2 边界与安全要点（写插件时必须保留的）

1. **meta 永远是数据**：模型写的 JS 只在禁闭进程里执行，meta 在 body 运行前由宿主校验（meta.ts:1-7 头注；host 侧 `assertBodyParses` 拒绝 meta 语句，index.ts:56-58）。
2. **fatal 不可伪造**：`WorkflowError` 类在宿主/guest 各自 realm 各有一份，fatality 靠 `instanceof` 判定，脚本 realm 造的对象过不了检查（runtime.ts:299-303 注释）。
3. **取消单向向下**：`cancel()` abort controller → PTC 杀进程 → 已发布子代理逐个 dispose；`result` 永不 reject，取消折叠成 `stopReason:'cancelled'`（host.ts:151-166、278-280）。
4. **事件快照不带控制权**：所有事件只发 `WorkflowRunInfo`，`workflow/end` 不带 value（§2.4），recorder/mirror 消费的就是这套事件，与引擎零耦合。

---

## 附：本次取证未做/做不到的事

- 未运行任何构建或测试（本任务是纯源码通读，无测试随镜像提供）。
- `engines` 字段：三份清单均无，如上游仓库其他包有先例，不在本镜像内，无法核实。
- `guest-source.ts` 为生成文件（首行 "Generated by scripts/gen-workflow-guest.ts. Do not edit directly."），其内容与 `runtime.ts/guest.ts/realm.ts` 手写源一致（已对照），生成脚本本身不在镜像内。
- docs 中引用的若干相对路径（如 `dsh-tool-ralph`、`dsh-client-ui-workflow-run`、jobs README）不在本镜像内，未核实。
