// 编译层单测（PLAN T5 验收② / DESIGN §7.2）：node:test + node 24 strip-types 直跑
// .ts 被测件，无 dsh 宿主。断言一经定稿即冻结（PLAN §4 考卷冻结）。
//
// 跑法：node --test test/compile.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileWorkflow } from '../src/compile/compiler.ts'

const facade = readFileSync(new URL('../assets/facade.d.ts', import.meta.url), 'utf8')

const LEGAL_SOURCE = `phase("探查")
phase("汇总")
phase("探查")
const researcher = agent("researcher", { system: "you research", model: model("qwen-max") })
const answer = await researcher.ask<{ title: string; score: number }>("summarize the repo")
log("score " + String(answer.score))
const listing = await files.glob("*.ts")
const status = await git.status()
const ran = await world.run("node", ["--version"])
report({ title: answer.title, score: answer.score }, "board.main")
artifact.table("board.main", { columns: [{ field: "title" }] })
const pick = await hole("direction", "which way next?")
await agent("helper").ask("double check")
return answer.title
`

test('合法脚本零诊断，lowering 产物含 __host.ask( 调用形，phase/world 命令被抽出', () => {
  const result = compileWorkflow(LEGAL_SOURCE, facade)
  assert.deepEqual(result.diagnostics, [], `expected zero diagnostics, got: ${JSON.stringify(result.diagnostics, null, 2)}`)
  // lowering：ask 调用形在（siteId + instructions + schema 字面量下沉）
  // p0-real-machine ③ 起 body 经 ts.transpileModule 输出（剥类型防 worker EPIPE），
  // 空白/引号风格会重排 —— 断言一律走归一化视图（去空白、单引号折双引号）。
  const flat = result.body.replace(/\s+/g, '').replace(/'/g, '"')
  assert.ok(result.body.includes('__host.ask('), 'body must contain __host.ask( call form')
  assert.ok(flat.includes('"ask#'), 'ask site ids are callSiteId(ask, ordinal)')
  assert.ok(flat.includes('"type":"object"'), 'ask<T> schema literal must be sunk into the body')
  assert.ok(flat.includes('"title"'), 'schema carries interface properties')
  assert.ok(flat.includes('"required":["title","score"]'), 'required covers non-optional props')
  // model() 不 lowering：纯数据工厂留在 guest 侧
  assert.ok(flat.includes('model("qwen-max")'), 'model() must stay a direct guest-local call')
  assert.ok(!result.body.includes('__host.model'), 'model() must not be lowered')
  // 其他效应家族各就各位
  assert.ok(result.body.includes('__host.worldRun('), 'world.run lowered')
  assert.ok(result.body.includes('__host.worldRead('), 'files.glob/git.status lowered')
  assert.ok(result.body.includes('__host.report('), 'report lowered')
  assert.ok(result.body.includes('__host.declareArtifact('), 'artifact.table lowered')
  assert.ok(result.body.includes('__host.hole('), 'unfilled hole lowered')
  // 直调面不动
  assert.ok(result.body.includes('agent("helper")'), 'agent() stays direct')
  assert.ok(result.body.includes('phase("探查")'), 'phase() stays direct')
  // 编译期抽取
  assert.deepEqual(result.phaseNames, ['探查', '汇总'], 'duplicate phase markers merge to one, first-occurrence order')
  assert.deepEqual(result.worldCommands, ['node'])
})

test('phase 名非字面量：报恰一条 9013', () => {
  const result = compileWorkflow('const step = "a"\nphase("step " + step)\nawait agent("x").ask("hi")\n', facade)
  assert.equal(result.diagnostics.length, 1, JSON.stringify(result.diagnostics))
  assert.equal(result.diagnostics[0].code, 9013)
})

test('agent 名字字面量重复：报恰一条 9014', () => {
  const result = compileWorkflow('agent("dup")\nagent("dup")\n', facade)
  assert.equal(result.diagnostics.length, 1, JSON.stringify(result.diagnostics))
  assert.equal(result.diagnostics[0].code, 9014)
})

test('hole 站点 id 形如 hole#xxxxxxxx（FNV-1a 内容寻址，跨次编译稳定）', () => {
  const first = compileWorkflow('const a = await hole<string>("decide")\nawait agent("x").ask(a)\n', facade)
  assert.deepEqual(first.diagnostics, [], JSON.stringify(first.diagnostics))
  const match = first.body.match(/hole#[0-9a-f]{8}/)
  assert.ok(match, `body must contain hole#xxxxxxxx site id, got: ${first.body}`)
  const second = compileWorkflow('const a = await hole<string>("decide")\nawait agent("x").ask(a)\n', facade)
  assert.equal(second.body.match(/hole#[0-9a-f]{8}/)?.[0], match[0], 'hole id is content-addressed and stable')
})

test('语义错误也被拦下（world.run cmd 类型错），诊断落回用户源码坐标', () => {
  const result = compileWorkflow('await world.run(42)\n', facade)
  assert.ok(result.diagnostics.length >= 1, JSON.stringify(result.diagnostics))
  assert.ok(result.diagnostics.every((d) => d.line === 1), 'diagnostics carry user-source line numbers')
})

test('填充形 hole 分流到 holeFilled，体内调用也被 lowering', () => {
  const result = compileWorkflow(
    'const v = await hole("fix", async () => (await files.read("a.txt")).trim())\nawait agent("x").ask(v)\n',
    facade,
  )
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics))
  assert.ok(result.body.includes('__host.holeFilled('), 'filled form lowered to holeFilled')
  assert.ok(result.body.includes('__host.worldRead('), 'facade call inside hole body lowered too')
})
