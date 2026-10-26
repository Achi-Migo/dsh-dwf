/**
 * @deepseek-ai/schemastery 的最小值替身（T6 扩展）：z.object/string/natural/boolean
 * + .default 链。只覆盖 dsh-dwf 的 Config schema 用面（engine.ts static Config）；
 * 校验行为不求与真包一致（R6），default 语义保持：undefined → 默认值。
 */

function chain(parse) {
  const schema = value => parse(value)
  schema.default = fallback => chain(value => (value === undefined ? fallback : parse(value)))
  schema.min = () => schema
  return schema
}

function z(schema) {
  return chain(value => {
    if (value === undefined) throw new TypeError('schemastery stub: value is required')
    return schema(value)
  })
}

z.object = shape =>
  chain(value => {
    const source = value !== null && typeof value === 'object' ? value : {}
    const out = {}
    for (const [key, member] of Object.entries(shape)) out[key] = member(source[key])
    return out
  })
z.string = () => chain(value => {
  if (value !== undefined && typeof value !== 'string') throw new TypeError('expected string')
  return value
})
z.boolean = () => chain(value => {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError('expected boolean')
  return value
})
z.natural = () => chain(value => {
  if (value === undefined) return value
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('expected natural number')
  return n
})

export { z }
export default z
