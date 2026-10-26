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
import type { RunWriter } from '../journal/store.ts';
import type { GuestRequest } from '../guest/protocol.ts';
import type { Json } from '../util/json.ts';
import type { ActorRegistry } from './actor.ts';
import type { Scheduler } from './scheduler.ts';
import type { ArtifactSink } from './artifacts.ts';
/** world.run 的结果形态（facade.d.ts:243-248 WorldRunResult 的宿主侧镜像）。 */
export interface WorldRunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface EffectDeps {
    runId: string;
    writer: RunWriter;
    scheduler: Scheduler;
    actors: ActorRegistry;
    /** report/artifact 的记账 sink（dwf_node 行归 artifacts 层）。 */
    sink: ArtifactSink;
    /** 世界操作的 workspace 根（sandboxPolicy.workspaceRoot）。 */
    workspaceRoot: string;
    signal: AbortSignal;
    /** report caps 拒收等「fail the whole run」情况的 run 侧回调（run.fail）。 */
    onRunFailure(message: string): void;
    /** ask 成功起步（activation 就绪）→ run 层 ledger.begin，返回 seq。 */
    onAgentAccepted(label: string, childId: import('@deepseek-ai/dsh-session').SessionId): {
        seq: number;
    };
    /** ask 结算（成功/确定性失败）→ run 层 ledger.end（幂等配对，B4）。 */
    onAgentSettled(seq: number, outcome: 'completed' | 'failed'): void;
}
export declare class EffectHandlers {
    private readonly deps;
    constructor(deps: EffectDeps);
    /**
     * 效应分派总入口：五态发射 + 按 op 路由。resolve = 成功值（guest 回包 resolve），
     * reject = 确定性失败（guest 回包 reject，脚本可 catch）。provider 类错误只从
     * ask 路径逃逸（scheduler 兜住），其余一律折叠成 reject。
     */
    dispatch(req: GuestRequest): Promise<Json>;
    /** ask 经 scheduler（同 actor FIFO + 并发上限 + provider 重试）。 */
    private dispatchAsk;
    /** world-read 七操作（facade files./git. 段；拒收不截断）。 */
    worldRead(req: GuestRequest): Promise<Json>;
    /** world.run：固定 argv 永不 shell；完成进程（含非零退出）resolve，仅 spawn 失败/超时 reject。 */
    worldRun(req: GuestRequest): Promise<Json>;
    /** hole：MVP 确定性 HOLE_UNAVAILABLE，绝不挂起（设计 §6.2；脚本可 catch 自行兜底）。 */
    hole(holeId: string): Promise<never>;
    /** 非调度直通效应（world/hole/publish-artifact）：同样五态，确定性失败折叠成 reject。 */
    private dispatchDirect;
    /** report：五态 + artifacts.handleReport 裁决；拒收 {ok:false} 折回 guest 并终止 run（facade「caps fail the whole run」）。 */
    private dispatchReport;
    /** publish-artifact：file/markdown 效应发布（artifacts 层落行）。 */
    private publishArtifact;
    private emitNode;
    private settleOkNode;
    private settleFailedNode;
    private inputOf;
    private interpretAnswer;
    private coerceSchema;
    private glob;
    private grep;
    private gitChangedFiles;
    private gitStatus;
    private gitLog;
    /** 固定 argv 跑 git；非零退出按确定性失败 reject（facade：仓库外一律可 catch 拒绝）。 */
    private runGit;
    /** spawn 封装：shell:false、stdout/stderr 各 256KB 拒收、超时 kill 后 reject。 */
    private spawnCapped;
    /** withinRoot 的判定半边（不抛）：rel 解析后仍落在 root 内（含 root 本身）返回 abs，否则 undefined。 */
    private resolveWithinRoot;
    /** workspace 相对路径收口：禁止逃出根（read/grep/glob 与 artifact 发布共用）。 */
    private withinRoot;
}
