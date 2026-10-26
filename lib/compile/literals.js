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
const WORLD_READ_OPS = new Map([
    ['glob', 'files.glob'],
    ['read', 'files.read'],
    ['grep', 'files.grep'],
    ['changedFiles', 'git.changedFiles'],
    ['diff', 'git.diff'],
    ['status', 'git.status'],
    ['log', 'git.log'],
]);
const ARTIFACT_PUBLISH_OPS = new Set(['file', 'markdown']);
const ARTIFACT_DECLARE_OPS = new Set(['chart', 'table', 'metrics', 'board']);
/** facade 全集识别（含不 lowering 的 phase/log/model/agent）。只认一层属性访问/裸标识符。 */
export function facadeCallAt(node) {
    if (!ts.isCallExpression(node))
        return undefined;
    const expr = node.expression;
    if (ts.isPropertyAccessExpression(expr)) {
        if (!ts.isIdentifier(expr.expression))
            return undefined;
        const owner = expr.expression.text;
        const member = expr.name.text;
        if (owner === 'world') {
            return member === 'run' ? { node, call: { family: 'world-run' } } : undefined;
        }
        if (owner === 'files' || owner === 'git') {
            const op = WORLD_READ_OPS.get(member);
            return op ? { node, call: { family: 'world-read', op } } : undefined;
        }
        if (owner === 'artifact') {
            if (ARTIFACT_PUBLISH_OPS.has(member)) {
                return { node, call: { family: 'artifact-publish', op: member } };
            }
            if (ARTIFACT_DECLARE_OPS.has(member)) {
                return { node, call: { family: 'artifact-declare', op: member } };
            }
            return undefined;
        }
        if (member === 'ask')
            return { node, call: { family: 'ask' } };
        return undefined;
    }
    if (ts.isIdentifier(expr)) {
        switch (expr.text) {
            case 'agent':
                return { node, call: { family: 'agent' } };
            case 'model':
                return { node, call: { family: 'model' } };
            case 'log':
                return { node, call: { family: 'log' } };
            case 'report':
                return { node, call: { family: 'report' } };
            case 'phase':
                return { node, call: { family: 'phase' } };
            case 'hole':
                return { node, call: { family: 'hole' } };
        }
    }
    return undefined;
}
/** lowering 子集：每个都会被重写成 `__host.<op>(siteId, …)` 并消耗一个调用点序号。 */
export function isLoweredCall(node) {
    const hit = facadeCallAt(node);
    if (!hit)
        return undefined;
    switch (hit.call.family) {
        case 'phase':
        case 'log':
        case 'model':
        case 'agent':
            return undefined;
        default:
            return hit;
    }
}
/** 编译期字符串字面量：StringLiteral 或无插值 TemplateLiteral，取其值。 */
export function stringLiteralText(expr) {
    if (expr !== undefined && ts.isStringLiteralLike(expr))
        return expr.text;
    return undefined;
}
/** hole 的 filled 形态识别：末位实参是否箭头/函数表达式（facade.d.ts hole 段三重载）。 */
export function isPlainFunctionExpression(expr) {
    return expr !== undefined && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));
}
/** 按三重载分流 hole 实参：(name) / (name, prompt) / (name, body) / (name, prompt, body)。 */
export function holeFormOf(call) {
    const args = call.arguments;
    if (args.length === 0 || args.length > 3)
        return undefined;
    const name = args[0];
    if (args.length === 1)
        return { filled: false, name };
    if (args.length === 2) {
        const second = args[1];
        return isPlainFunctionExpression(second)
            ? { filled: true, name, body: second }
            : { filled: false, name, prompt: second };
    }
    return { filled: true, name, prompt: args[1], body: args[2] };
}
