/**
 * 模型池单测（node --import ./test/runtime-stubs.mjs --test test/pool.test.mjs）：
 * 纯池逻辑（分摊/轮转/冷却/耗尽/错误分类）+ ActorRegistry 换道行为
 * （池分摊换道 / 显式硬绑定不换 / 瞬态退避后换道）。actor.ts 值导入
 * @deepseek-ai/dsh-workflow（WorkflowError），故本文件与引擎单测同法带替身跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelPool, classifyProviderError } from '../src/engine/pool.ts'
import { ActorRegistry } from '../src/engine/actor.ts'

// ============ 纯池逻辑 ============

test('spread：按 provider 累计分配最少优先，跨家均摊', () => {
  const pool = new ModelPool(['a/m1', 'a/m2', 'b/m3'])
  const chosen = Array.from({ length: 4 }, () => pool.choose())
  const fromA = chosen.filter(m => m?.startsWith('a/')).length
  const fromB = chosen.filter(m => m?.startsWith('b/')).length
  assert.equal(fromA, 2)
  assert.equal(fromB, 2)
  // 同 provider 多模型轮转（a 桶两次分别给 m2/m1，不永远用第一个）。
  const aModels = new Set(chosen.filter(m => m?.startsWith('a/')))
  assert.equal(aModels.size, 2)
})

test('round-robin：按 provider 声明序轮转', () => {
  const pool = new ModelPool(['a/m1', 'b/m2'], { policy: 'round-robin' })
  assert.equal(pool.choose(), 'a/m1')
  assert.equal(pool.choose(), 'b/m2')
  assert.equal(pool.choose(), 'a/m1')
})

test('确定性故障冷却：窗内跳过该 provider，窗外恢复', () => {
  let clock = 0
  const pool = new ModelPool(['a/m1', 'b/m2'], { cooldownMs: 1000, now: () => clock })
  assert.equal(pool.choose(), 'a/m1')
  pool.markProviderFailure('a/m1')
  assert.equal(pool.choose(), 'b/m2') // a 在冷却窗内被跳过
  clock = 1000
  assert.equal(pool.choose(), 'a/m1') // 窗外恢复（a 分配数 1 < b 分配数 1？平手取序在前 → a）
})

test('全部冷却 → choose 返回 undefined（调用方回落既有失败路径）', () => {
  const pool = new ModelPool(['a/m1', 'b/m2'])
  pool.markProviderFailure('a/m1')
  pool.markProviderFailure('b/m2')
  assert.equal(pool.choose(), undefined)
})

test('markProviderFailure 对池外模型是 no-op', () => {
  const pool = new ModelPool(['a/m1'])
  pool.markProviderFailure('zzz/other')
  assert.equal(pool.choose(), 'a/m1')
})

test('错误分类：额度/鉴权类 = deterministic；限流/网络类 = transient', () => {
  assert.equal(classifyProviderError(new Error('quota exceeded for this plan')), 'deterministic')
  assert.equal(classifyProviderError(new Error('401 unauthorized')), 'deterministic')
  assert.equal(classifyProviderError(new Error('no such model: glm-x')), 'deterministic')
  assert.equal(classifyProviderError(new Error('rate limited (429), slow down')), 'transient')
  assert.equal(classifyProviderError(new Error('fetch failed ECONNRESET')), 'transient')
})

// ============ ActorRegistry 换道行为（假 subagents） ============

function fakeSubagents(behavior) {
  const calls = []
  return {
    calls,
    async startActivation(init) {
      // p0-real-machine ④：真实 AgentOptions 是分字段 provider+model；fake 在
      // 此重建 "provider/model" 复合路由串，使断言仍按池的完整模型 id 表达。
      const opts = init.request.agentOptions
      const model = opts === undefined
        ? '(default)'
        : opts.provider !== undefined ? `${opts.provider}/${opts.model}` : opts.model
      calls.push(model)
      behavior(model, calls.length)
      return {
        childId: `sess-child-${calls.length}`,
        result: Promise.resolve({ output: `ok:${model}`, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
}

const registryDeps = (subagents, pool, extra = {}) => ({
  subagents,
  provider: 'spawn',
  parent: { id: 'p1', session: { id: 's1' } },
  cwd: async () => '/tmp',
  signal: new AbortController().signal,
  ...(pool === undefined ? {} : { pool }),
  ...extra,
})

test('池分摊的模型：确定性故障 → 冷却换道成功并记事件', async () => {
  const failovers = []
  const subagents = fakeSubagents((model) => {
    if (model === 'a/m1') throw new Error('insufficient quota')
    return undefined
  })
  const pool = new ModelPool(['a/m1', 'b/m2'])
  const registry = new ActorRegistry(registryDeps(subagents, pool, {
    failoverAttempts: 3,
    onModelFailover: e => failovers.push(e),
  }))
  registry.register('worker', 'actor#1', {})
  const result = await registry.ask(registry.lookup('worker'), 'do it', undefined)
  assert.equal(result.output, 'ok:b/m2')
  assert.equal(registry.resolvedModelOf('worker'), 'b/m2')
  assert.equal(failovers.length, 1)
  assert.deepEqual(
    { from: failovers[0].from, to: failovers[0].to },
    { from: 'a/m1', to: 'b/m2' },
  )
  // a 已进冷却：下一个未绑模型的 actor 直接拿 b。
  registry.register('worker2', 'actor#2', {})
  const r2 = await registry.ask(registry.lookup('worker2'), 'again', undefined)
  assert.equal(r2.output, 'ok:b/m2')
})

test('显式 persona.model = 硬绑定：不换道，原错误逃逸', async () => {
  const subagents = fakeSubagents((model) => {
    if (model === 'a/m1') throw new Error('insufficient quota')
    return undefined
  })
  const pool = new ModelPool(['a/m1', 'b/m2'])
  const registry = new ActorRegistry(registryDeps(subagents, pool, { failoverAttempts: 3 }))
  registry.register('pinned', 'actor#1', { model: 'a/m1' })
  await assert.rejects(
    () => registry.ask(registry.lookup('pinned'), 'do it', undefined),
    /insufficient quota/,
  )
  assert.equal(registry.resolvedModelOf('pinned'), 'a/m1')
})

test('瞬态错误：同模型退避重试，末次前换道成功', async () => {
  const subagents = fakeSubagents((model, n) => {
    if (n === 1) throw new Error('rate limited 429')
    return undefined
  })
  const pool = new ModelPool(['a/m1', 'b/m2'])
  const registry = new ActorRegistry(registryDeps(subagents, pool, { failoverAttempts: 2 }))
  registry.register('flaky', 'actor#1', {})
  const result = await registry.ask(registry.lookup('flaky'), 'do it', undefined)
  // 第一次 a/m1 瞬态失败 → 退避后（attempts=2 的下一次即末次）换到 b/m2 成功。
  assert.equal(result.output, 'ok:b/m2')
  assert.deepEqual(subagents.calls, ['a/m1', 'b/m2'])
})

test('池耗尽（全冷却）→ 原错误逃逸，不静默假装成功', async () => {
  const subagents = fakeSubagents((model) => {
    throw new Error(`quota exhausted on ${model}`)
  })
  const pool = new ModelPool(['a/m1', 'b/m2'])
  const registry = new ActorRegistry(registryDeps(subagents, pool, { failoverAttempts: 3 }))
  registry.register('doomed', 'actor#1', {})
  await assert.rejects(
    () => registry.ask(registry.lookup('doomed'), 'do it', undefined),
    /quota exhausted/,
  )
})
