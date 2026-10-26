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

import ts from 'typescript'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { isLoweredCall } from './literals.ts'

export function askSchemas(checker: ts.TypeChecker, sf: ts.SourceFile): Map<number, ObjectJsonSchema> {
  const schemas = new Map<number, ObjectJsonSchema>()
  let ordinal = 0
  const visit = (node: ts.Node): void => {
    const hit = isLoweredCall(node)
    if (hit) {
      ordinal += 1
      if (hit.call.family === 'ask' && hit.node.typeArguments !== undefined && hit.node.typeArguments.length > 0) {
        const t = checker.getTypeAtLocation(hit.node.typeArguments[0])
        const schema = objectSchemaOf(checker, t, hit.node.typeArguments[0])
        if (schema !== undefined) schemas.set(ordinal, schema)
      }
    }
    node.forEachChild(visit)
  }
  sf.forEachChild(visit)
  return schemas
}

/** T → JSON Schema 值；返回 undefined = 该位置不设约束或整体不入表。 */
function schemaOf(checker: ts.TypeChecker, type: ts.Type): JsonSchemaNode | undefined {
  // 联合：同基数字面量并成 enum；其余 oneOf（undefined 分支丢弃）。
  if (type.isUnion()) {
    const branches: JsonSchemaNode[] = []
    const literalEnums = new Map<'string' | 'number' | 'boolean', (string | number | boolean)[]>()
    for (const part of type.types) {
      if (part.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue
      if (part.getFlags() & ts.TypeFlags.Null) {
        branches.push({ type: 'null' })
        continue
      }
      if (part.getFlags() & ts.TypeFlags.StringLiteral) {
        const value = (part as ts.StringLiteralType).value
        pushEnum(literalEnums, 'string', value)
        continue
      }
      if (part.getFlags() & ts.TypeFlags.NumberLiteral) {
        const value = (part as ts.NumberLiteralType).value
        pushEnum(literalEnums, 'number', value)
        continue
      }
      if (part.getFlags() & ts.TypeFlags.BooleanLiteral) {
        const intrinsic = checker.typeToString(part)
        pushEnum(literalEnums, 'boolean', intrinsic === 'true')
        continue
      }
      const inner = schemaOf(checker, part)
      if (inner !== undefined) branches.push(inner)
    }
    for (const [kind, values] of literalEnums) branches.push({ type: kind, enum: values })
    if (branches.length === 0) return undefined
    if (branches.length === 1) return branches[0]
    // The enforced subset carries exact-one unions as `oneOf` (≥2 branches);
    // `anyOf` is outside the subset and rejects at runtime.
    return { oneOf: branches } as JsonSchemaNode
  }
  const flags = type.getFlags()
  if (flags & ts.TypeFlags.String) return { type: 'string' }
  if (flags & ts.TypeFlags.Number) return { type: 'number' }
  if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
  if (flags & ts.TypeFlags.Null) return { type: 'null' }
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {}
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return undefined
  // 函数/构造签名：JSON 传不了，通配放行。
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return {}
  // 数组 / 元组：items 取数字下标元素类型（元组为成员联合）。
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    return { type: 'array', items: index === undefined ? {} : schemaOf(checker, index) ?? {} }
  }
  // 对象面：interface/type literal。无属性也无索引签名 → 通配 {}。
  return objectSchemaOf(checker, type)
}

/** 顶层入口：只有对象形（有属性或索引签名）才产 ObjectJsonSchema，否则 undefined。 */
function objectSchemaOf(checker: ts.TypeChecker, type: ts.Type, at?: ts.Node): ObjectJsonSchema | undefined {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const prop of checker.getPropertiesOfType(type)) {
    const propType = at !== undefined ? checker.getTypeOfSymbolAtLocation(prop, at) : checker.getTypeOfSymbol(prop)
    const schema = schemaOf(checker, propType)
    if (propType.getCallSignatures().length > 0 || propType.getConstructSignatures().length > 0) continue
    properties[prop.getName()] = schema ?? {}
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
    if (!optional && schema !== undefined) required.push(prop.getName())
  }
  const indexInfos = checker.getIndexInfosOfType(type)
  const stringIndex = indexInfos.find((info) => info.keyType.getFlags() & ts.TypeFlags.String)
  // Real JsonSchemaNode subset: additionalProperties is BOOLEAN (open/closed),
  // never a nested schema — a string index signature means "open with any
  // JSON value", i.e. true; the enforced subset rejects the old schema-valued
  // form at runtime (assertSupportedJsonSchema).
  const additional = stringIndex === undefined ? undefined : true
  if (Object.keys(properties).length === 0 && additional === undefined) return undefined
  const schema: ObjectJsonSchema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  if (additional !== undefined) schema.additionalProperties = additional
  return schema
}

function pushEnum(map: Map<'string' | 'number' | 'boolean', (string | number | boolean)[]>, kind: 'string' | 'number' | 'boolean', value: string | number | boolean): void {
  const bucket = map.get(kind)
  if (bucket === undefined) map.set(kind, [value])
  else if (!bucket.some((v) => v === value)) bucket.push(value)
}
