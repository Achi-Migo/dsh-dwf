/**
 * 工件层（设计 §3.5 artifacts 段）：report 落 journal + artifact.file/markdown
 * 效应型发布。
 *   - handleReport 的 caps 拒收**折回 guest**（{ok:false,error}，评审 B8：
 *     report 是 request；facade.d.ts report 段「caps fail the whole run, not
 *     the call」——run 层收到拒收还会 fail 整个 run）；
 *   - caps（CAPS）：65536 条/run、1MiB/条、1GiB/run；artifact 32 id、16 版本/id、
 *     20MiB file、256KB markdown、title 120 / description 500；primary 至多一个 id；
 *   - id 编译期已验字面量（compile 层），本层做运行时复验（非空 ≤64 的
 *     [A-Za-z0-9_.-]）；chart/table/metrics/board 四 preset defer（设计 §6.2），
 *     带 artifactId 的 report 因此命名不到任何 preset → 拒收终止 run（facade 原义）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CAPS } from '../journal/caps.ts'
import type { RunWriter } from '../journal/store.ts'
import type { Json } from '../util/json.ts'
import { snapshotJsonValue } from '../util/json.ts'

/** handleReport 的裁决：接受落账；超限拒收（错误文案进 guest 回包与 run 失败）。 */
export type ReportOutcome = { ok: true } | { ok: false; error: string }

/** facade ArtifactRef（facade.d.ts:67-69）。 */
export interface ArtifactRef {
  id: string
  version: number
}

interface ArtifactOptionsShape {
  title?: unknown
  description?: unknown
  primary?: unknown
  contentType?: unknown
}

export interface ArtifactSinkDeps {
  runId: string
  writer: RunWriter
  /** workspace 根：publishFile 的 path 以它收口。 */
  workspaceRoot: string
}

export class ArtifactSink {
  private readonly deps: ArtifactSinkDeps
  /** per-run 计数：条数、累计字节、版本号、primary id。 */
  private items = 0
  private itemBytes = 0
  private readonly versions = new Map<string, number>()
  private primaryId: string | undefined

  constructor(deps: ArtifactSinkDeps) {
    this.deps = deps
  }

  /**
   * report 裁决：caps 全过 → recordNode(kind:'report') + 'report' 事件，{ok:true}；
   * 任一超限 → **{ok:false,error} 拒收**（不截断），由 effects 折回 guest 并终止 run。
   * 签名注记：DESIGN 写 handleReport(item, artifactId?)；siteId 是 guest 调用点
   * （journal (run_id, site_id, ordinal) 的 site 语义），作显式入参传入。
   */
  handleReport(item: Json, siteId: string, artifactId?: string): ReportOutcome {
    // preset defer：命名不到任何已声明 preset 的 tag 必须终止 run（facade report 段原义）。
    if (artifactId !== undefined) {
      return { ok: false, error: `report artifactId "${artifactId}" names no declared artifact preset (chart/table/metrics/board are deferred in dsh-dwf MVP)` }
    }
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (this.items + 1 > CAPS.reportItemsPerRun) {
      return { ok: false, error: `report cap exceeded: more than ${CAPS.reportItemsPerRun} items in one run` }
    }
    if (bytes > CAPS.reportItemBytes) {
      return { ok: false, error: `report cap exceeded: item is ${bytes} bytes (cap ${CAPS.reportItemBytes})` }
    }
    if (this.itemBytes + bytes > CAPS.reportTotalBytes) {
      return { ok: false, error: `report cap exceeded: more than ${CAPS.reportTotalBytes} bytes of items in one run` }
    }
    this.items += 1
    this.itemBytes += bytes
    const node = this.deps.writer.recordNode({
      siteId,
      kind: 'report',
      input: item,
      status: 'completed',
      result: { bytes },
    })
    this.deps.writer.appendEvent({
      type: 'report',
      payload: { runId: this.deps.runId, siteId: node.siteId, ordinal: node.ordinal, bytes },
    })
    return { ok: true }
  }

  /** artifact.file：workspace 内已存在文件，字节帽拒收；republish = 新版本。 */
  async publishFile(id: string, filePath: string, options: unknown, siteId: string): Promise<ArtifactRef> {
    const opts = this.checkOptions(options)
    const safeId = this.checkId(id)
    const abs = this.withinRoot(filePath)
    const stat = await fs.stat(abs).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) throw new Error(`artifact.file: "${filePath}" is not a workspace file`)
    if (stat.size > CAPS.artifactFileBytes) {
      throw new Error(`artifact.file: "${filePath}" is ${stat.size} bytes (cap ${CAPS.artifactFileBytes})`)
    }
    const version = this.mintVersion(safeId)
    return this.record(safeId, version, opts, siteId, {
      kind: 'file',
      path: filePath,
      bytes: stat.size,
      ...(typeof opts.contentType === 'string' ? { contentType: opts.contentType } : {}),
    })
  }

  /** artifact.markdown：内容帽 256KB；republish = 新版本。 */
  async publishMarkdown(id: string, content: string, options: unknown, siteId: string): Promise<ArtifactRef> {
    const opts = this.checkOptions(options)
    const safeId = this.checkId(id)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > CAPS.artifactMdBytes) {
      throw new Error(`artifact.markdown: content is ${bytes} bytes (cap ${CAPS.artifactMdBytes})`)
    }
    const version = this.mintVersion(safeId)
    return this.record(safeId, version, opts, siteId, { kind: 'markdown', bytes })
  }

  // ============ 内部 ============

  private record(id: string, version: number, opts: ArtifactOptionsShape, siteId: string, detail: Record<string, unknown>): ArtifactRef {
    if (opts.primary === true) {
      // 至多一个 primary id；一旦设定不再更改（facade ArtifactOptions.primary 注释）。
      if (this.primaryId !== undefined && this.primaryId !== id) {
        throw new Error(`artifact primary is already set to "${this.primaryId}" — at most one primary id per run`)
      }
      this.primaryId = id
    }
    const input = snapshotJsonValue({ id, version, title: opts.title ?? null, description: opts.description ?? null, primary: opts.primary === true, ...detail }) as Json
    const node = this.deps.writer.recordNode({
      siteId,
      kind: 'artifact',
      input,
      status: 'completed',
      result: { id, version },
      artifactId: id,
    })
    this.deps.writer.appendEvent({
      type: 'artifact-published',
      payload: { runId: this.deps.runId, siteId: node.siteId, ordinal: node.ordinal, id, version },
    })
    return { id, version }
  }

  /** id 运行时复验：非空 ≤64 的 [A-Za-z0-9_.-]（编译期字面量约束的第二道）。 */
  private checkId(id: string): string {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
      throw new Error(`artifact id "${id}" must be 1..64 chars of [A-Za-z0-9_.-]`)
    }
    const versions = this.versions.get(id)
    if (versions !== undefined && versions >= CAPS.artifactVersions) {
      throw new Error(`artifact id "${id}" exceeded ${CAPS.artifactVersions} versions in one run`)
    }
    if (this.versions.size >= CAPS.artifactIds && !this.versions.has(id)) {
      throw new Error(`run exceeded ${CAPS.artifactIds} distinct artifact ids`)
    }
    return id
  }

  private mintVersion(id: string): number {
    const next = (this.versions.get(id) ?? 0) + 1
    this.versions.set(id, next)
    return next
  }

  /** title/description 帽（primary 的至多一个 id 在 record() 里带 id 裁决）。 */
  private checkOptions(options: unknown): ArtifactOptionsShape {
    const opts: ArtifactOptionsShape = options === null || options === undefined || typeof options !== 'object' ? {} : (options as ArtifactOptionsShape)
    if (opts.title !== undefined && (typeof opts.title !== 'string' || opts.title.length > CAPS.artifactTitleChars)) {
      throw new Error(`artifact title exceeds ${CAPS.artifactTitleChars} characters`)
    }
    if (opts.description !== undefined && (typeof opts.description !== 'string' || opts.description.length > CAPS.artifactDescriptionChars)) {
      throw new Error(`artifact description exceeds ${CAPS.artifactDescriptionChars} characters`)
    }
    return opts
  }

  /** workspace 相对路径收口（与 effects 的 world 路径同一策略）。 */
  private withinRoot(rel: string): string {
    const root = path.resolve(this.deps.workspaceRoot)
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`artifact path "${rel}" escapes the workspace root`)
    }
    return abs
  }
}
