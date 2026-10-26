# dsh-dwf 实施差距审计（gap-audit）

- 日期：2026-10-24（审计会话内实测）
- 对照基准：`DESIGN.md`（现行版，已吸收第一轮评审）、`.review-round1.json`（唯一评审文件，内含 **blocking 12 条 + suggestions 8 条** 两组意见；目录里不存在第二份独立评审文件，本审计按「两份评审意见 = 该文件的 blocking 组与 suggestions 组」理解）、`assets/` 四份逆向原件。
- 约束：只读审计 + 新增本文件；未改动任何现有源码。

---

## 0. 结论摘要

**终态（2026-10-24 收尾对账，实施任务 T8）**：本节与 §4/§5 已更新为实施收尾终态；§1–§3 的逐文件偏差记录保留为**审计时点快照**（不再回改），每条的处置去向见 `../PLAN.md` 拍板表与 `../DESIGN.md`（已按拍板表 #7–#18 完成回写）。

| 维度 | 终态 |
|---|---|
| 文件树落码 | 🟢 40/40——§1.2 缺失 20 文件全部落码（`src/compile/`×6 + `src/engine/`×6 + `src/tool/`×7 + `src/index.ts`）；§1.3 树外多出的 `stubs/dsh-inline-shapes.d.ts` 已删除（T1 合并单文件，`stubs/dsh.d.ts` 542 行） |
| 编译门 | 🟢 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → EXIT=0 零输出（基线 6 错 3 类由 T2 归零；2026-10-24 21:46 与 21:50 终验轮两次实测，后者与 smoke/stub-check 同轮） |
| 评审阻塞项（已落码面） | B1–B12 全部落码关闭，无待落码残留（逐条终态与证据见 §4 表） |
| 评审 suggestions | #1–#8 全部关闭（#5 无代码动作维持；逐条终态见 §5 表） |

---

## 1. 文件树对照（DESIGN §2 vs 磁盘实测）

实测命令：`find /e/os/dsh-dwf -type f -not -path "*/node_modules/*"`（27 个文件）。

### 1.1 树内已落码（20）

```
DESIGN.md
package.json
tsconfig.json
stubs/dsh.d.ts
assets/facade.d.ts, assets/guest-prelude.js, assets/guest-channel-future.js, assets/journal-schema.sql
src/types/index.d.ts
src/guest/protocol.ts, prelude.ts, channels.ts, realm.ts
src/journal/schema.ts, store.ts, projection.ts, caps.ts
src/util/errors.ts, fnv1a.ts, json.ts
```

其中「业务落码 11 文件」= guest×4 + journal×4 + util×3（ask 所指范围；stubs×2、types、package.json、tsconfig.json 为配套，本审计一并覆盖）。

### 1.2 树内未落码（20）

```
src/index.ts
src/compile/compiler.ts, diagnostics.ts, literals.ts, schema.ts, phase-graph.ts, lower.ts
src/engine/engine.ts, run.ts, scheduler.ts, actor.ts, effects.ts, artifacts.ts
src/tool/create.ts, description.ts, get.ts, list.ts, recorder.ts, mirror.ts, placeholders.ts
```

### 1.3 树外多出的文件（DESIGN §2 未列）

- `stubs/dsh-inline-shapes.d.ts` —— §2/§5.2 明言「合并为**单文件** stubs/dsh.d.ts」，未合并（后果见 §3.13 探针）。
- `package-lock.json`、`.review-round1.json`、`research/dsh-contract.md`、`research/mechanism-map.md`（后两者是 §0 证据基线，树不列属正常）。

---

## 2. 编译门基线（实测）

命令（E:\os 下，与 ask 给的一致）：

```
node dsh-dwf/node_modules/typescript/bin/tsc --noEmit -p dsh-dwf/tsconfig.json
```

输出（6 错 3 类，EXIT=2）：

```
dsh-dwf/src/guest/protocol.ts(20,9): error TS2552: Cannot find name 'Json'. Did you mean 'JSON'?
dsh-dwf/src/guest/protocol.ts(27,9): error TS2552: （同上）
dsh-dwf/src/guest/protocol.ts(32,11): error TS2552: （同上）
dsh-dwf/src/guest/protocol.ts(38,10): error TS2552: （同上）
dsh-dwf/src/journal/store.ts(140,8): error TS2769: No overload matches this call.
  Overload 1 of 2, '(...anonymousParameters: SQLInputValue[]): StatementResultingChanges', gave the following error.
    Argument of type 'Json' is not assignable to parameter of type 'SQLInputValue'.
      Type 'false' is not assignable to type 'SQLInputValue'.
  Overload 2 of 2, ...（省略）
dsh-dwf/src/util/json.ts(52,46): error TS2769: No overload matches this call.
  ... Argument of type '{} | undefined' is not assignable to parameter of type '{ [s: string]: unknown; } | ArrayLike<unknown>'.
EXIT=2
```

与 ask 已知基线完全吻合：① protocol.ts 缺 `Json` 导入；② store.ts 的 node:sqlite 绑定类型；③ json.ts 的 `Object.entries` 可空参数。**注意第 ③ 类是真实 bug 的编译期症状**（见 §3.11）。

桩生效性自检（§7.1 步骤 3）：`tsc --noEmit --listFiles -p dsh-dwf/tsconfig.json | grep "stubs|facade"` → 输出含 `stubs/dsh.d.ts` 与 `assets/facade.d.ts` ✓；**但全量 235 行 listFiles 中没有 `stubs/dsh-inline-shapes.d.ts`**（`grep -n "inline"` 退出码 1）——该文件未被程序加载，见 §3.13。
§7.1 步骤 4（临时去掉 include 反向自检）**未运行**：需临时修改 tsconfig，违反本次只读约束；以 /tmp 探针替代（§3.13）。

---

## 3. 逐文件偏差（11 个落码文件 + 配套）

判定记号：✅ 符合设计；⚠ 偏差（设计/评审有明文，实现不符）；➕ 超出设计的额外实现；🔴 编译门症状。

### 3.1 src/guest/protocol.ts（对照 §3.3 协议段；B7/B8 落点）

- 🔴 缺 `Json` 导入/定义：`GuestRequest.args`(:20)、`GuestEvent.args`(:27)、`GuestComplete.value`(:32)、`WorkerInit.args`(:38) 四处用到 `Json`，文件无 import（`src/util/json.ts:3` 有现成定义）。
- ✅ B8 落实：`report` 在 `GuestOp`(:15) 内、文件头注释(:11-12)点名「deliberately a REQUEST (review B8)」。
- ✅ B7 落实：`begin` 通道存在——`WorkerInit`(:36-45) + prelude `dwfHost.begin()`。
- ⚠ `WorkerInit` 与 DESIGN `GuestInit` 形状不符：DESIGN 为 `{meta: WorkflowMeta; body: string; args: string /*JSON 文本*/; limits}`；实际 `{meta: {name, description}; args?: Json; limits: {4 个数值}}`。`body` 字段被去掉（PTC 进程内 program 由 ptcRuntime.resolve 提供，可辩护），`args` 由「JSON 文本、guest 侧 JSON.parse」改为已解析 Json（prelude 直接赋值，未再 parse——DESIGN §3.3 注释「args 为 JSON 文本…guest-template-00 同法」未兑现），meta 收窄丢失 `description` 之外的字段。
- ⚠ `GuestRequest` 字面形状不符：DESIGN `{id: number; type: 'ask'|…; payload: Json}` → 实际 `{siteId: string; op: GuestOp; args: Json}`(:17-21)。siteId 语义与 journal `(run_id, site_id, ordinal)` 对齐、属有意重设计，但设计文档未回写。
- ⚠ `GuestEventType`(:23) 缺 DESIGN 明列的 `'create-actor'` 成员；prelude 实际发射的事件名是 **`"declare-actor"`**（prelude.ts:112），类型层未收口。
- ⚠ `GuestComplete`(:30-34) 是 `{ok: boolean; value?; error?: {message, name?}}`，非 DESIGN 的判别联合 `{ok:true; value} | {ok:false; error: string}`。

### 3.2 src/guest/prelude.ts（对照 §3.3 prelude 段；B7/B8 落点）

- ✅ report 是 request：`__report`(:143-146) 走 `__request`，注释点名评审 B8。
- ✅ hole 三重载的 filled 形态本地求值 + `__fills` 缓存(:132-138)——符合 §3.3（且好于原件 `guest-prelude.js:48-67`：原件 filled 形态不缓存、只缓存宿主回填代码）。
- ✅ 同 actor ask FIFO：`tail = tail.then(run, run)`(:108)；`__complete` 幂等 `__settled` 守卫(:46)。
- ⚠ 停滞检测触发机制与 §3.3 文本不符：DESIGN「宿主每次投递 response 后与启动时各 **setImmediate** 调 __checkStalled」→ 实际「最后一次在飞请求结算后**连排两个微任务**再查」(:29-33)。realm 禁 setImmediate 与 DESIGN 文本自相矛盾，实现选了微任务并注释说明——改动有理但设计未回写。
- ⚠ args 未浅冻结：`globalThis.args = init.args`(:161) 无 `Object.freeze`。DESIGN §3.3 realm 段与原件 `guest-prelude.js:108`（`Object.freeze(JSON.parse(__argsJson))`）都要求浅冻结一层。
- ⚠ agent 名字查重做在 **guest 侧**（`__agentNames` Set，:23、:92 运行期 throw），而 DESIGN §3.5（B7 解法）规定「run 级 `Map<name, seq>` 由 **run.ts** 持有；**create-actor 事件抵达时查重**」。宿主侧注册表不存在，且协议层无 create-actor 事件，宿主完全感知不到 actor 创建。单进程 guest 内功能等价（facade.d.ts:37-38「computed one fails the run」由 guest throw 达成），归属与设计不符。
- ⚠ `model()` 返回 `{ __modelRef: id }`(:77)，DESIGN §3.2 写的是 `{ modelRef: id }`——键名不符。
- ⚠ 脚本体异常无 guest 侧折算：`__start(body)`(:158-164) 只 `then` 不 `catch`；原件 `guest-prelude.js:172-179` 的 `__execute` 会把错误折成 `complete{ok:false}`。折算责任隐式推给未落码的 run.ts，当前留白。
- ➕ `__agentsStarted` 计数(:24,:96)与 `__checkStalled.ifReachable`(:72)——前者与 DESIGN §3.5 宿主 AgentLedger 的 agentsStarted 是两套计数，落码 engine 时需对账取舍。

### 3.3 src/guest/channels.ts（对照 §3.3 channels 段 + assets/guest-channel-future.js）

- ✅ 主体移植忠实：环形缓冲 + `head/waitHead` 双游标、`__CHANNEL_COMPACT_MIN=1024` compact、send 不等待、close 幂等并排空 waiter、ChannelClosed 抛错。
- ⚠ **async iterator 丢了 `return()`**：原件 :69-71 的 `return: () => Promise.resolve(__END)`（for-await 中途 break/抛错的收尾路径）未移植；实际 `{ [Symbol.asyncIterator]: () => ({ next }) }`(:68) 也没有原件迭代器自带的 `Symbol.asyncIterator`(:73-75)。
- ⚠ `__future` 时序：原件同步调用 body、同步抛转拒绝(:81-90)；实际 `Promise.resolve().then(body)`(:74) 推迟到微任务。facade.d.ts:288-290 承诺「starts immediately, not when awaited」——微任务起步通常可接受，但非字面「immediately」。
- ➕ waiter 存 `{resolve}` 包装对象而非裸函数——等价改写，无语义差。

### 3.4 src/guest/realm.ts（对照 §3.3 realm 段 + assets/guest-prelude.js:181-201）

- ⚠ Date 禁令比设计/原件**更严**：DESIGN「Date.now / argless new Date / Math.random 禁令」、原件允许 `new Date(ts)` 且 `Date.parse/UTC` 透传；实际整个 `globalThis.Date` 被换成全抛错函数(:11-13)，带参构造与 `Date.parse` 一并禁掉。
- ✅ Math.random 禁令（实现用 frozen `Object.create(Math)`，原件只覆写 random——加强版，语义覆盖）。
- ✅ 无定时器/无 I/O：`fetch/setTimeout/setInterval/setImmediate/require/process` 置 undefined(:15-20)，落实 §3.3「无定时器、无 I/O、无 fs/fetch」。
- ➕ realm 段未做 args 冻结（DESIGN 把「浅冻结一层」写在 realm 段；实际两处都没做，见 §3.2）。

### 3.5 src/journal/schema.ts（对照 §3.4「DDL 抄 assets/journal-schema.sql」）

- ✅ 五表齐全、核心列与 assets/journal-schema.sql 一致；`initSchema(db: DatabaseSync)` 签名符合 §3.4。
- ⚠ 非逐字「抄」，约束多处放松：
  - `session_task_link`：id 由 text PK 改 `integer autoincrement`；`child_session_id/role/depth/path/status` 的 NOT NULL 全丢；`unique(child_session_id)` 丢；指向 workflow_run/workflow_activity/session 的外键丢（被引表不在五表内，可辩护）。
  - `dwf_run`：`caps_max_concurrency not null`、`spent_tokens not null default 0`、status 五值 check（pending/running/completed/failed/cancelled）全丢（:16-18）。
  - `dwf_event`：`payload_json not null` 放松为可空(:64)。
  - 索引：丢 `dwf_run_cwd_idx`、`dwf_event_artifact_idx`（json_extract 表达式索引）；新增 `dwf_event_run_idx`(:92)。
  - `create table` → `create table if not exists`（幂等化，合理）。

### 3.6 src/journal/store.ts（对照 §3.4 store 段；B11 落点）

- ✅ B11 落实：per-run 单调计数器（`sequences`/`ordinals` Map，:43-44）同步分配 + INSERT 同块；MAX+1 重开恢复(:48-71)超出设计的最小机制，正向加固。
- ⚠ 接口形状不符：DESIGN 是 `JournalStore.writerFor(runId): RunWriter`（每 run 一个写手，run 结算后计数器随写手丢弃）；实际无 writerFor/RunWriter，beginRun/appendEvent/recordNode/settleRun 直接挂在 `JournalStore` 上(:42-171)，**计数器 Map 永不清理**（跨 run 滞留）。`RunOutcome` 具名类型未定义（settleRun 内联参数）。
- ⚠ ordinal 粒度不符：DESIGN §3.4「`dwf_node.ordinal` 即**到达序**……投影回放**按它重建全序**」→ 实际按 `(run_id, site_id)` 分配(:59-64)，是 per-site 序；全序实际由 projection 按 autoincrement `id` 重建（projection.ts:71 `order by id`）。功能自洽、DDL `unique(run_id,site_id,ordinal)` 仍满足，但「按 ordinal 回放全序」机制未兑现且文档未回写。
- ⚠ `recordActor`(:133-154) 是 DESIGN RunWriter 接口外的附加方法（写 dwf_actor + actor-created 事件）——§3.5 说 dwf_actor 行由 actor 层照建，store 兼办可接受，但接口面与设计不符。
- ⚠ node 生命周期事件（node-queued/dispatched/executing/waiting/settled，§3.4 MVP 词表子集）当前**无任何发射点**：recordNode 只落行不发事件。按 §4 数据流发射方是未落码的 effects/engine，缺口在未落码侧，但 store 也未提供发射辅助。
- 🔴 :140 `.run(...)` node:sqlite 绑定类型不过（recordActor 的实参重载不匹配）——基线错 ②。
- ➕ `input_hash` = sha256 前 16 hex(:73-75)；DESIGN 只规定了 hole id 用 FNV-1a，未规定 input_hash 算法——不算违反，但与 fnv1a.ts 并存两套哈希需自知。
- ➕ `snapshotJsonValue` 导入未使用(:9)。
- ➕ beginRun 未写 `tool_call_id/resumed_from`（列在值为 null）——MVP 可接受；`script_hash` sha256 全长 ✓。

### 3.7 src/journal/projection.ts（对照 §3.4 projection 段）

- ✅ 签名符合：`runProjection(db, runId)` / `listRuns(db, limit)`。
- ⚠ **`maxNodes=2000` 展示帽缺失**：DESIGN「runProjection 回放 dwf_event 展开节点超过 2000 即停止展开并置 `nodesUnlisted: true`」——实际无上限、无 `nodesUnlisted` 字段。
- ⚠ 实现路径与设计文字不符：DESIGN 要求「回放 dwf_event 展开节点」（事件溯源，投影可驱逐**可重建**）；实际直读 `dwf_node` 表(:69-80)，events 仅作列表展示(:81-83)。没有 reducer，投影**不可由事件重建**，§3.4 的读写分离承诺只兑现一半。

### 3.8 src/journal/caps.ts（对照 §3.4 CAPS 块；suggestions#7 落点）

- ✅ 全部帽值与 DESIGN §3.4 数值一致；建议 7 点名的 artifact title 120 / description 500、grep 256KB、diff 512KB、log 100 commits 全部补齐（:14-25）——suggestions#7 已解决。
- ⚠ 四个键名与 §3.4 字面不符：`gitDiffBytes→gitDiffCap`、`gitLogCommits→gitLogMaxCommits`、`artifactTitleChars→artifactTitleLength`、`artifactDescriptionChars→artifactDescriptionLength`（types/index.d.ts 的 `Caps` 接口同步用新名，内部自洽，仅与设计文本不一致）。
- ➕ `CAPS: Caps = {...} as const`(:5-26) 注解 + as const 并用，as const 实际失效（纯风格）。

### 3.9 src/util/errors.ts（对照 §3.7、§3.6 placeholders）

- ✅ `DwfError extends HarnessError`，值导入 `@deepseek-ai/dsh-llm`(:3)——符合 §5.1 值/类型分工。
- ✅ `AMEND_UNAVAILABLE: 21`(:6) 符合 §3.6 点名的错误码；`SAVED_UNAVAILABLE`(:15)、`HOLE_UNAVAILABLE`(:16) 与 §3.5 effects.hole / §6.2 占位语义配套；`amendUnavailable/savedUnavailable/holeUnavailable` 三个工厂(:27-41)文案合格。
- ➕ 额外 8 个错误码（22-29：MISSING_BOUNDARIES/SUBAGENT_MODEL/SCRIPT_UNCHANGED/SCRIPT_FILE/SCRIPT_UNAVAILABLE/RETUNE_UNCHANGED/RUN_SETTLED/NOT_RETUNABLE）——DESIGN 未列，属 ZCode 原词汇超前转录，无害但超设计。
- ⚠（轻微）`amendUnavailable` 文案称 resumed_from「in place」——列存在但 beginRun 从不写值（§3.6）。

### 3.10 src/util/fnv1a.ts（对照 §3.7、§3.2）

- ✅ `fnv1a32(text): string`（trim 后 FNV-1a 32 位 → 8 位 hex）、`holeSiteId → hole#xxxxxxxx` 跨修订稳定——与 §3.2/§3.7 完全一致。
- ➕ `callSiteId(prefix, ordinal)`(:18-20) 服务 §3.2「siteId = 调用点序号」，超前自洽。

### 3.11 src/util/json.ts（对照 §3.7、§4 硬规则）

- ✅ 快照纪律齐全：深度 64 上限、稀疏数组/特殊原型/非有限数/嵌套 undefined/bigint/symbol/function 拒收(:24-50)。
- 🔴 **undefined 输入会裸抛 TypeError 而非 MaterializeError**：顶层 `undefined` 落到 `Object.getPrototypeOf(value)`(:47) 崩溃——基线错 ③（:52 `Object.entries` 可空参数）正是它的编译期症状，不是纯类型洁癖。
- ⚠ 声明返回 `Json | undefined`(:23) 与 DESIGN `snapshotJsonValue(v: unknown): Json` 不符，且掩盖事实：函数从不返回 undefined（:43/:54 的 `?? null` 是不可达死码），却会在 undefined 输入上崩。签名应改为抛 `MaterializeError('undefined is not lossless JSON')` 并返回 `Json`。

### 3.12 src/types/index.d.ts（对照 §2「对外词汇」）

- ✅ 三词汇齐：`DwfErrorCode` / `Caps` / `JournalEventName`。
- ➕ `JournalEventName` 14 个成员中 13 个与 §3.4 MVP 词表子集吻合，**`artifact-failed`(:46) 超出设计清单**（escalation/import-cache 族正确未收）。

### 3.13 stubs/dsh.d.ts + stubs/dsh-inline-shapes.d.ts（对照 §2「合并单文件」、§5.1/§5.2/§5.3）——本审计最重发现

- ⚠ **未按 §2/§5.2 合并为单文件**：拆成两个文件，且 `stubs/dsh-inline-shapes.d.ts` 不在 §2 文件树内。
- 🔴 **桩链潜伏断裂（/tmp 探针实证，未触碰仓库）**：`dsh-inline-shapes.d.ts:7` 的 `declare module './dsh-inline-shapes'` 是非法相对模块名（TS2436）；`dsh.d.ts:32,37` 在 ambient 模块内 `export … from './dsh-inline-shapes'` 相对引用（TS2439）。当前仓库 `tsc` 绿过**纯属侥幸**——src 里还没有任何文件 import `@deepseek-ai/dsh-workflow`，整条链从未被解析（`--listFiles` 235 文件中无 inline-shapes）。探针（`/tmp/dwf-stub-probe/`，复制两份桩 + `import { WorkflowEngine } from '@deepseek-ai/dsh-workflow'`，同 5.9.3 编译器）：
  - 无 `--skipLibCheck`：TS2436 / TS2439 / TS2306（"File … is not a module"）共 6 错；
  - 带 `--skipLibCheck`（与仓库 tsconfig 一致）：**0 错，但 `WorkflowEngine` 退化为 any**——`const x: WorkflowEngine = 42` 静默通过（probe2.ts 实测 EXIT=0）。
  - 结论：§5.3「stubs 只保证 tsc --noEmit 通过」与 §7.1 步骤 4 反向自检的承诺实质失效——**桩在、但无效，skipLibCheck 把断裂吞成 any**。engine.ts 落码时必须先修此链（单文件合并或改 `declare module` 名为包 specifier）。
- ⚠ §5.2 点名要补的 `Context.plugin(...)` 成员**没有**（dsh.d.ts:15-24 的 Context 接口无 plugin）；§5.1 两个 declare module 扩充（`Context.workflowEngine`、`JobKindMap['workflow']`）**都没有**。
- ⚠ §5.1 表中 `dsh-ptc-runtime` / `dsh-sandbox` / `dsh-sandbox-policy` / `dsh-working-directory` 四个 specifier 的桩声明**全缺**（engine 未落码所以暂无编译症状；§5.3 要求的「推断来源行号注释」无从谈起）。
- ✅ `WorkflowRunId`/`SessionId` 已按 `declare function` 声明为运行时工厂（dsh.d.ts:62、inline-shapes:12-13）——§5.2 与 suggestions#1 的类型面落实。
- ➕ dsh.d.ts:63-68 预置了 `dwf/*` SessionEventMap——§3.6 规定该扩充放 tool/recorder.ts；桩先顶上可接受，落码 recorder 时注意勿双处声明。
- ⚠（未验证的前瞻风险）schemastery 桩用 `export = z`(:146)，未来 engine/tool `import { z }` 在 nodenext + 无 esModuleInterop 下的行为未验证（当前无 import 方）。

### 3.14 package.json（对照 §1.2；B3、suggestions#8 落点）

- ⚠ **B3 部分未决**：缺 `@deepseek-ai/dsh-sandbox` / `dsh-sandbox-policy` / `dsh-working-directory` / `dsh-ptc-runtime` 四个 peer（§1.2 明列 15 peer，实际 10 个，:29-40）。`dsh-system-prompt` ✓ 已补。
- ⚠ peer 语义偏离：`workspace:*` → `*` + 全量 `peerDependenciesMeta.optional`(:45-76)——§1.2 字面是 `workspace:*`；单包独立于 monorepo 可辩护，需回写设计。
- ⚠ `exports["."]["types"]` 指向 `./src/index.ts`(:9)，§1.2 是 `./src/types/index.d.ts`；`./types` 出口 ✓。
- ✅ 条件对象 exports 形态（suggestions#8 落实）；`typescript` pin 5.9.3（dependencies + devDependencies 双写同 §1.2）；`main: src/index.ts`、`files` 三目录同 §1.2。
- ⚠ `scripts.smoke: node test/smoke.mjs`(:24) 指向**不存在的文件**（仓库无 test/ 目录）；`scripts.typecheck` 依赖 PATH 上的 tsc（§7.1 用 node node_modules/…/tsc）。
- ➕ `version: "0.1.0"`（§1.2 片段无此字段，无害）。

### 3.15 tsconfig.json（对照 §7.1）

- ✅ 与 §7.1 配置逐项一致：strict / noUncheckedIndexedAccess:false / target es2024 / module+resolution nodenext / types:["node"] / noEmit / skipLibCheck；include 三项一致。
- ➕ 附加 `allowImportingTsExtensions: true`(:11)——§7.1 未列；为 store.ts:9 `from '../util/json.ts'` 这类 .ts 后缀导入所必需，被现有代码依赖。

---

## 4. 评审 12 条阻塞项落点对照

终态（2026-10-24 T8 逐条取证更新；行内引用为本轮实测 grep/读码证据）：

| 项 | 落点文件 | 终态 |
|---|---|---|
| B1 引擎实例化矛盾 | engine/engine.ts、src/index.ts | ✅ 已落码：`src/index.ts:5` `ctx.plugin(DwfWorkflowEngine)` 显式装载（class 形态，`engine.ts` `DwfWorkflowEngine extends WorkflowEngine`） |
| B2 inject 丢 workflowEngine | src/index.ts | ✅ `src/index.ts:37` `inject = ['tools', 'workflowEngine', 'systemPrompt'] as const`；jobs 可选注入缺席报错 |
| B3 peer 缺 4 包 | package.json | ✅ 14 peer 全数在列（含 sandbox/sandbox-policy/working-directory/ptc-runtime），语义为 `*` + `peerDependenciesMeta` 全 optional（DESIGN §5.2 语义回写）；`exports["."].types` → `./src/types/index.d.ts`（拍板表#13） |
| B4 AgentLedger/agentsStarted | engine/run.ts | ✅ `run.ts` AgentLedger 4 处：begin/end 幂等配对、agentsStarted 归账；guest 侧 `__agentsStarted` 与宿主 ledger 分工在 DESIGN §3.5 注明 |
| B5 recorder/mirror 落点 | tool/recorder.ts、mirror.ts | ✅ 两文件落码；`dwf/*` SessionEventMap declare module 收口 `recorder.ts` 单处（桩内不预置，§3.13 ➕ 关闭） |
| B6 ask<T> schema 下沉 | compile/schema.ts | ✅ `schema.ts:28` `askSchemas(checker, sf): Map<number, ObjectJsonSchema>`；lowering 经 `__host.ask(siteId, instr, schema)` 下沉（`ObjectJsonSchema` 为桩内占位形状，拍板表#15，DESIGN §5.1 已标注） |
| B7 meta/args 进 guest 通道 | protocol.ts + prelude.ts | ✅ 已决：`begin` 承载 WorkerInit（meta/args/limits）；审计偏差按拍板表#1（args `Object.freeze` 一层，prelude 实测 1 处）与 #7（siteId/op/args 形状、事件名 declare-actor）修复/回写 DESIGN §3.3 |
| B8 report 定性 | protocol.ts + prelude.ts | ✅（维持原判）report=request，`protocol.ts` 头注「deliberately a REQUEST (review B8)」在位 |
| B9 script 语义单编译路径 | engine/engine.ts + tool/create.ts | ✅ `compileWorkflow` 仅 `engine.ts:165`（start() 六步流水线内）一处；`tool/create.ts` script 原样透传，不预编译 |
| B10 三套上限对齐 | caps.ts + engine.ts | ✅ `engine.ts:123` `runCap = min(请求值 ?? CAPS.maxSubagents /*64*/, 1000)`，超 ceiling 报 INVALID_ARGUMENT（:130）；CAPS.maxSubagents=64 维持 |
| B11 sequence/ordinal 分配 | journal/store.ts | ✅ `writerFor(runId): RunWriter`（store.ts:55 接口/:73 发放），计数器随 `settleRun` 回收（:210 ordinals 按 `runId\0` 前缀清理）——跨 run 滞留关闭；ordinal per-site 序按拍板表#9 回写 DESIGN §3.4 |
| B12 DESCRIPTION 重写 | tool/description.ts | ✅ 本插件契约文案：`ask`/`channel`/`world.run`/`hole`/`report` 词汇在（实测命中），`agent(prompt` 片段零命中（官方文案未混入） |

## 5. 评审 suggestions 8 条对照

终态（2026-10-24 T8 逐条取证更新）：

| # | 内容 | 终态 |
|---|---|---|
| 1 | WorkflowRunId/SessionId 值导入 | ✅ 桩 `dsh.d.ts:58-59` `export function WorkflowRunId(id: string): WorkflowRunId`（declare 形态）；src 值导入 `engine.ts:174` `WorkflowRunId(randomUUID())` 铸 id——开发期运行时经 `test/runtime-stubs.mjs` 替身解析 |
| 2 | agent 名字编译期检查 + model() lowering | ✅ `diagnostics.ts:192` `agentNameDiagnostics`（错误码 9014）+ 字面量族齐；`model()` 按拍板表#5 改键名 `modelRef`（`prelude.ts:78`），并按 §3.2 定稿**不参与 lowering**（纯数据工厂，launch 校验走 startActivation 的 request.agentOptions，R2） |
| 3 | hole filled 形态 | ✅（维持原判）`__holeFilled` 本地求值 + `__fills` 缓存 |
| 4 | Config.maxResultChars | ✅ `tool/create.ts:46/:128/:166`：Config 字段 + renderResult 封顶接线 |
| 5 | node:sqlite node22 旗标 | 无代码动作（DESIGN R4 记录维持；本机 node 24 免旗标，冒烟实测可跑） |
| 6 | report/artifact 记 dwf_node 行 | ✅ `artifacts.ts` `recordNode` kind:'report'（:81）/'artifact'（:137）；node-* 五态事件发射方为 `effects.ts` `emitNode`（`node-queued→…→settled`，拍板表#18） |
| 7 | CAPS 补 artifact/grep/diff/log 帽 | ✅ 全落且键名已对齐 DESIGN 字面（拍板表#12：`caps.ts:15-25` gitDiffBytes/gitLogCommits/artifactTitleChars/artifactDescriptionChars） |
| 8 | exports 条件对象形态 | ✅（维持原判） |

## 6. 本次未运行/未验证项（如实声明）

- §7.1 步骤 4 反向自检（临时移除 include）未跑：需改 tsconfig，违反只读约束；以 /tmp 探针等效替代（结论更强：不仅「去掉桩会报错」，现状是「桩在但对 @deepseek-ai/dsh-workflow 无效、静默 any」）。
- 未做任何运行时行为验证（guest 停滞检测、journal 读写、FIFO 语义）——设计 §7.1 边界声明本就不含，本次也未另写单测。
- schemastery 桩 `export = z` 与未来 `import { z }` 的兼容性未验证（无 import 方）。
- `.dsh-src/` 官方包源码未直接核对（WorkerInit/limits 字段名等以 DESIGN 转写为基准）。

## 7. 收尾残留清单（T8，2026-10-24）

三命令终验轮（2026-10-24 22:12）：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` EXIT=0 ｜ `node test/smoke.mjs` EXIT=0（28/28）｜ `node test/stub-check.mjs` EXIT=0（三断言 PASS）——同轮全绿。验收 grep：`grep -c "getProvider" DESIGN.md` = 0（R2 硬判据）；`modelRef/declare-actor/writerFor/WorkingDirectoryService` 与代码抽查无矛盾（prelude.ts:78、protocol.ts:31、store.ts:73、stubs/dsh.d.ts:42）；`recordActor` 在 DESIGN §3.4 RunWriter 接口描述（DESIGN.md:336 ↔ store.ts:55/59）；§5.1 无裸 `WorkingDirectory` 类型名。

残留逐条（defer 项均注明理由）：

| # | 项 | 处置 |
|---|---|---|
| 1 | **R6 替身≠真包**：单测/冒烟现经 `test/runtime-stubs.mjs` 替身解析官方包值导入（形状照桩声明），不保证与真实包运行时行为一致 | **defer（接入期）**：接入真实 dsh 后必须用真实 peer 包复跑全部单测（PLAN §5 R6 明文接入期动作；DESIGN §5.3 已注） |
| 2 | **projection 展示帽未实现**：DESIGN §3.4/拍板表#11 承诺 `maxNodes=2000` 帽 + `nodesUnlisted: true`，`src/journal/projection.ts` 全文无实现、测试无断言（本轮 grep 实证）；且 projection.ts **不在任何任务文件集内**（T2 path 清单无它）——孤儿项 | **未落码，非 defer**：指名拍板表#11 代码半边待补；建议随接入期或补一轮落码收口（约 6 行：节点列表截断 + 置位） |
| 3 | **contract-v2 §5.1 断言与源码不符（本轮新发现，报告项）**：contract-v2 称 SubagentRuntime 公有面只有 resolveMaxDepth/startActivation，但 `subagent/index.ts:573` 实有公有 `getProvider(name)`（`this.providers` :200 同类）。R2 处置（model 校验走 startActivation 的 `request.agentOptions`，types.ts:169）不依赖该断言、维持定稿；DESIGN 未写「无此成员」类假话 | **报告不改**：contract-v2 属 research 产物，非 T8 文件范围；修正交研究侧 |
| 4 | **jobs 包源码缺失**（contract-v2 §5.6），jobs 桩保持调用点反推并已标注 | **defer（接入期）**：抓到源码后按 contract-v2 流程补核实形状 |
| 5 | **ptc-runtime-node/ 后端实现未取证**（R1 收窄后的余量） | **defer（接入期首验）**：DESIGN §8 R1 已按此收窄更新 |
| 6 | **集成行为未验**：真实子代理、真实 PTC、seam workflow/* 事件——本机无 dsh 宿主 | **defer（永久边界）**：DESIGN §7.2 边界声明 + §7.2 终态注记在案 |

