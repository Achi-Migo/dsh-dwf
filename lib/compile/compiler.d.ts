/**
 * 编译器本体（DESIGN §3.2 / mechanism-map §2.3）：`compileWorkflow(source, facade)`
 * 用 TS 5.9.3 的 `createProgram` 把 facade.d.ts 全文与用户脚本（包在 async 函数体内
 * ——declare/export/import 天然非法）合成一个 Program，跑语义诊断 + 自定义诊断三族
 * （9012 hole 规则 / 9013 编译期字面量 / 9014 agent 名字字面量重复），通过后做
 * lowering。诊断非空 → 引擎 start 时同步折 SCRIPT_PARSE（DESIGN §3.5 步骤 2）。
 *
 * 选项：strict: true、noUncheckedIndexedAccess: false（mechanism-map §2.2——与
 * guest 侧编译一致）；TS pin 5.9.3（DESIGN §7.1 前置：7.x native preview 不暴露
 * createProgram 等库 API）。
 *
 * Program 的内存宿主：facade 与用户文件驻内存，lib 文件从依赖树内的 typescript
 * 包（node_modules/typescript/lib）按需读盘；`<reference lib>` 经
 * getDefaultLibLocation 解析到同一目录。
 */
import { type WorkflowDiagnostic } from './diagnostics.ts';
export interface CompiledWorkflow {
    /** lowering 后的脚本体（__host.* 前导 + 用户逻辑）；诊断非空时为原样用户源码。 */
    body: string;
    /** 编译期抽出的 phase 名（确认对话框用；同名 marker 已合并）。 */
    phaseNames: string[];
    /** world.run 命令名字面量全集（安全模型：随确认展示）。 */
    worldCommands: string[];
    /** 空数组 = 通过。 */
    diagnostics: WorkflowDiagnostic[];
}
export declare function compileWorkflow(source: string, facade: string): CompiledWorkflow;
