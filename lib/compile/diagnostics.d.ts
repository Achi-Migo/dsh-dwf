/**
 * 自定义诊断三族（mechanism-map §2.4 / DESIGN §3.2；9001 存值别名调用、9011 fill
 * 模型校验 defer，MVP 不做）：
 *   9012 —— hole 规则族（名字必须非空编译期字面量；filled/unfilled 形态由 TS 重载
 *           兜底，这里只补语义面）
 *   9013 —— 编译期字面量（phase 名、artifact id、world.run cmd、report artifactId、
 *           model id 必须是 string literal——facade.d.ts 注释逐条点名）
 *   9014 —— agent 名字字面量重复（facade.d.ts:37-38：a literal duplicate is a
 *           compile error；computed 名字放行，运行期由 guest 守卫 + 宿主注册表双层查重）
 *
 * 坐标口径：三个 family 收的是「包装后」SourceFile（用户体包在
 * `async function __workflow() {…}` 内），返回的 start/end 是包装文件内偏移；
 * diagnosticsToUserSource / tsToWorkflowDiagnostics 负责把偏移重定基到用户源码
 * 并折算行列。坐标换算只在这里，compiler.ts 不做算术。
 */
import ts from 'typescript';
/** 自定义诊断（TS 诊断同形转换后也用它承载）。start/end 为来源文件内偏移。 */
export interface WorkflowDiagnostic {
    start: number;
    end: number;
    line: number;
    column: number;
    code: number;
    message: string;
}
export declare const DIAGNOSTIC_CODES: {
    readonly hole: 9012;
    readonly literal: 9013;
    readonly agentName: 9014;
};
/** 把包装坐标的诊断重定基到用户源码（offset = 包装前缀长度），并折算行列。 */
export declare function diagnosticsToUserSource(diags: readonly WorkflowDiagnostic[], source: string, offset: number): WorkflowDiagnostic[];
/** TS 诊断（syntactic/semantic）→ WorkflowDiagnostic，同样重定基到用户源码。 */
export declare function tsToWorkflowDiagnostics(tsDiags: readonly ts.Diagnostic[], source: string, offset: number): WorkflowDiagnostic[];
/** 9012 hole 规则族。 */
export declare function holeDiagnostics(sf: ts.SourceFile): WorkflowDiagnostic[];
/** 9013 编译期字面量族 + 收集 world.run 命令字面量（安全模型：随确认展示）。 */
export declare function literalDiagnostics(sf: ts.SourceFile): {
    diagnostics: WorkflowDiagnostic[];
    worldCommands: string[];
};
/** 9014 agent 名字字面量重复；computed 名字放行（运行期双层查重）。 */
export declare function agentNameDiagnostics(sf: ts.SourceFile): WorkflowDiagnostic[];
