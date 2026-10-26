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
import type { RunWriter } from '../journal/store.ts';
import type { Json } from '../util/json.ts';
/** handleReport 的裁决：接受落账；超限拒收（错误文案进 guest 回包与 run 失败）。 */
export type ReportOutcome = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** facade ArtifactRef（facade.d.ts:67-69）。 */
export interface ArtifactRef {
    id: string;
    version: number;
}
export interface ArtifactSinkDeps {
    runId: string;
    writer: RunWriter;
    /** workspace 根：publishFile 的 path 以它收口。 */
    workspaceRoot: string;
}
export declare class ArtifactSink {
    private readonly deps;
    /** per-run 计数：条数、累计字节、版本号、primary id。 */
    private items;
    private itemBytes;
    private readonly versions;
    private primaryId;
    constructor(deps: ArtifactSinkDeps);
    /**
     * report 裁决：caps 全过 → recordNode(kind:'report') + 'report' 事件，{ok:true}；
     * 任一超限 → **{ok:false,error} 拒收**（不截断），由 effects 折回 guest 并终止 run。
     * 签名注记：DESIGN 写 handleReport(item, artifactId?)；siteId 是 guest 调用点
     * （journal (run_id, site_id, ordinal) 的 site 语义），作显式入参传入。
     */
    handleReport(item: Json, siteId: string, artifactId?: string): ReportOutcome;
    /** artifact.file：workspace 内已存在文件，字节帽拒收；republish = 新版本。 */
    publishFile(id: string, filePath: string, options: unknown, siteId: string): Promise<ArtifactRef>;
    /** artifact.markdown：内容帽 256KB；republish = 新版本。 */
    publishMarkdown(id: string, content: string, options: unknown, siteId: string): Promise<ArtifactRef>;
    private record;
    /** id 运行时复验：非空 ≤64 的 [A-Za-z0-9_.-]（编译期字面量约束的第二道）。 */
    private checkId;
    private mintVersion;
    /** title/description 帽（primary 的至多一个 id 在 record() 里带 id 裁决）。 */
    private checkOptions;
    /** workspace 相对路径收口（与 effects 的 world 路径同一策略）。 */
    private withinRoot;
}
