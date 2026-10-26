/**
 * 引擎层纯逻辑单测（PLAN T6 验收②）：假 subagents/ptcRuntime 注入对象，不起宿主。
 * 覆盖：AgentLedger begin/end 幂等配对（B4）、三帽取小（B10）、scheduler 并发上限
 * 与同 actor FIFO、effects 对每次效应分派经 RunWriter 依序发出 node-queued/
 * dispatched/executing/waiting/settled 五事件（拍板表#18，假 writer 断言事件序列
 * 与载荷 runId/siteId）、hole 确定性 HOLE_UNAVAILABLE、handleReport caps 拒收折回。
 *
 * 命令：`node --import ./test/runtime-stubs.mjs --test test/engine.test.mjs`
 * （engine.ts 值导入 dsh-workflow/cordis/schemastery，errors.ts 值导入 dsh-llm——
 * 全部经替身解析；真实子代理/真实 PTC 集成本迭代不验，待接入真实 dsh，DESIGN §7.2。）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { AgentLedger, DwfWorkflowRun } = await import('../src/engine/run.ts')
const { Scheduler } = await import('../src/engine/scheduler.ts')
const { ActorRegistry, agentOptionsFor } = await import('../src/engine/actor.ts')
const { EffectHandlers } = await import('../src/engine/effects.ts')
const { ArtifactSink } = await import('../src/engine/artifacts.ts')
const { validateMeta, resolveRunCap } = await import('../src/engine/engine.ts')
const { WorkflowError } = await import('@deepseek-ai/dsh-workflow')

const RUN_ID = 'run-test-0001'

/** 假 RunWriter（writerFor 绑定形态）：记录事件序列 / node 行 / actor 行 / 结算。 */
function fakeWriter() {
  const ordinals = new Map()
  return {
    events: [],
    nodes: [],
    actors: [],
    settled: [],
    appendEvent(event) {
      this.events.push(event)
    },
    recordNode(node) {
      const ordinal = (ordinals.get(node.siteId) ?? 0) + 1
      ordinals.set(node.siteId, ordinal)
      this.nodes.push({ ...node, ordinal })
      return { siteId: node.siteId, ordinal }
    },
    recordActor(siteId, ordinal, name, persona) {
      this.actors.push({ siteId, ordinal, name, persona })
    },
    settleRun(outcome) {
      this.settled.push(outcome)
    },
  }
}

/** 五态事件序列的公共断言：顺序 + runId/siteId 载荷（拍板表#18）。 */
function assertFiveStates(events, siteId) {
  const states = events.filter(event => event.payload.siteId === siteId).map(event => event.type)
  assert.deepEqual(
    states,
    ['node-queued', 'node-dispatched', 'node-executing', 'node-waiting', 'node-settled'],
    `site ${siteId} 的五态序列不符：${states.join(' → ')}`,
  )
  for (const event of events.filter(item => item.payload.siteId === siteId)) {
    assert.equal(event.payload.runId, RUN_ID, '五态事件载荷必须带 runId')
    assert.equal(event.payload.siteId, siteId, '五态事件载荷必须带 siteId')
  }
}

function makeEffects(writer, overrides = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'dwf-engine-test-'))
  const controller = new AbortController()
  const failures = []
  const actors = new ActorRegistry({
    subagents: overrides.subagents ?? { async startActivation() { throw new Error('not expected in this test') } },
    provider: 'spawn',
    parent: { id: 'agent-1', session: { id: 'sess-1' } },
    cwd: async () => workspaceRoot,
    signal: controller.signal,
    onWarn: () => {},
  })
  const sink = new ArtifactSink({ runId: RUN_ID, writer, workspaceRoot })
  const effects = new EffectHandlers({
    runId: RUN_ID,
    writer,
    scheduler: new Scheduler(2, { baseDelayMs: 1 }),
    actors,
    sink,
    workspaceRoot,
    signal: controller.signal,
    onRunFailure: message => failures.push(message),
    onAgentAccepted: () => ({ seq: 1 }),
    onAgentSettled: () => {},
  })
  return { effects, failures, workspaceRoot, controller }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ============ B4：AgentLedger begin/end 幂等配对 ============

test('AgentLedger: seq 单调、agentsStarted 计数、end 幂等配对', () => {
  const started = []
  const ended = []
  const ledger = new AgentLedger(info => started.push(info), info => ended.push(info))

  const first = ledger.begin('alice', 'sess-a')
  const second = ledger.begin('bob', 'sess-b', 'phase-1')
  assert.equal(first.seq, 1)
  assert.equal(first.childId, 'sess-a')
  assert.equal(second.seq, 2)
  assert.equal(ledger.agentsStarted, 2)
  assert.deepEqual(started, [
    { seq: 1, label: 'alice', childId: 'sess-a' },
    { seq: 2, label: 'bob', childId: 'sess-b', phase: 'phase-1' },
  ])

  ledger.end(1, 'completed')
  ledger.end(1, 'failed') // 已 end 的 seq 幂等跳过——每条 stop 路径恰好一次
  ledger.end(2, 'cancelled')
  ledger.end(99, 'completed') // 越界 seq 不产生事件
  assert.deepEqual(ended, [
    { seq: 1, label: 'alice', childId: 'sess-a', outcome: 'completed' },
    { seq: 2, label: 'bob', childId: 'sess-b', phase: 'phase-1', outcome: 'cancelled' },
  ])
})

// ============ B10：三帽取小 ============

test('resolveRunCap: 缺省取 CAPS.maxSubagents(64) 与 ceiling 取小；超 ceiling 报 INVALID_ARGUMENT', () => {
  assert.equal(resolveRunCap(undefined, 1000), 64, '缺省 = min(64, 1000)')
  assert.equal(resolveRunCap(200, 1000), 200, '请求值在帽内直通')
  assert.equal(resolveRunCap(undefined, 50), 50, '缺省还要与更小的 ceiling 取小')
  assert.equal(resolveRunCap(30, 1000), 30)
  assert.throws(() => resolveRunCap(2000, 1000), error => error instanceof WorkflowError && error.code === 'INVALID_ARGUMENT')
  assert.throws(() => resolveRunCap(0, 1000), error => error instanceof WorkflowError && error.code === 'INVALID_ARGUMENT')
  assert.throws(() => resolveRunCap(1.5, 1000), error => error instanceof WorkflowError && error.code === 'INVALID_ARGUMENT')
})

test('validateMeta: 合法 meta 归一化副本；违规点名叫 META_INVALID', () => {
  const meta = validateMeta({ name: 'my-flow', description: 'd', phases: [{ title: 'p1' }] })
  assert.deepEqual(meta, { name: 'my-flow', description: 'd', phases: [{ title: 'p1' }] })
  // 归一化副本：改返回值不影响入参
  meta.name = 'mutated'
  assert.throws(() => validateMeta({ name: '', description: 'd' }), error => error instanceof WorkflowError && error.code === 'META_INVALID')
  assert.throws(() => validateMeta({ name: 'a', description: 'd', unknownField: 1 }), /unknownField/)
  assert.throws(() => validateMeta('nope'), error => error instanceof WorkflowError && error.code === 'META_INVALID')
})

// ============ scheduler：并发上限 + 同 actor FIFO + 重试/终局 ============

test('Scheduler: 全局并发上限不被突破，收割后补位', async () => {
  const scheduler = new Scheduler(2, { baseDelayMs: 1 })
  let running = 0
  let peak = 0
  const gate = new Promise(resolve => {
    setTimeout(resolve, 20)
  })
  for (let i = 0; i < 5; i += 1) {
    scheduler.enqueue(`actor-${i}`, {
      work: async () => {
        running += 1
        peak = Math.max(peak, running)
        await gate
        running -= 1
      },
    })
  }
  await scheduler.drain()
  assert.equal(peak, 2, '在飞任务峰值必须等于 maxConcurrency')
})

test('Scheduler: 同 actor FIFO——后到 ask 等先到结算', async () => {
  const scheduler = new Scheduler(2, { baseDelayMs: 1 })
  const order = []
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  scheduler.enqueue('a', {
    work: async () => {
      order.push('a1')
      await gate
    },
  })
  scheduler.enqueue('b', {
    work: async () => {
      order.push('b1')
    },
  })
  scheduler.enqueue('a', {
    work: async () => {
      order.push('a2')
    },
  })
  await tick()
  assert.deepEqual(order, ['a1', 'b1'], 'a2 必须被同 actor FIFO 挡住（b1 先行）')
  release()
  await scheduler.drain()
  assert.deepEqual(order, ['a1', 'b1', 'a2'])
})

test('Scheduler: provider 类错误固定次数重试 + 指数退避后成功；终局错误进 onTerminal 不进脚本', async () => {
  let attempts = 0
  let terminal = 0
  const flaky = new Scheduler(1, { attempts: 3, baseDelayMs: 1, onTerminal: () => terminal++ })
  flaky.enqueue('a', {
    work: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('provider hiccup (rate limited)')
    },
  })
  await flaky.drain()
  assert.equal(attempts, 3)
  assert.equal(terminal, 0)

  // 确定性错误（WorkflowError）不重试、交终局回调；enqueue 的 promise 永不 reject。
  let deterministicTerminal = 0
  const strict = new Scheduler(1, { attempts: 3, baseDelayMs: 1, onTerminal: () => deterministicTerminal++ })
  strict.enqueue('a', {
    work: async () => {
      throw new WorkflowError('deterministic failure', 'AGENT_RESULT')
    },
  })
  await strict.drain()
  assert.equal(deterministicTerminal, 1, '确定性错误立即终局')
})

// ============ effects：五态发射（拍板表#18）+ hole 确定性失败 ============

test('effects: world-run 分派经 RunWriter 依序发五事件，载荷带 runId/siteId，node 行落 world-run', async () => {
  const writer = fakeWriter()
  const { effects } = makeEffects(writer)
  const value = await effects.dispatch({
    siteId: 'site#1',
    op: 'world-run',
    args: { cmd: process.execPath, args: ['-e', 'process.stdout.write("ok")'], timeoutMs: null },
  })
  assert.deepEqual(value, { exitCode: 0, stdout: 'ok', stderr: '' })
  assertFiveStates(writer.events, 'site#1')
  const settled = writer.events.find(event => event.type === 'node-settled' && event.payload.siteId === 'site#1')
  assert.equal(settled.payload.ok, true)
  assert.equal(writer.nodes.length, 1)
  assert.equal(writer.nodes[0].kind, 'world-run')
  assert.equal(writer.nodes[0].status, 'completed')
})

test('effects: hole 确定性 HOLE_UNAVAILABLE——绝不挂起，五事件照发、不落 node 行（DDL kind 无 hole）', async () => {
  const writer = fakeWriter()
  const { effects } = makeEffects(writer)
  await assert.rejects(
    effects.dispatch({ siteId: 'site#2', op: 'hole', args: { name: 'decision', prompt: '' } }),
    error => error.code === 'DW_31' && /cannot be filled/.test(error.message),
  )
  assertFiveStates(writer.events, 'site#2')
  const settled = writer.events.find(event => event.type === 'node-settled' && event.payload.siteId === 'site#2')
  assert.equal(settled.payload.ok, false)
  assert.equal(writer.nodes.length, 0, 'hole 无合法 node kind（DDL CHECK 五值），落事件不落行')
})

test('effects: world-read files.glob 真实执行且五态照发；未知 op 折回确定性 rejection', async () => {
  const writer = fakeWriter()
  const { effects, workspaceRoot } = makeEffects(writer)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(workspaceRoot, 'a.txt'), 'hi')
  const files = await effects.dispatch({ siteId: 'site#3', op: 'world-read', args: { op: 'files.glob', args: ['*.txt'] } })
  assert.deepEqual(files, ['a.txt'])
  assertFiveStates(writer.events, 'site#3')
  await assert.rejects(
    effects.dispatch({ siteId: 'site#4', op: 'world-read', args: { op: 'files.nope', args: [] } }),
    /unknown world-read op/,
  )
  assertFiveStates(writer.events, 'site#4')
})

test('effects: report 被 handleReport 拒收时 {ok:false} 折回并触发 run 失败回调', async () => {
  const writer = fakeWriter()
  const { effects, failures } = makeEffects(writer)
  const ok = await effects.dispatch({ siteId: 'site#5', op: 'report', args: { item: { n: 1 } } })
  assert.deepEqual(ok, { ok: true })
  const rejected = await effects.dispatch({ siteId: 'site#6', op: 'report', args: { item: { n: 1 }, artifactId: 'chart-1' } })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /preset/)
  assert.equal(failures.length, 1, 'caps 拒收必须折回为 run 失败（facade：caps fail the whole run）')
})

// ============ artifacts：caps 拒收折回 ============

test('ArtifactSink.handleReport: 条数/单条字节/带 tag 三路拒收；接受落 report 行', () => {
  const writer = fakeWriter()
  const sink = new ArtifactSink({ runId: RUN_ID, writer, workspaceRoot: tmpdir() })
  assert.deepEqual(sink.handleReport({ a: 1 }, 'site#7'), { ok: true })
  assert.equal(writer.nodes[0].kind, 'report')

  const huge = { blob: 'x'.repeat(1 << 20 + 1) }
  const perItem = sink.handleReport(huge, 'site#8')
  assert.equal(perItem.ok, false)
  assert.match(perItem.error, /report cap exceeded/)

  const tagged = sink.handleReport({ a: 1 }, 'site#9', 'chart-1')
  assert.equal(tagged.ok, false, 'preset defer：带 artifactId 的 report 命名不到 preset → 拒收终止 run')
  assert.match(tagged.error, /preset/)
})

test('ArtifactSink: title/description 帽与 primary 至多一个 id', async () => {
  const writer = fakeWriter()
  const sink = new ArtifactSink({ runId: RUN_ID, writer, workspaceRoot: tmpdir() })
  await assert.rejects(sink.publishMarkdown('md1', '# hi', { title: 'x'.repeat(121) }, 'site#10'), /title exceeds/)
  const first = await sink.publishMarkdown('md1', '# hi', { primary: true }, 'site#10')
  assert.deepEqual(first, { id: 'md1', version: 1 })
  await assert.rejects(sink.publishMarkdown('md2', '# hi', { primary: true }, 'site#11'), /at most one primary id/)
  const republish = await sink.publishMarkdown('md1', '# hi v2', {}, 'site#12')
  assert.equal(republish.version, 2, 'republish = 新版本')
})

// ============ run.ts：假 PTC 驱动（B7 名字注册表 / 沙箱硬门 / 结算折词） ============

/** 假 PtcRuntime：捕获 dwfHost 绑定面，把 guest 行为编进脚本（contract-v2 §1 形状）。 */
function fakePtc(script) {
  const captured = {}
  return {
    captured,
    programFormat: 'function-body',
    sandboxMode: undefined,
    resolve(request) {
      captured.request = request
      return { ...request, cwd: request.cwd ?? '/', timeoutMs: request.timeoutMs ?? null }
    },
    async run() {
      const dwfHost = captured.request.bindings[0].functions
      await script(dwfHost)
      return { value: null, logs: [] }
    },
  }
}

function makeRun(writer, ptc) {
  const run = new DwfWorkflowRun({
    ctx: { logger: { warn() {}, info() {} } },
    subagents: { async startActivation() { throw new Error('no real subagents in unit test') } },
    ptcRuntime: ptc,
    policy: { mode: 'danger-full-access', workspaceRoot: mkdtempSync(join(tmpdir(), 'dwf-run-test-')) },
    id: RUN_ID,
    meta: { name: 't', description: 't' },
    parent: { id: 'agent-1', session: { id: 'sess-1' } },
    provider: 'spawn',
    body: '/* lowered body */',
    args: {},
    limits: { maxConcurrentAgents: 4, maxTotalAgents: 64, maxItemsPerCall: 1, syncTimeoutMs: 0 },
    writer,
    runCap: 64,
    maxConcurrency: 4,
    cwd: Promise.resolve('/tmp'),
    observer: { phase() {}, log() {}, agentStart() {}, agentEnd() {} },
  })
  return run
}

test('run: declare-actor 计算名重复 → 宿主查重（B7）→ run 以 error 结算，journal 记 failed', async () => {
  const writer = fakeWriter()
  const ptc = fakePtc(async dwfHost => {
    await dwfHost.begin()
    dwfHost.event({ type: 'declare-actor', args: { siteId: 'actor#1', label: 'dup', persona: { system: 's' } } })
    dwfHost.event({ type: 'declare-actor', args: { siteId: 'actor#2', label: 'dup', persona: {} } })
    dwfHost.complete({ ok: true, value: { done: true } })
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'error', 'computed 名字重复必须 fail the run（facade.d.ts:37-38）')
  assert.match(result.error, /duplicate subagent name "dup"/)
  assert.equal(writer.actors.length, 1, '重复名字在注册前已被拒，dwf_actor 只落一行')
  assert.deepEqual(writer.settled, [{ status: 'failed', failure: result.error }], 'seam 词表 error 折成 journal 词表 failed')
  assert.ok(ptc.captured.request.timeoutMs === null, 'contract-v2 §1：timeoutMs:null（停跑永不超时）')
  assert.equal(ptc.captured.request.bindings[0].global, 'dwfHost')
  assert.deepEqual(Object.keys(ptc.captured.request.bindings[0].functions).sort(), ['begin', 'complete', 'event', 'request'], '宿主函数面就这四个')
})

test('run: 正常 complete(ok) → completed 结算；begin 回包携带 meta/args/limits（B7 承载通道）', async () => {
  const writer = fakeWriter()
  let init
  const ptc = fakePtc(async dwfHost => {
    init = await dwfHost.begin()
    dwfHost.complete({ ok: true, value: { answer: 42 } })
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { answer: 42 })
  assert.equal(result.agentsStarted, 0)
  assert.deepEqual(init.meta, { name: 't', description: 't' })
  assert.deepEqual(init.limits.maxTotalAgents, 64)
  assert.deepEqual(writer.settled, [{ status: 'completed', result: { answer: 42 } }])
})

test('run: 沙箱硬门——runtime 无文件约束且策略非 danger-full-access → 拒绝执行（error 结算）', async () => {
  const writer = fakeWriter()
  const run = new DwfWorkflowRun({
    ctx: { logger: { warn() {}, info() {} } },
    subagents: {},
    ptcRuntime: fakePtc(async () => {}),
    policy: { mode: 'read-only', workspaceRoot: tmpdir() },
    id: RUN_ID,
    meta: { name: 't', description: 't' },
    parent: { id: 'agent-1', session: { id: 'sess-1' } },
    provider: 'spawn',
    body: '',
    args: {},
    limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 1, syncTimeoutMs: 0 },
    writer,
    runCap: 1,
    maxConcurrency: 1,
    cwd: Promise.resolve('/tmp'),
    observer: { phase() {}, log() {}, agentStart() {}, agentEnd() {} },
  })
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.error, /cannot enforce the read-only file policy/)
})

test('agentOptionsFor：复合串 provider/model 拆分（p0-real-machine ④）', () => {
  // 复合串 → 分字段（真实 AgentOptions 形状，dsh-agent runtime-types.d.ts:21-37）
  assert.deepEqual(agentOptionsFor('agy/gemini-3.8-flash-high'), { provider: 'agy', model: 'gemini-3.8-flash-high' })
  // wf-gate 路由：model id 由适配器忽略，provider 是路由键
  assert.deepEqual(agentOptionsFor('wf-gate/gate'), { provider: 'wf-gate', model: 'gate' })
  // 裸模型名 → 只覆盖 model（provider 走父级继承）
  assert.deepEqual(agentOptionsFor('gemini-3.8-flash-high'), { model: 'gemini-3.8-flash-high' })
  // 退化形状不拆：开头/结尾斜杠
  assert.deepEqual(agentOptionsFor('/leading'), { model: '/leading' })
  assert.deepEqual(agentOptionsFor('trailing/'), { model: 'trailing/' })
})
