/**
 * T4 无宿主冒烟（PLAN §2/T4，断言定稿即冻结，§4 考卷纪律）。
 *
 * 不起 dsh 宿主、纯 node 进程（node 24 默认 type-stripping 直跑 src TS）。
 * - guest 侧：从 src/guest/{realm,channels,prelude}.ts 用正则 String\.raw`([\s\S]*)`
 *   抽源（三文件零 import、每文件恰一个 String.raw 且内容无裸反引号），node:vm
 *   建 context 注入假 dwfHost 四绑定 {begin, request, event, complete}
 *   （形状按 src/guest/protocol.ts + prelude.ts:27-48），program = realm+channels+prelude+测试体。
 * - journal 侧：node:sqlite :memory: 内存库 + initSchema + JournalStore + projection
 *   直 import——冒烟依赖面（journal×4+guest×3+util/json.ts）零官方包值导入
 *   （PLAN §0 全局不变式②），故冒烟命令不带 --import 替身。
 *
 * 断言五组 + 幂等（定稿清单，不得对卷调参）：
 *   ① FIFO——同 actor 两次 ask 乱序回包仍按提交序结算；
 *   ② event 与 request 共享 FIFO——declare-artifact 不被后发 report 超车；
 *   ③ 停滞检测——park 一个 channel receiver 且无在飞请求 → complete{ok:false}
 *      且 error.name === 'ChannelDeadlock'（prelude.ts:60-63）；
 *   ④ Date/random 三点禁令 + new Date(0) 透传（拍板表#2 后的语义）；
 *   ⑤ journal 往返——runProjection/listRuns 与写入的 sequence/ordinal/status 逐字段
 *      对账；node-* 五态事件以手工 append 喂入验 projection 对账（拍板表#18 记账/投影
 *      半环，发射半环由 T6 单测覆盖）；另 complete 幂等（prelude.ts:45-46）。
 *
 * 验收：node test/smoke.mjs EXIT=0 全绿。
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(pkgRoot, 'src')

// 进程级兜底：任何未处理拒绝都算冒烟失败，不许静默吞掉。
process.on('unhandledRejection', (reason) => {
  console.error('未处理拒绝（冒烟进程级）：', reason)
  process.exitCode = 1
})

// ============ 断言记账 ============

const outcomes = []

function check(group, name, cond, detail = '') {
  const pass = !!cond
  outcomes.push({ group, name, pass })
  console.log((pass ? '  ✅ ' : '  ❌ ') + `${group} ${name}` + (pass || !detail ? '' : `\n       ↳ ${detail}`))
  return pass
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待条件成立（宿主侧真定时器；realm 内定时器已被禁，宿主不受限）。 */
async function until(cond, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) throw new Error('等待超时：' + label)
    await delay(5)
  }
}

// ============ guest 源抽取（正则抽 String.raw，PLAN T4 spec） ============

/**
 * 抽取前提自检（PLAN T4 spec 括号内声明）：每文件恰一个 String.raw 且模板**内容**
 * 无裸反引号——此时贪婪正则的 m[1] 与字符串值确定等价（文件头注释里的反引号
 * 位于匹配起点之前，不影响抽取）。
 */
function extractStringRawSource(tsPath, label) {
  const text = readFileSync(tsPath, 'utf8')
  const m = text.match(/String\.raw`([\s\S]*)`/)
  if (m === null) throw new Error(`${label}: 未匹配到 String.raw 源`)
  if (m[1].includes('`')) throw new Error(`${label}: String.raw 内容含裸反引号，raw 抽取等价前提不成立`)
  return m[1]
}

const GUEST_PROGRAM_SOURCES = [
  extractStringRawSource(join(srcDir, 'guest', 'realm.ts'), 'guest/realm.ts'), // ← realm 源注入行（反向自检①：临时注释本行重跑，断言④必须 FAIL、断言③预期仍 PASS；验后还原）
  extractStringRawSource(join(srcDir, 'guest', 'channels.ts'), 'guest/channels.ts'),
  extractStringRawSource(join(srcDir, 'guest', 'prelude.ts'), 'guest/prelude.ts'),
]

// ============ 假 dwfHost（四绑定，形状按 protocol.ts + prelude.ts:27-48） ============

function makeFakeHost() {
  const host = {
    arrivals: [], // 到达序账本（event 与 request 共享 FIFO 的观察点）
    requests: [],
    events: [],
    completes: [],
    deferred: [], // 手动应答模式下的在飞请求 {msg, resolve, reject}
    autoAnswer: null, // 置为 (msg) => Json 则请求即刻应答
  }
  host.bindings = {
    // WorkerInit（protocol.ts:36-45）：begin() 承载 meta/args/limits
    begin() {
      return Promise.resolve({
        meta: { name: 'smoke-run', description: 'T4 无宿主冒烟' },
        args: { n: 1 },
        limits: { maxConcurrentAgents: 2, maxTotalAgents: 4, maxItemsPerCall: 8, syncTimeoutMs: 1000 },
      })
    },
    request(msg) {
      host.arrivals.push({ channel: 'request', msg })
      host.requests.push(msg)
      if (host.autoAnswer) return Promise.resolve(host.autoAnswer(msg))
      return new Promise((resolve, reject) => {
        host.deferred.push({ msg, resolve, reject })
      })
    },
    event(evt) {
      host.arrivals.push({ channel: 'event', evt })
      host.events.push(evt)
    },
    complete(result) {
      host.completes.push(result)
    },
  }
  return host
}

/** 组装并启动一个 guest 场景：program = realm+channels+prelude+启动体。 */
function runGuestScenario({ bodySource, hostSetup }) {
  const host = makeFakeHost()
  if (hostSetup) hostSetup(host)
  const out = []
  const context = vm.createContext({ dwfHost: host.bindings, out })
  // bodySource 是 async 函数表达式源码；body 拒绝必须被捕获（防未处理拒绝炸进程，且可被断言发现）
  const boot =
    '__start(function () { return (' + bodySource + ')(); })' +
    '\n  .catch(function (e) { out.push("BODY-REJECT " + ((e && e.name) || "Error") + ": " + (e && e.message)); });'
  const program = [...GUEST_PROGRAM_SOURCES, boot].join('\n')
  vm.runInContext(program, context, { filename: 'guest-program.js' })
  return { host, out }
}

function hasBodyReject(out) {
  return out.some((line) => String(line).startsWith('BODY-REJECT'))
}

// ============ ① FIFO：同 actor ask 乱序回包按提交序结算 ============

async function group1Fifo() {
  console.log('① 同 actor ask FIFO（乱序回包按提交序结算）')
  const { host, out } = runGuestScenario({
    hostSetup: (h) => {
      h.autoAnswer = null // 手动应答：宿主完全控制回包时机
    },
    bodySource: `async function () {
      var a = agent('worker')
      // 在飞保活（场景管道，非被测语义）：prelude 停滞自查只在「最后一个在飞请求结算」
      // 后武装；若两次 ask 之间在飞清零，tail 链的 promise 采纳跳数会落后于 2 微任务
      // 窗口，run 会被 ScriptStalled 抢先结算（见结果报告）。持住一条 hole 使 pending
      // 恒 ≥1，把被测属性（同 actor 提交序结算）从该窗口行为中隔离出来。
      var hold = __hole('site#HOLD', 'hh', 'pp')
      var p1 = __ask(a, 'site#1', 'i1')
      var p2 = __ask(a, 'site#2', 'i2')
      p1.then(function (v) { out.push('settle#1=' + v) })
      p2.then(function (v) { out.push('settle#2=' + v) })
      await hold
      out.push('hold-released')
    }`,
  })
  await until(() => host.deferred.some((d) => d.msg.op === 'hole'), '① 等待保活 hole 抵达宿主')
  await until(() => host.deferred.some((d) => d.msg.op === 'ask'), '① 等待第一个 ask 抵达宿主')
  const asksOutstanding = () => host.deferred.filter((d) => d.msg.op === 'ask')
  // 乱序回包策略：宿主总是应答「最后到达」的在飞请求。prelude 的 tail 链
  // （prelude.ts:108）使同 actor 第二个 ask 在首个结算前根本不发——此窗口恰 1 条。
  check('①', '同 actor 第二个 ask 在首个结算前不得发出（tail 链串行化）',
    asksOutstanding().length === 1 && asksOutstanding()[0].msg.args.instructions === 'i1',
    `在飞 ask ${asksOutstanding().length} 条：${JSON.stringify(asksOutstanding().map((d) => d.msg.args.instructions))}`)
  asksOutstanding()[asksOutstanding().length - 1].resolve('r1')
  await until(() => asksOutstanding().some((d) => d.msg.args.instructions === 'i2'), '① 等待第二个 ask 抵达宿主')
  check('①', '宿主收到 ask 的到达序 = 提交序（i1 先于 i2）',
    host.requests.length === 3 &&
      host.requests[1].args.instructions === 'i1' &&
      host.requests[2].args.instructions === 'i2',
    JSON.stringify(host.requests.map((m) => (m.op === 'ask' ? m.args.instructions : m.op))))
  check('①', 'fixture 自检：declare-actor 事件先于请求到达', host.events.length === 1 && host.events[0].type === 'declare-actor')
  asksOutstanding()[asksOutstanding().length - 1].resolve('r2')
  await until(() => out.length >= 2, '① 等待两次结算')
  check('①', '乱序回包下仍按提交序结算：settle#1 先于 settle#2，值一一对应',
    out[0] === 'settle#1=r1' && out[1] === 'settle#2=r2',
    JSON.stringify(out))
  // 收尾：放行保活 hole，body 续体先落 out，再由停滞自查自然收尾（ScriptStalled，不在此断言）
  host.deferred.filter((d) => d.msg.op === 'hole').pop().resolve('ok')
  await until(() => out.includes('hold-released'), '① 等待保活放行回传')
  check('①', 'fixture 自检：无 BODY-REJECT', !hasBodyReject(out), out.join(' | '))
}

// ============ ② event 与 request 共享 FIFO ============

async function group2SharedFifo() {
  console.log('② event 与 request 共享 FIFO（declare-artifact 不被后发 report 超车）')
  const { host, out } = runGuestScenario({
    bodySource: `async function () {
      __hole('site#A', 'ha', 'pa')
      __declareArtifact('artifact#1', 'declare', { aid: 'a1' })
      __report('site#R', { kind: 'note' }, null)
    }`,
  })
  await until(() => host.requests.length >= 2, '② 等待两条请求抵达宿主')
  // __hole 先发（在飞）、declare-artifact 事件居中、__report 后发：到达序必须保持
  // 发出序——事件不得被后发 request 超车，也不得积压到 request 之后集中冲刷。
  const shape = host.arrivals.map((a) => (a.channel === 'request' ? 'request:' + a.msg.op : 'event:' + a.evt.type))
  check('②', '共享 FIFO 到达序：hole → declare-artifact → report',
    host.arrivals.length === 3 &&
      host.arrivals[0].channel === 'request' && host.arrivals[0].msg.op === 'hole' &&
      host.arrivals[1].channel === 'event' && host.arrivals[1].evt.type === 'declare-artifact' &&
      host.arrivals[2].channel === 'request' && host.arrivals[2].msg.op === 'report',
    JSON.stringify(shape))
  check('②', 'declare-artifact 载荷对账（siteId/op/args 原样到达）',
    host.events.length === 1 &&
      host.events[0].args.siteId === 'artifact#1' && host.events[0].args.op === 'declare' &&
      host.events[0].args.args.aid === 'a1',
    JSON.stringify(host.events[0]))
  check('②', 'fixture 自检：无 BODY-REJECT', !hasBodyReject(out), out.join(' | '))
  // 收尾：应答全部在飞，让停滞自查自然落 ScriptStalled complete，场景不悬留
  while (host.deferred.length > 0) host.deferred.pop().resolve('ok')
  await until(() => host.completes.length >= 1, '② 等待停滞收尾 complete')
}

// ============ ③ 停滞检测：park receiver + 无在飞 → ChannelDeadlock ============

async function group3StallDetection() {
  console.log("③ 停滞检测（complete{ok:false} 且 error.name==='ChannelDeadlock'）")
  const { host, out } = runGuestScenario({
    hostSetup: (h) => {
      h.autoAnswer = () => 'hole-ok' // 唯一请求即刻应答 → 在飞清零 → 触发自查
    },
    bodySource: `async function () {
      var ch = __channel('dead-0')
      ch[Symbol.asyncIterator]().next() // 停泊一个接收者（不 await、永不投递、永不 close）
      await __hole('site#H', 'hh', 'pp') // 唯一请求；应答后 pending=0，武装停滞自查
    }`,
  })
  await until(() => host.completes.length >= 1, '③ 等待停滞结算 complete')
  const c = host.completes[0]
  check('③', 'receiver 停泊且无在飞 → complete{ok:false}（value 折 null）',
    c && c.ok === false && c.value === null, JSON.stringify(c))
  check("③", "error.name === 'ChannelDeadlock'（prelude.ts:62）",
    !!(c && c.error && c.error.name === 'ChannelDeadlock'),
    c && c.error ? JSON.stringify(c.error.name) : JSON.stringify(c))
  check('③', 'fixture 自检：无 BODY-REJECT', !hasBodyReject(out), out.join(' | '))
}

// ============ ④ Date/random 三点禁令 + new Date(0) 透传 ============

async function group4DateBans() {
  console.log('④ Date/random 三点禁令 + new Date(0) 透传（拍板表#2 后的语义）')
  const { out } = runGuestScenario({
    bodySource: `async function () {
      function probe(label, fn) {
        try { out.push(label + ':ok:' + String(fn())) }
        catch (e) { out.push(label + ':throw:' + ((e && e.name) || 'Error')) }
      }
      probe('datenow', function () { return Date.now() })
      probe('dateargless', function () { return new Date() })
      probe('daterandom', function () { return Math.random() })
      probe('dateepoch', function () { return new Date(0).getTime() })
    }`,
  })
  await until(() => out.length >= 4, '④ 等待四个探针回传')
  const find = (label) => out.find((line) => String(line).startsWith(label + ':'))
  check('④', 'Date.now() 抛错', /^datenow:throw:/.test(find('datenow') ?? ''), find('datenow') ?? '无回传')
  check('④', 'argless new Date() 抛错', /^dateargless:throw:/.test(find('dateargless') ?? ''), find('dateargless') ?? '无回传')
  check('④', 'Math.random() 抛错', /^daterandom:throw:/.test(find('daterandom') ?? ''), find('daterandom') ?? '无回传')
  check('④', 'new Date(0) 透传可用（getTime() === 0）',
    find('dateepoch') === 'dateepoch:ok:0', find('dateepoch') ?? '无回传')
}

// ============ complete 幂等（prelude.ts:45-46） ============

async function groupCompleteIdempotent() {
  console.log('幂等：complete 二次调用不重复结算')
  const { host, out } = runGuestScenario({
    bodySource: `async function () {
      __complete(true, 'first')
      __complete(true, 'second')
      __complete(false, undefined, new Error('late'))
    }`,
  })
  await until(() => host.completes.length >= 1, '幂等 等待首次 complete')
  await delay(30) // 留出微任务窗，确认后两次调用被 __settled 守卫吞掉
  check('幂等', '宿主只收到 1 次 complete（取首次调用）', host.completes.length === 1, `实收 ${host.completes.length} 次`)
  const c = host.completes[0] ?? {}
  check('幂等', '载荷 = {ok:true, value:"first", error:undefined}',
    c.ok === true && c.value === 'first' && c.error === undefined, JSON.stringify(c))
  check('幂等', 'fixture 自检：无 BODY-REJECT', !hasBodyReject(out), out.join(' | '))
}

// ============ 验收守卫：依赖面零官方包值导入（PLAN T4 验收③） ============

function guardNoOfficialValueImports() {
  console.log('守卫：冒烟依赖面零官方包值导入（import type 允许）')
  const rels = [
    'journal/schema.ts',
    'journal/store.ts',
    'journal/projection.ts',
    'journal/caps.ts',
    'guest/realm.ts',
    'guest/channels.ts',
    'guest/prelude.ts',
    'guest/protocol.ts',
    'util/json.ts',
  ]
  const hits = []
  for (const rel of rels) {
    const lines = readFileSync(join(srcDir, rel), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      // 与验收命令同语义：grep "from '@deepseek" | grep -v "import type"
      if (lines[i].includes("from '@deepseek") && !lines[i].includes('import type')) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
      }
    }
  }
  check('守卫', "grep \"from '@deepseek\"（除 import type）零命中", hits.length === 0, hits.join(' | '))
}

// ============ ⑤ journal 往返：记账→投影逐字段对账 ============

async function group5JournalRoundTrip() {
  console.log('⑤ journal 往返（runProjection/listRuns 逐字段对账 + node-* 五态手工 append 半环）')

  // 直 import（零官方值导入故不带 --import 替身）；store 若不可加载，如实失败并带上真实错误
  let schemaMod = null
  let storeMod = null
  let projectionMod = null
  let importError = null
  try {
    // 相对 specifier 按 import.meta.url 解析，与 cwd 无关；node 24 默认 strip-types 吃 .ts
    schemaMod = await import('../src/journal/schema.ts')
    storeMod = await import('../src/journal/store.ts')
    projectionMod = await import('../src/journal/projection.ts')
  } catch (e) {
    importError = e
  }
  if (importError !== null) {
    check('⑤', 'journal 三件直 import 可加载', false, importError.message)
    // 后续逐字段断言全部依赖加载，标失败后直接返回（避免连环假失败噪音）
    check('⑤', '（因加载失败跳过的逐字段对账按失败计）', false, 'runProjection/listRuns 未执行')
    return
  }

  const db = new DatabaseSync(':memory:')
  schemaMod.initSchema(db)
  const store = new storeMod.JournalStore(db)

  // —— 记账：beginRun → appendEvent → recordNode → settleRun（PLAN T4 spec 路径）——
  store.beginRun({ id: 'run-1', name: 'smoke-run', script: 'export function main() {}', cwd: '/w', args: { n: 1 }, capsMaxConcurrency: 4 })
  store.appendEvent('run-1', { type: 'run-launched', payload: { worker: 'smoke' } })
  store.recordNode('run-1', { siteId: 'site#1', kind: 'ask', input: { q: 1 }, status: 'completed', result: { a: 1 }, actorSiteId: 'actor#1' })
  store.recordNode('run-1', { siteId: 'site#1', kind: 'ask', input: { q: 2 }, status: 'failed', error: 'boom' }) // 同 site → ordinal 2
  store.recordNode('run-1', { siteId: 'site#2', kind: 'world-run', input: { cmd: 'ls' }, status: 'completed', result: [] }) // 异 site → ordinal 1

  const midView = projectionMod.runProjection(db, 'run-1')
  check('⑤', '结算前 status=running（status 逐字段·前半）', midView?.status === 'running', String(midView?.status))

  // —— node-* 五态以手工 append 喂入（拍板表#18：T4 只验记账/投影半环，发射半环归 T6）——
  for (const t of ['node-queued', 'node-dispatched', 'node-executing', 'node-waiting', 'node-settled']) {
    store.appendEvent('run-1', { type: t, payload: { siteId: 'site#1' } })
  }
  store.settleRun('run-1', { status: 'completed', result: { done: true }, spentTokens: 5 })

  // —— 投影对账 ——
  const view = projectionMod.runProjection(db, 'run-1')
  check('⑤', 'run 头字段对账（id/name/status/cwd）',
    view?.id === 'run-1' && view?.name === 'smoke-run' && view?.status === 'completed' && view?.cwd === '/w',
    JSON.stringify(view && { id: view.id, name: view.name, status: view.status, cwd: view.cwd }))
  check('⑤', '节点计数对账（total 3 / completed 2 / failed 1）',
    view?.nodesTotal === 3 && view?.nodesCompleted === 2 && view?.nodesFailed === 1,
    JSON.stringify(view && { total: view.nodesTotal, ok: view.nodesCompleted, fail: view.nodesFailed }))
  const expectedNodes = [
    { siteId: 'site#1', ordinal: 1, kind: 'ask', status: 'completed', actorSiteId: 'actor#1', artifactId: undefined },
    { siteId: 'site#1', ordinal: 2, kind: 'ask', status: 'failed', actorSiteId: undefined, artifactId: undefined },
    { siteId: 'site#2', ordinal: 1, kind: 'world-run', status: 'completed', actorSiteId: undefined, artifactId: undefined },
  ]
  check('⑤', '节点 (siteId, ordinal, kind, status) 逐字段对账：per-site ordinal + 插入序',
    JSON.stringify(view?.nodes) === JSON.stringify(expectedNodes),
    JSON.stringify(view?.nodes))
  const events = view?.events ?? []
  const eventTypes = events.map((e) => e.type)
  const expectedTypes = ['run-started', 'run-launched', 'node-queued', 'node-dispatched', 'node-executing', 'node-waiting', 'node-settled', 'run-settled']
  check('⑤', '事件 sequence 连续 1..8 且类型逐一对账（timeCreated 为数值）',
    JSON.stringify(eventTypes) === JSON.stringify(expectedTypes) &&
      events.every((e, i) => e.sequence === i + 1) &&
      events.every((e) => typeof e.timeCreated === 'number'),
    JSON.stringify(events.map((e) => [e.sequence, e.type])))
  check('⑤', 'node-* 五态（手工 append 喂入）按序出现在投影事件流中（拍板表#18 记账/投影半环）',
    JSON.stringify(eventTypes.slice(2, 7)) === JSON.stringify(['node-queued', 'node-dispatched', 'node-executing', 'node-waiting', 'node-settled']),
    JSON.stringify(eventTypes))

  // —— listRuns：新 run 时间戳严格更新（睡过 15.6ms 时钟粒度）后按 time_created desc ——
  // capsMaxConcurrency 恒传：DDL 对齐后 dwf_run.caps_max_concurrency not null
  // （拍板表#16），真实引擎侧 runCap=min(请求值,1000) 恒有值（DESIGN §3.5）。
  await delay(30)
  store.beginRun({ id: 'run-2', name: 'smoke-run-2', script: 'export function main() {}', capsMaxConcurrency: 2 })
  const sums = projectionMod.listRuns(db, 10)
  check('⑤', 'listRuns 两条且字段对账（新 run 在前；run-2 running/0 节点；run-1 completed）',
    sums.length === 2 &&
      sums[0].id === 'run-2' && sums[0].status === 'running' && sums[0].nodesTotal === 0 && sums[0].nodesCompleted === 0 && sums[0].nodesFailed === 0 &&
      sums[1].id === 'run-1' && sums[1].status === 'completed' && sums[1].cwd === '/w',
    JSON.stringify(sums.map((s) => ({ id: s.id, status: s.status, n: s.nodesTotal }))))
  const limited = projectionMod.listRuns(db, 1)
  check('⑤', 'listRuns limit=1 截取最新一条', limited.length === 1 && limited[0].id === 'run-2',
    JSON.stringify(limited.map((s) => s.id)))
  check('⑤', '不存在的 runId → runProjection 返回 undefined', projectionMod.runProjection(db, 'nope') === undefined)
}

// ============ 主流程 ============

async function main() {
  console.log('T4 无宿主冒烟（node:vm 假 dwfHost + node:sqlite :memory:，无 --import）\n')
  await group1Fifo()
  await group2SharedFifo()
  await group3StallDetection()
  await group4DateBans()
  await groupCompleteIdempotent()
  await group5JournalRoundTrip()
  guardNoOfficialValueImports()

  const failed = outcomes.filter((o) => !o.pass)
  console.log(`\n冒烟结果：${outcomes.length - failed.length}/${outcomes.length} 通过` + (failed.length ? `，失败 ${failed.length} 条` : '，全绿'))
  for (const o of failed) console.log(`  FAIL ${o.group} ${o.name}`)
  process.exitCode = failed.length ? 1 : 0
}

await main()
