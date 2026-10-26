/**
 * 编译期字面量检查的原语层：facade 调用点的纯语法识别 + 字符串字面量提取。
 *
 * 识别是「按字面拼写」而非按 checker 符号——lower 的重写与诊断的收集必须对同一
 * 识别规则达成一致，这里就是唯一的规则出处：
 *   - facadeCallAt：facade 全集（含不参与 lowering 的 phase/log/model/agent），诊断与
 *     phase 图用它；
 *   - isLoweredCall：lowering 子集（每个效应调用点），schema.ts 与 lower.ts 的
 *     siteId 序号计数都用它——两侧各走一遍同一 AST，序号因此逐点一致。
 *
 * 字面量 = StringLiteral 或无插值 TemplateLiteral（二者都是编译期常量，facade 注释
 * 的 "compile-time literal" 两者皆容）。用户若自行 shadow 这些名字（如
 * `const log = …`），识别会误报——facade 词汇表是脚本面保留字，原版同样如此；
 * 类型错误的脚本在语义诊断就已被拦下，不会走到 lowering。
 */
import ts from 'typescript';
/** world-read 的操作面（DESIGN §3.5 effects.worldRead 的 op 词表）。 */
export type WorldReadOp = 'files.glob' | 'files.read' | 'files.grep' | 'git.changedFiles' | 'git.diff' | 'git.status' | 'git.log';
/** artifact 预置声明四件套（chart/table/metrics/board，DESIGN §3.5 artifacts.ts defer 的声明面）。 */
export type ArtifactDeclareOp = 'chart' | 'table' | 'metrics' | 'board';
/** facade 效应/原语全集——按调用形态归类。 */
export type FacadeOp = {
    family: 'ask';
} | {
    family: 'world-read';
    op: WorldReadOp;
} | {
    family: 'world-run';
} | {
    family: 'report';
} | {
    family: 'artifact-publish';
    op: 'file' | 'markdown';
} | {
    family: 'artifact-declare';
    op: ArtifactDeclareOp;
} | {
    family: 'hole';
} | {
    family: 'phase';
} | {
    family: 'log';
} | {
    family: 'model';
} | {
    family: 'agent';
};
export interface FacadeCall {
    node: ts.CallExpression;
    call: FacadeOp;
}
/** facade 全集识别（含不 lowering 的 phase/log/model/agent）。只认一层属性访问/裸标识符。 */
export declare function facadeCallAt(node: ts.Node): FacadeCall | undefined;
/** lowering 子集：每个都会被重写成 `__host.<op>(siteId, …)` 并消耗一个调用点序号。 */
export declare function isLoweredCall(node: ts.Node): FacadeCall | undefined;
/** 编译期字符串字面量：StringLiteral 或无插值 TemplateLiteral，取其值。 */
export declare function stringLiteralText(expr: ts.Expression | undefined): string | undefined;
/** hole 的 filled 形态识别：末位实参是否箭头/函数表达式（facade.d.ts hole 段三重载）。 */
export declare function isPlainFunctionExpression(expr: ts.Expression | undefined): boolean;
export type HoleForm = {
    filled: false;
    name: ts.Expression;
    prompt?: ts.Expression;
} | {
    filled: true;
    name: ts.Expression;
    prompt?: ts.Expression;
    body: ts.Expression;
};
/** 按三重载分流 hole 实参：(name) / (name, prompt) / (name, body) / (name, prompt, body)。 */
export declare function holeFormOf(call: ts.CallExpression): HoleForm | undefined;
