/**
 * 编译器本体（DESIGN §3.2 / mechanism-map §2.3）：`compileWorkflow(source, facade)`
 * 用 TS 5.9.3 的 `createProgram` 把 facade.d.ts 全文与用户脚本（包在 async 函数体内
 * ——declare/export/import 天然非法）合成一个 Program，跑语义诊断 + 自定义诊断三族
 * （9012 hole 规则 / 9013 编译期字面量 / 9014 agent 名字字面量重复），通过后做
 * lowering。诊断非空 → 引擎 start 时同步折 SCRIPT_PARSE（DESIGN §3.5 步骤 2）。
 *
 * 选项：strict: true、noUncheckedIndexedAccess: false（mechanism-map §2.2——与
 * guest 侧编译一致）；TS pin 5.9.3（DESIGN §7.1 前置：7.x native preview 不暴露
 * createProgram 等库 API）。
 *
 * Program 的内存宿主：facade 与用户文件驻内存，lib 文件从依赖树内的 typescript
 * 包（node_modules/typescript/lib）按需读盘；`<reference lib>` 经
 * getDefaultLibLocation 解析到同一目录。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  agentNameDiagnostics,
  diagnosticsToUserSource,
  holeDiagnostics,
  literalDiagnostics,
  tsToWorkflowDiagnostics,
  type WorkflowDiagnostic,
} from './diagnostics.ts'
import { collectPhaseClaims, projectPhaseGraph } from './phase-graph.ts'
import { askSchemas } from './schema.ts'
import { lower, wrapUserSource as wrapForCheck, WRAP_PREFIX_LENGTH } from './lower.ts'

export interface CompiledWorkflow {
  /** lowering 后的脚本体（__host.* 前导 + 用户逻辑）；诊断非空时为原样用户源码。 */
  body: string
  /** 编译期抽出的 phase 名（确认对话框用；同名 marker 已合并）。 */
  phaseNames: string[]
  /** world.run 命令名字面量全集（安全模型：随确认展示）。 */
  worldCommands: string[]
  /** 空数组 = 通过。 */
  diagnostics: WorkflowDiagnostic[]
}

const USER_FILE = '__workflow-source__.ts'
const FACADE_FILE = '__facade__.d.ts'

/** 类型检查选项：与 guest 侧编译一致（mechanism-map §2.2）；lib 走默认链。 */
const PROGRAM_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noUncheckedIndexedAccess: false,
  target: ts.ScriptTarget.ES2024,
  noEmit: true,
  skipLibCheck: true,
}

export function compileWorkflow(source: string, facade: string): CompiledWorkflow {
  const wrapped = wrapForCheck(source)
  const userSf = ts.createSourceFile(USER_FILE, wrapped, ts.ScriptTarget.ES2024, true)
  const facadeSf = ts.createSourceFile(FACADE_FILE, facade, ts.ScriptTarget.ES2024, true)
  const host = createInMemoryHost(userSf, facadeSf)
  const program = ts.createProgram([USER_FILE, FACADE_FILE], PROGRAM_OPTIONS, host)

  const diagnostics: WorkflowDiagnostic[] = [
    ...tsToWorkflowDiagnostics(program.getSyntacticDiagnostics(userSf), source, WRAP_PREFIX_LENGTH),
    ...tsToWorkflowDiagnostics(program.getSemanticDiagnostics(userSf), source, WRAP_PREFIX_LENGTH),
  ]

  // 自定义三族收在包装文件上，统一重定基到用户源码坐标。
  const literal = literalDiagnostics(userSf)
  diagnostics.push(...diagnosticsToUserSource(literal.diagnostics, source, WRAP_PREFIX_LENGTH))
  diagnostics.push(...diagnosticsToUserSource(holeDiagnostics(userSf), source, WRAP_PREFIX_LENGTH))
  diagnostics.push(...diagnosticsToUserSource(agentNameDiagnostics(userSf), source, WRAP_PREFIX_LENGTH))

  const phaseNames = projectPhaseGraph(collectPhaseClaims(userSf)).map((node) => node.name)
  const worldCommands = literal.worldCommands

  if (diagnostics.length > 0) {
    return { body: source, phaseNames, worldCommands, diagnostics }
  }

  const schemas = askSchemas(program.getTypeChecker(), userSf)
  const lowered = lower(source, phaseNames, schemas)
  // p0-real-machine ③ 修复：真机 NodePtcRuntime 对含 TS 语法的程序走
  // stripTypeScriptTypes，而其 module 语法不接受顶层 return —— function-body
  // 程序在 worker 侧解析即崩（worker-exit: write EPIPE，首例：脚本带 interface
  // 声明 + return）。编译期转译成纯 JS：类型声明剥除、顶层 return 保留
  // （ts.transpileModule 实测行为），worker 不再进入 strip 路径。官方 guest
  // 程序本就是纯 JS，同构。
  // t3-epipe-clean-error 终态补记：worker-exit 此后仍可能因别因逃逸（流/通道
  // error 抢在带退出码+stderr 的退出汇总前结算，run 07770553 首例）；宿主侧
  // run.ts settleFrom 已把这类错误折成统一前缀 + 原文 + outcome.logs 摘录落
  // journal，不再以裸 EPIPE 收场（回归：test/worker-exit.test.mjs）。
  const body = ts.transpileModule(lowered, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    reportDiagnostics: false,
  }).outputText
  return { body, phaseNames, worldCommands, diagnostics: [] }
}

// —— 内存宿主：facade/用户文件驻内存，lib 从 typescript 包目录读盘 ——

function createInMemoryHost(userSf: ts.SourceFile, facadeSf: ts.SourceFile): ts.CompilerHost {
  const require = createRequire(import.meta.url)
  const libDir = path.dirname(require.resolve('typescript'))
  const fileCache = new Map<string, ts.SourceFile | undefined>()

  const getSourceFile = (fileName: string): ts.SourceFile | undefined => {
    if (fileName === USER_FILE) return userSf
    if (fileName === FACADE_FILE) return facadeSf
    // 默认 lib 以裸文件名（lib.es2024.full.d.ts）进来，先落到 typescript 包目录；
    // 库内 triple-slash path 引用已是绝对路径，直读。
    const resolved = path.isAbsolute(fileName) ? fileName : path.join(libDir, fileName)
    if (fileCache.has(resolved)) return fileCache.get(resolved)
    let content: string | undefined
    try {
      content = fs.readFileSync(resolved, 'utf8')
    } catch {
      content = undefined
    }
    const sf = content === undefined ? undefined : ts.createSourceFile(resolved, content, ts.ScriptTarget.ES2024, true)
    fileCache.set(resolved, sf)
    return sf
  }

  return {
    getSourceFile,
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => path.dirname(require.resolve('typescript')),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === USER_FILE || fileName === FACADE_FILE || fs.existsSync(fileName),
    readFile: (fileName) => {
      if (fileName === USER_FILE) return userSf.getFullText()
      if (fileName === FACADE_FILE) return facadeSf.getFullText()
      try {
        return fs.readFileSync(fileName, 'utf8')
      } catch {
        return undefined
      }
    },
    directoryExists: (dirName) => (dirName === libDir ? true : fs.existsSync(dirName) && fs.statSync(dirName).isDirectory()),
    getDirectories: () => [],
  }
}
