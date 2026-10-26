/**
 * T6 集成回归测试（FIX-PLAN §T6 / review-findings「测试盲区」/ 验证门第 6 条）。
 *
 * 与 engine.test.mjs 的差别：那里的 fakePtc 在脚本回调后立即 return（complete 后
 * 不等任何东西），掩盖了「真 PTC 下停滞脚本永不返回」的断点（findings P0-B 原文）。
 * 这里 fake PTC **真实执行 assembleProgram 的拼装产物**——node:vm 起 context
 * （binding global 名按 spec.bindings[0].global，通常 dwfHost），按 programFormat
 * 'function-body' 把 program 当 async 函数体执行：`(async () => {<program>})()`
 * （诚实仿真：function-body 本身就是 async 函数体，顶层 await/return 因此合法）。
 * run() 只在两个出口收束：程序 promise 结算，或 request.signal abort 时以
 * error:{kind:'abort'} 收束——所以 P0-B 场景里挂死的 run 只能靠修后 fail→abort 链
 * 唤醒，修前永不结算、测试超时红（engine.test.mjs:318-334 的形状做不到这一点）。
 *
 * 宿主侧直构 `new DwfWorkflowEngine(fakeCtx, config)`（替身基类经
 * test/runtime-stubs.mjs 的 loader 钩子可解析：cordis Service / dsh-workflow
 * WorkflowEngine / schemastery z，见 runtime-stub-values/hook.mjs）。fakeCtx 提供
 * subagents（tripwire：集成测试不 ask 真子代理）、ptcRuntime、sandboxPolicy.resolve
 * → danger-full-access（绕 run.ts 沙箱硬门）、workingDirectory.ensure、logger。
 *
 * 跨 realm 纪律（与真 PTC 边界同语义）：guest→host 的绑定入参与程序完成值经
 * JSON 往返物化为宿主 plain 对象再交付——vm 内建的 Object.prototype 与宿主不同，
 * 不物化会被 util/json.ts snapshotJsonValue 的「special prototype」拒收（探针实证）；
 * 真 PTC 在 worker/postMessage 边界做同型物化（dsh-contract-v2 §1.2 无损 JSON）。
 * 同理：guest 体以纯 JS 执行，脚本不得写 TypeScript 注解（真 PTC 在边界剥型，
 * vm 直跑不剥——本文件所有脚本均已按纯 JS 书写）。
 *
 * 回归覆盖（红→绿基线证据：三份 scratch 副本分别只回退被测修复后跑本文件，
 * P0-B 修前 30s 超时红、P0-C/#4/#7/#8/#5 修前断言红、修后全绿——摘要记于
 * review-findings.md「测试盲区」状态行，各断言消息自带修前失败形态）：
 *   P0-C  args 经 __start→begin 到达 guest，成功由 PTC 返回值结算；
 *   P0-B  停滞脚本（park receiver 无在飞）超时窗内 error 结算且 error 含 Deadlock，
 *         假宿主收到 complete{ok:false}（修前永不结算必超时红）；
 *   P0-A  engine 以临时文件 dbPath 跑完 completed run，另开 DatabaseSync 同路径
 *         runProjection：run 行 completed、journal 事件与节点可读；
 *   D1    await 末个请求后立即 return 的成功收尾：completed 且 result 正确
 *         （修前 __settled 无成功置位，停滞自查抢先折成 ScriptStalled）；
 *   D2    channel()/future() 裸名直调（别名缺失期必 ReferenceError）→ completed
 *         且 channel 收发/异步迭代与 future 求值语义正确；
 *   D3    fake PTC 直接返回 worker-exit 错误两形态 → error 结算且消息统一前缀
 *         workflow worker exited before settling、原文/stderr 摘录保留；
 *   #4    runCap 先判后计边界：maxTotalAgents:2 声明 3 个 agent() → error(cap
 *         exceeded)；恰 2 个 → completed（防先增后判 off-by-one）；
 *   #7    自动 label "subagent 1" 之后显式 agent('subagent 1') 不误报 duplicate，
 *         ordinal 由声明计数承载；
 *   #8    循环内 filled hole 每次到达现场求值 → [0,1] 而非 [0,0]；
 *   #5    直连 store 写 2001 节点 → runProjection.nodesUnlisted === true 且列表截断。
 *
 * ✔ 新发现一（已修＝fix-d2：channels.ts 补 channel()/future() 运行时别名）：
 * facade.d.ts 声明的 channel()/future() 曾在 guest realm 无运行时绑定——
 * channels.ts 只定义 __channel/__future，无 `channel = __channel` 之类别名
 * （grep 实证 + vm 探针 typeof channel === 'undefined'），用户脚本写 channel(...)
 * 编译通过、运行必 ReferenceError。别名落地后本文件已把 P0-B 的 eval('__channel')
 * 同构换回裸名 channel()（t1③，依赖 t2/d2 同轮修复，S4 统一验收）；D2 回归
 * 另以收发/异步迭代/future 求值语义承载别名可用性。
 *
 * ✔ 新发现二（已修：D1 方案 b）：停滞自查与成功路径竞态——P0-C 拍板去掉成功路径
 * __complete(true,value) 后，__settled 不再被成功结算置位，__checkStalled 对
 * body 已返回的程序失去完成信号：任何以「await 一个 request 且其后再无 request」
 * 结尾的成功脚本（如 `await report({note:1}); return {done:true}`）被折成
 * ScriptStalled error（探针复现实证；原版 guest-prelude.js:175 的 __complete(true)
 * 与宿主 setImmediate 武装是配套的，移植改微任务武装 + 去成功 complete 后失配）。
 * D1 修复：__start 在 body 正常 resolve 后置 __settled=true（成功仍由 PTC 返回值
 * 结算，prelude.ts），自查自此被幂等守卫永久解除，正常收尾不再依赖时序裕量。
 * 原被竞态迫使弱化的断言已恢复：P0-A 的 report run 重新断言 stopReason=completed
 * （本轮唯一豁免项，非删改既有断言）；另新增 D1 锁定回归（await 请求→立即
 * return → completed、value 正确、宿主侧无 complete{ok:false} 到达——锁机制
 * 不只锁结果）。
 *
 * 命令：node --import ./test/runtime-stubs.mjs --test test/integration.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { DwfWorkflowEngine } = await import('../src/engine/engine.ts')
const { runProjection } = await import('../src/journal/projection.ts')
const { initSchema } = await import('../src/journal/schema.ts')
const { JournalStore } = await import('../src/journal/store.ts')
const { CAPS } = await import('../src/journal/caps.ts')

function renderMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** guest→host 边界物化（见文件头「跨 realm 纪律」）；非 JSON 安全值由调用方折 invalid-output。 */
function materialize(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

/**
 * 假 PtcRuntime（contract-v2 §1 形状）：resolve 捕获 spec；run 用 node:vm 真实
 * 执行拼装产物，绑定面逐到达记账（begin/request/event/complete 的宿主侧到达序），
 * 监听 spec.signal，abort 时以 error:{kind:'abort'} 收束——P0-B 的唤醒前提。
 */
function makeFakePtc() {
  const captured = {}
  const arrivals = [] // { channel, arg }——绑定函数被 guest 调用的到达序账本
  const ptc = {
    captured,
    arrivals,
    programFormat: 'function-body',
    sandboxMode: undefined,
    resolve(request) {
      captured.request = request
      return { ...request, cwd: request.cwd ?? '/', timeoutMs: request.timeoutMs ?? null }
    },
    async run(spec) {
      const raw = spec.bindings[0].functions
      const dwfHost = {}
      for (const name of ['begin', 'request', 'event', 'complete']) {
        dwfHost[name] = (...callArgs) => {
          // 记账与转发用同一份物化值：guest→host 的入参必须落成宿主 plain 对象
          // （run.ts 的 parseRequest/onDeclareActor 对入参跑 snapshotJsonValue，
          // 跨 realm 原型会被「special prototype」拒收）。
          const arg0 = materialize(callArgs[0])
          arrivals.push({ channel: name, arg: arg0 })
          return raw[name](arg0)
        }
      }
      const context = vm.createContext({ [spec.bindings[0].global]: dwfHost })
      let program
      try {
        program = vm.runInContext(`(async () => {\n${spec.program}\n})()`, context, { filename: 'dwf-guest-program.js' })
      } catch (error) {
        return { value: null, logs: [], error: { kind: 'exception', message: renderMessage(error) } }
      }
      return await new Promise(resolve => {
        const settle = outcome => {
          spec.signal?.removeEventListener('abort', onAbort)
          resolve(outcome)
        }
        const onAbort = () =>
          settle({
            value: null,
            logs: [],
            error: { kind: 'abort', message: typeof spec.signal?.reason === 'string' ? spec.signal.reason : 'aborted' },
          })
        if (spec.signal?.aborted === true) {
          onAbort()
          return
        }
        spec.signal?.addEventListener('abort', onAbort, { once: true })
        Promise.resolve(program).then(
          value => {
            try {
              settle({ value: materialize(value), logs: [] })
            } catch (error) {
              settle({ value: null, logs: [], error: { kind: 'invalid-output', message: renderMessage(error) } })
            }
          },
          error => settle({ value: null, logs: [], error: { kind: 'exception', message: renderMessage(error) } }),
        )
      })
    },
  }
  return ptc
}

/** 宿主侧 ctx（engine static inject 四件 + logger）；subagents 是 tripwire——集成测试不 ask。 */
function makeHostCtx(ptc, workspaceRoot) {
  return {
    logger: { warn() {}, info() {} },
    subagents: {
      async startActivation() {
        throw new Error('integration test never asks a real subagent')
      },
    },
    ptcRuntime: ptc,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot }) },
    workingDirectory: { ensure: async () => workspaceRoot },
  }
}

/** 直构引擎（P0-A 场景即依赖此处 config.dbPath 落到引擎写侧）。 */
function makeEngine(ptc, dbPath) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'dwf-integration-ws-'))
  const ctx = makeHostCtx(ptc, workspaceRoot)
  const config = {
    toolName: 'workflow',
    dbPath,
    maxConcurrency: 4,
    maxTotalAgents: 1000,
    maxResultChars: 50000,
    enableRunInBackground: false,
  }
  return { engine: new DwfWorkflowEngine(ctx, config), workspaceRoot }
}

const PARENT = { id: 'agent-1', session: { id: 'sess-integration' } }

/** engine.start 合法请求（validateMeta 要求 name/description 非空）。 */
function startRun(engine, { script, args, maxTotalAgents }) {
  return engine.start({
    meta: { name: 'integration', description: 'T6 integration regression' },
    script,
    ...(args === undefined ? {} : { args }),
    ...(maxTotalAgents === undefined ? {} : { maxTotalAgents }),
    parent: PARENT,
  })
}

function scratchDir(label) {
  return mkdtempSync(join(tmpdir(), `dwf-integration-${label}-`))
}

// ============ P0-C：args 经 begin 到达 guest ============

test('P0-C 回归：args 经 __start→begin 到达 guest；成功由 PTC 返回值结算；假宿主收到 begin 与 log', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const { engine } = makeEngine(ptc, join(scratchDir('p0c'), 'journal.db'))
  const run = startRun(engine, {
    script: "log('target=' + String(args.target));\nreturn { seen: args.target };",
    args: { target: 'v1' },
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', '修前 assembleProgram 无人调 __start，body 不经 begin 装配')
  assert.deepEqual(result.value, { seen: 'v1' }, '修前 args 恒 {}，seen 必不为 v1')
  const channels = ptc.arrivals.map(item => item.channel)
  assert.ok(channels.includes('begin'), '假宿主必须收到 begin（__start 确被调用）')
  const log = ptc.arrivals.find(item => item.channel === 'event' && item.arg?.type === 'log')
  assert.ok(log, '假宿主必须收到 log 事件')
  assert.equal(log.arg.args.message, 'target=v1', 'args.target 必须经 begin 的 WorkerInit 到达 guest（修前恒 target=undefined）')
  assert.ok(channels.indexOf('begin') < channels.indexOf('event'), 'begin 先于 log 到达')
  assert.equal(
    ptc.arrivals.some(item => item.channel === 'complete' && item.arg?.ok === false),
    false,
    '成功路径不发失败 complete（P0-C 拍板：成功仍由 PTC 返回值结算，不补 __complete(true)）',
  )
})

// ============ P0-B：停滞脚本在超时窗内以 error 结算 ============

test('P0-B 回归：停滞脚本（park receiver 无在飞）超时窗内 stopReason=error 且 error 含 Deadlock；假宿主收到 complete{ok:false}', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const { engine } = makeEngine(ptc, join(scratchDir('p0b'), 'journal.db'))
  const run = startRun(engine, {
    // smoke ③ 同景：停泊一个 channel receiver；hole 请求被宿主确定性拒收 → 在飞
    // 清零 → guest 停滞自查报 ChannelDeadlock → complete{ok:false}；
    // 脚本随后挂死在永不结算的 promise 上——真 PTC 下 run(spec) 永不返回，唯一
    // 唤醒源是修后 P0-B 的 fail→abort→signal。修前：complete 只存不发 fail，
    // run.result 永不结算 → 本测试超时红。
    // t1③：eval('__channel') 已同构换回裸名 channel()（依赖 t2/d2 别名落地）。
    script: [
      "const ch = channel('downstream');",
      'ch[Symbol.asyncIterator]().next();',
      "try { await hole('gate', 'blocked'); } catch {}",
      'await new Promise(() => {});',
    ].join('\n'),
  })
  const result = await run.result
  assert.equal(result.stopReason, 'error', '修前永不结算（此断言靠测试超时红举证）')
  assert.match(result.error, /Deadlock/)
  const complete = ptc.arrivals.find(item => item.channel === 'complete')
  assert.ok(complete, '假宿主必须收到 complete（guest 停滞自查发出）')
  assert.equal(complete.arg.ok, false)
  assert.match(complete.arg.error?.message ?? '', /Deadlock/)
})

// ============ D1：await 末个请求后立即 return 的成功收尾（锁机制不只锁结果） ============

test('D1 锁定回归：脚本体 await report 后立即 return——completed 且 value 正确，宿主侧无 complete{ok:false} 到达', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const { engine } = makeEngine(ptc, join(scratchDir('d1-locked'), 'journal.db'))
  const run = startRun(engine, {
    // 「新发现二」的竞态形状：body 以「await 一个 request 且其后再无 request」收尾。
    // 修前 __settled 不被成功路径置位，停滞自查（tick-8 级联）恒先开火，把 run 折成
    // ScriptStalled 并向宿主发 complete{ok:false}；修后 __start 在 body 正常 resolve
    // 时置 __settled=true（成功仍由 PTC 返回值结算，prelude.ts），自查被幂等守卫
    // 短路——锁机制不只锁结果：run 侧 completed 之外，宿主侧必须收不到任何
    // complete{ok:false} 到达（修前自查先开火必有一条）。
    script: 'await report({ note: 1 });\nreturn { done: true };',
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', 'D1 修前：末个请求结算后收尾被停滞自查抢先折成 ScriptStalled error')
  assert.deepEqual(result.value, { done: true }, '成功值必须经 PTC 返回值无损到达')
  assert.equal(
    ptc.arrivals.some(item => item.channel === 'complete' && item.arg?.ok === false),
    false,
    '锁机制不只锁结果：停滞自查必须被 __settled 短路，宿主侧不得收到任何 complete{ok:false}（D1 修前自查先开火必有一条）',
  )
})

// ============ D2：channel()/future() 裸名直调（fix-d2 别名回归） ============

test('D2 回归：channel()/future() 裸名直调——别名在 guest realm 可见，收发/异步迭代/future 求值语义正确', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const { engine } = makeEngine(ptc, join(scratchDir('d2-alias'), 'journal.db'))
  const run = startRun(engine, {
    // 「新发现一」的缺口形状：脚本以裸名 channel()/future() 直调（facade.d.ts 声明
    // 面、不参与 lowering）。修前 guest realm 只有 __channel/__future 无别名（grep
    // + vm 探针实证），裸名必 ReferenceError；修后 channels.ts 以裸名包装直供。
    script: [
      "const ch = channel('pipe');",
      'ch.send(1);',
      'ch.send(2);',
      'ch.close();',
      'const seen = [];',
      'for await (const item of ch) seen.push(item);',
      'const f = await future(async () => 40 + 2);',
      'return { seen, f };',
    ].join('\n'),
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', 'D2 修前：裸名 channel 必 ReferenceError（guest realm 无运行时别名）')
  assert.deepEqual(result.value, { seen: [1, 2], f: 42 }, 'channel 收发/关闭/异步迭代与 future 现场求值语义')
})

// ============ D3：worker-exit 两形态统一前缀（fix-d3 回归） ============

test('D3 回归：worker-exit 两形态消息统一前缀 workflow worker exited before settling——原文/stderr 摘录保留、不落旧裸形态', { timeout: 30000 }, async () => {
  // 形态一：流错误裸消息（如 'write EPIPE'）→ 前缀 + 原文全文 + 病因说明（run.ts
  // cleanWorkerExitMessage ②：原文后必有后续文字，消息不以裸 EPIPE 结尾）。
  const epipePtc = makeFakePtc()
  epipePtc.run = async () => ({ value: null, logs: [], error: { kind: 'worker-exit', message: 'write EPIPE' } })
  const { engine: epipeEngine } = makeEngine(epipePtc, join(scratchDir('d3-epipe'), 'journal.db'))
  const epipeRun = startRun(epipeEngine, { script: 'return null;' })
  const epipeResult = await epipeRun.result
  assert.equal(epipeResult.stopReason, 'error', 'worker-exit 错误必须以 error 结算')
  assert.match(epipeResult.error, /^workflow worker exited before settling/, '统一前缀（run.ts WORKER_EXIT_PREFIX 钉死契约，journal failure 可 grep）')
  assert.ok(epipeResult.error.includes('write EPIPE'), '前缀后原文全文保留（评审钉死契约）')
  assert.ok(!epipeResult.error.includes('workflow execution failed (worker-exit)'), '不得再落旧裸形态（settleFrom 旧分支字样）')
  assert.ok(!epipeResult.error.endsWith('write EPIPE'), '原文后必有病因说明文字，消息不以裸 EPIPE 结尾（fix-d3 ②）')

  // 对照形态（fix-d3 ①）：Node 进程退出路径的 exitMessage 已内嵌 stderr 摘录 →
  // 同一前缀 + 摘录保留（形态一与对照形态统一加前缀，不区分两套文案）。
  const nodeExitPtc = makeFakePtc()
  nodeExitPtc.run = async () => ({
    value: null,
    logs: [],
    error: { kind: 'worker-exit', message: 'Node process exited (1, signal null): TypeError: unexpected token return' },
  })
  const { engine: nodeExitEngine } = makeEngine(nodeExitPtc, join(scratchDir('d3-nodeexit'), 'journal.db'))
  const nodeExitRun = startRun(nodeExitEngine, { script: 'return null;' })
  const nodeExitResult = await nodeExitRun.result
  assert.equal(nodeExitResult.stopReason, 'error', '对照形态同以 error 结算')
  assert.match(nodeExitResult.error, /^workflow worker exited before settling/, '两形态统一加前缀（fix-d3 ①）')
  assert.ok(nodeExitResult.error.includes('TypeError: unexpected token'), 'stderr 摘录必须保留')
})

// ============ P0-A：engine 写侧与独立读侧同库 ============

test('P0-A 回归：临时文件 dbPath 跑完 completed run，另开 DatabaseSync 同路径 runProjection 读到 run/事件/节点', { timeout: 40000 }, async () => {
  const ptc = makeFakePtc()
  const dbPath = join(scratchDir('p0a'), 'journal.db')
  const { engine } = makeEngine(ptc, dbPath)

  // run-1：零请求脚本（成功路径不被「新发现二」的停滞自查竞态波及）→ completed。
  const run = startRun(engine, { script: 'return { done: true };' })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', '修前引擎建库不 initSchema，beginRun 即 no such table: dwf_run 同步抛')
  assert.deepEqual(result.value, { done: true })

  // run-2：report 产生节点行与五态事件；D1 修后正常收尾，stopReason 恢复断言
  // completed（修前受「新发现二」竞态波及，此处曾刻意不断言）。
  const nodeRun = startRun(engine, { script: 'await report({ note: 1 });' })
  const nodeResult = await nodeRun.result
  assert.equal(nodeResult.stopReason, 'completed', 'D1 修前：末个请求结算后收尾被停滞自查抢先折成 ScriptStalled')

  // 另开一条读侧连接（tool 读侧同法）：同一数据库文件。
  const readDb = new DatabaseSync(dbPath)
  const view = runProjection(readDb, run.id)
  assert.ok(view, '同路径必须投影出 run（修前引擎落 :memory:/无表必红）')
  assert.equal(view.status, 'completed')
  const eventTypes = view.events.map(event => event.type)
  assert.ok(eventTypes.includes('run-started'), 'journal 事件可读：run-started')
  assert.ok(eventTypes.includes('run-settled'), 'journal 事件可读：run-settled')

  const nodeView = runProjection(readDb, nodeRun.id)
  assert.ok(nodeView, '同库第二个 run 可读')
  assert.equal(nodeView.nodesTotal, 1)
  assert.equal(nodeView.nodes.length, 1)
  assert.equal(nodeView.nodes[0].kind, 'report')
  assert.equal(nodeView.nodes[0].status, 'completed', 'report 节点行落盘且读侧可读（engine 写侧与 tool 读侧同库）')
  const nodeEventTypes = nodeView.events.map(event => event.type)
  assert.ok(nodeEventTypes.includes('node-queued') && nodeEventTypes.includes('node-settled'), 'journal 事件可读：节点五态')
})

// ============ #4：runCap 先判后计边界 ============

test('#4 回归：maxTotalAgents=2 声明 3 个 agent() → error(cap exceeded)；恰 2 个 → completed（先判后计边界）', { timeout: 40000 }, async () => {
  const overPtc = makeFakePtc()
  const { engine } = makeEngine(overPtc, join(scratchDir('cap-over'), 'journal.db'))
  const over = startRun(engine, {
    script: "agent('a1');\nagent('a2');\nagent('a3');\nreturn null;",
    maxTotalAgents: 2,
  })
  const overResult = await over.result
  assert.equal(overResult.stopReason, 'error', '第 runCap+1 个声明必须 fail run（修前纸面帽零消费必红）')
  assert.match(overResult.error, /cap exceeded/)

  const exactPtc = makeFakePtc()
  const { engine: exactEngine } = makeEngine(exactPtc, join(scratchDir('cap-exact'), 'journal.db'))
  const exact = startRun(exactEngine, {
    script: "agent('a1');\nagent('a2');\nreturn null;",
    maxTotalAgents: 2,
  })
  const exactResult = await exact.result
  assert.equal(exactResult.stopReason, 'completed', '恰 runCap 个必须放行——先判后计，先增后判会拒掉第 runCap 个')
})

// ============ #7：自动 label 与显式名撞形不误报 duplicate ============

test('#7 回归：自动 label "subagent 1" 之后显式 agent(\'subagent 1\') 不误报 duplicate；ordinal 由声明计数承载', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const dbPath = join(scratchDir('label'), 'journal.db')
  const { engine } = makeEngine(ptc, dbPath)
  const run = startRun(engine, {
    script: "agent();\nagent('subagent 1');\nreturn null;",
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', '修前宿主对自动 label 也查重必红（duplicate subagent name "subagent 1"）')
  const readDb = new DatabaseSync(dbPath)
  const actors = readDb
    .prepare('select ordinal, name from dwf_actor where run_id = ? order by ordinal')
    .all(run.id)
    .map(row => ({ ordinal: row.ordinal, name: row.name }))
  assert.deepEqual(
    actors,
    [
      { ordinal: 1, name: 'subagent 1' },
      { ordinal: 2, name: 'subagent 1' },
    ],
    'ordinal 必须由声明计数承载（自动 label 不进显式名查重集，但序号不冻结）',
  )
})

// ============ #8：循环内 filled hole 每次到达现场求值 ============

test('#8 回归：循环内 filled hole 现场求值——返回 [0,1] 而非 [0,0]', { timeout: 30000 }, async () => {
  const ptc = makeFakePtc()
  const { engine } = makeEngine(ptc, join(scratchDir('hole'), 'journal.db'))
  const run = startRun(engine, {
    // filled 形态按 facade 重载 body 须返回 Promise（async () => i）；guest 体纯 JS
    // 执行（见文件头「跨 realm 纪律」），不得写 TS 注解。filled hole 是同步现场
    // 求值，不发 request → 不武装停滞自查 → 成功路径不被「新发现二」波及。
    script: ['const acc = [];', 'for (let i = 0; i < 2; i += 1) {', "  acc.push(await hole('h', async () => i));", '}', 'return { acc };'].join('\n'),
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { acc: [0, 1] }, '修前 __fills 按 siteId 缓存闭包，第二 iteration 复用首次 let 绑定必得 [0,0]')
})

// ============ #5：投影展示帽 nodesUnlisted ============

test('#5 回归：2001 节点投影展示帽——nodesUnlisted===true 且列表截断到 2000', () => {
  const dbPath = join(scratchDir('nodecap'), 'journal.db')
  const db = new DatabaseSync(dbPath)
  initSchema(db)
  const store = new JournalStore(db)
  const runId = 'run-node-cap'
  store.beginRun({ id: runId, name: 'cap-probe', script: 'export function main() {}', args: {}, capsMaxConcurrency: 1 })
  for (let i = 0; i < CAPS.maxNodes + 1; i += 1) {
    store.recordNode(runId, { siteId: `site#${i}`, kind: 'report', input: { i }, status: 'completed', result: { i } })
  }
  store.settleRun(runId, { status: 'completed' })
  const readDb = new DatabaseSync(dbPath)
  const view = runProjection(readDb, runId)
  assert.equal(view.nodesTotal, CAPS.maxNodes + 1, '记账不阻断：dwf_node 全量落行')
  assert.equal(view.nodesUnlisted, true, '修前投影无展示帽（nodesUnlisted 恒缺省）必红')
  assert.equal(view.nodes.length, CAPS.maxNodes, '展示列表截断到 maxNodes')
})
