/**
 * worker 非正常退出回归（t3-epipe-clean-error）：真机首例 run 07770553——模型被
 * provider 拒收后 run 以裸「workflow execution failed (worker-exit): write EPIPE」
 * 收场，journal dwf_node 0 行、无任何可定位诊断。探因结论（dsh-ptc-runtime-node
 * lib/index.js）：worker stderr 其实被 admit 进 PtcRunResult.logs（index.js:1663-1671、
 * types.d.ts:158），但 io/流 error 路径先结算者胜，抢在带退出码+stderr 的退出汇总
 * 之前，宿主侧（run.ts）又把 outcome.logs 整体丢弃 → 只剩裸 errno。
 *
 * 修复面（run.ts settleFrom/cleanWorkerExitMessage）：kind==='worker-exit' 的错误
 * 折叠为统一前缀 + 原文 + 可用诊断（logs 摘录或如实说明未捕获），不再以裸 EPIPE
 * 收场；journal settleRun 的 failure 同步携带。
 *
 * 命令：`node --import ./test/runtime-stubs.mjs --test test/worker-exit.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { DwfWorkflowRun, cleanWorkerExitMessage, WORKER_EXIT_PREFIX } = await import('../src/engine/run.ts')

const RUN_ID = 'run-worker-exit-0001'

/** 假 RunWriter（writerFor 绑定形态）：只关心事件/结算（与 engine.test.mjs 同骨架）。 */
function fakeWriter() {
  return {
    events: [],
    nodes: [],
    actors: [],
    settled: [],
    appendEvent(event) {
      this.events.push(event)
    },
    recordNode(node) {
      this.nodes.push(node)
      return { siteId: node.siteId, ordinal: 1 }
    },
    recordActor(siteId, ordinal, name, persona) {
      this.actors.push({ siteId, ordinal, name, persona })
    },
    settleRun(outcome) {
      this.settled.push(outcome)
    },
  }
}

/**
 * 假 PtcRuntime：不执行脚本，直接按注入的 outcome 结算（contract-v2 §1 形状：
 * 失败是 result.error 字段而非 reject；logs 随结果返回）。
 */
function fakePtcOutcome(outcome) {
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
      return outcome
    },
  }
}

function makeRun(writer, ptc) {
  return new DwfWorkflowRun({
    ctx: { logger: { warn() {}, info() {} } },
    subagents: { async startActivation() { throw new Error('no real subagents in unit test') } },
    ptcRuntime: ptc,
    policy: { mode: 'danger-full-access', workspaceRoot: mkdtempSync(join(tmpdir(), 'dwf-worker-exit-test-')) },
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
}

test('run: worker-exit 裸 EPIPE + logs 带 worker stderr → error 折叠前缀/原文/摘录，journal 同步', async () => {
  const writer = fakeWriter()
  const stderrExcerpt = 'ReferenceError: dwfHost is not defined\n    at ptc-repl:1:1'
  const ptc = fakePtcOutcome({
    value: null,
    logs: [stderrExcerpt],
    error: { kind: 'worker-exit', message: 'write EPIPE' },
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'error', 'worker 非正常退出必须以 error 结算')
  assert.ok(result.error.startsWith(WORKER_EXIT_PREFIX), `错误必须带统一可 grep 前缀：${result.error}`)
  assert.ok(result.error.includes('write EPIPE'), '原始传输错误字面必须保留（不得改写删除）')
  assert.ok(result.error.includes(stderrExcerpt), `worker stderr 摘录必须折进消息：${result.error}`)
  assert.ok(
    !result.error.endsWith('write EPIPE'),
    '消息不得以裸 EPIPE 结尾（真机首例的裸逃逸形态）',
  )
  assert.deepEqual(
    writer.settled,
    [{ status: 'failed', failure: result.error }],
    'journal 结算必须携带同一折叠消息（failure_json 可 grep）',
  )
})

test('run: worker-exit 裸 EPIPE + logs 为空 → 如实说明未捕获，不以裸 EPIPE 收场', async () => {
  const writer = fakeWriter()
  const ptc = fakePtcOutcome({
    value: null,
    logs: [],
    error: { kind: 'worker-exit', message: 'write EPIPE' },
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.ok(result.error.startsWith(WORKER_EXIT_PREFIX))
  assert.ok(result.error.includes('write EPIPE'), '原文保留')
  assert.ok(result.error.includes('no worker output was captured'), `未捕获必须如实说明：${result.error}`)
  assert.ok(!result.error.endsWith('write EPIPE'), '消息不得以裸 EPIPE 结尾')
  assert.deepEqual(writer.settled, [{ status: 'failed', failure: result.error }])
})

test('run: worker-exit 退出汇总形态（已带退出码+stderr）→ 前缀 + 原文完整，不重复摘录', async () => {
  const writer = fakeWriter()
  const runtimeMessage = 'Node process exited before completing (1): ReferenceError: boom'
  const ptc = fakePtcOutcome({
    value: null,
    logs: ['ReferenceError: boom'],
    error: { kind: 'worker-exit', message: runtimeMessage },
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.equal(result.error, `${WORKER_EXIT_PREFIX}${runtimeMessage}`, '退出码(1)与 stderr 已在原文内嵌，只加前缀')
  assert.ok(result.error.includes('(1)'), '退出码必须可定位')
  assert.deepEqual(writer.settled, [{ status: 'failed', failure: result.error }])
})

test('run: 非 worker-exit 错误（protocol 等）维持原折叠词，不受摘录逻辑影响', async () => {
  const writer = fakeWriter()
  const ptc = fakePtcOutcome({
    value: null,
    logs: ['noise'],
    error: { kind: 'protocol', message: 'invalid control frame' },
  })
  const run = makeRun(writer, ptc)
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.equal(result.error, 'workflow execution failed (protocol): invalid control frame')
})

// ============ cleanWorkerExitMessage 单元面 ============

test('cleanWorkerExitMessage: 摘录超限只保留尾部并注明截断', () => {
  const head = 'x'.repeat(600)
  const tail = 'SyntaxError: Unexpected token return'
  const logs = [`${head}${tail}`]
  const message = cleanWorkerExitMessage('write EPIPE', logs)
  assert.ok(message.includes(tail), '摘录必须保留尾部（崩溃点通常在输出末尾）')
  assert.ok(!message.includes(head), '超限头部必须截掉')
  assert.ok(message.includes('(truncated)'), '截断必须注明')
})

test('cleanWorkerExitMessage: 空 logs 缺省（旧调用形态兼容）', () => {
  const message = cleanWorkerExitMessage('write EPIPE')
  assert.ok(message.startsWith(WORKER_EXIT_PREFIX))
  assert.ok(message.includes('no worker output was captured'))
})
