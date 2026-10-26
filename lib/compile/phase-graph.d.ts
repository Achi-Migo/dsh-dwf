/**
 * phase 图编译期抽取（mechanism-map §2.5；DESIGN §3.2 MVP 降级：phase 图只用于
 * 确认展示，画不了图就列表展示）。
 *
 * marker 覆盖其后所在 block（词法盖章）——MVP 不重建覆盖区间，claims 只带调用点
 * span 供将来画图；projectPhaseGraph 把同名 marker 合成一个 phase（facade.d.ts
 * phase 段：「two markers with the same name are one phase」），保持首现顺序。
 */
import ts from 'typescript';
export interface PhaseClaim {
    /** phase 名（字面量值）。 */
    name: string;
    /** 调用点 span（包装文件内偏移；词法盖章的原始凭据）。 */
    start: number;
    end: number;
}
export interface PhaseNode {
    name: string;
    /** 首现顺序（0 起），确认对话框按它列表展示。 */
    ordinal: number;
}
/** 收集 phase(字面量) 调用点；非字面量名字不进图（由 literalDiagnostics 报 9013）。 */
export declare function collectPhaseClaims(sf: ts.SourceFile): PhaseClaim[];
/** 同名合并、首现排序的 MVP 投影（列表展示面）。 */
export declare function projectPhaseGraph(claims: readonly PhaseClaim[]): PhaseNode[];
