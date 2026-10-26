# dsh-dwf 评审发现清单（2026-10-25 两评审员 + 主会话复核确认）

> 修复实施的唯一输入。状态列由实施任务回填：☐待修 → ✅已修验证 / 📄仅文档 / ➡️defer 有理由。

## P0 接线断点（三处缝合处，必须全修）

### P0-A 引擎库错位（默认配置首 run 即抛）

> 状态：✅已修验证（T1，2026-10-25）——index.ts 改传 config；路径收口为 engine.ts 导出的 resolveJournalPath（apply 读侧与引擎写侧同一字符串）；构造器建库即 initSchema。验证：tsc --noEmit、smoke.mjs、stub-check.mjs、compile.test.mjs、engine+tool --test 五命令实跑退出码全 0；构造探针实证显式 dbPath 与空 dbPath（临时 cwd 落 ./dwf.db）两侧连接同库见 dwf_run。
- 现状：`src/index.ts:49` `ctx.plugin(DwfWorkflowEngine)` **不传 config** → 引擎吃 static Config 默认 `dbPath:''` → `src/engine/engine.ts:152` 落 `:memory:`；且引擎自建库**从未 initSchema**（全工程建表仅 index.ts:61 与 smoke.mjs）。工具侧 get/list 读的是另一个库 `./dwf.db`（index.ts:56-61）。
- 后果：默认配置下第一次 `beginRun` 即 `no such table: dwf_run` 同步抛，每个 run 都起不来；显式 dbPath 也只到 apply、到不了引擎。
- 修法方向：`ctx.plugin(DwfWorkflowEngine, config)` 传同一 config；引擎建库时 `initSchema`；工具读侧与引擎写侧指向同一 db 文件（单一事实源，engine 持有、tool 经配置路径开只读连接均可，二选一由 CTO 定）。

### P0-B 停滞/死锁 run 永不结算

> 状态：✅已修验证（T2，2026-10-25）——onComplete(ok:false) 存 completePayload 后走现成失败链 this.fail(error ?? 'workflow script failed')（fail → abort → signal 唤醒挂死的 await ptcRuntime.run），drive() catch 补 failReason 优先；成功路径零改动。验证：tsc/smoke/stub-check/compile/engine+tool 五命令实跑全绿；行为回归（真实 DwfWorkflowRun + vm 起完整 guest，fake PTC 仅在 signal abort 时收束）：park receiver + 停滞自查 → complete{ok:false, ChannelDeadlock} → run 以 error 结算，error 与 guest Deadlock 文案同源、不被 abort 文案盖掉。
- 现状：`src/engine/run.ts:437-450` `onComplete` 收 `{ok:false}` 只存 `completePayload` 就返回，不 fail、不 abort；而 `runProgram` 挂在 `await ptcRuntime.run`（真 PTC 下 suspended 脚本永不返回）→ run 挂到外部 cancel。engine.test.mjs:318-334 的 fakePtc 在 complete 后立即 return，掩盖了此断。
- 修法方向：`onComplete(ok:false)` 时走现成的失败链（对齐 dispatchReport 拒收 → onRunFailure → fail → abort 的做法）；成功路径维持现状（PTC 返回值结算）。

### P0-C `__start` 无人调用，args 到不了 guest

> 状态：✅已修验证（T2，2026-10-25）——assembleProgram 改为 prelude 后包 `return await __start(async () => {body})`，两种 programFormat 兼容（function-body 顶层 await/return 合法、repl 外层 async IIFE 内 return 合法，两者均实跑验证）；成功路径按拍板不补 __complete(true,value)，仍由 PTC 返回值结算。验证：行为回归实证 begin 被调用（修前恒 0）、args 经 begin 到达 guest（log 事件入账）、返回值结算 completed{seen:'v1'}、body 抛错经 __start 折 __complete(false) → P0-B 失败链结算。T7 补注（验证门第 6 条实跑发现，2026-10-25）：成功路径若紧随最后一个 request 结算即 return（如 `await report(...); return {...}`），prelude 停滞自查因 __settled 恒 false（成功路径不标记 settled）在程序收尾前误报 ScriptStalled → run 以 error 结算——本条拍板（不补 __complete(true)）与停滞自查「未结算」前提冲突，修法待裁定（原版 guest-prelude.js:175 成功路径有 __complete(true,value)；__start 包裹/args 到达半边不受影响已验证）。T6 文件头「新发现二」独立复核到同一竞态（探针互证），integration.test.mjs 的 P0-A 场景已改零请求脚本承载、report run 只断言 journal 落盘不断言其 stopReason。终态（2026-10-25 内核四缺陷轮 / D1，方案 b）：缺陷本体已修——`__start` 在 body 正常 resolve 后置 `__settled=true`（`src/guest/prelude.ts:183-186`），不补 `__complete(true)`，成功仍由 PTC 返回值结算（拍板表 P0-C 不变）。8 级级联来龙去脉与终态一句话：真机首例误报（两 ask 均 completed 后自查先于收尾触发 Stalled）后，停滞自查武装从 2 级加深到 8 级微任务作过渡（真停滞永无第 9 级事件、判定不受影响）——级联仅承担判定延迟，终态由方案 b 收口、成功收尾不再依赖微任务级数。T6 弱化的 run-2 `stopReason` 断言已恢复（`test/integration.test.mjs:302-306`）。终态修订（2026-10-25 闭环轮）：`__settled` 仅在 body resolve 且 `__pending===0` 且无停泊 channel 接收者时置位——fire-and-forget / 真 Deadlock 仍走停滞自查；`await-report-then-return` 误报窗口关闭。本会话验证：smoke 28/28、integration 含 D1 锁定回归全绿；真机 `closure-d1`（run 7c9e30bd）completed、failure_json=null、无 Stalled/Deadlock/EPIPE。
- 现状：`src/engine/run.ts:456-459` assembleProgram = realm+channels+prelude+body，**没有任何代码调用 `__start(...)`** → `begin` 绑定永不被调、`globalThis.args` 恒 `{}`、WorkerInit/limits 通道整条死。smoke.mjs:134 自己拼了 boot 所以测试绿。另：prelude `__start` 成功路径不调 `__complete(true,value)`（原版 guest-prelude.js:175 有），当前靠 PTC 返回值结算自洽——对齐与否由 CTO 定，但失败半边必须接通（关联 P0-B）。
- 修法方向：拼装改为 prelude 后包一层启动调用（如 `return await __start(async () => {\n${body}\n})`），注意 programFormat 两种形态与 body 顶层 await/return 语义；smoke 的 boot 写法可作参照。

## P1 正确性缺陷（应修）

| # | 问题 | 位置 | 修法方向 | 状态 |
|---|---|---|---|---|
| 1 | grep 上界 off-by-one：恰 2000 条被拒（facade 承诺 over 2000 才拒；glob 的 `>` 是对的） | effects.ts:403 | `>=` 改 `>` | ✅已修验证（T3：effects.ts:403 `>=`改`>`；探针实证恰 2000 条放行、第 2001 条 rejects（exceeded caps）；五命令实跑全绿） |
| 2 | detached HEAD 时 branch 返回 `"HEAD (no branch)"`（facade：absent） | effects.ts:431 | 解析失败/ detached 时返回 undefined | ✅已修验证（T3：effects.ts:433-439 detached「HEAD (no branch)」形态与解析空值均不带 branch 字段；真实 git 仓库探针实证 detached 时 keys 无 branch、main 分支 branch="main"） |
| 3 | description.ts:29 称「calling them (chart/…) fails the run」——实际声明静默通过、失败点在 tagged report | src/tool/description.ts:29 | 文案改为如实描述（声明被忽略、tagged report 报 defer 错） | ✅已修验证（T5：文案改如实——声明静默忽略、失败点在 tagged report；tool.test.mjs 新增断言验证，行为面 run.ts:403-406 / artifacts.ts:63-66 本就如此无需改） |
| 4 | runCap（默认 64）计算下发后 run.ts 零消费——纸面帽 | engine.ts:127-136→run.ts:74 | 要么在 ask 派发处执法（超帽 fail run），要么删除链路并在 DESIGN 记录；CTO 定 | ✅已修验证（T2：run.ts onDeclareActor 到达处执法，先判后计——进入时计数已 >= runCap 即第 runCap+1 个声明 fail run，恰 runCap 个放行；错误定性对齐 B7 重名 AGENT_START fatal；该计数兼为 ordinal 唯一来源。探针实证 runCap=2 第 3 个声明 → error「subagent cap exceeded: more than 2 agents in one run」、恰 2 个 → completed、runCap=1 恰 1 个放行不差一） |
| 5 | maxNodes/maxOpLength/maxArgs 孤儿（零消费者） | src/journal/caps.ts:9-11 | maxNodes 在 recordNode 或投影执法；另两码同理或删；CTO 定 | ✅已修验证（T4：maxNodes 落投影执法——节点查询 limit maxNodes+1 探测、超帽截 2000 并置 RunView.nodesUnlisted:true、恰帽缺省不带；maxOpLength/maxArgs 删除，grep 全仓零引用；tsc/smoke/stub-check/compile/engine+tool 全绿，2001 节点探针实证记账不阻断 nodesTotal=2001/展示=2000） |
| 6 | changedFiles 不按 workspace 过滤（facade：changes outside the workspace are not reported） | effects.ts:413+ | 加 pathspec/workspace 相对过滤 | ✅已修验证（T3：effects.ts:413-428 两条路径逐项 resolveWithinRoot 收口（withinRoot 判定半边抽出复用，抛错语义不变）；探针实证 `../` 与绝对路径形态条目丢弃、a..b.txt/./ 正常放行。注：实测 git porcelain/diff 输出恒为仓库根相对路径，子目录 workspace 下 `../` 形态不出现——过滤守门不误杀，详见 T3 报告） |
| 7 | `agent()` 未命名自动 label `"subagent N"` 可与显式命名碰撞误报 duplicate | prelude.ts:96 vs run.ts:423 | 自动 label 加保留前缀或宿主查重只对显式名 | ✅已修验证（T2：prelude declare-actor 事件加 named 标志（自动 label named:false、显式 named:true），宿主查重仅对 named!==false（缺省按显式，旧断言保形）；ordinal/actor-created 序改由声明计数承载，agentNames 仅司显式名查重。探针实证：自动 label 与显式 'subagent 1' 双向撞形均 completed 无误报、ordinals 1,2 不冻结、显式重名仍 duplicate fatal） |
| 8 | filled-hole 按 siteId 缓存 body：循环内第二 iteration 复用首次闭包，`let` 变量绑旧值 | prelude.ts:133-139 | 每次到达重新求值或文档声明限制；CTO 定 | ✅已修验证（T2：__holeFilled 删 __fills 缓存、每次到达现场求值（siteId 形参保留，lower.ts:155 发射形不变）；探针实证循环内 filled hole（let i 绑定）返回 [0,1] 而非修前缓存闭包的 [0,0]） |

## P2 文案/承诺错配（CTO 三选一处置：实现 / 文档声明差距 / defer 并记录）

| # | facade/文案承诺 | 现状 | 状态 |
|---|---|---|---|
| 9 | report 的函数/Date/promise 是 compile errors（facade.d.ts:57-59） | 零编译诊断，运行时 MaterializeError 可 catch | 📄仅文档（T5：description.ts:28 已改运行时拒收可 catch 语义；编译期 JSON 安全诊断按 FIX-PLAN §2 defer，T7 于 DESIGN §6.2 声明） |
| 10 | phase Required / standalone / 每相位≥1 ask 或 world.run（facade.d.ts:150-152） | 零强制（无 phase 脚本照跑） | 📄仅文档（T5：description.ts:26 保留 9013 字面量执法，REQUIRED/standalone/每相位≥1 软化为本版不强制；相位×效应点诊断 defer） |
| 11 | worldCommands「shown to the user at confirmation」+ phaseNames 列表展示 | 编译产出零消费（engine.ts:165 只取 body/diagnostics） | ➡️defer 有铁证（闭环轮 2026-10-25）：数据面已就绪（compile 探针 `phaseNames=["p"]`/`worldCommands=["node"]`）；npx 闭包 `@deepseek-ai/*` 无确认对话/展示 API 可接（grep worldCommands/phaseNames 于 dsh-workflow*/lib 零命中）。维持 defer 至宿主提供确认面 |
| 12 | artifact「Bytes are copied at publish time / cards kept after ends」 | journal 有 path/bytes；无宿主卡片目录约定 | ➡️defer 有铁证（闭环轮）：journal 事实面完整；宿主闭包无 artifact card / 数据目录约定 API。维持 defer |
| 13 | report items「reach the completion notification even when run fails」 | item 落 dwf_node.input_json；无通知通道 | ➡️defer 有铁证（闭环轮）：item 可投影消费；宿主闭包无 completion notification API。维持 defer |
| 14 | grep「ripgrep-compatible」 | JS RegExp 近似，`{a,b}` 不支持（代码注释自认） | 📄仅文档（T5：description.ts:31 注明 JS RegExp 近似与 glob */**/? 子集、{a,b} 不支持；对齐 rg 二进制语义 defer） |

## 测试盲区（必须补：缝合处集成测试）

> 状态：✅已修验证（T6，2026-10-25）——`test/integration.test.mjs` 已建：初版 7 测试（P0-A/B/C 三条 P0 回归 + #4 先判后计边界 + #7/#8/#5 附带），验证门第 6 条实跑退出码 0；本轮增至 10 测试（+D1 锁定回归等）。红→绿基线证据：三份 scratch 副本分别只回退被测修复（P0-A 引擎建库 / kernel=P0-B+P0-C+#4+#7+#8 / #5 投影帽）跑同一份测试——P0-B 修前 30s 超时红（永不结算实证）、P0-C#4/#7/#8 修前各自断言红、#5 修前红，修后全绿；P0-A/#5 在 kernel 基线保持绿（红因归位）。回报告两条新发现：①facade `channel()/future()` 无运行时绑定（guest realm 仅 `__channel`/`__future`，脚本调用必 ReferenceError，P0-B 场景以 `eval('__channel')` 同构替代）——已修（D2，`channels.ts:86-88` 直供 channel/future 裸名；`eval('__channel')` 探针场景按 reg-integration 豁免保留原样，未换回裸名；本会话 `node --import ./test/runtime-stubs.mjs --test test/channels.test.mjs` → EXIT=0、ℹ tests 4 / pass 4）；②停滞自查与成功路径竞态（已记 P0-C 状态行）——已修（D1），见上方 P0-C 状态行终态。integration.test.mjs 场景细节见该文件头注释（跨 realm 物化、纯 JS 脚本约束）。

新增 `test/integration.test.mjs`（node --import ./test/runtime-stubs.mjs --test），fake PTC **真实执行** assembleProgram 产物（node:vm 起完整 guest），至少覆盖三条 P0 回归：
- args 经 begin 到达 guest（P0-C 回归）；
- 停滞脚本（park receiver 无在飞）run 以 error 结算且不挂起（P0-B 回归）；
- engine.start 全流程落同一 db（journal 行可从 get/list 投影读到，P0-A 回归）。
既有断言冻结（AGENTS.md 考卷纪律）：smoke/compile 不得改；engine/tool 旧断言不得弱化，新增行为加新断言。

## 内核四缺陷轮（2026-10-25）

> 闭环轮终态（2026-10-25）：本机门禁全绿——tsc/smoke 28/28/stub/unit(含 channels+worker-exit+integration)/gate 32/32。真机 headless 复跑通过：`closure-d1` run `7c9e30bd`（await-report-then-return）completed 无 Stalled；`closure-ask2` run `29fe57f0` reply=pong。D4 已热部署到 `profiles/personal/node_modules/dsh-workflow-gate/lib/report.js`（homedir 回落，探针 NO_CWD_FALLBACK）。另收口：ask 成功/失败路径补发 `node-settled`（effects.ts，修前 journal 有 ask 行无 settled 事件）。

### D1 成功路径停滞误报（方案 b）

> 状态：✅已修验证（本轮，integration 锁定回归实跑；smoke 冻结考卷残余见下）——`src/guest/prelude.ts` `__start` 在 body 正常 resolve 后置 `__settled=true`（:183-186），不调 `dwfHost.complete`，成功仍由 PTC 返回值结算；`__queueStallCheck` 保持 8 级，注释改为「级联仅判定延迟 / 误报守卫是 __settled」（:32-39）。T6 弱化的 P0-A run-2 `stopReason` 断言已恢复（`test/integration.test.mjs:302-306`）；新增 D1 锁定回归（:270-287，`settleDelayMs:5` 钉死自查先开火顺序）。验证：`node --import ./test/runtime-stubs.mjs --test test/integration.test.mjs` → EXIT=0、pass 10（含「D1 回归：脚本体 await 请求后立即 return」）。残余：`node test/smoke.mjs` → EXIT=1（② group 无 await 发完即 return，D1 置 settled 后不再发 ScriptStalled complete，冻结 smoke 收尾 `until(completes)` 超时）——D1 本体锁定回归绿，冻结考卷未改。

### D2 facade `channel()`/`future()` 裸名绑定

> 状态：✅已修验证（本轮）——`src/guest/channels.ts:86-88` 直供 `function channel(name)` / `function future(body)` 包装 `__channel`/`__future`（facade stay-direct，不经 lowering）。`test/channels.test.mjs` 覆盖裸名 round-trip / for-await break / future 同步抛 / 与 `__channel` 同一性。integration P0-B 场景的 `eval('__channel')` 按 reg-integration 豁免保留原样（未换回裸名）。验证：`node --import ./test/runtime-stubs.mjs --test test/channels.test.mjs` → EXIT=0、ℹ tests 4 / pass 4。

### D3 worker-exit 裸 EPIPE 折叠

> 状态：✅已修验证（本轮，单测实跑；真机 neg 复跑未跑）——链路证据：`dsh-ptc-runtime-node/lib/index.js:1173` `stream.on("error")` → `this.fail("worker-exit", error.message)`（裸 `write EPIPE`，先结算者胜）vs `:1135-1136` `exitMessage` / `:1189` 退出汇总路径内嵌 stderr。折叠契约（`src/engine/run.ts:563-599` `WORKER_EXIT_PREFIX` + `cleanWorkerExitMessage`）：两形态统一前缀 `workflow worker exited before settling: `；原文全文保留（含字面 `write EPIPE`）；有 logs 则附 worker output tail，无则明示未捕获（绝不伪造 stderr）。编译器既有缓解保留：`src/compile/compiler.ts:84-93`（transpile 剥 TS，避免 strip 路径解析崩；注记指向本折叠）。真机首例 run `07770553`（`smoke-neg`）修前 `failure_json`=`workflow execution failed (worker-exit): write EPIPE`（本会话 DB 实查仍为修前值）。验证：`node --import ./test/runtime-stubs.mjs --test test/worker-exit.test.mjs` → EXIT=0、ℹ tests 6 / pass 6。

### D4 gate `reportRoot` cwd 漂移

> 状态：✅已修验证（本轮，单测实跑；宿主重部署落盘本会话未复证）——漂移证据：相对 `reportRoot`（schemastery 缺省 `.dsh/workflow-gate`）曾按进程 cwd 解析；`<plugin-root>/.dsh/workflow-gate/` 恰 22 个漂移 jsonl（本会话 `ls | wc -l`=22）；真机首例 run `dce351d7` 审计未落预期根（integration-report 原 :105）。修复契约（`dsh-plugins/dsh-workflow-gate/src/report.ts:28-33` `resolveReportRoot`）：相对路径锚定 `$DSH_HOME`（绝对时），否则回落用户主目录（`homedir()`）——**明示永不回落 `process.cwd()`**（`tests/report-root.test.mjs:59-63`）；与早期「回落 cwd」草案不同，以源码+测试为准。已部署 `lib/report.js:76-78` 仍为 `$DSH_HOME`/回落 `process.cwd()`（mtime 早于 src）——重部署步骤：在 `dsh-plugins/dsh-workflow-gate` 跑 `npm run build` → 确认 profile 链到新 lib → 带 `export DSH_HOME='<DSH_HOME>'` 重启 dsh web → 再跑 gate 工作流，断言 JSONL 落 `$DSH_HOME/.dsh/workflow-gate/<runId>.jsonl`（本会话该目录尚不存在）。边界注记：gate `GUIDANCE` 文案（`src/index.ts:62+`）与 README「相对 → parent session cwd」表述**不改**（本轮写集未含文案；行为以 `resolveReportRoot` 为准）。验证：`node --test tests/report-root.test.mjs`（cwd=`<gate-plugin>`）→ EXIT=0、ℹ tests 5 / pass 5；`node --test tests/report.test.mjs` → EXIT=0、pass 6。

## 验证门（全量六命令，退出码全 0 才算过）

```
node E:\os\dsh-dwf\node_modules\typescript\bin\tsc --noEmit -p E:\os\dsh-dwf\tsconfig.json
node E:\os\dsh-dwf\test\smoke.mjs
node E:\os\dsh-dwf\test\stub-check.mjs
node --test E:\os\dsh-dwf\test\compile.test.mjs
node --import E:\os\dsh-dwf\test\runtime-stubs.mjs --test E:\os\dsh-dwf\test\engine.test.mjs E:\os\dsh-dwf\test\tool.test.mjs
node --import E:\os\dsh-dwf\test\runtime-stubs.mjs --test E:\os\dsh-dwf\test\integration.test.mjs
```
