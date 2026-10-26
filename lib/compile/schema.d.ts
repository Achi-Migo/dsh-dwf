/**
 * ask<T> 的 schema 下沉（gap-audit §4 B6：prelude `__submit(site, instructions,
 * schema)` 已留好参数位，这里把 T 经 checker 查询后转成 ObjectJsonSchema 字面量，
 * 由 lower 以第三/四参嵌入 `__host.ask(...)`）。
 *
 * ObjectJsonSchema 取型自 T1 桩 dsh-tools specifier（PLAN 拍板表#15：contract-v2
 * §6.2/§6.6 明示定义体不在镜像内，属外部假设——形状为
 * `{ type: 'object', properties, required?, [key: string]: unknown }`，
 * 接入真实 dsh-tools 时校）。
 *
 * 序号口径：与 lower.ts 逐点一致——同一份包装 SourceFile，前序遍历，isLoweredCall
 * 的每个调用点消耗一个全局序号；ask 站点以「当时的序号」为键。map 键=序号、
 * 值=schema（DESIGN §3.2 签名 Map<number, ObjectJsonSchema>）。
 *
 * 表示范围：interface/type literal（含可选属性——required 只收必填）、基本类型、
 * 数组/元组、字面量与它们的联合（同基数字面量并成 enum，否则 anyOf）、null/
 * undefined（只在联合内出现，作为分支被丢弃——可选性由 required 表达）、
 * any/unknown → 通配 {}。函数型属性不进 properties（JSON 传不了函数）。顶层
 * T 不是对象（含缺省 =string，或显式 ask<number> 这类面板不支持的写法）时不入表
 * ——facade 契约里 T 就是「plain interface declaration」，此时答案按子代理最终
 * 回复文本回传。
 */
import ts from 'typescript';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
export declare function askSchemas(checker: ts.TypeChecker, sf: ts.SourceFile): Map<number, ObjectJsonSchema>;
