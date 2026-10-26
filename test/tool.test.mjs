/**
 * T7 工具层单测（PLAN T7 验收②③）：
 * ② DESCRIPTION 按本插件 facade 契约重写——含 ask/channel/world.run/hole/report
 *    词汇，且不含官方 `agent(prompt` 片段（B12：官方文案禁入）；
 * ③ placeholders 六占位逐一报对应错误码——amend 族 AMEND_UNAVAILABLE(21)→'DW_21'、
 *    saved 族 SAVED_UNAVAILABLE(30)→'DW_30'。
 *
 * 运行命令（带 --import 替身：placeholders→errors.ts→dsh-llm、defineTool→dsh-tools）：
 *   node --import ./test/runtime-stubs.mjs --test test/tool.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DESCRIPTION, SCRIPT_PARAM_DESCRIPTION } from '../src/tool/description.ts'
import {
  amendWorkflowTool,
  resumeWorkflowRunTool,
  fillWorkflowHoleTool,
  resolveWorkflowQuestionTool,
  saveWorkflowTool,
  listSavedWorkflowsTool,
} from '../src/tool/placeholders.ts'

test('DESCRIPTION documents the facade contract vocabulary', () => {
  for (const word of ['ask', 'channel', 'world.run', 'hole', 'report']) {
    assert.ok(DESCRIPTION.includes(word), `DESCRIPTION must mention ${word}`)
  }
})

test('DESCRIPTION keeps the official agent(prompt, opts) text out (B12)', () => {
  assert.ok(!DESCRIPTION.includes('agent(prompt'), 'official agent(prompt wording must not leak in')
  assert.ok(!SCRIPT_PARAM_DESCRIPTION.includes('agent(prompt'), 'official agent(prompt wording must not leak in')
})

test('DESCRIPTION documents the TS-checked facade (not plain-JS)', () => {
  assert.ok(/TypeScript/.test(DESCRIPTION), 'scripts are TypeScript-checked against the facade')
  assert.ok(/interface/.test(DESCRIPTION), 'interface declarations double as ask schemas')
})

test('six placeholders answer their deferred-capability error codes', async () => {
  const amendFamily = [
    ['amend_workflow', amendWorkflowTool],
    ['resume_workflow_run', resumeWorkflowRunTool],
    ['fill_workflow_hole', fillWorkflowHoleTool],
    ['resolve_workflow_question', resolveWorkflowQuestionTool],
  ]
  for (const [name, build] of amendFamily) {
    const tool = build()
    assert.equal(tool.name, name)
    await assert.rejects(
      () => tool.execute({}, { agent: undefined, signal: new AbortController().signal, callId: 'c', rootCallId: 'r' }),
      (error) => {
        assert.equal(error.code, 'DW_21', `${name} must answer AMEND_UNAVAILABLE(21), got ${error.code}`)
        return true
      },
    )
  }

  const savedFamily = [
    ['save_workflow', saveWorkflowTool],
    ['list_saved_workflows', listSavedWorkflowsTool],
  ]
  for (const [name, build] of savedFamily) {
    const tool = build()
    assert.equal(tool.name, name)
    await assert.rejects(
      () => tool.execute({}, { agent: undefined, signal: new AbortController().signal, callId: 'c', rootCallId: 'r' }),
      (error) => {
        assert.equal(error.code, 'DW_30', `${name} must answer SAVED_UNAVAILABLE(30), got ${error.code}`)
        return true
      },
    )
  }
})

// ── T5 修复轮新增（FIX-PLAN §1 T5，只增不改）：文案族断言，既有四组断言一字未动。──

test('DESCRIPTION states the shipped MVP semantics (fix round T5)', () => {
  // #3：预置产物声明被静默忽略（run.ts drop declare-artifact），失败点在带 artifactId 的 tagged report。
  assert.ok(!DESCRIPTION.includes('calling them fails the run'), 'stale "calling them fails the run" preset claim must be gone')
  assert.ok(/silently ignored/.test(DESCRIPTION), 'preset declarations must be documented as silently ignored')
  assert.ok(/tagged report/.test(DESCRIPTION), 'tagged report must be documented as the failure point')
  // #9：非 JSON 安全的 report item 是运行时拒收、脚本可 catch，不再是「compile errors」。
  assert.ok(!/promises are compile errors/.test(DESCRIPTION), 'stale report-item "compile errors" claim must be gone')
  assert.ok(/rejected when the call runs/.test(DESCRIPTION), 'report item rejection must be documented as runtime')
  assert.ok(/catchable/.test(DESCRIPTION), 'report item rejection must be documented as catchable')
  // #10：phase 保留编译期字面量要求（9013），REQUIRED/standalone/每相位≥1 本版不强制。
  assert.ok(/phase\("title"\)[^\n]*compile-time string literal/.test(DESCRIPTION), 'phase name stays a compile-time string literal')
  assert.ok(/not enforced/.test(DESCRIPTION), 'phase REQUIRED/standalone/per-phase-ask rules must be documented as not enforced')
  // #14：grep pattern 是 JS 正则近似；glob 是 */**/? 子集，{a,b} 不支持。
  assert.ok(/JavaScript RegExp/.test(DESCRIPTION), 'grep pattern must be documented as a JavaScript RegExp approximation')
  assert.ok(/brace alternation/.test(DESCRIPTION) && /\{a,b\}/.test(DESCRIPTION), 'glob brace alternation must be documented as unsupported')
})
