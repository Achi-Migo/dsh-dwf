# dsh-dwf 初版设计

把 ZCode 动态工作流（dsh-dynamic-workflow 逆向产物）复现为一个 DeepSeek Harness 插件：实现官方 seam 包 `@deepseek-ai/dsh-workflow` 的 `WorkflowEngine` 抽象服务，上游脚本从「ZCode 的 TS facade + journal 重放」改为跑在同一套语义上。

证据基线（本设计每一条可溯源到以下材料）：
- `research/dsh-contract.md`：`.dsh-src/` 三官方包（v0.2.1-rc.3）逐行取证。
- `research/mechanism-map.md`：逆向文档 + `out/zcode-dwf-assets/` 翻译成的实现清单（must/nice/defer 三档）。
- `assets/facade.d.ts`（290 行）：guest 脚本编译期声明的唯一事实源（逆向原件）。
- `assets/guest-prelude.js`、`assets/guest-channel-future.js`：两个 guest-template 的移植工作稿。
- `assets/journal-schema.sql`：五表 DDL 原文。
- `stubs/dsh-stubs.d.ts` + `stubs/dsh-stubs-shapes.ts`：已转写好的官方类型 stub（初版设计将其合并为 `stubs/dsh.d.ts`，见 §3）。

---

## 1. 包结构与 manifest 字段

### 1.1 插件定位

一个 DSH 插件同时提供三件事（对照 dsh-contract.md §3.1 的官方注入模式）：

1. **服务插件（class 形态，apply 内显式装载）**：`DwfWorkflowEngine extends WorkflowEngine`，`static inject` 与 `static Config` 成对声明（对齐官方 workflow-ptc/index.ts:103-122：config schema 填默认值后传入构造器）。**实例化路径：apply 内 `ctx.plugin(DwfWorkflowEngine, config)` 显式装载**（修复轮 P0-A 回写，2026-10-25：第二参传同一 config——不传则引擎吃 static Config 默认空 dbPath，与工具读侧落两个库；官方 workflow-ptc/index.ts:103-122 同法，R5 接入真实 cordis 时校），cordis 按 `'workflowEngine'` 名发布。镜像内没有证据表明宿主会从 apply 形态模块里自行扫描并构造 Service 子类（官方 workflow-ptc 是独立 class 形态包，dsh-contract.md:196）；不显式装载则 `ctx.workflowEngine` 不存在、工具 inject 失败，插件启动即挂。
2. **工具插件（apply 形态）**：`apply(ctx, config)` 注册 `CreateWorkflow / GetWorkflowRun / ListWorkflowRuns`（fork 官方 tool-workflow 的 apply 模板，dsh-contract.md §3.6；inject 含 `'workflowEngine'`，见 §3.1）。
3. **journal 持久层**：SQLite 五表 + 22 事件词表（mechanism-map §4）。

一个插件包、一个 apply 入口；apply 的完整职责清单见 §3.1（ctx.plugin 装载 engine + 注册工具 + prompt section）。`ctx.plugin` 的签名在镜像内无 cordis 源码可核对（它是 cordis 的常规装载入口，config 传递行为接入真实包时校），见风险 R5。

### 1.2 manifest 字段（对齐官方骨架，dsh-contract.md §1.1）

```jsonc
{
  "name": "@local/dsh-dwf",
  "description": "Deterministic dynamic-workflow engine: TS-facade compiler, replay journal, guest sandbox, actor subagents, and the dwf workflow tools",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/types/index.d.ts",
  "exports": {
    ".": { "types": "./src/types/index.d.ts", "default": "./src/index.ts" },
    "./types": { "types": "./src/types/index.d.ts", "default": "./src/types/index.d.ts" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["src", "assets", "stubs"],
  "license": "MIT",
  "dependencies": {
    "typescript": "5.9.3"           // 编译层引 npm 全量包，不内嵌（mechanism-map §2.1）；
                                    //   **pin 死 5.9.3**：7.0.2（native preview）的库 API 不可用，
                                    //   实测见 §7.1 前置与 R3
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:*",
    "@deepseek-ai/dsh-workflow": "workspace:*",
    "@deepseek-ai/dsh-agent": "workspace:*",
    "@deepseek-ai/dsh-session": "workspace:*",
    "@deepseek-ai/dsh-subagent": "workspace:*",
    "@deepseek-ai/dsh-tools": "workspace:*",
    "@deepseek-ai/dsh-system-prompt": "workspace:*",     // ctx.systemPrompt（tool-workflow_package.json:42）
    "@deepseek-ai/dsh-jobs": "workspace:*",
    "@deepseek-ai/dsh-llm": "workspace:*",
    "@deepseek-ai/dsh-ptc-runtime": "workspace:*",
    "@deepseek-ai/dsh-sandbox": "workspace:*",           // sandboxPolicy（workflow-ptc_package.json:40-42 三件）
    "@deepseek-ai/dsh-sandbox-policy": "workspace:*",
    "@deepseek-ai/dsh-working-directory": "workspace:*", // workingDirectory
    "@deepseek-ai/schemastery": "workspace:~"
  },
  "devDependencies": {
    "@types/node": "^26.6.5",
    "typescript": "5.9.3"
  }
}
```

> **落地差异（gap-audit §3.14 回写）**：本仓库 package.json 的 peer 以 `*` + `peerDependenciesMeta` 全 optional 落地（单包独立开发，无 monorepo workspace 可解析 `workspace:*`）；上片保持官方骨架字面，接入 dsh monorepo 时二者合流。`exports["."].types` 落地为 `./src/types/index.d.ts`（拍板表#13）。

字段决策与出处：

| 字段 | 决策 | 出处 |
|---|---|---|
| `type: "module"` | 全 ESM | 三官方包一致（workflow_package.json:13） |
| `exports["./types"]` | 保留：对外暴露我们自己的词汇（错误码、caps、journal 事件类型） | tool-workflow_package.json:16-28 |
| `exports["./src/*"]` | 保留官方惯例：发布产物带源码 | dsh-contract.md §1.2 |
| 无 `engines` 字段 | 官方三包均无此字段，不发明 | dsh-contract.md §1.3 |
| `main` 指向 `src/index.ts` | **存疑项**：官方发布物是 `lib/index.js`，但镜像内无插件安装文档可证实宿主加载 TS 还是 JS；MVP 按 dev 直载 TS（脚手架现状），发布形态留待接入真实 dsh 时定 | dsh-contract.md §1.1（只有 lib 形态可考） |
| `typescript` 放 dependencies | 编译层运行时需要；**pin `5.9.3`**——7.0.2 native preview 库 API 实测不可用（§7.1 前置） | mechanism-map §2.1 |

### 1.3 插件 Config（schemastery，dsh-contract.md §1.4 双形态之 class 形态）

```ts
export interface Config {
  toolName: string              // 默认 'workflow'，与官方同名（tool-workflow/index.ts:44-63）
  dbPath: string                // journal SQLite 文件路径，默认 '<plugin-data>/dwf.db'
  maxConcurrency: number        // 默认 4（逆向实例默认值，mechanism-map §5）
  maxTotalAgents: number        // 默认 1000：**引擎级 ceiling**（跨 run 生命周期总量，
                                //   workflow-ptc/index.ts:33-44 同语义；单 run 默认帽 64 由
                                //   CAPS.maxSubagents 承担，不设重复字段——两帽关系见 §3.5）
  maxResultChars: number        // 默认 50000：renderResult 封顶（tool-workflow/index.ts:44-63 同名同默认）
  enableRunInBackground: boolean // 默认 true；false 时工具 schema 里连 run_in_background 都不出现
                                // （照抄官方门控，tool-workflow/index.ts:371-376）
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  dbPath: z.string().default(''),
  maxConcurrency: z.natural().default(4),
  maxTotalAgents: z.natural().default(1000),
  maxResultChars: z.natural().default(50000),
  enableRunInBackground: z.boolean().default(true),
})
```

schemastery 在 apply 前填好默认值；engine 构造器内断言 `config as ResolvedConfig`（记录事实，非兜底）——照抄官方注释语义（dsh-contract.md §1.4）。

---

## 2. 完整文件树

```
dsh-dwf/
├── DESIGN.md                    # 本文件
├── package.json                 # §1.2 manifest
├── tsconfig.json                # §7 验证计划用：strict、module nodenext、noEmit
│
├── stubs/
│   └── dsh.d.ts                 # 官方包 ambient 类型桩（合并现有 dsh-stubs.d.ts +
│                                #   dsh-stubs-shapes.ts 为单文件；纯 declare module，
│                                #   无实现体）。真实 dsh 环境下从 tsconfig include 移除
│
├── assets/                      # 逆向原件，构建/测试期只读
│   ├── facade.d.ts              # guest 编译期声明（290 行，唯一事实源）
│   ├── guest-prelude.js         # guest 前导：三通道 + 原语 + 停滞检测（guest-template-00 移植稿）
│   ├── guest-channel-future.js  # channel/future 环形缓冲 + waiter 队列（guest-template-01 移植稿）
│   └── journal-schema.sql       # 五表 DDL 原文（schema.ts 按 MVP 子集建表）
│
└── src/
    ├── index.ts                 # apply() 入口：注册工具、发 prompt section、挂 engine 服务
    ├── types/
    │   └── index.d.ts           # 对外词汇：DwfErrorCode、Caps、JournalEventName
    │
    ├── compile/                 # ── 层2：TS 编译层（全自写，工程最大增量）──
    │   ├── compiler.ts          # createProgram(facade.d.ts + 用户 interface) → 诊断 + lowering
    │   ├── diagnostics.ts       # 自定义诊断：9012 hole 规则族 + 编译期字面量检查 + agent 名字重复
    │   ├── literals.ts          # phase 名 / artifact id / world.run cmd / agent 名字 必须是 string literal
    │   ├── schema.ts            # ask<T> 的 T（脚本内 interface）→ ObjectJsonSchema：TS checker 类型查询
    │   │                        #   + JSON Schema 化，随 lowering 下沉到 __host.ask
    │   ├── phase-graph.ts       # collectPhaseClaims / projectPhaseGraph（MVP：列表展示）
    │   └── lower.ts             # facade 调用 → __host.* 前导调用；每个效应调用点打 siteId；
    │                            #   model()/channel() 为 guest 本地原语，不参与 lowering
    │
    ├── guest/                   # ── 层3：guest 确定性沙箱（移植两个 guest-template）──
    │   ├── protocol.ts          # 通道消息类型：init / request{ask|world-read|world-run|hole|
    │   │                        #   publish-artifact|report} / event{log|phase-entered|
    │   │                        #   declare-artifact|declare-actor} / complete
    │   ├── prelude.ts           # guest 前导 shim：__pending Map、FIFO 承重语义、停滞检测
    │   │                        #   （__checkStalled / ChannelDeadlock / ScriptStalled）
    │   ├── channels.ts          # Channel<T>/future：环形缓冲 + waiter 队列 + compact
    │   └── realm.ts             # Date.now / argless new Date / Math.random 禁令；
    │                            #   args 经 JSON.parse 进 context、浅冻结一层
    │
    ├── journal/                 # ── 层4：journal 记账（node:sqlite，五表）──
    │   ├── schema.ts            # 建表：dwf_run/dwf_actor/dwf_node/dwf_event（session_task_link
    │   │                        #   留空表不接线）；DDL 抄 assets/journal-schema.sql
    │   ├── store.ts             # append-only dwf_event；节点记账 (run_id,site_id,ordinal) 唯一
    │   ├── projection.ts        # reducer 投影：Get/List 用，可驱逐可重建
    │   └── caps.ts              # caps 常量：32 phases/64 subagents/2000 nodes/report 65536×1MiB/
    │                            #   artifact 32 id×16 版本×20MiB/world 输出 256KB 拒收不截断
    │
    ├── engine/                  # ── 层5+6：调度 + actor + host 侧 run 生命周期 ──
    │   ├── engine.ts            # DwfWorkflowEngine extends WorkflowEngine：start() 流水线
    │   ├── run.ts               # DwfWorkflowRun implements WorkflowRun：进程、bindings、清理序
    │   ├── scheduler.ts         # maxConcurrency 上限 + pumpAll；重试=固定次数+指数退避；
    │   │                        #   错误永不进脚本（provider 错误折叠为脚本侧等待）
    │   ├── actor.ts             # actor 注册表：persona 建即冻结 {system,model}；同 actor
    │   │                        #   ask FIFO 内存队列；actor→子会话绑定只留接口
    │   ├── effects.ts           # 四类 request 的宿主执行：ask/world-read/world-run/hole
    │   └── artifacts.ts         # report 落 journal + artifact.file/markdown 效应型发布
    │
    ├── tool/                    # ── 层1：模型侧工具面（fork 官方 tool-workflow 模板）──
    │   ├── create.ts            # CreateWorkflow：参数 DSL、oneOf 输出、双路径 execute
    │   ├── description.ts       # 重写的 DESCRIPTION 与 script 参数描述：按本插件 facade 契约
    │   │                        #   （agent(name,persona).ask / channel / world / hole / report /
    │   │                        #   artifact / TS interface）；官方 DESCRIPTION 写的是
    │   │                        #   agent(prompt,opts)+纯 JS，照抄即错，必须重写
    │   ├── get.ts               # GetWorkflowRun：读 journal 投影
    │   ├── list.ts              # ListWorkflowRuns：读 journal 投影
    │   ├── recorder.ts          # 引擎事件 → 父 Session 的 dwf-tool/* 日志事件；含 SessionEventMap
    │   │                        #   的 declare module 扩充（对齐 tool-workflow/types.ts:41-64）
    │   │                        #   ← fork 配套件落点，照树开工不再缺件
    │   ├── mirror.ts            # 后台 run：phase|log|agent-start|agent-end 流进持有 job 的
    │   │                        #   输出环（官方 record.ts 的对应件）
    │   └── placeholders.ts      # Amend/Resume/Fill/Resolve/Save/ListSaved：占位，报错误码
    │
    └── util/
        ├── errors.ts            # DwfError 词汇（工具层错误码，独立于 seam 的 WorkflowErrorCode）
        ├── fnv1a.ts             # hole 站点 id：FNV-1a(trim 后源文本) → hole#xxxxxxxx
        └── json.ts              # snapshotJsonValue：guest↔host 只过无损 JSON
```

现有脚手架迁移说明：`stubs/dsh-stubs.d.ts` 与 `stubs/dsh-stubs-shapes.ts` 合并为 `stubs/dsh.d.ts`。原因：shapes 是 `.ts`（含 `WorkflowError` 类实现体、`WorkflowRunId` 函数体），与 ambient 桩的定位冲突——桩必须**只含声明**，运行时值从真实官方包 import（见 §5）。

---

## 3. 各模块接口签名与职责

### 3.1 src/index.ts — 插件入口

```ts
export const name = 'dwf'
export const inject = ['tools', 'workflowEngine', 'systemPrompt'] as const   // 官方同序（tool-workflow/index.ts:41）

export function apply(ctx: Context, config: Config): void
```

职责：① `ctx.plugin(DwfWorkflowEngine, config)`——**显式装载 engine 服务**（P0-A 回写：config 随装载传入，§1.1），cordis 构造之并以 `'workflowEngine'` 名发布（class 上的 `static Config` + `static inject` 供框架解析 config 与依赖，§3.5）；镜像内无宿主自动扫描 Service 子类的证据，不装即挂（见 §1.1）；② `ctx.tools.register(...)` 注册 §3.6 的三个真工具 + 占位工具；③ `ctx.systemPrompt.section(...)`（照抄官方段注册，tool-workflow/index.ts:325-330）。inject 里声明 `'workflowEngine'` 是为了让 `ctx.workflowEngine.start` 的就绪顺序由注入保证（与官方 tool-workflow/index.ts:41 一致）。jobs 为可选注入：`ctx.get('jobs')` 缺席时后台路径报错并点名缺的包（照抄官方行为，tool-workflow/index.ts:271-274）。

### 3.2 src/compile — 编译层

```ts
// compiler.ts
export interface CompiledWorkflow {
  body: string                  // lowering 后的脚本体（__host.* 前导 + 用户逻辑）
  phaseNames: string[]          // 编译期抽出的 phase 图（确认对话框用）
  worldCommands: string[]       // world.run 命令名字面量全集（安全模型：随确认展示）
  diagnostics: Diagnostic[]     // 空数组 = 通过
}
export function compileWorkflow(source: string, facade: string): CompiledWorkflow
```

- `createProgram` 把 `assets/facade.d.ts` 全文与用户脚本的 `interface` 声明合成一个 Program（mechanism-map §2.3）。用户体包在函数体内编译 → `declare/export/import` 天然非法。
- 选项：`strict: true`、`noUncheckedIndexedAccess: false`（mechanism-map §2.2）。

```ts
// diagnostics.ts
export function holeDiagnostics(sf: SourceFile): Diagnostic   // 9012 规则族
export function literalDiagnostics(sf: SourceFile): Diagnostic // 字面量检查
export function agentNameDiagnostics(sf: SourceFile): Diagnostic // agent() 名字字面量重复 → 编译错
```

MVP 做三族：9012（hole 规则）+ 编译期字面量（`phase` 名、`artifact` id、`world.run` cmd、`agent` 名字必须是 string literal——facade.d.ts 注释明言，agent 名字重复是编译错、facade.d.ts:37-38）+ agent 名字字面量重复检查。9001/9011 defer。

```ts
// schema.ts —— ask<T> 的 schema 下沉
// T 是用户脚本里用普通 interface 声明的类型（facade.d.ts ask 段注释）。
export function askSchemas(checker: TypeChecker, sf: SourceFile): Map<number, ObjectJsonSchema>
// 返回 siteId → ObjectJsonSchema：对每个 ask<T> 调用点用 checker 取 T 的声明类型，
// 递归把 interface/基本类型/数组/联合(字面量)转成 JSON Schema 对象；T 缺省（=string）时
// 不入表，答案为子代理最终回复文本。schema 以字面量形式嵌入 lowering 产物。
```

```ts
// lower.ts
export function lower(source: string, phaseNames: readonly string[], askSchemas: Map<number, ObjectJsonSchema>): string
```

lowering：facade 调用点 → `__host.<op>(siteId, ...)` 前导调用；**siteId = 调用点序号**（journal 的 `(run_id, site_id, ordinal)` 之上，hole 站点单独用内容寻址，见 util/fnv1a.ts；mechanism-map §2.7：hole id = `FNV-1a(trim 后源文本) → hole#xxxxxxxx`，跨修订稳定）。特别映射：`ask<T>(instr)` → `__host.ask(siteId, instr, <schema 字面量>)`（schema 来自 schema.ts，缺 T 则第三参省略）。**`model(id)` 不参与 lowering**：它是纯数据工厂，由 guest 前导直接提供实现（返回 `{ modelRef: id }` 形状的 ModelRef），不产生宿主往返、无效应节点、故无 siteId——facade.d.ts 注释「String literal only (**checked at launch**)」指模型可用性校验发生在 launch 时：persona 里的 model id 随 `agent()` 的 `declare-actor` 事件 / `ask` 请求 payload 到宿主，由 actor 层经 `subagents.startActivation` 的 `request.agentOptions.model` 下发、由 provider 侧按能力校验（**R2 定稿回写**：不做 provider 注册表前置查询，model 校验统一随 startActivation 走——contract-v2 §5.2 `SubagentStartRequest.agentOptions`，subagent/types.ts:169，需 provider `capabilities.agentOptions`，缺能力或模型不可用 → `AGENT_START`；§3.5）。

```ts
// phase-graph.ts
export function collectPhaseClaims(sf: SourceFile): PhaseClaim[]
export function projectPhaseGraph(claims: readonly PhaseClaim[]): PhaseNode[]
```

MVP 降级：phase 图只用于确认展示，画不了图就列表展示（mechanism-map §2.5）。marker 覆盖其后所在 block（词法盖章）。

### 3.3 src/guest — guest 确定性沙箱

```ts
// protocol.ts —— 四绑定（guest-template-01 即协议书 + 官方 guest host.begin() 取 WorkerInit 的
// init 语义，guest.ts:17）。形状按实现定稿（拍板表#7 回写，NDJSON 原形的有意重设计）：
//   · request 以 siteId（string）寻址，对齐 journal 的 (run_id, site_id, ordinal)；
//     原 id/type/payload 改为 op/args，args 已是解析后的 Json——PTC 进程内直传无损 JSON，
//     不再有「JSON 文本 + guest 侧 JSON.parse」这一步（原 GuestInit.args: string 废止）。
//   · begin 承载 meta/args/limits（WorkerInit）；body 字段去掉——program 由
//     ptcRuntime.resolve 提供，不经消息面。
//   · 事件名统一 declare-actor（与 prelude 发射点同名；原件 create-actor 废弃）；
//     GuestComplete 收敛为单形状 { ok, value?, error?: {message, name?} }。
export type GuestOp            = 'ask' | 'world-read' | 'world-run' | 'hole' | 'report' | 'publish-artifact'
export interface GuestRequest  { siteId: string; op: GuestOp; args: Json }
export type GuestEventType     = 'log' | 'phase-entered' | 'declare-artifact' | 'declare-actor'
export interface GuestEvent    { type: GuestEventType; args: Json }
export interface GuestComplete { ok: boolean; value?: Json; error?: { message: string; name?: string } }
export interface WorkerInit    { meta: { name: string; description: string }; args?: Json;
                                 limits: { maxConcurrentAgents: number; maxTotalAgents: number;
                                           maxItemsPerCall: number; syncTimeoutMs: number } }
```

传输映射决策：原版走 stdio NDJSON；本插件 guest 跑在 PTC Node runtime 里，传输面只过无损 JSON（dsh-contract.md §4.1：`json()` 用 `snapshotJsonValue` 校验）。因此四类消息映射为 PTC 绑定函数：

- `init` → `dwfHost.begin(): Promise<WorkerInit>`——guest 启动后第一个调用，对齐官方 `host.begin()` 取 WorkerInit（guest.ts:17）。agent 名字查重双层（拍板表#8 回写）：宿主 run 级注册表为主（`declare-actor` 事件抵达时查重，见 §3.5），guest 侧 `__agentNames` Set 守卫保留作第二道（prelude `agent()` 同名即抛，单进程内先行拦截）。**#7 回写（2026-10-25）**：`declare-actor` 载荷带 `named` 标志（自动 label `"subagent N"` 置 `named:false`、显式名置 `named:true`），宿主只对 `named !== false` 的 label 查重（缺省按显式，旧事件保形）——自动 label 与显式名撞形不再误报 duplicate；`__agentNames` 仍只收显式名。
- `request` → `dwfHost.request(req): Promise<{ok, value|error}>`（异步、保 FIFO）。**`report` 是 request 不是 event**：caps 校验（65536 条/run、1MiB/条、1GiB/run）在宿主侧进行，超限返回 `{ok:false, error}`，guest 收到即 `complete{ok:false}` 结算 run 为 error——对齐官方「progress 错误折叠为脚本 error 结果」（guest.ts:69-74）与 facade.d.ts report 段「caps fail the whole run, not the call」；脚本侧 report() 仍是同步 void 外观：guest 发出 request 后不 await，但在飞计数计入停滞检测，错误回包抵达时终止 run。
- `event` → `dwfHost.event(evt): void`（即发即忘、与 request 共享 FIFO 保序——declare-artifact 与 report 原先共用 FIFO 的承重语义保留，guest-template-01:14-19）。
- `complete` → `dwfHost.complete(result): void`（幂等，`__settled` 守卫）。

```ts
// prelude.ts —— guest 前导（进程内执行的 program 头部）
// 移植 guest-template-00/01：__pending 计数挂 promise。停滞检测 guest 自有（拍板表#7 回写）：
// realm 禁 setImmediate，故不由宿主投递触发——最后一个在飞请求结算后连排两个微任务再查
// __checkStalled，其间任何脚本续体发出新请求都会先重挂 __pending；仍无在飞请求且未结算 →
// 有 channel receiver 停着报 ChannelDeadlock（点名通道与人数），否则 ScriptStalled。
// 停跑永不超时是设计（timeoutMs: null，对齐 workflow-ptc/host.ts:290-297）。
// hole 三重载（facade.d.ts hole 段）：带 body 的 filled 形态在 guest 本地把 body
//   到达现场求值、不发 request；**不按 siteId 缓存 body**（#8 拍板回写，2026-10-25：
//   缓存闭包令循环第二 iteration 绑定首次的 let 绑定——是缺陷非特性，facade 语义是
//   「body 在 hole 的位置原地运行」，是代码不是 memo）；只有未填站点
//   才发 request{hole} 等宿主（MVP 下宿主确定性报 HOLE_UNAVAILABLE，见 §6.2）。
export const GUEST_PRELUDE_SOURCE: string
```

```ts
// channels.ts —— Channel/future 原语（facade.d.ts:270-291 语义注释与模板逐条对上）
// send 同步不等待；close 幂等；无人 close 的 channel 停滞时报 ChannelDeadlock。
```

```ts
// realm.ts —— belt 层禁令（guest-template-01:181-201）
// Date.now / argless new Date / Math.random 运行期抛错；无定时器、无 I/O、无 fs/fetch；
// 唯一唤醒源是宿主 response。args 经 JSON.parse 进 context（context-native），浅冻结一层。
```

### 3.4 src/journal — 记账层

```ts
// schema.ts —— node:sqlite 直接建表（决策见下）
export function initSchema(db: DatabaseSync): void
```

存储决策：**MVP 用 `node:sqlite`（node 22+ 内置 DatabaseSync），不依赖任何 dsh storage 服务**。理由：mechanism-map §4 明言 SQLite 五表「官方明示无对应」；镜像里没有任何 storage 包可证 API 形状，为避免发明接口，journal 直连本地 DB 文件（`config.dbPath`），五表 DDL 抄 `assets/journal-schema.sql`（dwf_run :23 / dwf_actor :52 / dwf_node :70 / dwf_event :99 / session_task_link :2 留空表不接线）。将来 dsh storage 服务形态确认后可整体换底。**P0-A 回写（2026-10-25）**：路径解析收口为 `resolveJournalPath(dbPath)`（engine.ts 导出，apply 的工具读侧与引擎构造器写侧共用——非空原样、空串 `'./dwf.db'` 相对 cwd，单一事实源）；引擎建库后立即 `initSchema`（DDL 全 `if not exists` 幂等，修前引擎侧从未建表、默认配置首 run 即 no such table）。**双连接注记**：落地后同文件两连接（engine 写、tool 读）——MVP 工具读按需查询、写侧单写汇聚于 JS 单线程，冲突窗口可忽略；接入真实宿主若出现锁竞争，届时改 WAL 或收口为单连接（FIX-PLAN §4 既定项，不在本轮扩做）。

```ts
// store.ts —— JournalStore 类；写面统一经 RunWriter（每 run 一个写手）
export class JournalStore {
  writerFor(runId: string): RunWriter             // 每 run 一个写手（见下）；结算时回收该 run 计数器条目
}
export interface RunWriter {                      // 写手绑定到 writerFor 的 runId，方法不再收 runId
  beginRun(run: RunRow): void                     // dwf_run insert + run-started
  appendEvent(event: JournalEvent): void          // dwf_event append-only；sequence 自动分配；
                                                  //   payload_json not null——payload 缺省落 JSON null 文本
  recordNode(node: NodeRecord): { siteId: string; ordinal: number }
                                                  // (run_id, site_id, ordinal) UNIQUE；ordinal 自动分配（per-site 序）
  recordActor(siteId: string, ordinal: number, name: string | undefined, persona: Json | undefined, sessionId?: string): void
                                                  // dwf_actor insert or replace + actor-created
                                                  //   （拍板表#17：收编进 RunWriter 接口，不再是无名附加方法）
  settleRun(outcome: RunOutcome): void            // dwf_run 置 status/result/failure/spent_tokens + run-settled
}
```

**序号分配机制**：`JournalStore` 持有每 run 的内存单调计数器（`sequences: Map<runId, number>` 与 `ordinals: Map<runId␀siteId, number>`），由 `writerFor(runId)` 发放、`settleRun` 结算时丢弃（不跨 run 滞留）。分配是纯同步操作：node:sqlite 为同步 API、写路径全部经 RunWriter 汇聚在 JS 单线程事件循环上，`sequence`（dwf_event UNIQUE(run_id,sequence)，journal-schema.sql:106）与 `ordinal` 的分配与 INSERT 在同一同步块内完成，不存在并发竞争窗口。`dwf_node.ordinal` 是 **per-site 到达序**（拍板表#9 回写）：DDL 原文 `UNIQUE(run_id, site_id, ordinal)` 本就是 per-site 语义——同一 siteId 的每次调用各占一个单调位；跨 site 全序不由 ordinal 承担，由 `dwf_node.id`（autoincrement）承担，投影按它重建全序（projection `order by id`）。

关键约束（DDL 原文，db-schema-dwf.sql:63/89）：`(run_id, site_id, ordinal)` 唯一；`node.kind ∈ ask | world-read | world-run | report | artifact`（:75）；`input_hash` 为将来 amend 缓存的键（:79）——MVP 照常落列（mechanism-map §11「必须现在做对的事」）。事件词表 22 个（event-vocabulary.md 实测分布），MVP 实现其中 run-started/launched/settled、node-queued/dispatched/executing/waiting/settled、actor-created、log、report、phase-entered、artifact-published、artifact-failed（types/index.d.ts 词表保留）；escalation 与 import-cache 族不产事件。

```ts
// projection.ts
export function runProjection(db: DatabaseSync, runId: string): RunView    // GetWorkflowRun
export function listRuns(db: DatabaseSync, limit: number): RunSummary[]    // ListWorkflowRuns
```

事件溯源 + 投影读写分离，MVP 取**直读**形态（拍板表#11 回写）：`dwf_event` 是事实，节点表 `dwf_node` 本身持久——投影直读 dwf_node（节点列表 `order by id`）与「可重建」承诺等价，MVP 不做事件重放 reducer，也不做驱逐预算（`evictForEntryBudget` defer）。`CAPS.maxNodes=2000` 仍由**投影层计数**：`runProjection` 计数节点超过 2000 即停止展开列表并置 `nodesUnlisted: true`（展示帽，不阻断记账——记账事实完整在 dwf_event/dwf_node 里）。**#5 落地回写（2026-10-25）**：实现为节点查询 `limit maxNodes+1` 探测，超帽截到 2000 并置 `RunView.nodesUnlisted: true`、未超帽字段缺省省略（工具面 JSON.stringify 省略 undefined，与 `cwd` 字段同风格）；2001 节点探针实证记账不阻断（nodesTotal=2001、展示=2000、nodesUnlisted=true）、恰帽不置。

```ts
// caps.ts ——（#5 回写，2026-10-25：maxOpLength/maxArgs 已删除——零消费孤儿码，
//   grep 全仓仅定义与类型声明两处、无 facade 出处；maxNodes 落投影执法见上）
export const CAPS = {
  maxPhases: 32, maxPhaseNameLength: 128, maxSubagents: 64, maxNodes: 2000,
  worldStdoutCap: 256 << 10, worldReadCap: 2000,          // 拒收不截断
  grepResultBytes: 256 << 10, gitDiffBytes: 512 << 10, gitLogCommits: 100,
  reportItemsPerRun: 65536, reportItemBytes: 1 << 20, reportTotalBytes: 1 << 30,
  artifactIds: 32, artifactVersions: 16, artifactFileBytes: 20 << 20, artifactMdBytes: 256 << 10,
  artifactTitleChars: 120, artifactDescriptionChars: 500,
} as const
```

### 3.5 src/engine — 引擎宿主侧

```ts
// engine.ts —— seam 挂接点（本插件的核心承诺面）
export class DwfWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents', 'ptcRuntime', 'sandboxPolicy', 'workingDirectory'] as const
  static Config: z<Config> = Config            // 与 static inject 成对（workflow-ptc/index.ts:103-112 同法）；
                                               //   框架解析后把 ResolvedConfig 传入构造器
  constructor(ctx: Context, config: ResolvedConfig)   // 构造器断言 config 已解析（官方 :116-122 同语义）
  start(request: WorkflowStartRequest): WorkflowRun   // 覆写抽象方法
}
```

`start()` 流水线（对齐官方 workflow-ptc/index.ts:134-189 的骨架，替换执行内核）：
1. `validateMeta`（meta 纯数据校验，dsh-contract.md §4.1）→ `META_INVALID`；
2. `compileWorkflow(request.script, facade)`（宿主侧编译，替代官方 `assertBodyParses`；诊断非空 → 同步抛 `SCRIPT_PARSE`，与官方「META_INVALID/SCRIPT_PARSE 在 start 时同步抛」契约一致，dsh-contract.md §3.3）。**编译只发生在这里**：tool 层不预编译，`WorkflowStartRequest.script` 语义即官方词汇「纯 JS 脚本体」（runtime-types.ts:20）——本插件收的是**用户源码**，lowering 产物不出 seam 请求面；
3. `resolveSubagentProvider`；per-run 帽解析：`runCap = min(request.maxTotalAgents ?? CAPS.maxSubagents /*64*/, config.maxTotalAgents /*ceiling 1000*/)`，请求值超 ceiling → `INVALID_ARGUMENT`（对齐 workflow-ptc/index.ts:83-95）；两帽分工：1000 = 引擎生命周期总量，64 = 单 run 默认帽；
4. 铸 `WorkflowRunId`（官方为运行时工厂函数，值导入 `WorkflowRunId(randomUUID())`，§5.1）→ journal.beginRun → `emitWorkflowEvent('workflow/start')`；
5. `new DwfWorkflowRun(...)`：编译产物（lowered body、siteId 表、askSchemas、phaseNames、worldCommands）经构造参数**直接交给 run**，run 内拼装 program = realm 禁令 + channel/future 原语 + prelude + **启动包裹 `return await __start(async () => { lowered body })`**（P0-C 回写，2026-10-25：修前裸拼无人调 `__start`，begin 绑定永不被调、args 恒 `{}`；两种 programFormat 均兼容——function-body 本身是 async 函数体、repl 外层已是 async IIFE）——不经过 seam 字段，tool 与 run.ts 之间无第二条编译连线。**成功路径拍板（P0-C）**：不补 `__complete(true,value)`，成功由 PTC 返回值结算——`__complete(true)` 与 PTC 返回值是双结算通道，`settleFrom` 优先级会令 guest complete 压过 PTC 结果，徒增竞态面；失败半边由 P0-B 接通（body 抛错由 `__start` 的 `.then(undefined,…)` 折成 `__complete(false,…)` → fail 链结算）。⚠ **T6 集成回归新发现（2026-10-25，待裁定）**：成功路径紧随最后一个 request 结算即 return 时（如 `await report(...); return {…}`），prelude 停滞自查因 `__settled` 恒 false 在程序收尾前误报 ScriptStalled → run 以 error 结算——与本拍板（成功不标记 settled）冲突，原版 guest-prelude.js:175 成功路径有 `__complete(true,value)`，修法待 CTO 裁定；`__start` 包裹与 args 到达半边不受影响（已验证）；
6. run 结算时发 `workflow/end`（只带 `WorkflowResultInfo`，不带 value——seam 契约，dsh-contract.md §2.4）。

```ts
// run.ts
export class DwfWorkflowRun implements WorkflowRun {
  readonly id: WorkflowRunId
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>   // 永不 reject（seam 契约，workflow-seam/index.ts:151-156）；
                                             //   agentsStarted 由 agentLedger 提供（必填字段，types.ts:72-87）
  cancel(reason?: string): void              // abort → 杀 guest 进程 → dispose 已发布子代理
  dispose(): Promise<void>                   // 幂等；排空 pending 后对 liveAgents 合成
                                             //   outcome:'cancelled' 的 agent-end（每 stop 路径恰一次）
}

// —— per-run 子代理账本（agent-start/agent-end 事件与 agentsStarted 的唯一归属地）——
export class AgentLedger {
  begin(label: string, phase?: string): { seq: number; childId: SessionId }
                                             // seq 从 1 起单调分配；childId 取自
                                             //   subagents.startActivation 返回的 activation.childId；
                                             //   随即 emitWorkflowEvent('workflow/agent-start', info)
  end(seq: number, outcome: WorkflowAgentOutcome): void
                                             // 发 'workflow/agent-end'；已 end 的 seq 幂等跳过
                                             //   ——配对「每条 stop 路径恰好一次」由幂等守卫保证
                                             //   （seam 契约，workflow-seam/index.ts:79）
  get agentsStarted(): number                // 全程被接受的 agent() 调用数；取消等终止路径
                                             //   退化为宿主侧计数（seam 契约，dsh-contract.md §2.3）
}
// actor.ts / effects.ts 的每次 ask 成功起步都经 ledger.begin；结算路径（成功、失败、
// cancel、dispose 合成）一律经 ledger.end。tool/ 的 recorder 与 mirror 消费的正是
// 这两路事件（§3.6），与引擎零耦合。
// —— agent 名字注册表（拍板表#8 双层定稿）：run 级 `Map<name, seq>` 由 run.ts 持有，
//   `declare-actor` 事件抵达时查重（宿主侧权威）；computed 名字重复 → WorkflowError('AGENT_START',
//   fatal) → run 以 error 结算（facade.d.ts:37-38「a computed one fails the run」）；字面量重复
//   已在编译期拦截；guest 侧 `__agentNames` Set 守卫保留作第二道（§3.3，单进程内先行拦截）。
// #7 回写（2026-10-25）：查重仅对 `named !== false` 的 label（prelude 自动 label 带
//   named:false，缺省按显式保旧形）；ordinal（recordActor 与 actor-created 事件同源）
//   改由声明计数承载，agentNames 仅司显式名查重、不再承载序号；ActorRegistry 对撞名
//   后到不覆盖先到（actor.ts）——显式名与自动 label 撞名时 ask 落先到者，MVP 接受并注记。
// #4 回写（2026-10-25）：runCap 在 declare-actor 抵达处执法（run.ts 本地声明计数），
//   **先判后计**——进入时计数已 >= runCap（即第 runCap+1 个声明）→ fail run（错误定性
//   对齐 B7 重名的 AGENT_START fatal），恰 runCap 个放行；该声明计数同时是 ordinal 的
//   唯一来源。P0-B 回写（2026-10-25）：`onComplete(ok:false)` 存完 completePayload 即走
//   现成失败链 fail → abort → signal，唤醒挂死在 `await ptcRuntime.run` 的真 PTC（停滞
//   脚本唯一唤醒源）；drive() catch 补 failReason 优先，abort 后 PTC 笼统错误不再盖掉
//   guest 的 Deadlock/失败文案。成功路径零改动（结算仍由 PTC 返回值走 settleFrom）。
// 宿主函数面（PTC bindings）：{ global: 'dwfHost', functions: { begin, request, event, complete } }
//   ——就此四个；model()/channel() 等 guest 本地原语由 prelude 提供，不占绑定面
//   （model(id) 为纯数据工厂，launch 校验走 declare-actor/ask payload，见 §3.2）。
// 沙箱硬门：ptcRuntime.sandboxMode === undefined && policy.mode !== 'danger-full-access'
//   时拒绝执行（对齐 workflow-ptc/host.ts:287-289）。
```

清理序照抄官方：abort controller → dispose 全部已发布子代理 → `Promise.allSettled` 排空 pending → 再 dispose 一轮 → 合成 cancelled agent-end（dsh-contract.md §4.1）。

```ts
// scheduler.ts
export class Scheduler {
  constructor(maxConcurrency: number)
  pumpAll(): void                                   // must（mechanism-map §5）
  enqueue(actor: ActorKey, task: AskTask): void     // 同 actor FIFO
}
// 错误模型（must）：provider 侧错误重试固定次数+指数退避；确定性错误 → run 'error' 等人。
// 任何情况下错误对象不进脚本——脚本侧只看到 promise 未决或折叠后的失败结果。
```

```ts
// actor.ts —— declare-actor 建册 + 同 actor FIFO + startActivation 封装（形状照实现定稿回写）
export class ActorRegistry {
  register(label: string, siteId: string, persona: unknown): ActorKey
                                             // declare-actor 抵达时建册；persona 建即冻结一层
                                             //   （归一化纯 JSON，facade.d.ts:14-19）；重复 label 不在
                                             //   此拒绝——查重是 run 层注册表职责（#8 宿主侧）
  lookup(label: string): ActorKey | undefined
  ask(key: ActorKey, instructions: string, schema: ObjectJsonSchema | undefined,
      onActivation?: (childId: SessionId) => void): Promise<SubagentResult>
                                             // 一次 ask = 一次独立 startActivation（FIFO 排队，
                                             //   facade.d.ts:25-33 内存队列）；只以 **provider 类错误**
                                             //   reject（基础设施拒绝 → scheduler 重试/终局），子代理
                                             //   确定性失败以 SubagentResult resolve 交回 effects 折叠；
                                             //   onActivation 在起步成功即回调（childId 在此，
                                             //   ledger.begin 的挂点）
}
```

- MVP 每 ask 一次独立 `subagents.startActivation({provider, label, delivery:'caller', signal, request:{cwd, prompt, parent, outputSchema?, agentOptions?}})`——形状照 contract-v2 §5.2 `SubagentActivationSpec`（subagent/types.ts:31-44，request 为 `Omit<SubagentStartRequest,'label'|'signal'>`；persona 的 model id 经 `request.agentOptions.model` 下发，R2 定稿，见 §3.2）。actor→持久子会话绑定只留接口（`dwf_actor` 行照建，`sess_dwf-<runid>-actor_<n>_<k>` 命名约定留注释），amend defer。

```ts
// effects.ts
export interface EffectHandlers {
  ask(instructions: string, schema?: ObjectJsonSchema): Promise<Json>
  worldRead(op: 'files.glob' | 'files.read' | 'files.grep' | 'git.changedFiles' |
            'git.diff' | 'git.status' | 'git.log', args: Json): Promise<Json>
  worldRun(cmd: string, args: string[], timeoutMs?: number): Promise<WorldRunResult>
  hole(holeId: string): Promise<never>   // MVP：抛 HOLE_UNAVAILABLE（确定性失败，见 §6 砍掉项）
}
```

- `world-read`（files.\*/git.\*）与 `world-run` 的结果照常落 `result_json` + `input_hash`（amend 缓存钩子，mechanism-map §11）。
- `world-run` 固定 argv 永不 shell；完成进程（含非零退出）resolve，仅 spawn 失败/超时 reject（facade.d.ts world 段注释）。
- **node 生命周期事件五态发射（拍板表#18，发射方就是本层）**：每次效应分派经 RunWriter 依序发 `node-queued → node-dispatched → node-executing → node-waiting → node-settled`（§3.4 MVP 词表的承载点；store 只落行不发事件——`writer.appendEvent` 载荷带 runId/siteId）。

```ts
// artifacts.ts
export function handleReport(item: Json, artifactId?: string): { ok: true } | { ok: false; error: string }
                              // caps 校验（65536 条/run、1MiB/条、1GiB/run）；接受 → journal 记
                              //   dwf_node 行（kind:'report'）+ report 事件，返回 {ok:true}；
                              //   超限 → {ok:false, error}，guest 据此以 error 结算 run（§3.3 定性）
export async function publishFile(id: string, path: string): Promise<ArtifactRef>
                              // journal 记 dwf_node 行（kind:'artifact'）+ artifact-published
export async function publishMarkdown(id: string, content: string): Promise<ArtifactRef>
                              // 同上；title/description 帽见 CAPS
// primary: true 至多一个；id 编译期已验字面量；republish = 新版本。
// chart/table/metrics/board 四 preset：defer（§6）。
```

### 3.6 src/tool — 工具面

`create.ts` 整体 fork 官方 tool-workflow 的 apply 内核（dsh-contract.md §3.6 判定「可原样搬」）。**工具不编译**：`script` 参数原样透传给 `engine.start`，编译诊断由 engine.start 同步抛出的 `WorkflowError('SCRIPT_PARSE')` 经注册层转成 isError 结果——模型看到违规清单可自我纠正，与官方「META_INVALID/SCRIPT_PARSE 在 start 时同步抛」的接线完全一致（dsh-contract.md §3.3）；全插件只有 engine.start 这一条编译路径。

```ts
// create.ts
export function createWorkflowTool(ctx: Context, config: ResolvedConfig): ToolDefinition
// parameters DSL（JSON-Schema 风格，照抄 tool-workflow/index.ts:334-377）：
//   script(string,必) / meta(object,必) / args(object,可选) / run_in_background(可选,门控)
// 输出 oneOf：{kind:'background', jobId, runId} | {kind:'foreground', runId, agentsStarted, result}
// execute 生命周期照抄：校验 exec.agent → engine.start → 前台 await run.result /
//   后台 jobs.start → finally 摘监听 + dispose + recorder 结账。
```

```ts
// description.ts —— 契约文案重写
export const DESCRIPTION: string
// 按本插件 facade（assets/facade.d.ts 全文）重写脚本契约：agent(name?, persona?).ask()、
// channel/future、parallel、world.run、hole 三重载、report、artifact（file/markdown 效应 +
// 声明式 preset 词汇预留）、脚本内普通 interface 声明即 ask 的 schema。官方 DESCRIPTION
// （tool-workflow/index.ts:158-166）与 script 参数描述（:338）写的是 agent(prompt,opts)/
// pipeline/parallel + 纯 JS not TypeScript——照抄会让模型按错误契约写脚本，故此文件是
// fork 时必须替换的第三点（前两点：编译诊断接线、journal 观察面）。
```

```ts
// recorder.ts —— session 观察面（官方 tool-workflow/index.ts:93-151 的对应件）
export class RunRecorder {
  start(parentSession: Session, run: WorkflowRun): void
  finish(runId: string): void
  abandon(runId: string): void
}
// 把引擎事件投影成父 Session 的 dwf-tool/* 日志事件；SessionEventMap 的 declare module
// 扩充放在本文件（对齐官方 types.ts:41-64 的放置法）。任何一次 append 失败即永久禁用
// 该 run 的后续记录，记录故障绝不影响工具执行（照抄官方 :106-113 语义）。
// 本文件消费 AgentLedger 发出的 workflow/agent-start|agent-end（§3.5），web/Get 视图
// 由此获得 agent 面数据。

// mirror.ts —— 后台 run 观察面（官方 record.ts:37-64 的对应件）
export function mirrorToJob(run: WorkflowRun, job: JobHandle): () => void
// 把 workflow/phase|log|agent-start|agent-end 流进持有 job 的输出环
// （job.append(..., {channel:'log'}) + job.updateProgress(title)），run 结算后 stop() 摘除。
```

```ts
// get.ts / list.ts —— 读 projection；无引擎耦合
export function getWorkflowRunTool(db: DatabaseSync): ToolDefinition
export function listWorkflowRunsTool(db: DatabaseSync): ToolDefinition
```

```ts
// placeholders.ts —— 占位工具返回固定错误码（mechanism-map §1/§11）
// AmendWorkflow / ResumeWorkflowRun / FillWorkflowHole / ResolveWorkflowQuestion → AMEND_UNAVAILABLE(21)
// SaveWorkflow / ListSavedWorkflows → SAVED_UNAVAILABLE
```

### 3.7 src/util

```ts
export function fnv1a32(text: string): string          // hole 站点内容寻址
export function snapshotJsonValue(v: unknown): Json    // 无损 JSON 校验（跨进程边界强制）
export class DwfError extends HarnessError { /* 工具层错误码词汇 */ }
```

---

## 4. 模块间数据流

```
模型
 │ CreateWorkflow {script, meta, args, run_in_background?}
 ▼
tool/create.ts ──校验 exec.agent──▶ engine.start({script=用户源码, meta, args, parent, signal})
                                        │                          （tool 不编译，编译只在 engine.start）
                                        ├─ compile/compiler.ts：facade+用户码 → 诊断/lowering/siteId
                                        │    ├─ compile/schema.ts：ask<T> 的 T → ObjectJsonSchema 下沉
                                        │    └─ 诊断非空 → SCRIPT_PARSE 同步抛 → isError 结果
                                        ├─ journal/store.ts：writerFor(run) 分配 sequence/ordinal、
                                        │    dwf_run insert、run-started
                                        └─ emit workflow/start ──▶ 工具 recorder / web 观察面
                                                     │
                                                     ▼
                              run.ts：ptcRuntime.resolve({program: prelude+body,
                                        bindings:[{global:'dwfHost',…}], sandboxPolicy,
                                        timeoutMs:null, signal}) → run
                                                     │
              ┌──────────────────────────────────────┤ guest 进程（禁闭）
              │  guest/prelude.ts + channels.ts + realm.ts
              │  脚本调 facade 钩子：
              │   ask ─────────────── request{ask} ──────────▶ effects.ask
              │   files/git ───────── request{world-read} ───▶ effects.worldRead ─┐
              │   world.run ───────── request{world-run} ───▶ effects.worldRun  ─┤ 每次调用落
              │   hole ────────────── request{hole} ────────▶ effects.hole       ┘ journal node
              │   log/phase ───────── event ───────────────▶ journal event + workflow/log|phase
              │   report ──────────── request{report} ─────▶ artifacts.handleReport：
              │                                          caps 校验，{ok:false} 回包 → guest
              │                                          以 error 结算 run（与 §3.3 定性一致）
              │   artifact.file/md ── request{publish-artifact} ─▶ artifacts.publish*
              │   channel/parallel ── guest 内部原语（FIFO、停滞检测在 guest 侧）
              │   model(id) ───────── guest 本地纯数据工厂（不发宿主调用；model id 随
              │                        agent()/ask 的 payload 到宿主，launch 时校验）
              ▼
        effects.ask ──▶ scheduler.pumpAll（maxConcurrency=4）
                          └─ actor.ask ── FIFO 队列 ──▶ subagents.startActivation
                                                          └─ 真实子代理（parent=发起者）
                              activation 就绪 ──▶ run.agentLedger.begin(label, phase)：
                              分配 seq、取 activation.childId、发 workflow/agent-start；
                              结算（completed/failed/cancelled）──▶ ledger.end（幂等配对，
                              每条 stop 路径恰一次）；agentsStarted=ledger 计数
                                                     │
                                                     ▼
                              guest 跑到脚本 return ──▶ complete{ok,value}
                                                     │
                                        journal.run-settled + workflow/end
                                                     │
                       ┌─────────────────────────────┴──────────────┐
                 前台路径                                      后台路径
        await run.result → stopReason!=='completed'      jobs.start({kind:'workflow',…})
        即 throw（只报原因）→ renderResult                starter 内 engine.start；done 里
        （meta 名 + agent 数 + config.maxResultChars 封顶）dispose + recorder + jobOutcomeOf
```

两条硬规则贯穿全流：
1. **result 永不 reject**（seam 契约）：取消折叠 `stopReason:'cancelled'`，错误折叠 `'error'`，value 只在 completed 有意义。
2. **错误永不进脚本**：provider 限流/网络错在 scheduler 层消化；脚本看到的要么是结果、要么是确定性失败。

---

## 5. dsh seam 挂接点（import 清单）

**原则：类型一律 import 自官方包名；运行时值只依赖三个官方导出（`Service`/`WorkflowEngine` 基类、`defineTool`、`z`）加可选的 `HarnessError`/jobs。桩文件只在编译期顶替官方包，不含任何实现体。**

### 5.1 import 自官方包（src 内的 specifier，真实 dsh 环境直接生效）

| 模块 specifier | import 什么 | 类型/值 | 出处 |
|---|---|---|---|
| `@deepseek-ai/dsh-workflow` | `WorkflowEngine`（extends 的基类，**值**）、`WorkflowRunId`（**值**，官方运行时工厂函数，铸 id 用）、`WorkflowRun`、`WorkflowStartRequest`、`WorkflowMeta`、`WorkflowRunInfo`、`WorkflowResult`、`WorkflowResultInfo`、`WorkflowAgentInfo/EndInfo`、`WorkflowErrorCode`（类型）；`WorkflowError`（**值**，抛错用） | 值+类型 | workflow-seam/index.ts:157-160/168；types.ts 全套词汇 |
| `@deepseek-ai/cordis` | `Context`（类型）、`Service`（基类，**值**）、`ctx.plugin`（**值**，apply 内装载 engine 用；签名镜像内不可考，见 R5） | 值+类型 | workflow-seam/index.ts:31-34 模块扩充模式；plugin 为 cordis 常规装载入口 |
| `@deepseek-ai/dsh-agent` | `Agent`（类型） | 类型 | WorkflowStartRequest.parent（runtime-types.ts:19-34） |
| `@deepseek-ai/dsh-session` | `SessionId`（**值**，运行时工厂函数）、`Session`、`SessionEventMap`（类型） | 值+类型 | WorkflowAgentInfo.childId（types.ts:98-107）；recorder append |
| `@deepseek-ai/dsh-subagent` | `SubagentRuntime`、`SubagentActivation`、`SubagentResult`（类型） | 类型 | **contract-v2 §5 已核实**（startActivation 双重载 subagent/index.ts:255-269；`SubagentActivationSpec/Activation` types.ts:31-59）；workflow-ptc/host.ts:200-229 调用形状同形 |
| `@deepseek-ai/dsh-tools` | `defineTool`（**值**）、`ToolDefinition`/`ToolExec`（类型）、`ObjectJsonSchema`（类型） | 值+类型 | dsh-contract.md §3.1；**`ObjectJsonSchema` 为桩内占位形状——contract-v2 §6「仍属反推」明示定义体不在镜像内（外部假设），接入真实 dsh-tools 时校**（拍板表#15；编译层 schema.ts 下沉与 engine 的 outputSchema 均从它取型） |
| `@deepseek-ai/dsh-system-prompt` | `SystemPromptService`（类型，经 inject 取用） | 类型 | tool-workflow/index.ts:325-330 用法；peer 见 tool-workflow_package.json:42 |
| `@deepseek-ai/dsh-sandbox` / `dsh-sandbox-policy` | `SandboxPolicy`、`SandboxExecutionPolicy`（类型，经 static inject 取用） | 类型 | **contract-v2 §2/§3 已核实**（SandboxMode 三值/ConfinedArgv/confine 签名；`SandboxPolicyService.resolve` 优先级 显式 mode > 会话投影 > defaultMode）；workflow-ptc/host.ts:287-289 用法；peer 见 workflow-ptc_package.json:40-42 |
| `@deepseek-ai/dsh-working-directory` | `WorkingDirectoryService`（类型：get/ensure/set 三方法挂其上） | 类型 | **拍板表#14**：类名照 contract-v2 §4 核实形状（working-directory/index.ts:62，方法 :122/:134/:163）——v1 本行的 `WorkingDirectory` 是残名，照写必 TS2305；workflow-ptc/host.ts:200-229 request.cwd 用法；同上 peer |
| `@deepseek-ai/schemastery` | `z`（**值**） | 值 | tool-workflow/index.ts:59-63 |
| `@deepseek-ai/dsh-llm` | `HarnessError`（**值**，DwfError 基类） | 值 | workflow-seam index.ts:130 `WorkflowError extends HarnessError`；**开发期 peer 未安装，运行时经 `test/runtime-stubs.mjs` 替身解析（值形状照桩声明，评审修订3/B2），接入真实 dsh 后由真实 peer 包承接** |
| `@deepseek-ai/dsh-jobs` | `JobsService`、`JobOutcome`（类型）——可选注入 | 类型 | tool-workflow/index.ts:263-316（**jobs 包源码仍缺，contract-v2 §5.6：API 面仍属调用点反推**） |
| `@deepseek-ai/dsh-ptc-runtime` | `PtcRuntime`（抽象类 9 成员：resolve/run/sandboxMode/language/isolation/programFormat/timeout/release/executionInstructions） | 类型 | **contract-v2 §1 已核实**（ptc-runtime/index.ts:104-163 + types.ts 全文：`PtcRunRequest/Spec/Result/Failure` 全字段；失败是 `result.error` 字段**非 reject**）——原「调用点反推」升级，R1 收窄为仅 `ptc-runtime-node/` 后端实现未取证 |

另有两个**只扩充不 import** 的 `declare module`：`@deepseek-ai/cordis` 的 `Context.workflowEngine`（照抄 workflow-seam/index.ts:31-34）、`@deepseek-ai/dsh-jobs` 的 `JobKindMap['workflow']`（照抄 tool-workflow/index.ts:34-38）。

### 5.2 来自 stubs/dsh.d.ts 的（仅编译期）

`stubs/dsh.d.ts` 已是**单文件** ambient 桩——早期 `stubs/dsh-inline-shapes.d.ts` 的双文件相对 `declare module` 链（gap-audit §3.13 实证的 TS2436/TS2439 断裂、skipLibCheck 下静默 any）已按本节与 §2 合并废弃。桩用 `declare module '<上述每个 specifier>'` 提供与 5.1 完全同名的声明，**形状已按 `research/dsh-contract-v2.md` 的核实形状落定**（不再调用点反推）：`@deepseek-ai/dsh-ptc-runtime`（§1）、`@deepseek-ai/dsh-sandbox`（§2）、`@deepseek-ai/dsh-sandbox-policy`（§3）、`@deepseek-ai/dsh-working-directory`（§4，类名 `WorkingDirectoryService`）四段在桩内标注 contract-v2 行号出处；`ObjectJsonSchema` 归属 `@deepseek-ai/dsh-tools` specifier 的桩、占位形状并注明「外部假设，接入真实 dsh-tools 时校」（拍板表#15）。`WorkflowRunId`/`SessionId` 以 `declare function` 声明为运行时工厂、`WorkflowError` 类体纯声明——运行时值走官方包；SubagentRuntime 的桩只落 contract-v2 §5.1 公有契约面（resolveMaxDepth/startActivation），provider 注册表查询成员不进桩（R2 定稿，§3.2/§3.5）。§5.2 点名的 `Context.plugin(...)` 成员与两个 declare module 扩充（`Context.workflowEngine` 照 workflow-seam/index.ts:31-34、`JobKindMap['workflow']` 照 tool-workflow/index.ts:34-38）已补；`dwf/*` 的 SessionEventMap 扩充收口在 `src/tool/recorder.ts` 单处声明，桩内不预置（防双处声明，gap-audit §3.13 ➕）。

不进桩的：`node:sqlite`、`node:child_process` 等 Node 内置（走 `@types/node`）。`Context.plugin` 的签名按 cordis 惯例占位，接入真实 cordis 时校（R5）。

**peer 语义回写（gap-audit §3.14）**：本包独立于 monorepo 开发，`workspace:*` 无 workspace 可解析，package.json 实态以 `*` + `peerDependenciesMeta` 全 optional 落地；§1.2 片段保持官方骨架字面，接入 dsh monorepo 时二者合流。

### 5.3 stubs 的使用边界

- stubs 只保证 `tsc --noEmit` 通过——正反向自检固化为 `test/stub-check.mjs`（正向：`--listFiles` 含 `stubs/dsh.d.ts` 与 `assets/facade.d.ts`；反向：探针工程逐 specifier 断言带桩 0 错、去桩各报 TS2307；any 探针 `const x: WorkflowEngine = 42` 必报 TS2322，堵死「桩在但退化 any」）；**运行时必须装真实 peerDependencies**。发布/接入真实 dsh 时，把 `stubs/` 从 tsconfig include 移除即可，src 的 import specifier 一字不改。
- 早期桩中 `ptcRuntime`/`sandboxPolicy`/`workingDirectory` 形状来自调用点反推——**已按 contract-v2 核实形状重写**（§5.2）；例外是 `dsh-jobs`（包源码仍缺，contract-v2 §5.6），其桩保持调用点反推并在桩内标注。
- 开发期 peer 缺位的官方包**值**导入（`HarnessError`、`WorkflowEngine`/`Service` 基类、`defineTool`、`z`、`WorkflowRunId`/`SessionId` 工厂等）运行时经 `test/runtime-stubs.mjs` 的 resolve 钩子映射到 `test/runtime-stub-values/` 最小值实现——只服务 node 直跑/单测，不进 tsc 程序；**替身 ≠ 真包**，接入真实 dsh 后必须用真实 peer 包复跑全部单测（R6，残留清单在案）。

---

## 6. MVP 范围与明确砍掉项

### 6.1 MVP 必含（mechanism-map 附录表逐行）

| 层 | MVP 内动作 |
|---|---|
| 1 工具面 | CreateWorkflow / GetWorkflowRun / ListWorkflowRuns 三个真实现 + recorder/mirror 观察面（fork 内核配套件，§3.6）；Amend/Resume/Fill/Resolve/Save/ListSaved 占位报错误码 |
| 2 编译层 | facade 合成编译 + 9012 hole 规则 + 编译期字面量诊断 + lowering 打 siteId + FNV-1a hole id |
| 3 guest 沙箱 | 三通道协议 + channel/future + 停滞检测 + Date/random 禁令，原样移植两模板 |
| 4 journal | 五表（session_task_link 建表不接线）+ 22 事件词表的 MVP 子集 + caps + 投影 reducer |
| 5 调度 | maxConcurrency（默认 4）+ pumpAll + 重试固定次数指数退避 + 错误不进脚本 |
| 6 actor | persona 冻结 + 同 actor ask FIFO（内存队列）+ actor→子会话只留接口 |
| 7 工件 | report 落 journal + artifact.file/markdown 效应型 + primary 至多一个 |

### 6.2 明确砍掉（defer，含降级路径）

| 砍掉项 | 降级路径 |
|---|---|
| escalation 问答桥（§8） | 子代理答不上 → ask 返回兜底文本，脚本自行兜底 |
| amend-resume 缓存（§11） | 改脚本=停掉重跑；journal 按 amend 语义留钩子（input_hash / resumed_from 列 / superseded 状态），占位工具报错误码 21 |
| 四种声明式工件 preset：chart/table/metrics/board（§7） | 数据都在 report 流里，一点不少；dsh web 卡片体系就绪后一批做 |
| EvalWorkflowSnippet 完整版（§1） | 模型直接走 CreateWorkflow，不提供试错面 |
| retune / 自适应扇出收缩（§5） | 并发上限启动即冻结 |
| Saved Workflows（§9） | 内联脚本先行；MVP 末若有余量再补（薄壳：编译器复用 + YAML 元数据块） |
| phase 图形化确认（§2） | 列表展示 phaseNames |
| 诊断 9001/9011（§2） | 只保留 9012 + 字面量族 |
| 投影驱逐预算 `evictForEntryBudget`（§4） | 投影只增不驱逐（数据量 MVP 可承受） |
| session_task_link 接线（§4） | 建空表，不产生行 |
| 技能门禁/懒激活（§1） | MVP 用 prompt section 约定代替拒裸调 |
| `hole()` 运行时 | FillWorkflowHole 占位 ⇒ unfilled hole 请求确定性返回 `HOLE_UNAVAILABLE` 错误，**绝不挂起等待**（脚本可 catch 自行兜底） |
| 逆向文档 §4 六个超越原版机会点 | 全部不进第一版（mechanism-map §12） |
| #11 worldCommands/phaseNames 确认展示接线（findings P2#11，2026-10-25） | `CompiledWorkflow.phaseNames/worldCommands` 编译层产物已保留（§3.2）；确认对话面属宿主 web/工具集成层，镜像内无该 API 取证，接线 defer 至接入真实 dsh——与「phase 图形化确认」同批（FIX-PLAN §2） |
| #12 artifact 字节拷贝与卡片（findings P2#12，2026-10-25） | journal 事实面已完整（`dwf_node` kind=artifact 带 path/bytes + artifact-published 事件）；字节拷贝落点依赖宿主数据目录约定（§1.3 dbPath 默认空、无约定可依），卡片是 dsh web 能力——与 preset defer 同批（FIX-PLAN §2） |
| #13 report 完成通知通道（findings P2#13，2026-10-25） | item 值已完整落 `dwf_node.input_json`（将来投影/通知可直接消费，无需现在补通道）；完成通知通道属宿主会话面（无取证），defer（FIX-PLAN §2） |
| #9 report 非法 item 编译期诊断（findings P2#9，**文档声明差距**，2026-10-25） | 运行时兜底已在：非 JSON item 被 dispatchReport 的 `snapshotJsonValue` 拒收且脚本可 catch（§3.6 handleReport 定性）；工具文案已改如实（运行时拒收、非 compile error）——编译期 JSON 安全诊断需新诊断族（类型遍历+联合收窄），defer |
| #10 phase REQUIRED/standalone/每相位≥1 强制（findings P2#10，**文档声明差距**，2026-10-25） | 字面量半边已执法（9013，diagnostics）；其余需相位 span×效应点匹配的新诊断族，不写 phase 仅影响进度展示——工具文案已软化为「本版不强制」，defer |
| #14 grep/glob 对齐 ripgrep 二进制语义（findings P2#14，**文档声明差距**，2026-10-25） | pattern 按 JS RegExp 近似、glob 为 `*`/`**`/`?` 子集（`{a,b}` 不支持）已在工具文案注明；对齐 rg 语义需引依赖或自写引擎，defer |

---

## 7. 验证计划

### 7.1 编译门：对 stubs 跑 `tsc --noEmit`

前置（已完成，本设计终审修订时实测，两条均有命令与输出）：

1. **TS 7.0.2 库 API 不可用**（在 `<plugin-root>` 下，`node --input-type=module -e "import ts from 'typescript'; console.log(ts.version, typeof ts.createProgram, Object.keys(ts).length)"`）→ 输出 `version: 7.0.2`、`createProgram: undefined`、ESM 命名空间仅 4 个键、`ScriptKind`/`sys` 均为 undefined。native preview 包（`"type": "module"`）不暴露 compile 层所需的库 API——**7.x 不能作编译层依赖**。
2. **TS 5.9.3 库 API 验证通过**（仓库外临时目录 `npm i typescript@5` 后同法运行内存 Program 脚本）：`createProgram`/`ScriptKind`/`sys` 均可用；facade.d.ts + 用户码合成 Program 后语义诊断精确报出预期错误（`Type 'string' is not assignable to type 'number'`，唯一 1 条，`ask<Answer>` 处无误报）；`checker.getTypeAtLocation(call.typeArguments[0])` → `typeToString` 得 `Answer`、`getPropertiesOfType` 得 `score,reason`——正是 compile/compiler.ts 与 schema.ts 的用法面。故 dependencies/devDependencies **pin `5.9.3`**（§1.2）。

`@types/node ^26.6.5` 已在 devDependencies（node:sqlite 类型随附）。

**步骤（文件树落齐后逐条执行）：**

1. 写 `tsconfig.json`（本设计 §2 已列）：
   ```jsonc
   {
     "compilerOptions": {
       "strict": true,
       "noUncheckedIndexedAccess": false,     // 与 guest 侧编译选项一致（mechanism-map §2.2）
       "target": "es2024",                    // 对齐官方 tsdown target（workflow-ptc_tsdown.config.ts:8）
       "module": "nodenext",
       "moduleResolution": "nodenext",
       "types": ["node"],
       "noEmit": true,
       "skipLibCheck": true                   // 桩文件与 @types/node 交叉容忍；facade.d.ts 逆向原件不逐行校
     },
     "include": ["src/**/*.ts", "stubs/dsh.d.ts", "assets/facade.d.ts"]
   }
   ```
2. 编译门命令（在 `<plugin-root>` 下）：
   ```bash
   node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
   ```
   通过标准：exit code 0、零输出。
3. 桩生效性自检（防「假通过」——万一某 specifier 拼错被 any 化）：
   ```bash
   node node_modules/typescript/bin/tsc --noEmit --listFiles -p tsconfig.json | grep -E "stubs|facade"
   ```
   预期输出包含 `stubs/dsh.d.ts` 与 `assets/facade.d.ts` 两行。
4. 桩未接入自检（反向）：临时在 include 里去掉 `stubs/dsh.d.ts` 跑第 2 步命令，**必须**报大量「Cannot find module '@deepseek-ai/dsh-workflow'」类错误；确认后恢复。此步证明错误不是被 skipLibCheck 吞掉。

**边界声明**：`tsc --noEmit` 只验证类型面（import specifier 与官方词汇对齐、我们的模块签名自洽）。运行时行为（guest 三通道、journal 记账、seam 事件）不在本门覆盖内——需要真实 dsh 宿主 + peerDependencies，属后续集成验证，本设计不含其步骤。

### 7.2 后续门（本设计只立项不展开）

> **实施终态注记（T8）**：前三是「编译层单测 / guest prelude 单测 / journal 单测」已随实施落地为 `test/compile.test.mjs`、`test/engine.test.mjs`、`test/tool.test.mjs`（node:test，官方包值导入经 `test/runtime-stubs.mjs` 替身）与 `test/smoke.mjs`（无宿主冒烟：node:vm 假 dwfHost + node:sqlite 内存库，PLAN T4）；**集成冒烟（真实 dsh 宿主）仍未执行**，维持本节边界声明。

- **编译层单测**：把 `assets/facade.d.ts` + 若干样例脚本喂 `compileWorkflow`，断言诊断/lowering/phaseNames/世界命令清单（node:test，无需 dsh 宿主）。
- **guest prelude 单测**：用 `node:vm` + 假 `dwfHost` 绑定驱动 prelude，断言 FIFO 序、停滞检测报 ChannelDeadlock、Date/random 禁令抛错（无需 dsh 宿主）。
- **journal 单测**：`node:sqlite` 内存库跑五表 + 投影 reducer 回放。
- **集成冒烟**：真实 dsh 环境装包后跑一个两 ask 工作流，核对 workflow/* 六事件与 journal 行数对账。

---

## 8. 风险与未决项

- **R1（已收窄）**：`@deepseek-ai/dsh-ptc-runtime` 的**接口**契约已按真实源码逐行取证核实（contract-v2 §1：PtcRuntime 9 成员 + PtcRunRequest/Spec/Result/Failure 全字段，失败是 `result.error` 字段非 reject），桩与 engine 调用面按此落定；**仍未取证的是 `ptc-runtime-node/` Node 后端实现**（contract-v2 §6.5）——接入真实宿主时首验（PLAN §5 R1 同源）。
- **R2**：官方宿主加载插件用 TS 还是编译后 JS 未可考（dsh-contract.md §1 无插件安装文档）；manifest 的 main/exports 按官方骨架写，接入时再定构建产物形态（官方 workflow-ptc 的 tsdown 二次打包流程可抄）。（PLAN §5 另有一条同号 R2：`subagents` 的 provider 前置查询成员不进设计——model 校验统一走 startActivation 的 `request.agentOptions`，定稿回写见 §3.2/§3.5/§5.2。）
- **R3（已关闭）**：TS 版本决策已实测关闭——7.0.2 库 API 不可用、5.9.3 验证通过并已 pin（证据与命令见 §7.1 前置）。此前「compile 层对 TS API 版本敏感面窄」的说法与 §3.2 实际用法（createProgram 合成、TypeChecker 类型查询、AST 诊断与 lowering 改写）不符，已撤回。遗留不确定「5.9.3 对 `declare module` 桩文件的合并行为」亦已实证无虞：完整 tsconfig 下 `tsc --noEmit` EXIT=0，且 `test/stub-check.mjs` 正反向探针通过。
- **R4**：journal 用 `node:sqlite` 是规避「dsh storage 服务 API 无据可考」的决策；若宿主对插件数据目录有约定（config.dbPath 默认值），接入时对齐。版本注意：node 22 的 node:sqlite 需 `--experimental-sqlite` 旗标，23+ 免旗标——宿主 node 版本接入时核对（开发侧 devDependencies 已是 node 26 类型环境）。
- **R5**：`ctx.plugin(...)` 是 cordis 的常规装载入口，但镜像内无 cordis 源码，其签名（是否第二参传 config、装载是否同步可就绪）不可考。已按「apply 内显式装载」写入设计（§1.1/§3.1）；接入真实 dsh 时第一件事就是核对该 API——若宿主另有服务装载约定，只需改 apply 里这一行，engine 类本身不动。

---

## 9. 模型池与自动换道（2026-10-25 增补，用户需求：多供应商摊负载）

- **Config**：`modelPool`（逗号分隔 "provider/model" 清单，空=不启用）、`poolPolicy`（spread=按 provider 累计分配最少优先，默认；round-robin）、`poolCooldownMs`（默认 60000）、`failoverAttempts`（默认 3，含首次）。
- **语义**：未显式绑模型的 actor 从池分摊（惰性解析、随后钉在该 actor；同 actor 的 ask 模型一致）；**显式 persona.model = 硬绑定，不参与换道**。确定性 provider 故障（额度尽/401/403/模型不存在）→ 冷却该 provider 并立即换道；瞬态（限流/过载/网络）→ 同模型退避重试，耗尽后换道；池耗尽/无池 → 原错误走既有失败路径，绝不静默假装成功。
- **记账**：换道落 journal `model-failover` 事件（载荷 {runId, actor, from, to, reason}）；ask 节点 `input_json` 记实际模型（input_hash 反映真实执行面）。
- **实现**：`src/engine/pool.ts`（ModelPool + classifyProviderError，纯逻辑零官方依赖）+ actor.ts 换道循环 + engine/run/effects 接线；测试 `test/pool.test.mjs` 10 条（分摊/轮转/冷却/耗尽/分类/换道/硬绑定/瞬态退避）。spread 用累计分配数而非在途计数：确定性保证重放一致。
- **边界**：真实宿主下 `agentOptions.model` 对 "provider/model" 复合串的路由行为仍属接入期验证项（§6.2 同口径）。
