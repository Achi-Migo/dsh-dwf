/**
 * lowering：facade 效应调用点 → `__host.<op>(siteId, …)`（mechanism-map §2.6、
 * DESIGN §3.2）。重写以「外科手术式文本替换」进行——调用点 span 之外的用户文本
 * （缩进、注释、格式）逐字保留。
 *
 * 宿主对象桥：prelude（src/guest/prelude.ts）暴露的是裸 shim 函数（__ask/
 * __worldRun/…），而 DESIGN §3.2 与原版 guest-prelude.js 的调用形是 `__host.*`；
 * lower 在产物头部生成一行 `var __host = { ask: __ask, … }` 把两者接上。分派按
 * prelude shim 的真实签名（DESIGN §3.2 的三参 `__host.ask(siteId, instr, schema)`
 * 缺 receiver，落不了 prelude 的 `__ask(receiver, siteId, instructions, schema)`
 * ——以 prelude 契约为准，已在任务结果中回报告）。
 *
 * siteId：全局调用点序号（「调用点序号」，源码序），每个 isLoweredCall 消耗一个
 * ——hole 也占号（保持与 schema.ts 的序号口径完全一致），但 emit 用内容寻址
 * `hole#xxxxxxxx`（FNV-1a(trim 后调用点源文本)，util/fnv1a.ts，跨修订稳定）。
 * 其余家族 emit `<family>#<ordinal>`（util/fnv1a.ts callSiteId）。
 *
 * 序号口径与 schema.ts 逐点一致：同一份包装 SourceFile、前序遍历、访问到调用点
 * 即计号（先于其参数内的嵌套调用点）。
 *
 * 不参与 lowering（guest 前导直供）：model()（纯数据工厂，无宿主往返，facade
 * 「checked at launch」）、agent()/channel()/future()/phase()/log()/args。
 */
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
/** 用户体包装：包进 async 函数体后 declare/export/import 天然非法（mechanism-map §2.2）。 */
export declare const WRAP_PREFIX = "async function __workflow() {\n";
export declare const WRAP_SUFFIX = "\n}\n";
export declare function wrapUserSource(source: string): string;
/** 包装前缀长度：诊断把包装坐标重定基回用户源码时用（compiler.ts 引用）。 */
export declare const WRAP_PREFIX_LENGTH: number;
/**
 * lowering 主入口（DESIGN §3.2 签名）。phaseNames 为契约签名保留：phase() 保持
 * guest 直调（prelude 直发 phase-entered 事件），不参与重写；确认展示的清单由
 * compileWorkflow 返回值承载。
 */
export declare function lower(source: string, phaseNames: readonly string[], askSchemas: Map<number, ObjectJsonSchema>): string;
