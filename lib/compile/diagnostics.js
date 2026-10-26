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
import { facadeCallAt, holeFormOf, stringLiteralText } from "./literals.js";
export const DIAGNOSTIC_CODES = {
    hole: 9012,
    literal: 9013,
    agentName: 9014,
};
function lineColumnOf(text, offset) {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            line += 1;
            column = 1;
        }
        else {
            column += 1;
        }
    }
    return { line, column };
}
function makeDiagnostic(sourceText, start, end, code, message) {
    const pos = lineColumnOf(sourceText, start);
    return { start, end, line: pos.line, column: pos.column, code, message };
}
/** 把包装坐标的诊断重定基到用户源码（offset = 包装前缀长度），并折算行列。 */
export function diagnosticsToUserSource(diags, source, offset) {
    return diags.map((d) => {
        const start = Math.max(0, d.start - offset);
        const end = Math.max(0, d.end - offset);
        const pos = lineColumnOf(source, start);
        return { ...d, start, end, line: pos.line, column: pos.column };
    });
}
/** TS 诊断（syntactic/semantic）→ WorkflowDiagnostic，同样重定基到用户源码。 */
export function tsToWorkflowDiagnostics(tsDiags, source, offset) {
    const out = [];
    for (const d of tsDiags) {
        if (d.file === undefined || d.start === undefined)
            continue;
        const start = Math.max(0, d.start - offset);
        const pos = lineColumnOf(source, start);
        out.push({
            start,
            end: Math.max(0, (d.start + (d.length ?? 0)) - offset),
            line: pos.line,
            column: pos.column,
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        });
    }
    return out;
}
/** 9012 hole 规则族。 */
export function holeDiagnostics(sf) {
    const out = [];
    const visit = (node) => {
        const hit = facadeCallAt(node);
        if (hit && hit.call.family === 'hole') {
            const form = holeFormOf(hit.node);
            const name = form === undefined ? undefined : stringLiteralText(form.name);
            if (form === undefined || name === undefined) {
                out.push(makeDiagnostic(sf.getFullText(), hit.node.getStart(sf), hit.node.getEnd(), DIAGNOSTIC_CODES.hole, 'hole() name must be a non-empty compile-time string literal: it is the identity the FillWorkflowHole UI matches against.'));
            }
            else if (name.length === 0) {
                out.push(makeDiagnostic(sf.getFullText(), hit.node.getStart(sf), hit.node.getEnd(), DIAGNOSTIC_CODES.hole, 'hole() name must not be empty.'));
            }
        }
        node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return out;
}
/** 9013 编译期字面量族 + 收集 world.run 命令字面量（安全模型：随确认展示）。 */
export function literalDiagnostics(sf) {
    const diagnostics = [];
    const worldCommands = [];
    const fail = (node, what, requirement) => {
        diagnostics.push(makeDiagnostic(sf.getFullText(), node.getStart(sf), node.getEnd(), DIAGNOSTIC_CODES.literal, `${what} must be ${requirement} (a string literal in the script source).`));
    };
    const visit = (node) => {
        const hit = facadeCallAt(node);
        if (hit) {
            const args = hit.node.arguments;
            switch (hit.call.family) {
                case 'phase': {
                    const name = stringLiteralText(args[0]);
                    if (name === undefined)
                        fail(hit.node, 'phase() name', 'a non-empty compile-time string literal');
                    else if (name.length === 0)
                        fail(hit.node, 'phase() name', 'non-empty');
                    break;
                }
                case 'world-run': {
                    const cmd = stringLiteralText(args[0]);
                    if (cmd === undefined)
                        fail(hit.node, 'world.run() cmd', 'a compile-time string literal shown to the user at confirmation');
                    else if (!worldCommands.includes(cmd))
                        worldCommands.push(cmd);
                    break;
                }
                case 'artifact-publish':
                case 'artifact-declare': {
                    const id = stringLiteralText(args[0]);
                    if (id === undefined)
                        fail(hit.node, `artifact.${hit.call.op}() id`, 'a compile-time string literal');
                    else if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
                        fail(hit.node, `artifact.${hit.call.op}() id`, 'non-empty, at most 64 characters of [A-Za-z0-9_.-]');
                    }
                    break;
                }
                case 'report': {
                    if (args.length > 1 && stringLiteralText(args[1]) === undefined) {
                        fail(hit.node, 'report() artifactId', 'a compile-time string literal naming an artifact preset');
                    }
                    break;
                }
                case 'model': {
                    if (stringLiteralText(args[0]) === undefined) {
                        fail(hit.node, 'model() id', 'a string literal ("modelId" or "providerId/modelId", optional "$level")');
                    }
                    break;
                }
                default:
                    break;
            }
        }
        node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return { diagnostics, worldCommands };
}
/** 9014 agent 名字字面量重复；computed 名字放行（运行期双层查重）。 */
export function agentNameDiagnostics(sf) {
    const out = [];
    const seen = new Map();
    const visit = (node) => {
        const hit = facadeCallAt(node);
        if (hit && hit.call.family === 'agent') {
            const name = stringLiteralText(hit.node.arguments[0]);
            if (name !== undefined && name.length > 0) {
                const first = seen.get(name);
                if (first === undefined) {
                    seen.set(name, hit.node.getStart(sf));
                }
                else {
                    out.push(makeDiagnostic(sf.getFullText(), hit.node.getStart(sf), hit.node.getEnd(), DIAGNOSTIC_CODES.agentName, `a subagent named "${name}" already exists in this run (first at offset ${first}): names are identities, and a literal duplicate is a compile error.`));
                }
            }
        }
        node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return out;
}
