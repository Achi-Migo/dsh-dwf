/**
 * phase 图编译期抽取（mechanism-map §2.5；DESIGN §3.2 MVP 降级：phase 图只用于
 * 确认展示，画不了图就列表展示）。
 *
 * marker 覆盖其后所在 block（词法盖章）——MVP 不重建覆盖区间，claims 只带调用点
 * span 供将来画图；projectPhaseGraph 把同名 marker 合成一个 phase（facade.d.ts
 * phase 段：「two markers with the same name are one phase」），保持首现顺序。
 */
import { facadeCallAt, stringLiteralText } from "./literals.js";
/** 收集 phase(字面量) 调用点；非字面量名字不进图（由 literalDiagnostics 报 9013）。 */
export function collectPhaseClaims(sf) {
    const claims = [];
    const visit = (node) => {
        const hit = facadeCallAt(node);
        if (hit && hit.call.family === 'phase') {
            const name = stringLiteralText(hit.node.arguments[0]);
            if (name !== undefined && name.length > 0) {
                claims.push({ name, start: hit.node.getStart(sf), end: hit.node.getEnd() });
            }
        }
        node.forEachChild(visit);
    };
    sf.forEachChild(visit);
    return claims;
}
/** 同名合并、首现排序的 MVP 投影（列表展示面）。 */
export function projectPhaseGraph(claims) {
    const nodes = [];
    const indexOf = new Map();
    for (const claim of claims) {
        if (indexOf.has(claim.name))
            continue;
        indexOf.set(claim.name, nodes.length);
        nodes.push({ name: claim.name, ordinal: nodes.length });
    }
    return nodes;
}
