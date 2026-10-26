# dsh-dwf 修复轮计划（FIX-PLAN，2026-10-25 CTO 拍板）

> 唯一输入：`research/review-findings.md`（评审发现清单）。本文只做拆分与拍板，不改 findings 的事实陈述。
> 每条决策一句话理由；任务写集两两不相交（并行实施无文件冲突）；验收全部可判定。
> 本仓库非 git 仓库（`git rev-parse` 实测 fatal），冻结面验收用**哈希基线**核对（T1 动工前取快照，见 §3.2），其余以六命令实跑退出码为准。

## 0. CTO 拍板表（findings 中「由 CTO 定」的六处 + 一处关联决策）

| # | 决策 | 一句话理由 |
|---|---|---|
| P0-A 库二选一 | **tool 经配置路径各开连接（同一文件）**：路径解析收口为共享函数，engine 建库即 `initSchema`，tool 侧照旧只读 | tool 层零改动、不引入 apply↔engine 时序耦合（R5 `ctx.plugin` 签名镜像内不可考，接入真实 cordis 时校）；`initSchema` 全 DDL `if not exists` 幂等（schema.ts:16 起实证），双连接同文件读写 MVP 可承受 |
| P0-C `__start` 成功路径 | **不对齐原版，不补 `__complete(true,value)`**：成功仍由 PTC 返回值结算 | `__complete(true)` 与 PTC 返回值是双结算通道，`settleFrom` 优先级（run.ts:292-301）会令 guest complete 压过 PTC 结果，徒增竞态面；失败半边由 P0-B 接通后语义已完整 |
| P0-B 失败链 | `onComplete(ok:false)` 存 `completePayload` 后**走现成失败链 `this.fail(message)`**（对齐 dispatchReport 拒收 → onRunFailure → fail → abort，run.ts:195/330-334），`drive()` catch 补 failReason 优先 | 真实 PTC 下停滞脚本永不返回，唯一唤醒源是 fail→abort 的 signal；成功路径一行不动 |
| #4 runCap | **实现**：declare-actor 抵达处执法（run.ts 本地声明计数，**先判后计**：第 runCap+1 个声明 → fail run）；该计数同时是 ordinal 的唯一来源（见 #7 联动） | `CAPS.maxSubagents` 语义是「单 run 子代理数」，`agent()` 即子代理诞生点；ask 派发处执法会放过「声明了却没 ask」的空转计数错位；先判后计锚定恰 runCap 个放行，避免与 T3#1 同款 off-by-one |
| #5 孤儿码 | **maxNodes 落投影执法（`nodesUnlisted` 展示帽）；maxOpLength/maxArgs 删除** | maxNodes 是 DESIGN §3.4 既定承诺（投影计数、不阻断记账）补实现即可；后两码零消费（grep 实证）且无 facade 出处，删死账优于留孤儿 |
| #7 自动 label 碰撞 | **宿主查重只对显式名**：prelude declare-actor 事件加 `named` 标志，自动 label `named:false`；宿主对缺省（无字段）按显式处理；**ordinal/actor-created 序改由 #4 声明计数承载**（run.ts:431-434 现取 `agentNames.size`，#7 后自动 label 不进 agentNames 会冻结序号） | engine.test.mjs:358-375 手工 emit 无 named 字段的旧断言不弱化；guest 侧显式查重（prelude.ts:91-95）本就先行拦截，宿主只补显式名的第二道；store.ts:176 `insert or replace` 使序号错位不崩但账面错，必须修在源头 |
| #8 filled-hole 缓存 | **每次到达现场重新求值**（删 `__fills` 缓存） | facade 语义是「body 在 hole 的位置原地运行」，是代码不是 memo；按 siteId 缓存闭包令循环第二 iteration 绑定首次的 `let`，是缺陷非特性 |

## 1. 任务拆分（写集互斥，可并行）

| 任务 | 写集（相对 dsh-dwf 包根） | 对照 findings |
|---|---|---|
| T1 | `src/index.ts`、`src/engine/engine.ts` | P0-A |
| T2 | `src/engine/run.ts`、`src/guest/prelude.ts` | P0-B、P0-C、P1#4、P1#7、P1#8 |
| T3 | `src/engine/effects.ts` | P1#1、P1#2、P1#6 |
| T4 | `src/journal/projection.ts`、`src/journal/caps.ts`、`src/types/index.d.ts` | P1#5 |
| T5 | `src/tool/description.ts`、`test/tool.test.mjs` | P1#3（+P2#9/#10/#14 文案半边） |
| T6 | `test/integration.test.mjs`（新建） | 测试盲区（三条 P0 回归 + #7/#8/#5 附带断言） |
| T7 | `research/review-findings.md`、`DESIGN.md` | 状态回填 + P2 处置与决策文档化 |

互斥核对：`index.ts`/`engine.ts` 仅 T1，`run.ts`/`prelude.ts` 仅 T2，其余各文件唯一属主——无跨任务共改文件。`engine.ts`/`run.ts`/`index.ts` 无一被多任务共改，未触发合并条款。

### T1 — P0-A 引擎库错位（默认配置首 run 即抛）

- `src/index.ts:49` 改 `ctx.plugin(DwfWorkflowEngine, config)`（桩签名已容第二参，stubs 的 plugin 声明带 `config?: unknown`，tsc 无需改桩）。
- 路径解析收口：`engine.ts` 导出 `resolveJournalPath(dbPath: string): string`（非空取 `dbPath`，空取 `'./dwf.db'` 相对 cwd），`index.ts:56` 改调它并保留现有空 dbPath warn——两侧同一字符串、单一事实源。
- `engine.ts:152` 构造器删 `:memory:` 兜底，建库后立即 `initSchema(db)`（幂等，实证见 schema.ts）；`index.ts:61` 的先建表保留（先 plugin 后开工具连接，顺序无关、`if not exists` 兜底）。
- 不改 tool 三件（get/list/create 只吃 db 句柄，零改动）。

### T2 — P0-B + P0-C + #4 + #7 + #8（run.ts / prelude.ts 执行内核）

- **P0-B**：`run.ts:438-450` `onComplete` 在 `ok===false` 分支存完 `completePayload` 后追加 `this.fail(completePayload.error ?? 'workflow script failed')`——失败沿现成链（fail → controller.abort → signal 传 PTC）唤醒挂死的 `await ptcRuntime.run`（run.ts:266）；`drive()` 的 catch（run.ts:230-235）在 `cancelReason` 判定旁补 `failReason` 优先（已 fail 时用 `errored(this.failReason)`，避免 abort 后 PTC 侧笼统错误盖掉 guest 的 Deadlock 文案）。成功路径（`ok:true` / PTC 返回值结算）零改动——fake PTC 立即 return 的既有断言（engine.test.mjs:377-392）不受影响。
- **P0-C**：`run.ts:456-459` `assembleProgram` 改为 prelude 后包启动调用：`return await __start(async () => {\n${body}\n})`。两种 programFormat 兼容：function-body 本身是 async 函数体、repl 外层已是 async IIFE，bare `return` 与顶层 `await` 均合法（lower.ts 剥包装后 body 即用户源码，compile.test.mjs LEGAL_SOURCE 顶层 `return answer.title` 实证）；body 抛错由 `__start` 的 `.then(undefined,…)` 折成 `__complete(false,…)`（prelude.ts:165-169）→ P0-B 链结算。成功路径按拍板表不接 `__complete(true)`。
- **#4**：`onDeclareActor`（run.ts:420-435）加本地声明计数，**到达时先判后计**：进入时计数已 `>= deps.runCap`（即本次是第 runCap+1 个声明）→ `fail("subagent cap exceeded: more than <runCap> agents in one run")`，恰 runCap 个放行——判定必须先于自增，先增后判会把恰第 runCap 个（默认 64）拒掉、只放行 63 个，与 engine.ts:127-136「runCap=单 run 子代理数」差一，与 T3#1 修的 `>=`→`>` 同款 off-by-one（`runCap` 经 RunDeps:74 下发、此前零消费；错误定性对齐 B7 重名的 AGENT_START fatal）。**该声明计数同时是 ordinal 的唯一来源**（与 #7 联动，见下条）。T6 新增回归断言：runCap=2 时第 3 次 `agent()` 声明 → run 以 error 结算（cap exceeded），恰 2 个 → completed。engine.test 重名场景 runCap=64 不触帽，旧断言不弱化。
- **#7**：`prelude.ts:96` 自动 label（`"subagent N"`）的 `declare-actor` 事件载荷加 `named: false`；显式名分支发 `named: true`。`run.ts onDeclareActor`：仅 `args.named !== false` 的 label 进 `agentNames` 查重集与查重判定（缺省按显式 → 旧断言保形）。**ordinal 联动写死**：run.ts:431-434 现从 `this.agentNames.size` 取 ordinal（`recordActor` 与 actor-created 事件 payload 同源）——照「自动 label 不进 agentNames」字面实施，多个自动 label 的 `dwf_actor.ordinal` 与 actor-created 序会全部冻结在显式名计数上重复错位（不会崩：`unique(run_id, site_id, ordinal)` 中 site_id 各异且 store.ts:176 用 `insert or replace`，但账面错）。拍板：**ordinal（recordActor 与 actor-created 序）一律改用 #4 的声明计数，`agentNames` 仅司显式名查重、不再承载序号**。`actors.register` 对自动 label 照常（ask 路由不变；ActorRegistry 重复 label 后到不覆盖先到，actor.ts:63-71——显式名与自动 label 撞名时 ask 落到先到者，MVP 接受并在 T7 文档注记）。
- **#8**：`prelude.ts:133-139` `__holeFilled` 删 `__fills` 缓存，直接 `return body()`——每次到达现场求值。

### T3 — P1 effects 族（#1 / #2 / #6）

- **#1**：`effects.ts:403` `matches.length >= CAPS.worldReadCap` 改 `>`（facade.d.ts:180「Over 2000 … rejects」——恰 2000 条必须放行；glob 侧 `effects.ts:155` 已是对的，不对齐它）。
- **#2**：`effects.ts:431` 分支解析：解析结果为 `undefined` 或 detached 状态（`git status -b` 的 `## HEAD (no branch)` 形态）时不带 `branch` 字段返回（facade 语义 branch absent）。
- **#6**：`effects.ts:413-425` `gitChangedFiles` 两条路径（diff --name-only 与 status porcelain）的输出逐项做 workspace 收口过滤：`path.resolve(root, entry)` 逃出 root（含 `..`/绝对路径形态）的条目丢弃（facade「changes outside the workspace are not reported」；复用 `withinRoot` 的判定语义）。

### T4 — #5 孤儿码（projection / caps / types）

- `projection.ts` `runProjection` 节点查询加 `limit CAPS.maxNodes + 1` 探测：超帽时列表截到 2000 并在 `RunView` 新增 `nodesUnlisted: true`（未超帽字段缺省 false/缺省不带，与既有 `undefined-省略` 风格一致）——DESIGN §3.4 既定承诺的「展示帽、不阻断记账」。
- `caps.ts:10-11` 删 `maxOpLength`/`maxArgs`，`types/index.d.ts` `Caps` 同步删两字段（零消费 grep 实证：仅 caps.ts 定义与 types 声明两处；无 facade 出处）。
- smoke/compile 冻结不受影响（两者均未引用这三个码，grep 实证）。

### T5 — 文案族（#3 + P2 #9/#10/#14 的文案半边）

- `description.ts:29`：chart/table/metrics/board 「calling them fails the run」改为如实——声明被静默忽略（run.ts:403-406 drop declare-artifact，实证），失败点在带该 id 的 tagged report（artifacts.ts:63-66 拒收实证）。
- `description.ts:28`（#9 文案半边）：report 非法类型「are compile errors」改为运行时语义——非 JSON 安全的 item 在发布时被拒收且可 catch（effects.ts:236-241 实证），编译期不报。
- `description.ts:26`（#10 文案半边）：phase 保留「名字必须是编译期字面量」（9013 已执法，diagnostics.ts:148-152），REQUIRED/standalone/每相位≥1 ask 软化为「本版不强制」。
- `description.ts:31`（#14 文案半边）：注明 grep pattern 按 JavaScript 正则近似执行（非 rg 二进制语义，effects.ts:372 实证 `new RegExp`）、glob 参数为 `*`/`**`/`?` 子集（`{a,b}` 不支持，effects.ts:541 自注）。
- `test/tool.test.mjs` **只增不改**：新增断言（如 DESCRIPTION 不再含 "calling them fails the run"、含运行时拒收与 glob 子集说明）；既有四组断言（词汇在、`agent(prompt` 不在、TypeScript/interface 在）一字不动。

### T6 — 集成回归测试（新任务，唯一写文件 `test/integration.test.mjs`）

写法参照 `test/smoke.mjs` 的 vm boot，但**不复制 smoke 的手拼 boot**——本测试的存在意义就是回归 `run.ts assembleProgram` 的真实拼装产物：

- fake PTC：`sandboxMode: undefined`、`programFormat: 'function-body'`；`resolve(request)` 捕获 spec（bindings/program/signal）；`run(spec)` 用 `node:vm` 起 context（`dwfHost = spec.bindings[0].functions`）真实执行 `(async () => {\n<program>\n})()`（function-body 形态即 async 函数体的诚实仿真；顶层 await/return 由此合法），记录 complete 载荷与 event/request 到达序；监听 `request.signal`，abort 时以 `error:{kind:'abort'}` 收束等待——这就是 P0-B「真 PTC 挂死」的仿真前提（engine.test.mjs:318-334 的 fakePtc 在 complete 后立即 return，掩盖断点，此处不复用其形状）。
- 宿主侧 ctx：直构 `new DwfWorkflowEngine(fakeCtx, config)`（替身基类已具备：cordis `Service`、dsh-workflow `WorkflowEngine.emitWorkflowEvent` no-op、schemastery `z`，hook.mjs 映射表实证可解析）；`fakeCtx` 提供 `subagents`（不启真会话）、`ptcRuntime`、`sandboxPolicy.resolve → {mode:'danger-full-access', workspaceRoot}`（绕沙箱硬门，run.ts:248）、`workingDirectory.ensure`、`logger`；`start()` 传合法 meta/args/parent/session。
- **P0-C 回归断言**：脚本体 `log("target=" + String(args.target)); return { seen: args.target }`，`engine.start({args:{target:'v1'}})` → `run.result` 为 `completed` 且 `value` 深等 `{seen:'v1'}`，假宿主收到 `begin()` 与 `log` 事件——args 经 begin 到达 guest、`__start` 确被调用（修前 `globalThis.args` 恒 `{}` 必红）。
- **P0-B 回归断言**：脚本体停泊一个 channel receiver 且无在飞请求（smoke ③ 同景）→ run 在超时窗内（node:test timeout 或 `Promise.race` 守卫）以 `stopReason:'error'` 结算且 error 含 `Deadlock`、假宿主收到 `complete{ok:false}`——修前永不结算必超时红。
- **P0-A 回归断言**：engine 以临时文件 `config.dbPath` 构造并跑完一个 completed run → **另开** `new DatabaseSync(同路径)` 跑 `runProjection`：run 行 status=`completed`、journal 事件（run-started 等）与节点可读——engine 写侧与 tool 读侧同库（修前引擎落 `:memory:` / 无表必红）。
- 附带回归（同文件同 harness，低成本）：**#4**——`engine.start({maxTotalAgents: 2})`、脚本体声明 3 个 `agent()` → run 以 error 结算且 error 含 cap exceeded；对照场景恰 2 个 → completed（先判后计边界回归）；**#7**——先 `agent()`（自动 label `subagent 1`）后 `agent('subagent 1')`（显式）→ run completed、无 duplicate 误报；**#8**——循环内 filled hole（`for (let i=0;i<2;i++) acc.push(await hole('h', () => i))`）→ 返回 `[0,1]` 而非 `[0,0]`；**#5**——直连 store 写 2001 个节点 → `runProjection.nodesUnlisted === true` 且节点列表截断。
- 命令：`node --import E:\os\dsh-dwf\test\runtime-stubs.mjs --test E:\os\dsh-dwf\test\integration.test.mjs`（findings 验证门第 6 条）。

### T7 — 文档收口（findings 状态回填 + DESIGN 回写）

- `research/review-findings.md`：**先补结构再回填**——现状全文 `☐` 仅存在于 :3 图例，P1 表头（:22）与 P2 表头（:35）均无状态列、P0 三节（:5-19）无状态落点，照原文回填无锚点：先在 P1/P2 表头各增『状态』列（P2 行并加三选一处置注记）、P0-A/B/C 三节各加一行状态标记（如 `> 状态：✅已修验证`），再对 #1-#14 与 P0-A/B/C 逐条回填 `✅已修验证 / 📄仅文档 / ➡️defer 有理由`（T1-T6 完成后按实际验证结果填，不预填）。
- `DESIGN.md`：§6.2 defer 表补三行（#11 worldCommands/phaseNames 确认展示接线、#12 artifact 字节拷贝与卡片、#13 report 完成通知通道，理由见 §2 处置表）；#9/#10/#14 文案差距在 §6.2 声明；§3.4/§3.5 回写拍板表六条决策（P0-A 路径收口、P0-C 成功路径、#4 执法点、#5 删两码、#7 named 标志与撞名 ask 落先到者的 MVP 限制、#8 现场求值）。

## 2. P2 处置表（三选一，不贪多）

| # | 处置 | 理由（含落点） |
|---|---|---|
| 9 | **文档声明差距** | 运行时兜底已在：非 JSON item 被 `dispatchReport` 的 `snapshotJsonValue` 拒收且可 catch（effects.ts:236-241）；编译期 JSON 安全性需新诊断族（类型遍历+联合收窄），成本/收益不配。T5 改 description.ts:28 文案，T7 在 DESIGN §6.2 声明 |
| 10 | **文档声明差距** | 字面量半边已执法（9013，diagnostics.ts:148-152）；REQUIRED/standalone/每相位≥1 ask 需相位 span×效应点匹配的新诊断族，不写 phase 仅影响进度展示，MVP 收益低。T5 软化 description.ts:26，T7 声明 |
| 11 | **defer** | 确认对话面属宿主 web/工具集成层，镜像内无该 API 取证；`CompiledWorkflow.phaseNames/worldCommands` 已保留（compile 层产物在），接线 defer 至接入真实 dsh——与 §6.2「phase 图形化确认 defer」同批。T7 记录 |
| 12 | **defer** | 字节拷贝落点依赖宿主数据目录约定（DESIGN §1.3 dbPath 默认空、无约定可依），卡片是 dsh web 能力；journal 事实面已完整（dwf_node kind=artifact 带 path/bytes + artifact-published 事件，artifacts.ts:126-148）。与 §6.2 preset defer 同批。T7 记录 |
| 13 | **defer** | 完成通知通道属宿主会话面（无取证）；item 值已完整落 `dwf_node.input_json`（artifacts.ts:82），将来投影/通知可直接消费，无需现在补通道。T7 记录 |
| 14 | **文档声明差距** | pattern 按 JS RegExp 近似（effects.ts:372）、glob 为 `*`/`**`/`?` 子集（effects.ts:541 自注 `{a,b}` 不支持）；对齐 rg 二进制语义需引依赖或自写引擎，defer。T5 在 description.ts:31 注明近似语义 |

## 3. 验收口径（全部可判定）

1. **六命令全绿**：findings「验证门」六条命令逐一执行、退出码全 0（第 6 条即 T6 新文件）。验收报告如实附各命令关键输出。
2. **冻结面（哈希基线）**：T1 动工前对 `test/smoke.mjs`、`test/compile.test.mjs`、`test/engine.test.mjs`、`test/tool.test.mjs` 四文件取哈希（`sha256sum` 或 `Get-FileHash`）记录于验收报告，并为 `test/tool.test.mjs` 另存改动前副本（它必有增量，需对照举证）；验收时重取比对——前三个文件哈希不变（零改动），`test/tool.test.mjs` 对照副本核实「仅新增 test 块、既有断言语句未动」。
3. **旧断言不弱化**：engine/tool 既有断言语句未修改；新行为一律新增断言（T5/T6 承载）。
4. **P0 覆盖 + #4 边界**：`test/integration.test.mjs` 含 P0-A/B/C 各 ≥1 条回归断言且通过（修前语义下三条必红，实施时可先行在未修代码上跑一遍确红再修——红→绿即回归证据）；另含 #4 执法边界断言（runCap=2 时第 3 次 `agent()` → error、恰 2 个 → completed，防先增后判的 off-by-one 漏网）。
5. **回填完整（正向检查）**：`research/review-findings.md` 的 P1/P2 表已补『状态』列——#1-#14 共 14 条的『状态』单元格每条出现 ✅/📄/➡️ 之一，P0-A/B/C 三节各出现一处 ✅/📄/➡️ 状态标记；**不做『☐ 缺席』检查**（grep 实证全文 `☐` 仅 :3 图例一处，缺席检查恒真、形同虚设）；P2 六条均有本计划 §2 处置表对应的落点。

## 4. 风险与协调点

- **T2↔T6 语义耦合**（写集不交但行为相依）：T6 的断言以 T2 修后行为为准，两任务需同轮合入后才过验证门；T6 可先写、先在未修代码上跑出「预期红」作为基线证据。
- **R5**：`ctx.plugin(DwfWorkflowEngine, config)` 第二参传 config 是官方 workflow-ptc 同法（DESIGN §1.1/§1.3），桩已容；接入真实 cordis 时按 DESIGN 既定项首核该 API。
- **双连接写写并发**：T1 落地后同文件两连接（engine 写、tool 读）。MVP 工具读按需查询、写侧单写手汇聚于 JS 单线程（store.ts 注释语义），冲突窗口可忽略；接入真实宿主若出现锁竞争，届时改 WAL 或收口为单连接（记入 T7 的 DESIGN 注记，不在本轮扩做）。
