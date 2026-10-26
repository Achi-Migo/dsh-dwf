/**
 * 效应层（设计 §3.5 effects 段 / §4 数据流）：guest request 的宿主执行。
 *
 * 职责边界（拍板表#18 定稿）：
 *   - 本层拥有 node 生命周期五态发射：**每次效应分派**经 RunWriter 依次发
 *     node-queued → node-dispatched → node-executing → node-waiting → node-settled
 *     （设计 §3.4 MVP 词表承诺，此前全工程无任何发射点——gap-audit §3.6）；
 *   - dwf_node **行**归各域所有：ask/world 由本层 recordNode，report/artifact
 *     归 artifacts 层；hole 无合法 kind（DDL CHECK 五值），落事件不落行；
 *   - 确定性失败（hole/report caps/AGENT_RESULT/world 拒收）以 reject 折回
 *     guest，脚本可 catch（facade 各段语义）；provider 类失败只允许从 ask
 *     路径以非 WorkflowError reject 逃逸，交 scheduler 重试/终局——错误永不进脚本。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import { CAPS } from '../journal/caps.ts'
import type { NodeKind, RunWriter } from '../journal/store.ts'
import type { JournalEventName } from '../types/index.d.ts'
import type { GuestRequest } from '../guest/protocol.ts'
import { holeUnavailable } from '../util/errors.ts'
import type { Json } from '../util/json.ts'
import { snapshotJsonValue } from '../util/json.ts'
import type { ActorRegistry } from './actor.ts'
import type { Scheduler } from './scheduler.ts'
import type { ArtifactSink } from './artifacts.ts'

/** world.run 的结果形态（facade.d.ts:243-248 WorldRunResult 的宿主侧镜像）。 */
export interface WorldRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** guest ask 载荷（guest/prelude.ts:106 __request 的 args 形状）。 */
interface AskPayload {
  actor: string
  actorSiteId?: string
  instructions: string
  schema: Json | null
}

export interface EffectDeps {
  runId: string
  writer: RunWriter
  scheduler: Scheduler
  actors: ActorRegistry
  /** report/artifact 的记账 sink（dwf_node 行归 artifacts 层）。 */
  sink: ArtifactSink
  /** 世界操作的 workspace 根（sandboxPolicy.workspaceRoot）。 */
  workspaceRoot: string
  signal: AbortSignal
  /** report caps 拒收等「fail the whole run」情况的 run 侧回调（run.fail）。 */
  onRunFailure(message: string): void
  /** ask 成功起步（activation 就绪）→ run 层 ledger.begin，返回 seq。 */
  onAgentAccepted(label: string, childId: import('@deepseek-ai/dsh-session').SessionId): { seq: number }
  /** ask 结算（成功/确定性失败）→ run 层 ledger.end（幂等配对，B4）。 */
  onAgentSettled(seq: number, outcome: 'completed' | 'failed'): void
}

export class EffectHandlers {
  private readonly deps: EffectDeps

  constructor(deps: EffectDeps) {
    this.deps = deps
  }

  /**
   * 效应分派总入口：五态发射 + 按 op 路由。resolve = 成功值（guest 回包 resolve），
   * reject = 确定性失败（guest 回包 reject，脚本可 catch）。provider 类错误只从
   * ask 路径逃逸（scheduler 兜住），其余一律折叠成 reject。
   */
  dispatch(req: GuestRequest): Promise<Json> {
    switch (req.op) {
      case 'ask':
        return this.dispatchAsk(req)
      case 'world-read':
        return this.dispatchDirect(req, 'world-read', () => this.worldRead(req))
      case 'world-run':
        return this.dispatchDirect(req, 'world-run', () => this.worldRun(req))
      case 'hole':
        return this.dispatchDirect(req, undefined, () => this.hole(req.siteId))
      case 'report':
        return this.dispatchReport(req)
      case 'publish-artifact':
        return this.dispatchDirect(req, undefined, () => this.publishArtifact(req))
    }
  }

  // ============ 设计 §3.5 EffectHandlers 四 handler ============

  /** ask 经 scheduler（同 actor FIFO + 并发上限 + provider 重试）。 */
  private dispatchAsk(req: GuestRequest): Promise<Json> {
    const payload = req.args as Partial<AskPayload> | null
    const label = typeof payload?.actor === 'string' ? payload.actor : ''
    const instructions = typeof payload?.instructions === 'string' ? payload.instructions : ''
    const schema = this.coerceSchema(payload?.schema)
    let resolveResponse!: (value: Json) => void
    let rejectResponse!: (error: unknown) => void
    const response = new Promise<Json>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    this.emitNode(req.siteId, 'queued', { kind: 'ask' })
    const input = snapshotJsonValue({ actor: label, instructions, schema: payload?.schema ?? null }) as Json
    this.deps.scheduler.enqueue(label, {
      work: async () => {
        this.emitNode(req.siteId, 'dispatched', { kind: 'ask' })
        this.emitNode(req.siteId, 'executing', { kind: 'ask' })
        const key = this.deps.actors.lookup(label)
        if (key === undefined) {
          this.settleFailedNode(req.siteId, 'ask', `actor "${label}" was never declared`, input)
          this.emitNode(req.siteId, 'settled', { ok: false, kind: 'ask', error: `actor "${label}" was never declared` })
          rejectResponse(new WorkflowError(`ask target "${label}" was never declared in this run`, 'AGENT_START'))
          return
        }
        this.emitNode(req.siteId, 'waiting', { kind: 'ask' })
        // activation 就绪即 ledger.begin（B4 配对的起点；agent-start 事件由此发出）。
        let seq: number | undefined
        // provider 类拒绝从这里逃逸 → scheduler 重试/终局（错误不进脚本；
        // 终局会 fail run 并 abort guest，未决回包随进程终止）。
        const result = await this.deps.actors.ask(key, instructions, schema, childId => {
          seq = this.deps.onAgentAccepted(label, childId).seq
        })
        // 池模式下 actor 的实际模型（含换道后的）记进 ask 节点 input——
        // input_hash 随之反映真实执行面（诚实记账）。
        const actualModel = this.deps.actors.resolvedModelOf(label)
        const inputWithModel: Json = actualModel === undefined
          ? input
          : (snapshotJsonValue({ actor: label, instructions, schema: payload?.schema ?? null, model: actualModel }) as Json)
        let value: Json
        try {
          value = this.interpretAnswer(label, result, schema)
        } catch (error: unknown) {
          this.settleFailedNode(req.siteId, 'ask', renderMessage(error), inputWithModel)
          this.emitNode(req.siteId, 'settled', { ok: false, kind: 'ask', error: renderMessage(error) })
          if (seq !== undefined) this.deps.onAgentSettled(seq, 'failed')
          rejectResponse(error)
          return
        }
        this.settleOkNode(req.siteId, 'ask', inputWithModel, value, payload?.actorSiteId)
        // ask 五态收口：原先只 recordNode 不发 node-settled（真机 closure-ask2 /
        // p0a-smoke-2 观察：dwf_node ask 行 completed 但事件流缺 settled）。
        this.emitNode(req.siteId, 'settled', { ok: true, kind: 'ask' })
        if (seq !== undefined) this.deps.onAgentSettled(seq, 'completed')
        resolveResponse(value)
      },
    })
    return response
  }

  /** world-read 七操作（facade files./git. 段；拒收不截断）。 */
  async worldRead(req: GuestRequest): Promise<Json> {
    const payload = (req.args ?? {}) as Partial<{ op: unknown; args: unknown[] }>
    const op = typeof payload.op === 'string' ? payload.op : ''
    const args = Array.isArray(payload.args) ? payload.args : []
    const root = this.deps.workspaceRoot
    switch (op) {
      case 'files.glob': {
        const pattern = typeof args[0] === 'string' ? args[0] : throwOp('files.glob(pattern: string)')
        const matches = await this.glob(root, pattern)
        if (matches.length > CAPS.worldReadCap) throw new Error(`files.glob exceeded ${CAPS.worldReadCap} entries — rejected, not truncated`)
        return matches
      }
      case 'files.read': {
        const rel = typeof args[0] === 'string' ? args[0] : throwOp('files.read(path: string)')
        const abs = this.withinRoot(root, rel)
        const stat = await fs.stat(abs)
        if (stat.size > CAPS.worldStdoutCap) throw new Error(`files.read: ${rel} is ${stat.size} bytes — over the ${CAPS.worldStdoutCap} cap`)
        return await fs.readFile(abs, 'utf8')
      }
      case 'files.grep': {
        const pattern = typeof args[0] === 'string' ? args[0] : throwOp('files.grep(pattern: string)')
        const glob = typeof args[1] === 'string' ? args[1] : undefined
        return await this.grep(root, pattern, glob)
      }
      case 'git.changedFiles': {
        const base = typeof args[0] === 'string' ? args[0] : undefined
        return await this.gitChangedFiles(root, base)
      }
      case 'git.diff': {
        const base = typeof args[0] === 'string' ? args[0] : undefined
        const file = typeof args[1] === 'string' ? args[1] : undefined
        const diff = await this.runGit(root, ['--no-pager', 'diff', ...(base === undefined ? ['HEAD'] : [base]), ...(file === undefined ? [] : ['--', file])])
        if (diff.stdout.length > CAPS.gitDiffBytes) throw new Error(`git.diff exceeded ${CAPS.gitDiffBytes} bytes — rejected, not truncated`)
        return diff.stdout
      }
      case 'git.status':
        return await this.gitStatus(root)
      case 'git.log': {
        const count = typeof args[0] === 'number' && Number.isSafeInteger(args[0]) ? args[0] : 20
        return await this.gitLog(root, count)
      }
      default:
        throw new Error(`unknown world-read op "${op}"`)
    }
  }

  /** world.run：固定 argv 永不 shell；完成进程（含非零退出）resolve，仅 spawn 失败/超时 reject。 */
  async worldRun(req: GuestRequest): Promise<Json> {
    const payload = (req.args ?? {}) as Partial<{ cmd: unknown; args: unknown; timeoutMs: unknown }>
    const cmd = typeof payload.cmd === 'string' && payload.cmd.length > 0 ? payload.cmd : throwOp('world.run(cmd: string)')
    const argv = (Array.isArray(payload.args) ? payload.args : []).map(item => (typeof item === 'string' ? item : String(item)))
    const timeoutMs = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : 300000
    const outcome = await this.spawnCapped(cmd, argv, this.deps.workspaceRoot, timeoutMs)
    return snapshotJsonValue(outcome) as Json
  }

  /** hole：MVP 确定性 HOLE_UNAVAILABLE，绝不挂起（设计 §6.2；脚本可 catch 自行兜底）。 */
  async hole(holeId: string): Promise<never> {
    throw holeUnavailable(holeId)
  }

  // ============ 分派通路（五态发射的公共骨架） ============

  /** 非调度直通效应（world/hole/publish-artifact）：同样五态，确定性失败折叠成 reject。 */
  private async dispatchDirect(req: GuestRequest, kind: NodeKind | undefined, work: () => Promise<Json>): Promise<Json> {
    this.emitNode(req.siteId, 'queued', kind === undefined ? {} : { kind })
    this.emitNode(req.siteId, 'dispatched', kind === undefined ? {} : { kind })
    this.emitNode(req.siteId, 'executing', kind === undefined ? {} : { kind })
    this.emitNode(req.siteId, 'waiting', kind === undefined ? {} : { kind })
    try {
      const value = await work()
      if (kind !== undefined) this.settleOkNode(req.siteId, kind, this.inputOf(req), value)
      this.emitNode(req.siteId, 'settled', kind === undefined ? { ok: true } : { ok: true, kind })
      return value
    } catch (error: unknown) {
      if (kind !== undefined) this.settleFailedNode(req.siteId, kind, renderMessage(error))
      this.emitNode(req.siteId, 'settled', kind === undefined ? { ok: false, error: renderMessage(error) } : { ok: false, kind, error: renderMessage(error) })
      throw error
    }
  }

  /** report：五态 + artifacts.handleReport 裁决；拒收 {ok:false} 折回 guest 并终止 run（facade「caps fail the whole run」）。 */
  private async dispatchReport(req: GuestRequest): Promise<Json> {
    this.emitNode(req.siteId, 'queued', { kind: 'report' })
    this.emitNode(req.siteId, 'dispatched', { kind: 'report' })
    this.emitNode(req.siteId, 'executing', { kind: 'report' })
    this.emitNode(req.siteId, 'waiting', { kind: 'report' })
    const payload = (req.args ?? {}) as Partial<{ item: unknown; artifactId: unknown }>
    let item: Json
    try {
      item = snapshotJsonValue(payload.item)
    } catch (error: unknown) {
      const message = `report item is not lossless JSON: ${renderMessage(error)}`
      this.emitNode(req.siteId, 'settled', { ok: false, kind: 'report', error: message })
      throw new Error(message)
    }
    const artifactId = typeof payload.artifactId === 'string' && payload.artifactId.length > 0 ? payload.artifactId : undefined
    const outcome = this.deps.sink.handleReport(item, req.siteId, artifactId)
    if (outcome.ok) {
      this.emitNode(req.siteId, 'settled', { ok: true, kind: 'report' })
      return { ok: true }
    }
    this.emitNode(req.siteId, 'settled', { ok: false, kind: 'report', error: outcome.error })
    this.deps.onRunFailure(outcome.error)
    return { ok: false, error: outcome.error }
  }

  /** publish-artifact：file/markdown 效应发布（artifacts 层落行）。 */
  private async publishArtifact(req: GuestRequest): Promise<Json> {
    const payload = (req.args ?? {}) as Partial<{ op: unknown; args: unknown[] }>
    const op = typeof payload.op === 'string' ? payload.op : ''
    const args = Array.isArray(payload.args) ? payload.args : []
    this.emitNode(req.siteId, 'queued', { kind: 'artifact' })
    this.emitNode(req.siteId, 'dispatched', { kind: 'artifact' })
    this.emitNode(req.siteId, 'executing', { kind: 'artifact' })
    this.emitNode(req.siteId, 'waiting', { kind: 'artifact' })
    try {
      let ref
      if (op === 'file') {
        ref = await this.deps.sink.publishFile(str(args[0], 'artifact id'), str(args[1], 'artifact path'), args[2], req.siteId)
      } else if (op === 'markdown') {
        ref = await this.deps.sink.publishMarkdown(str(args[0], 'artifact id'), str(args[1], 'artifact content'), args[2], req.siteId)
      } else {
        throw new Error(`unknown publish-artifact op "${op}"`)
      }
      const value = snapshotJsonValue(ref) as Json
      this.emitNode(req.siteId, 'settled', { ok: true, kind: 'artifact' })
      return value
    } catch (error: unknown) {
      this.emitNode(req.siteId, 'settled', { ok: false, kind: 'artifact', error: renderMessage(error) })
      throw error
    }
  }

  // ============ 五态发射与 node 记账 ============

  private emitNode(siteId: string, state: 'queued' | 'dispatched' | 'executing' | 'waiting' | 'settled', extra: Record<string, unknown>): void {
    // RunWriter 是 run 绑定写手（writerFor），appendEvent 不带 runId——载荷里仍带
    // runId/siteId（拍板表#18 单测断言载荷用）。
    this.deps.writer.appendEvent({
      type: `node-${state}` as JournalEventName,
      payload: snapshotJsonValue({ runId: this.deps.runId, siteId, ...extra }),
    })
  }

  private settleOkNode(siteId: string, kind: NodeKind, input: Json, result: Json, actorSiteId?: string): void {
    this.deps.writer.recordNode({
      siteId,
      kind,
      input,
      status: 'completed',
      result,
      ...(actorSiteId === undefined ? {} : { actorSiteId }),
    })
  }

  private settleFailedNode(siteId: string, kind: NodeKind, message: string, input?: Json): void {
    this.deps.writer.recordNode({
      siteId,
      kind,
      input: input ?? ({}),
      status: 'failed',
      error: message,
    })
  }

  private inputOf(req: GuestRequest): Json {
    return snapshotJsonValue(req.args) as Json
  }

  // ============ ask 结果解释 ============

  private interpretAnswer(label: string, result: SubagentResult, schema?: ObjectJsonSchema): Json {
    if (result.stopReason !== 'completed') {
      throw new WorkflowError(
        `subagent "${label}" stopped (${result.stopReason})${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`,
        'AGENT_RESULT',
      )
    }
    if (schema !== undefined) {
      if (result.structured === undefined) {
        throw new WorkflowError(`subagent "${label}" completed without a structured answer for its schema`, 'AGENT_RESULT')
      }
      return snapshotJsonValue(result.structured)
    }
    const blocks = Array.isArray(result.output) ? result.output : []
    let text = ''
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const value = (block as { text?: unknown }).text
        if (typeof value === 'string') text += value
      }
    }
    return text
  }

  private coerceSchema(raw: unknown): ObjectJsonSchema | undefined {
    if (raw === null || raw === undefined) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw) || (raw as { type?: unknown }).type !== 'object') {
      throw new WorkflowError('ask schema must be an ObjectJsonSchema object', 'UNSUPPORTED_SCHEMA')
    }
    return raw as ObjectJsonSchema
  }

  // ============ world 实现体（node 内建，无外部依赖） ============

  private async glob(root: string, pattern: string): Promise<string[]> {
    const matcher = globToRegExp(pattern)
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/')
        if (entry.isDirectory()) await walk(path.join(dir, entry.name))
        else if (matcher.test(rel)) out.push(rel)
        if (out.length > CAPS.worldReadCap) return
      }
    }
    await walk(root)
    return out.sort()
  }

  private async grep(root: string, pattern: string, glob: string | undefined): Promise<Json> {
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error: unknown) {
      throw new Error(`files.grep: invalid pattern: ${renderMessage(error)}`)
    }
    const fileFilter = glob === undefined ? undefined : globToRegExp(glob)
    const matches: Json[] = []
    let bytes = 0
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
          continue
        }
        const rel = path.relative(root, abs).split(path.sep).join('/')
        if (fileFilter !== undefined && !fileFilter.test(rel)) continue
        let content: string
        try {
          content = await fs.readFile(abs, 'utf8')
        } catch {
          continue // 二进制/不可读文件跳过（rg 同语义）
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          if (regex.test(lines[i])) {
            const match = { path: rel, line: i + 1, text: lines[i] }
            matches.push(snapshotJsonValue(match) as Json)
            bytes += lines[i].length
          }
          if (matches.length > CAPS.worldReadCap || bytes > CAPS.grepResultBytes) {
            throw new Error(`files.grep exceeded caps (${CAPS.worldReadCap} matches / ${CAPS.grepResultBytes} bytes) — rejected, not truncated`)
          }
        }
      }
    }
    await walk(root)
    return matches
  }

  private async gitChangedFiles(root: string, base: string | undefined): Promise<Json> {
    if (base !== undefined) {
      const diff = await this.runGit(root, ['--no-pager', 'diff', '--name-only', base])
      return diff.stdout
        .split('\n')
        .filter(line => line.length > 0 && this.resolveWithinRoot(root, line) !== undefined)
    }
    const status = await this.runGit(root, ['status', '--porcelain'])
    const seen = new Set<string>()
    for (const line of status.stdout.split('\n')) {
      if (line.length < 4) continue
      const entry = line.slice(3).trim()
      if (entry.length > 0 && this.resolveWithinRoot(root, entry) !== undefined) seen.add(entry)
    }
    return [...seen]
  }

  private async gitStatus(root: string): Promise<Json> {
    const out = await this.runGit(root, ['status', '--porcelain', '-b'])
    const lines = out.stdout.split('\n').filter(line => line.length > 0)
    const head = lines[0] ?? ''
    const headBody = head.startsWith('##') ? head.replace(/^##\s*/, '') : undefined
    // detached HEAD 的 porcelain 固定形态是 `## HEAD (no branch)`：解析失败或 detached
    // 时不带 branch 字段（facade：absent when HEAD is detached）。
    const branch = headBody === undefined || headBody.startsWith('HEAD (no branch)')
      ? undefined
      : headBody.split('...')[0].trim() || undefined
    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []
    for (const line of lines.slice(1)) {
      const x = line[0]
      const y = line[1]
      const file = line.slice(3).trim()
      if (x === '?') untracked.push(file)
      else {
        if (x !== ' ') staged.push(file)
        if (y !== ' ') unstaged.push(file)
      }
    }
    const result = {
      ...(branch === undefined ? {} : { branch }),
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      staged,
      unstaged,
      untracked,
    }
    return snapshotJsonValue(result) as Json
  }

  private async gitLog(root: string, count: number): Promise<Json> {
    const capped = Math.max(1, Math.min(count, CAPS.gitLogCommits))
    const out = await this.runGit(root, ['--no-pager', 'log', `-n`, String(capped), '--pretty=format:%H%x1f%s%x1f%an%x1f%aI'])
    return out.stdout
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const [hash, subject, author, date] = line.split('\x1f')
        return snapshotJsonValue({ hash, subject, author, date }) as Json
      })
  }

  /** 固定 argv 跑 git；非零退出按确定性失败 reject（facade：仓库外一律可 catch 拒绝）。 */
  private async runGit(root: string, argv: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.spawnCapped('git', argv, root, 60000)
    if (result.exitCode !== 0) {
      throw new Error(`git ${argv[0]} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200) || 'not a git repository?'}`)
    }
    return result
  }

  /** spawn 封装：shell:false、stdout/stderr 各 256KB 拒收、超时 kill 后 reject。 */
  private spawnCapped(cmd: string, argv: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, argv, { cwd, shell: false, signal: this.deps.signal })
      let stdout = ''
      let stderr = ''
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > CAPS.worldStdoutCap) {
          child.kill()
          fail(new Error(`world.run stdout exceeded ${CAPS.worldStdoutCap} bytes — rejected, not truncated`))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > CAPS.worldStdoutCap) {
          child.kill()
          fail(new Error(`world.run stderr exceeded ${CAPS.worldStdoutCap} bytes — rejected, not truncated`))
        }
      })
      child.on('error', (error: Error) => fail(new Error(`world.run failed to spawn "${cmd}": ${error.message}`)))
      child.on('close', exitCode => {
        if (settled) return
        settled = true
        resolve({ exitCode: exitCode ?? -1, stdout, stderr })
      })
      const timer = setTimeout(() => {
        child.kill()
        fail(new Error(`world.run "${cmd}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.once('close', () => clearTimeout(timer))
    })
  }

  /** withinRoot 的判定半边（不抛）：rel 解析后仍落在 root 内（含 root 本身）返回 abs，否则 undefined。 */
  private resolveWithinRoot(root: string, rel: string): string | undefined {
    const abs = path.resolve(root, rel)
    return abs === root || abs.startsWith(root + path.sep) ? abs : undefined
  }

  /** workspace 相对路径收口：禁止逃出根（read/grep/glob 与 artifact 发布共用）。 */
  private withinRoot(root: string, rel: string): string {
    const abs = this.resolveWithinRoot(root, rel)
    if (abs === undefined) throw new Error(`path "${rel}" escapes the workspace root`)
    return abs
  }
}

// ============ 模块级小件 ============

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function throwOp(signature: string): never {
  throw new Error(`world operation requires ${signature}`)
}

function renderMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 极简 glob → RegExp（** 跨段、* 单段内、? 单字符、{a,b} 不支持——MVP 够用）。 */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      source += `\\${ch}`
    } else {
      source += ch
    }
  }
  return new RegExp(`^${source}$`)
}
