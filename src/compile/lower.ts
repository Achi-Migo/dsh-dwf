/**
 * lowering：facade 效应调用点 → `__host.<op>(siteId, …)`（mechanism-map §2.6、
 * DESIGN §3.2）。重写以「外科手术式文本替换」进行——调用点 span 之外的用户文本
 * （缩进、注释、格式）逐字保留。
 *
 * 宿主对象桥：prelude（src/guest/prelude.ts）暴露的是裸 shim 函数（__ask/
 * __worldRun/…），而 DESIGN §3.2 与原版 guest-prelude.js 的调用形是 `__host.*`；
 * lower 在产物头部生成一行 `var __host = { ask: __ask, … }` 把两者接上。分派按
 * prelude shim 的真实签名（DESIGN §3.2 的三参 `__host.ask(siteId, instr, schema)`
 * 缺 receiver，落不了 prelude 的 `__ask(receiver, siteId, instructions, schema)`
 * ——以 prelude 契约为准，已在任务结果中回报告）。
 *
 * siteId：全局调用点序号（「调用点序号」，源码序），每个 isLoweredCall 消耗一个
 * ——hole 也占号（保持与 schema.ts 的序号口径完全一致），但 emit 用内容寻址
 * `hole#xxxxxxxx`（FNV-1a(trim 后调用点源文本)，util/fnv1a.ts，跨修订稳定）。
 * 其余家族 emit `<family>#<ordinal>`（util/fnv1a.ts callSiteId）。
 *
 * 序号口径与 schema.ts 逐点一致：同一份包装 SourceFile、前序遍历、访问到调用点
 * 即计号（先于其参数内的嵌套调用点）。
 *
 * 不参与 lowering（guest 前导直供）：model()（纯数据工厂，无宿主往返，facade
 * 「checked at launch」）、agent()/channel()/future()/phase()/log()/args。
 */

import ts from 'typescript'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { callSiteId, holeSiteId } from '../util/fnv1a.ts'
import { holeFormOf, isLoweredCall, type FacadeCall } from './literals.ts'

/** 用户体包装：包进 async 函数体后 declare/export/import 天然非法（mechanism-map §2.2）。 */
export const WRAP_PREFIX = 'async function __workflow() {\n'
export const WRAP_SUFFIX = '\n}\n'

export function wrapUserSource(source: string): string {
  return `${WRAP_PREFIX}${source}${WRAP_SUFFIX}`
}

/** 包装前缀长度：诊断把包装坐标重定基回用户源码时用（compiler.ts 引用）。 */
export const WRAP_PREFIX_LENGTH = WRAP_PREFIX.length

/** 产物头部：把 prelude 裸 shim 绑成 `__host.<op>`。名字占 facade 保留面，脚本不得声明 __host。 */
const HOST_HEADER =
  'var __host = { ask: __ask, worldRun: __worldRun, worldRead: __worldRead, hole: __hole, holeFilled: __holeFilled, report: __report, publishArtifact: __publishArtifact, declareArtifact: __declareArtifact };\n'

interface Edit {
  start: number
  end: number
  text: string
}

/**
 * lowering 主入口（DESIGN §3.2 签名）。phaseNames 为契约签名保留：phase() 保持
 * guest 直调（prelude 直发 phase-entered 事件），不参与重写；确认展示的清单由
 * compileWorkflow 返回值承载。
 */
export function lower(source: string, phaseNames: readonly string[], askSchemas: Map<number, ObjectJsonSchema>): string {
  void phaseNames
  const wrapped = wrapUserSource(source)
  const sf = ts.createSourceFile('workflow.ts', wrapped, ts.ScriptTarget.ES2024, /* setParentNodes */ true)
  const edits: Edit[] = []
  let ordinal = 0

  // rewrite：返回 node span 的 lowering 后文本；facade 调用点登记 edit 并消耗序号。
  const rewrite = (node: ts.Node): string => {
    const hit = isLoweredCall(node)
    if (hit) {
      ordinal += 1
      const text = lowerCall(hit, ordinal, askSchemas, rewrite, sf)
      edits.push({ start: node.getStart(sf), end: node.getEnd(), text })
      return text
    }
    const children = node.getChildren(sf)
    if (children.length === 0) return wrapped.slice(node.getStart(sf), node.getEnd())
    let out = ''
    let pos = node.getStart(sf)
    for (const child of children) {
      out += wrapped.slice(pos, child.getStart(sf))
      out += rewrite(child)
      pos = child.getEnd()
    }
    out += wrapped.slice(pos, node.getEnd())
    return out
  }

  rewrite(sf)
  // 先剥包装（坐标 = wrapped − 前缀），再在**用户坐标系**里从后往前套用 edits——
  // 若先套用再按原始 wrapped 长度切尾，lowering 产物变长时会把尾部多切掉。
  let body = wrapped.slice(WRAP_PREFIX.length, wrapped.length - WRAP_SUFFIX.length)
  const editsDesc = [...edits].sort((a, b) => b.start - a.start)
  for (const edit of editsDesc) {
    const start = edit.start - WRAP_PREFIX.length
    const end = edit.end - WRAP_PREFIX.length
    body = body.slice(0, start) + edit.text + body.slice(end)
  }
  return HOST_HEADER + body
}

/** 单个 facade 调用点 → `__host.<op>(siteId, …)` 文本；参数经 rewrite 递归 lowering。 */
function lowerCall(
  hit: FacadeCall,
  ordinal: number,
  askSchemas: Map<number, ObjectJsonSchema>,
  rewrite: (node: ts.Node) => string,
  sf: ts.SourceFile,
): string {
  const call = hit.node
  const args = call.arguments
  const arg = (i: number): string => rewrite(args[i])
  const argList = (): string => {
    const parts: string[] = []
    for (let i = 0; i < args.length; i += 1) parts.push(arg(i))
    return parts.join(', ')
  }

  switch (hit.call.family) {
    case 'ask': {
      // isLoweredCall 只经属性访问识别 ask，receiver 即点号左边的表达式。
      const expr = call.expression
      const receiver = ts.isPropertyAccessExpression(expr) ? rewrite(expr.expression) : rewrite(expr)
      const siteId = callSiteId('ask', ordinal)
      const schema = askSchemas.get(ordinal)
      const schemaArg = schema === undefined ? '' : `, ${JSON.stringify(schema)}`
      return `__host.ask(${receiver}, ${JSON.stringify(siteId)}, ${arg(0)}${schemaArg})`
    }
    case 'world-run': {
      const siteId = JSON.stringify(callSiteId('world-run', ordinal))
      const cmd = arg(0)
      const argv = args.length > 1 ? arg(1) : 'undefined'
      const timeout = args.length > 2 ? `${arg(2)}?.timeoutMs` : 'undefined'
      return `__host.worldRun(${siteId}, ${cmd}, ${argv}, ${timeout})`
    }
    case 'world-read': {
      const siteId = JSON.stringify(callSiteId('world-read', ordinal))
      return `__host.worldRead(${siteId}, ${JSON.stringify(hit.call.op)}, [${argList()}])`
    }
    case 'report': {
      const siteId = JSON.stringify(callSiteId('report', ordinal))
      const artifactId = args.length > 1 ? `, ${arg(1)}` : ''
      return `__host.report(${siteId}, ${arg(0)}${artifactId})`
    }
    case 'artifact-publish': {
      const siteId = JSON.stringify(callSiteId('artifact', ordinal))
      return `__host.publishArtifact(${siteId}, ${JSON.stringify(hit.call.op)}, [${argList()}])`
    }
    case 'artifact-declare': {
      const siteId = JSON.stringify(callSiteId('artifact', ordinal))
      return `__host.declareArtifact(${siteId}, ${JSON.stringify(hit.call.op)}, [${argList()}])`
    }
    case 'hole': {
      // 站点 id = FNV-1a(trim 后调用点源文本)（mechanism-map §2.7），跨修订稳定。
      const siteId = JSON.stringify(holeSiteId(call.getText(sf).trim()))
      const form = holeFormOf(call)
      if (form === undefined) return call.getText(sf)
      if (form.filled) {
        return `__host.holeFilled(${siteId}, ${rewrite(form.body)})`
      }
      const prompt = form.prompt !== undefined ? `, ${rewrite(form.prompt)}` : ''
      return `__host.hole(${siteId}, ${rewrite(form.name)}${prompt})`
    }
    default:
      return call.getText(sf)
  }
}
