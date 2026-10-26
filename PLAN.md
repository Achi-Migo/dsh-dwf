# dsh-dwf 自闭环迭代方案（PLAN）

- 日期：2026-10-24。拍板：CTO 会话（本文件唯一产出）。
- 输入：`DESIGN.md`（现行版）、`research/dsh-contract-v2.md`（真实源码形状取证）、`research/gap-audit.md`（差距审计）、`research/mechanism-map.md`（实现清单）。
- 本会话基线实测（计划内引用的证据，全部当日执行）：
  - `find /e/os/dsh-dwf -type f -not -path "*/node_modules/*"` → 27 文件，树内缺 20 个源文件（gap-audit §1.2 名单逐个确认在盘上不存在）。
  - `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → 6 错 3 类（protocol.ts×4 Json 未导入、store.ts:140 绑定类型、json.ts:52 Object.entries），与 gap-audit §2 基线一致。
  - `node --version` → v24.20.0；`node -e "...new DatabaseSync(':memory:')" ` → node:sqlite 免旗标可用。
  - `grep -rn "from '@deepseek" src/`（排除 import type）→ 仅 `src/util/errors.ts:3` 一个官方包**值**导入——journal/guest/util 三簇可脱离 dsh 宿主直跑（冒烟可行性前提）。
  - `node -e "import('./src/journal/store.ts')"` → **FAIL: TypeScript parameter property is not supported in strip-only mode**（store.ts:46 `constructor(private readonly db…)`）；schema.ts/projection.ts 直跑 OK。→ node 24 type-stripping 只吃**可擦除 TS 语法**，这是冒烟方案的硬约束。
  - `ls node_modules/@deepseek-ai/` → **No such file or directory**（同级 `typescript` 存在，对照成立）；`node -e "import('./src/util/errors.ts')"` → **FAIL: Cannot find package '@deepseek-ai/dsh-llm' imported from …/errors.ts**——评审 B2 复核成立：errors.ts:3 的值导入在运行时不可解析（peers 全量 optional，npm 不装）。
  - `node --import <14 行 resolve 钩子> -e "import('…/src/util/errors.ts')"` → **OK: DwfError = function**（最小 `HarnessError` 替身模块，/tmp 实验后已清理）→ **拍板：官方包值导入保持不变**（DESIGN §5.1/§5.3 的 specifier 承诺），运行时验证统一走 `--import` 模块替身，由 T2 立项 `test/runtime-stubs.mjs`。

---

## 0. 结论摘要

- 缺 20 个源文件分三簇落码：编译层（T5，6 文件）→ 引擎层（T6，6 文件）→ 工具层+入口（T7，8 文件）。
- 现役 11 文件的 6 错 + 全部已落码面偏差一次性修完（T2），方向按 §2 拍板表，不留「偏差待议」。
- 桩链断裂（gap-audit §3.13：双文件相对 declare module + skipLibCheck 静默 any）按 DESIGN §2/§5.2 单文件合并修复，并把 ptcRuntime 等 4 个 specifier 从调用点反推换成 contract-v2 §1–§5 **核实形状**（T1）。
- 两个必含验证件：`test/stub-check.mjs` 桩正反向自检（T3）、`test/smoke.mjs` 无宿主冒烟（T4，node:vm 假 dwfHost + node:sqlite 内存库）。
- 自迭代回路边界：类型门每任务 ≤5 轮、冒烟/桩自检各 ≤3 轮，超限即停如实上报（§4）。
- **全局不变式（评审 B3 升格）**：① `src/**/*` 一律**可擦除 TS 语法**（无构造器参数属性/enum/namespace，store.ts:46 即反例）——T5/T6/T7 新落码文件同样受约束，否则 node:test 直跑验收加载即炸；② **测试依赖面零官方包值导入**：journal×4 + guest×3 + `util/json.ts` 不得 import 任何 `@deepseek-ai/*` 值（`import type` 允许，strip 后无运行时痕迹）——保 T4 冒烟免替身直跑；③ 官方包值导入只允许存在于 `util/errors.ts` 与 T6/T7 新文件，运行时经 `test/runtime-stubs.mjs` 替身解析。

## 1. 拍板原则（偏差修复方向表）

原则一句话：**正确性与安全类偏差改实现对齐 DESIGN/原件；实现更优且已自洽的回写 DESIGN 文本；逆向原件（assets/）与 facade.d.ts 是唯一事实源，优先级最高。**

| # | 偏差（gap-audit 节） | 方向 | 一句话理由 |
|---|---|---|---|
| 1 | args 未浅冻结（§3.2） | 改实现 | DESIGN §3.3 与原件 guest-prelude.js:108 双源一致要求 |
| 2 | realm Date 全禁（§3.4） | 改实现收窄回三点 | DESIGN §3.3 与原件 :181-201 一致：只禁 Date.now/argless new Date/Math.random；`new Date(ts)`/`Date.parse` 透传不破坏重放 |
| 3 | async iterator 丢 `return()`（§3.3） | 改实现 | for-await 中途 break 的收尾路径，原件 :69-71 有 |
| 4 | json.ts undefined 裸崩（§3.11） | 改实现 | 真实 bug（基线错③即其症状），改抛 MaterializeError、签名收口 `Json` |
| 5 | model() 键名 `__modelRef`（§3.2） | 改实现→`modelRef` | facade.d.ts:5（唯一事实源）声明 `modelRef` |
| 6 | `__start` 无 catch 折算（§3.2） | 改实现 | 原件 :172-179 折 `complete{ok:false}`，不能隐式推给未落码 run.ts |
| 7 | protocol 形状（WorkerInit/GuestRequest/GuestComplete、declare-actor、微任务停滞检测，§3.1/§3.2） | 回写 DESIGN | siteId 对齐 journal、begin 承载 meta/args/limits 是有意重设计且自洽；事件名统一 `declare-actor`（改 protocol.ts 类型层与 prelude:112 对齐后回写） |
| 8 | agent 名字查重 guest 侧 vs DESIGN 宿主侧（§3.2） | 双层，回写 DESIGN | T6 按 B7 定稿实现宿主 run 级注册表；guest 守卫保留作第二道 |
| 9 | ordinal per-site 序（§3.6） | 回写 DESIGN | DDL 原文 UNIQUE(run_id,site_id,ordinal) 本就是 per-site 语义；全序由 dwf_node.id 承担（projection.ts:71 现状） |
| 10 | 无 writerFor/计数器滞留（§3.6） | 改实现 | 恢复 DESIGN §3.4 `writerFor(runId): RunWriter` 形态，结算丢弃计数器条目 |
| 11 | projection 直读 dwf_node（§3.7） | 回写 DESIGN + 补帽 | dwf_node 本身持久，「可重建」承诺等价；但 `maxNodes=2000` 帽 + `nodesUnlisted` 是明确承诺，必须补 |
| 12 | caps 四键名（§3.8） | 改实现对齐 DESIGN 字面 | DESIGN 是评审定稿基准；两处引用改键名成本最低 |
| 13 | package.json：缺 4 peer、exports types 指 src/index.ts（§3.14） | 改实现 | B3 收尾 + §1.2 字面 |
| 14 | DESIGN §5.1（:607）写 `WorkingDirectory`（类型：cwd），contract-v2 §4（:130-139）核实的类名是 **`WorkingDirectoryService`**（get/ensure/set 挂其上） | 桩按 contract-v2 落 + T8 回写 DESIGN §5.1 | 类名照 DESIGN 写必 TS2305；contract-v2 是逐行读源码的取证，DESIGN 该行是 v1 转写残名 |
| 15 | `ObjectJsonSchema` 在 DESIGN §5.1 import 表（:597-611）无来源 specifier（dsh-tools 行只列 defineTool/ToolDefinition/ToolExec），contract-v2 §6.2/§6.6 明示定义体不在镜像内 | 桩内归属 `@deepseek-ai/dsh-tools` specifier、占位形状 + 标注外部假设 | 桩不给落点则 T5 下沉 schema 时 TS2305 或私造类型；现桩 dsh.d.ts:108-113 已有形状，保留并注明「外部假设，接入真实 dsh-tools 时校」 |
| 16 | journal/schema.ts DDL 松弛（gap-audit §3.5）：dwf_run 的 caps_max_concurrency not null / spent_tokens default 0 / status 五值 CHECK 丢，dwf_event payload_json 放松可空，session_task_link 的 NOT NULL 列与 unique(child_session_id) 丢，dwf_run_cwd_idx / dwf_event_artifact_idx 两索引丢 | 改实现对齐 DDL 原文（T2） | assets/journal-schema.sql 是唯一事实源，MVP 建表一次成型无放松理由；status CHECK 是将来 resume 语义的承重约束；`if not exists` 幂等化保留（语义等价）；指向五表外实体的外键以注释保留（MVP 空表不接线） |
| 17 | journal/store.ts `recordActor` 是 DESIGN RunWriter 接口外的附加方法（gap-audit §3.6） | 保留并收编进 RunWriter 接口 + 回写 DESIGN §3.4（T2 改码、T8 回写） | gap-audit 原文「store 兼办可接受」；收编比搬移便宜，接口面与文档一次对齐 |
| 18 | node 生命周期事件（node-queued/dispatched/executing/waiting/settled）当前无任何发射点、store 亦无发射辅助（gap-audit §3.6），DESIGN §3.4 MVP 词表承诺落空风险 | T6 effects 必须实现五态发射（分派经 RunWriter 发 node-queued→dispatched→executing→waiting→settled）；T4 断言⑤以手工 append 验 projection 对账、T6 单测验 effects 真实发射 | 发射方是 effects（§4 数据流），T4 依赖序在 T6 前，故 T4 只验记账/投影半环、T6 验发射半环，两段拼成闭环——不留「待议」 |

---

## 2. 任务拆分

> 依赖序与文件集：**T1 ∥ T2 可真并行**（触碰集不相交：T1 只动 stubs/，T2 只动 src 现役 11 文件+package.json）→ T3 ← T1；T4 ← T2；T5 ← T1（与 T2 无文件交集）；T6 ← T1+T2+T4；T7 ← T6；T8 ← 全部。
> **类型门两级语义（评审第二轮修订）**：基线 6 错归 T2 修复，故 T1/T5 的类型门适用**中间门**——`tsc --noEmit` 错误输出**恰等于** §1 基线 6 错清单（protocol.ts×4 TS2552 / store.ts:140 TS2769 / json.ts:52 TS2769，按 文件+错误码 匹配，零新增零漂移；T1/T5 不触碰这三文件，行号稳定），不要求 EXIT=0；T2/T6/T7 及 T8 终验适用**终验门** EXIT=0 零输出。中间门防的是「桩/编译层落码引入新错」，不会诱导执行者越界修 T2 名下文件，也不会误标 BLOCKED。
> 每任务完成态必须附实际命令与关键输出；空嘴不算完成。

### T1 桩单文件合并 + contract-v2 核实形状
- **path**: `stubs/dsh.d.ts`
- **spec**: 删除 `stubs/dsh-inline-shapes.d.ts`，按 DESIGN §2/§5.2 合并为单文件 ambient 桩：workflow 词汇整体内联进 `declare module '@deepseek-ai/dsh-workflow'`（消除 gap-audit §3.13 实证的 TS2436/TS2439 断裂链）。把 4 个 specifier 的桩从「调用点反推」换成 research/dsh-contract-v2.md 的**核实形状**，桩内注释标 contract-v2 行号出处：`@deepseek-ai/dsh-ptc-runtime`（§1：PtcRuntime 抽象类 9 成员 + PtcRunRequest/Spec/Result/Failure/Sandbox 全字段 + PtcBindingNamespace 等 4 绑定类型）、`@deepseek-ai/dsh-sandbox`（§2：SandboxMode 三值/SandboxExecutionPolicy/SandboxPolicy/SandboxProvider.confine）、`@deepseek-ai/dsh-sandbox-policy`（§3：SandboxPolicyService 全成员含 resolve 优先级）、`@deepseek-ai/dsh-working-directory`（§4：类名 **`WorkingDirectoryService`**——拍板表#14，DESIGN §5.1:607 的 `WorkingDirectory` 是残名照写必 TS2305；get/ensure/set 三方法签名 :122-170）。subagent 段按 §5 修正：SubagentStartRequest 补必填 `signal`、`prompt: ContentBlock[]`、`label?`，SubagentActivation/SubagentResult 按源码形状；**`getProvider` 不进桩**（contract-v2 §5.1 的 SubagentRuntime 公有面无此成员，见 §5 风险 R2）。`ObjectJsonSchema` **归属 `@deepseek-ai/dsh-tools` specifier 的桩**（拍板表#15：DESIGN §5.1 import 表无来源、contract-v2 §6.2/§6.6 明示定义体是外部假设——保留现桩 dsh.d.ts:108-113 形状并注明「占位，接入真实 dsh-tools 时校」，T5 的 schema.ts 下沉与 T6 的 outputSchema 都从它取型）。补 DESIGN §5.2 点名的 `Context.plugin(...)` 成员与两个 declare module 扩充（`Context.workflowEngine` 照 workflow-seam/index.ts:31-34、`JobKindMap['workflow']` 照 tool-workflow/index.ts:34-38）。
- **验收**: ① **类型门（中间门）**：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 错误输出恰等于 §1 基线 6 错（protocol.ts×4 / store.ts:140 / json.ts:52——均 T2 名下，T1 不触碰），零新增；EXIT=0 由 T8 终验；② `... --listFiles -p tsconfig.json | grep -E "stubs|facade"` 含 `stubs/dsh.d.ts` 与 `assets/facade.d.ts` 两行、`grep inline` 无结果；③ 桩内 4 个新 specifier 段各有 contract-v2 行号注释（`grep -c "contract-v2" stubs/dsh.d.ts` ≥4）；④ `grep -c "WorkingDirectoryService" stubs/dsh.d.ts` ≥1 且 `grep -n "interface WorkingDirectory\b" stubs/dsh.d.ts` 无结果；⑤ 桩内 ObjectJsonSchema 注释含「外部假设」标注（`grep -c "外部假设" stubs/dsh.d.ts` ≥1）。
- **轮次上限**: 类型门 ≤5 轮。

### T2 现役文件偏差修复 + 类型门归零
- **path**: `src/guest/protocol.ts`（连带：json.ts、store.ts、schema.ts、realm.ts、prelude.ts、channels.ts、caps.ts、types/index.d.ts、package.json、**test/runtime-stubs.mjs（新）**、DESIGN.md §3.3/§3.4 文本回写）
- **spec**: ① 六错归零：protocol.ts 补 `import type { Json } from '../util/json.ts'`（或本地定义，与 json.ts 单一来源）；json.ts 顶层 undefined 改抛 `MaterializeError`、返回签名收口 `Json`（拍板表#4）——**`MaterializeError` 在 json.ts 本地定义，json.ts 不得 import errors.ts 或任何官方包**（冒烟依赖面零官方值导入，全局不变式②）；store.ts:140 绑定改传 JSON 文本。①b **schema.ts DDL 对齐（拍板表#16）**：补回 dwf_run 三约束（caps_max_concurrency not null / spent_tokens not null default 0 / status 五值 CHECK）、dwf_event payload_json not null、session_task_link 的 NOT NULL 列与 unique(child_session_id)、dwf_run_cwd_idx 与 dwf_event_artifact_idx 两索引；`if not exists` 保留；指向五表外实体的外键以注释保留。①c **store.ts `recordActor` 收编（拍板表#17）**：RunWriter 接口正式含 recordActor（与 beginRun/appendEvent/recordNode/settleRun 并列），writerFor 形态不变。② 拍板表 #1/2/3/5/6/12/13 全部落码：realm Date 三点禁令；args 在 prelude `__start` 赋值处 `Object.freeze` 一层；channels iterator 补 `return()`；prelude `modelRef` 键名（personaOf :84 同步改）；`__start` 补 catch → `__complete(false,…)`；caps 四键名（gitDiffBytes/gitLogCommits/artifactTitleChars/artifactDescriptionChars）对齐 DESIGN §3.4；package.json 补 `@deepseek-ai/dsh-sandbox`/`dsh-sandbox-policy`/`dsh-working-directory`/`dsh-ptc-runtime` 4 peer、`exports["."].types` 改 `./src/types/index.d.ts`、`typecheck` 改 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`。③ **可擦除语法约束（本会话实测）**：journal/guest/util 全簇改掉参数属性（store.ts:46 改显式字段赋值）与一切 enum/namespace（全局不变式①）。④ **`test/runtime-stubs.mjs` 直跑替身（评审修订3/B2 立项）**：`module.register` 的 resolve 钩子把 `@deepseek-ai/dsh-llm` 映射到 `test/runtime-stub-values/` 下最小 `HarnessError` 值实现（本会话 /tmp 已实证该机制让 errors.ts 直跑 OK）；映射表可被 T6/T7 扩展（届时补 dsh-workflow 的 WorkflowEngine 基类/WorkflowRunId/WorkflowError、cordis 的 Service、dsh-tools 的 defineTool、schemastery 的 z）；替身只服务 node 直跑/单测，不进 tsc 程序。⑤ protocol.ts `GuestEventType` 收口 `'declare-actor'`（与 prelude.ts:112 一致）；`types/index.d.ts` 的 `artifact-failed` 保留并在 DESIGN §3.4 词表回写。⑥ DESIGN.md 拍板表 #7/8/9/11 文本回写。
- **验收**: ① **类型门（终验门）**：tsc EXIT=0 零输出；② `node --import ./test/runtime-stubs.mjs -e "import('./src/journal/schema.ts')"` 与 store/projection 及 guest×4 无错，`util` 三件同法（errors.ts 必须经替身——已实证）；③ `node -e "import('./src/journal/store.ts')"` 等不经替身也全 OK（journal/guest/json.ts 零官方值导入的证明）；④ `grep -rnE "constructor\(\s*(private|public|protected|readonly)|^\s*(enum|namespace) " src/` 无结果；⑤ `grep -n "__modelRef" src/` 无结果、`grep -c "Object.freeze" src/guest/prelude.ts` ≥1；⑥ `grep -n "dsh-sandbox-policy\|dsh-ptc-runtime" package.json` 有 4 peer 命中；⑦ `grep -n "import.*errors" src/util/json.ts` 无结果；⑧ DDL 对齐：`node -e "…initSchema 后 db.prepare(\"select sql from sqlite_master where name='dwf_run'\")…"` 输出含 `status` CHECK 与 `caps_max_concurrency not null`，且 `grep -c "not null" src/journal/schema.ts` ≥6（拍板表#16）；⑨ `grep -n "recordActor" src/journal/store.ts` 出现在 RunWriter 接口成员清单内（拍板表#17）。
- **轮次上限**: 类型门 ≤5 轮。

### T3 桩正反向自检脚本（必含任务）
- **path**: `test/stub-check.mjs`
- **spec**: 自包含 node 脚本，三断言：① **正向**——对主工程跑 `tsc --noEmit --listFiles -p tsconfig.json`，断言输出含 `stubs/dsh.d.ts` 与 `assets/facade.d.ts`（DESIGN §7.1 步骤 3）；② **反向（评审 B1 修订：改探针临时工程，不依赖主工程导入方）**——临时目录组装探针工程，其源文件 import **桩覆盖的全部 specifier 清单**（dsh-workflow/cordis/dsh-agent/dsh-session/dsh-subagent/dsh-tools/dsh-system-prompt/dsh-sandbox/dsh-sandbox-policy/dsh-working-directory/dsh-jobs/dsh-llm/schemastery），先带桩跑断言 0 错、再生成去掉 stubs include 的配置跑同工程，断言**每个 specifier 各报一条 TS2307**——主工程不能作此断言：T3 依赖序在 T6 前，届时 src 只有 errors.ts→dsh-llm 一个导入方（偶然兜底、覆盖率 1/13），探针工程把断言从「报了错」升格为「逐 specifier 全覆盖」；跑完清理。③ **any 探针**——同一探针工程带桩跑 `const x: WorkflowEngine = 42`，断言必须报 TS2322——堵死「桩在但退化 any」的假通过；同法断言 `import { z } from '@deepseek-ai/schemastery'` 可编译（§3.13 未验证项，若 fail 由 T1 轮次内修桩）。注：评审 B1 的「届时 tsc 仍 EXIT=0」前提不准确——errors.ts:3 值导入 dsh-llm（本会话 grep 实证）+ 桩 :171 有该 declare module，去桩后主工程会报 1 条 TS2307；但仅此一条，探针方案仍按上述理由采纳。
- **验收**: ① `node test/stub-check.mjs` EXIT=0、三断言全 PASS；② 反向自有效性：临时删掉桩内 `WorkflowEngine` 导出重跑必须 FAIL（验证后还原）；③ 报告每条断言的实际命令与退出码。
- **轮次上限**: ≤3 轮。

### T4 无宿主冒烟（必含任务）
- **path**: `test/smoke.mjs`
- **spec**: 不起 dsh 宿主、纯 node 进程（node 24 默认 type-stripping 直跑 src TS；T2 已保证全簇可擦除语法）。guest 侧：从 `src/guest/{realm,channels,prelude}.ts` 用正则 `String\.raw\`([\s\S]*)\`` 抽源（三文件零 import、每文件恰一个 String.raw 且内容无裸反引号——raw 抽取与字符串值确定等价），`node:vm` 建 context 注入假 `dwfHost` 四绑定 `{begin, request, event, complete}`（形状按 protocol.ts + prelude.ts:27-48），program = realm+channels+prelude+测试体。journal 侧：`node:sqlite` `:memory:` 库 + `initSchema` + `JournalStore` + `projection` 直 import——**冒烟依赖面（journal×4+guest×3+json.ts）零官方包值导入（全局不变式②，本会话 grep 实证现状即满足；T2 的 MaterializeError 落 json.ts 本地维持该前提），故冒烟命令不带 `--import` 替身**。断言五组：① **FIFO**——同 actor 两次 ask乱序回包仍按提交序结算；② event 与 request 共享 FIFO（declare-artifact 不被后发 report 超车）；③ **停滞检测**——park 一个 channel receiver 且无在飞请求 → `complete{ok:false}` 且 `error.name === 'ChannelDeadlock'`（prelude.ts:60-63）；④ **Date/random 禁令**——realm 内 `Date.now()`/`new Date()`/`Math.random()` 抛错、`new Date(0)` 透传可用（拍板表#2 后的语义）；⑤ **journal 往返**——beginRun→appendEvent→recordNode→settleRun 后 `runProjection`/`listRuns` 与写入的 sequence/ordinal/status 逐字段对账；node-* 事件以**手工 append** 含五态（node-queued/dispatched/executing/waiting/settled）的事件序列喂入验 projection 对账（拍板表#18 的记账/投影半环——发射半环在 effects，由 T6 单测覆盖，T4 依赖序不等到 T6）。另断言 complete 幂等（二次调用不重复结算，prelude.ts:45-46）。package.json `scripts.smoke` 自此生效。
- **验收**: ① `node test/smoke.mjs` EXIT=0、五组断言 + 幂等断言全绿；② 反向自有效性：临时注释 realm 源注入行重跑，**断言④必须 FAIL、断言③预期仍 PASS**（评审第二轮修订：停滞检测逻辑在 prelude.ts:29-33/60-63、receiver 停泊在 channels，均不经 realm 的任何全局——只有 Date/random 围栏在 realm）；断言③的独立反向自检另测：临时改坏 prelude 的 `ChannelDeadlock` 错误名重跑，断言③必须 FAIL（两处验证后均还原）；③ `grep -rn "from '@deepseek" src/journal/ src/guest/ src/util/json.ts | grep -v "import type"` 无结果（依赖面零官方值导入的回归守卫）；④ 报告各断言实际输出。
- **轮次上限**: ≤3 轮。断言一经定稿即冻结（§4）。

### T5 编译层落码
- **path**: `src/compile/compiler.ts`（连带 diagnostics.ts、literals.ts、schema.ts、phase-graph.ts、lower.ts 六文件全落）
- **spec**: 按 DESIGN §3.2 全部签名：`compileWorkflow(source, facade)` 用 `createProgram` 合成 facade.d.ts + 用户 interface（strict、noUncheckedIndexedAccess:false；TS pin 5.9.3——§7.1 前置已实测 7.x 库 API 不可用）；诊断三族：9012 hole 规则 + phase 名/artifact id/world.run cmd/agent 名 string literal + agent 名字重复编译错（facade.d.ts:37-38）；lower：facade 调用点 → `__host.*`/prelude 原语调用，siteId=调用点序号，hole 站点 FNV-1a 内容寻址（复用 util/fnv1a.ts），`ask<T>` 的 T 经 checker 查询转 ObjectJsonSchema 字面量下沉（schema.ts，类型取自 T1 桩的 dsh-tools specifier——拍板表#15）；`model()` 不 lowering（§3.2 特别映射）；抽 `phaseNames`/`worldCommands`。修 gap-audit §4 B6。**六文件全部可擦除 TS 语法**（全局不变式①：无参数属性/enum/namespace）。
- **验收**: ① **类型门（中间门）**：`tsc --noEmit` 错误输出恰等于 §1 基线 6 错（均 T2 名下，T5 不触碰 src/guest、src/journal、src/util），零新增；EXIT=0 由 T8 终验；② node:test 单测（`test/compile.test.mjs`，node:test + strip-types 跑 .ts 被测件）断言：合法脚本零诊断且 lowering 产物含 `__host.ask(` 调用形；phase 名非字面量、agent 重名各报恰一条诊断；hole 站点 id 形如 `hole#xxxxxxxx`；③ 单测全绿附输出；④ compile×6 不触发 `grep -rnE "constructor\(\s*(private|public|protected|readonly)|^\s*(enum|namespace) " src/compile/`。
- **轮次上限**: 类型门 ≤5 轮。

### T6 引擎层落码
- **path**: `src/engine/engine.ts`（连带 run.ts、scheduler.ts、actor.ts、effects.ts、artifacts.ts 六文件全落）
- **spec**: 按 DESIGN §3.5：`DwfWorkflowEngine extends WorkflowEngine`，`static inject = ['subagents','ptcRuntime','sandboxPolicy','workingDirectory']` 与 `static Config` 成对；start() 六步流水线（validateMeta→编译同步抛 SCRIPT_PARSE→`runCap=min(请求值,1000)` 超限 INVALID_ARGUMENT（B10 收口）→`WorkflowRunId(randomUUID())` 铸 id（桩 declare function，值导入真实包）→journal.beginRun→new DwfWorkflowRun）；run.ts 清理序照 dsh-contract.md §4.1（abort→dispose 子代理→allSettled 排空→再 dispose→合成 cancelled agent-end）；`AgentLedger` begin/end 幂等配对（B4）；宿主侧 run 级 `Map<name,seq>` 名字注册表在 declare-actor 事件抵达时查重（B7 定稿；guest 守卫保留双保险，拍板表#8）；scheduler maxConcurrency+pumpAll+固定次数指数退避，**错误永不进脚本**；effects 四 handler，hole 确定性 HOLE_UNAVAILABLE 绝不挂起，并**负责 node 生命周期事件五态发射（拍板表#18）**：每次效应分派经 RunWriter 依次发 `node-queued/dispatched/executing/waiting/settled`（DESIGN §3.4 MVP 词表承诺，当前全工程无任何发射点——gap-audit §3.6）；artifacts.handleReport caps 校验 `{ok:false}` 折回 guest。ptcRuntime 调用按 contract-v2 §1 核实形状写：`resolve(PtcRunRequest{program, bindings, timeoutMs:null, signal, sandboxPolicy})` → `run(spec)`，失败是 `result.error` 字段**非 reject**（types.ts:146-150）——替换旧反推形状。修 B1/B4/B9（engine 侧）/B10。
- **验收**: ① tsc EXIT=0；② node:test 纯逻辑单测（假 subagents/ptcRuntime 注入对象，不起宿主）覆盖：AgentLedger begin/end 幂等配对、三帽取小（请求 64 默认/ceiling 1000/超限报错）、scheduler 并发上限、**effects 对每次效应分派经 RunWriter 依序发出 node-queued/dispatched/executing/waiting/settled 五事件（拍板表#18，假 writer 断言事件序列与载荷 runId/siteId）**——engine.ts 值导入 dsh-workflow/cordis，**单测命令带 `--import ./test/runtime-stubs.mjs` 替身**（评审修订3/B2），T6 负责在 T2 替身基础上补 dsh-workflow（WorkflowEngine 可继承基类/WorkflowRunId 函数/WorkflowError 类）与 cordis（Service 基类）的最小值实现；③ 六文件全部可擦除 TS 语法（`grep -rnE "constructor\(\s*(private|public|protected|readonly)|^\s*(enum|namespace) " src/engine/` 无结果）；④ 集成行为（真实子代理、真实 PTC）如实标注「本迭代不验，待接入真实 dsh」（DESIGN §7.2 边界声明延续）。
- **轮次上限**: 类型门 ≤5 轮。

### T7 工具层 + 入口落码
- **path**: `src/tool/create.ts`（连带 description.ts、get.ts、list.ts、recorder.ts、mirror.ts、placeholders.ts + `src/index.ts` 八文件全落）
- **spec**: create.ts fork 官方内核（参数 DSL、oneOf 输出、双路径 execute；**工具不编译**——B9 单编译路径，script 原样透传 engine.start）；description.ts 按本插件 facade 契约重写 DESCRIPTION（B12：`agent(name,persona).ask`/channel/future/world.run/hole 三重载/report/artifact/脚本内 interface 即 schema；官方 `agent(prompt,opts)` 纯 JS 文案禁入）；get/list 读 projection 无引擎耦合；recorder.ts 落 SessionEventMap declare module 扩充并**收口 T1 桩预置的 dwf/***（防双处声明，gap-audit §3.13 ➕）；mirror 流进 job 输出环；placeholders 六占位报 AMEND_UNAVAILABLE(21)/SAVED_UNAVAILABLE（复用 util/errors.ts 工厂——运行时经 T2 替身解析，评审修订3/B2）；`src/index.ts` 按 DESIGN §3.1：`ctx.plugin(DwfWorkflowEngine)` 显式装载 + `inject` 含 `'workflowEngine'` + systemPrompt section + jobs 可选注入缺席报错。修 B2/B5/B12。**八文件全部可擦除 TS 语法**（全局不变式①）。
- **验收**: ① tsc EXIT=0；② node:test 断言 DESCRIPTION 含 `ask`/`channel`/`world.run`/`hole`/`report` 词汇且**不含** `agent(prompt` 片段；③ placeholders 六工具逐一返回对应错误码——**单测命令带 `--import ./test/runtime-stubs.mjs` 替身**（placeholders→errors.ts→dsh-llm 路径，已实证替身可解）；④ `grep -rn "declare module '@deepseek-ai/dsh-session'" src/tool/recorder.ts` 恰一处且桩内 dwf/* 预置已删（`grep -c "dwf/" stubs/dsh.d.ts` = 0）；⑤ tool×8 无参数属性/enum/namespace（grep 同全局不变式）。
- **轮次上限**: 类型门 ≤5 轮。

### T8 收尾对账
- **path**: `DESIGN.md`（连带 `research/gap-audit.md` 状态表更新）
- **spec**: 核对拍板表 #7/8/9/11 文本回写已落（T2 未尽的补齐）：§3.3 协议四绑定形状/微任务停滞检测/declare-actor/modelRef；§3.4 ordinal=per-site 序、投影直读 dwf_node 降级声明、artifact-failed 入词表、**recordActor 收编进 RunWriter 接口清单（拍板表#17）**；§3.5 宿主注册表+guest 守卫双层、**getProvider 引用改为 startActivation 的 request.agentOptions（R2 定稿，PLAN §5）**；**§5.1（评审修订1/B2 落点）**：① :607 `WorkingDirectory` 行改为 contract-v2 §4 核实的 **`WorkingDirectoryService`**（类名与三方法）；② :604 dsh-tools 行补 `ObjectJsonSchema`（类型，标注「桩内占位形状，contract-v2 §6.2 明示定义体外部假设，接入真实 dsh-tools 时校」）；③ :609 HarnessError 值导入行补注「开发期运行时经 test/runtime-stubs.mjs 替身解析，接入真实 dsh 后由真实 peer 包承接」；§5.2 桩已换 contract-v2 形状、peer `*`+optional 语义回写（gap-audit §3.14）。gap-audit.md §0 摘要表与 §4/§5 对照表逐条更新为终态。终跑三命令记录留档。
- **验收**: ① `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` EXIT=0；② `node test/smoke.mjs` EXIT=0；③ `node test/stub-check.mjs` EXIT=0——三命令**同轮**全绿；④ `grep -n "modelRef\|declare-actor\|writerFor\|WorkingDirectoryService" DESIGN.md` 与代码抽查无矛盾（§5.1 不再出现裸 `WorkingDirectory` 类型名），且 **`grep -c "getProvider" DESIGN.md` = 0（R2 回写落地的硬判据）**、recordActor 出现在 DESIGN §3.4 RunWriter 接口描述中；⑤ 残留偏差清单为空或逐条声明 defer 理由。

## 3. gap-audit 覆盖对账（全部缺失文件与偏差的去向）

| gap-audit 项 | 去向 |
|---|---|
| §1.2 缺失 20 文件 | T5（compile×6）、T6（engine×6）、T7（tool×7 + src/index.ts）|
| §2 编译门 6 错 3 类 | T2① |
| §3.1–3.4 guest 四文件偏差 | T2（拍板表 #1/2/3/5/6/7）|
| §3.5–3.8 journal 四文件偏差 | T2（#4/9/10/11/12）|
| §3.9–3.12 util/types 偏差 | T2① + T8（errors 文案随 T2 顺手）|
| §3.13 桩断裂 + 反推形状 + plugin/扩充缺失 | T1（含 contract-v2 形状替换）+ T3（自检）+ T7（dwf/* 收口）|
| §3.14 package.json（B3 残留等） | T2② |
| §4 阻塞 B1/B2/B4/B5/B6/B9/B10/B12（未落码面） | T5（B6）、T6（B1/B4/B10）、T7（B2/B5/B12）|
| §6 未验证项（§7.1 步骤 4、schemastery、运行时行为） | T3②③、T4 |
| 评审修订1：WorkingDirectory 类名冲突（DESIGN §5.1:607 vs contract-v2 §4） | T1（桩按 WorkingDirectoryService 落）+ T8（DESIGN §5.1 回写）|
| 评审修订2：ObjectJsonSchema 无 import 来源 | T1（归属 dsh-tools specifier、占位形状+外部假设标注）+ T5（取型处）+ T8（待接入校验项）|
| 评审修订3/B2：官方包值导入运行时不可解析（本会话实测 `Cannot find package '@deepseek-ai/dsh-llm'`） | T2④（test/runtime-stubs.mjs 替身立项，/tmp 已实证机制）+ T6②/T7③（验收命令带 --import）+ T4（依赖面零官方值导入前提+grep 守卫）|
| 评审 B1：T3 反向自检依赖位空转风险 | T3②（改探针临时工程逐 specifier 断言 TS2307；评审「tsc 仍 EXIT=0」前提经核实不准确——errors.ts:3→dsh-llm 会报 1 条，但覆盖率 1/13，探针方案仍采纳）|
| 评审 B3：可擦除语法未传导到 T5/T6/T7 | §0 全局不变式①升格 + T5④/T6③/T7⑤ 各加 grep 验收 |
| 第二轮·验收门与依赖图矛盾（T1/T5 整工程 EXIT=0 vs T1∥T2、T5←T1，基线 6 错归 T2） | §2 头部类型门两级语义（T1/T5 中间门=错误集合恰等于基线 6 错，T2/T6/T7/T8 终验门=EXIT=0）；依赖序行改注文件集不相交 |
| 第二轮·T4 反向自检断言③预期不成立（停滞检测在 prelude/channels，不经 realm） | T4 验收②改为「断言④必须 FAIL、③预期 PASS」+ 断言③独立反向自检（改坏 ChannelDeadlock 错误名）|
| 第二轮·拍板表三缺口（schema.ts DDL 松弛 / recordActor 附加方法 / node 生命周期事件无发射点） | 拍板表 #16/#17/#18 + T2①b①c（DDL 对齐、recordActor 收编）+ T6 spec effects 五态发射与单测 + T4 断言⑤手工喂事件半环 |
| 第二轮·R2 回写无载体 | T8 spec §3.5 getProvider→startActivation 回写项 + T8 验收④ `grep -c "getProvider" DESIGN.md` = 0 |

## 4. 自迭代回路边界（硬边界，超限即停）

- **类型门 ≤5 轮**：每个落码/修复任务（T1/T2/T5/T6/T7）独立计数；一轮 = 一次完整 `tsc --noEmit` + 一批修复；门语义按 §2 头部的**两级定义**（T1/T5 中间门＝错误集合恰等于基线 6 错，T2/T6/T7 终验门＝EXIT=0）。第 5 轮后仍红 → 该任务标 **BLOCKED**，如实上报：已尝试轮数、最后一轮完整错误输出、当前 diff。**禁止**放宽 tsconfig（strict/skipLibCheck/include）凑绿。
- **冒烟 ≤3 轮**：`test/smoke.mjs`（T4）与 `test/stub-check.mjs`（T3）各 ≤3 轮；一轮 = 一次全量跑 + 修复。断言失败先查被测代码、再查测试自身；超限标 BLOCKED 如实上报。
- **考卷冻结**：T4/T3 断言一经验收即冻结；T5–T7 实现改动若确需动断言，必须在结果中单列「改了哪条、为什么」，不得静默对卷调参（对齐 AGENTS.md 泛化铁律）。
- **证据纪律**：每个任务的完成态必须附实际命令与关键输出；未跑的检查如实报「未跑」，不得以推断充数。
- **全局不变式即静态验收**：§0 的三条不变式（可擦除语法 / 测试依赖面零官方值导入 / 值导入仅限 errors.ts 与 T6/T7 新文件且经替身）适用于所有任务的每一轮；违反不变式的修复不计入轮次、直接打回。

## 5. 风险与升级点

- **R1 ptcRuntime**：contract-v2 已核实**接口**形状（§1），但 `ptc-runtime-node/` 后端实现未取证（§6.5）。T6 按接口契约落码，接入真实宿主时首验。
- **R2 `subagents.getProvider` 无据**：DESIGN §3.5 的 model 校验路径引用了它，但 contract-v2 §5.1 的 SubagentRuntime 公有面只有 `resolveMaxDepth`/`startActivation`。拍板：T6 的 model 校验改走 `startActivation` 的 `request.agentOptions`（contract-v2 types.ts:169），`getProvider` 不进桩；接入时若真实 API 有此成员再补。此为 DESIGN 的一处待回写（T8）。
- **R3 schemastery `export = z`**：nodenext + 无 esModuleInterop 下 `import { z }` 兼容性未验证（gap-audit §3.13）。T3 探针覆盖；fail 则在 T1 轮次内改桩。
- **R6（评审修订3 引入）替身≠真包**：`test/runtime-stubs.mjs` 只保证 src 官方包值导入「可加载、形状对齐桩声明」，不保证与真实包运行时行为一致（WorkflowError 构造语义、z 的校验行为等）；替身值实现一律以桩声明形状为准，接入真实 dsh 后必须用真实 peer 包复跑全部单测（T8 验收不含此项，属接入期动作，如实记入残项）。
- **R4 升级条件**：任务互斥冲突（如 T1 桩形状与 T6 调用面矛盾）、或 BLOCKED 超限、或发现 contract-v2 与 DESIGN 语义冲突无解时，升级提问，不拍脑袋。
