#!/usr/bin/env node
/**
 * 真实类型链接自检（p0-real-machine 步骤②后取代旧桩自检；文件名保留使命令连续）。
 *
 * 背景：stubs/dsh.d.ts 已从 tsconfig include 摘除，src 的 import specifier 直接
 * 解析到 node_modules/@deepseek-ai/<pkg> 的 junction——目标为真机宿主
 * @deepseek-ai/*@0.2.1-rc.3（npx 缓存 a3a60f53b42a237b）里的真实包与 .d.ts。
 *
 * 防「假通过」三断言（旧桩自检的等价物）：
 *   ① 链接在位：src import 的每个 @deepseek-ai/* specifier 都能在
 *      node_modules/@deepseek-ai/<pkg>/package.json 解析出同名包（junction 断链在此暴露）；
 *   ② 桩确已摘除：主 tsconfig include 不含 stubs/dsh.d.ts（回潮即 FAIL）；
 *   ③ 类型门：tsc --noEmit -p tsconfig.json 退出码 0（真实形状判据，与
 *      `npm run typecheck` 同一命令）。
 *
 * 用法：node test/stub-check.mjs（任意 CWD 均可，路径自脚本位置推导）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = path.join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const mainTsconfig = path.join(pkgRoot, 'tsconfig.json')
const srcDir = path.join(pkgRoot, 'src')

/** src 全体 .ts 里出现过的 @deepseek-ai/* import specifier（含子路径，取包名）。 */
function importedScopes() {
  const specifiers = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8')
        for (const m of src.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) {
          const spec = m[1]
          // 子路径 specifier（如 @deepseek-ai/dsh-session/types）折回包名
          const parts = spec.split('/')
          specifiers.add(parts.length > 2 ? `${parts[0]}/${parts[1]}` : spec)
        }
      }
    }
  }
  walk(srcDir)
  return [...specifiers].sort()
}

// node:fs 的 readdir 需要 readdirSync；为保持无顶层 require，此处薄封装。

let failures = 0

// ---------- 断言①：junction 链接在位 ----------
function assertLinks() {
  console.log('[断言①] 真实包链接：src 引用的每个 @deepseek-ai/* 包可解析')
  const scopes = importedScopes()
  console.log(`        specifier 清单（${scopes.length} 个）: ${scopes.join(', ')}`)
  let ok = true
  for (const scope of scopes) {
    const manifest = path.join(pkgRoot, 'node_modules', scope, 'package.json')
    if (!existsSync(manifest)) {
      console.log(`        FAIL：node_modules/${scope}/package.json 不存在（junction 断链或漏建）`)
      ok = false
      continue
    }
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name
    if (name !== scope) {
      console.log(`        FAIL：node_modules/${scope} 解析出的包名是 ${name}`)
      ok = false
    }
  }
  if (ok) console.log(`        ✅ ${scopes.length} 个包全部解析到同名真实包`)
  return ok
}

// ---------- 断言②：桩已摘除 ----------
function assertStubRetired() {
  console.log('\n[断言②] 桩摘除：主 tsconfig include 不含 stubs/dsh.d.ts')
  const tsconfig = readFileSync(mainTsconfig, 'utf8')
  const includes = JSON.parse(tsconfig).include ?? []
  const stubbed = includes.some((entry) => entry.includes('stubs/'))
  if (stubbed) {
    console.log(`        FAIL：include 仍含桩：${JSON.stringify(includes)}`)
    return false
  }
  console.log(`        ✅ include = ${JSON.stringify(includes)}，无桩`)
  return true
}

// ---------- 断言③：真实形状类型门 ----------
function assertTypeGate() {
  console.log('\n[断言③] 类型门：tsc --noEmit -p tsconfig.json（真实 .d.ts，判据不变）')
  const rel = path.relative(pkgRoot, tscBin)
  const r = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', mainTsconfig], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  console.log(`        命令: node ${rel.split(path.sep).join('/')} --noEmit -p tsconfig.json`)
  console.log(`        退出码: ${r.status}`)
  if (r.status !== 0) {
    const lines = out.split(/\r?\n/).filter((l) => /: error TS\d+:/.test(l))
    console.log(`        FAIL：${lines.length} 条错误：`)
    for (const line of lines.slice(0, 10)) console.log(`          ${line}`)
    return false
  }
  console.log('        ✅ 0 错误')
  return true
}

if (assertLinks()) { /* counted below */ } else failures += 1
if (assertStubRetired()) { /* counted below */ } else failures += 1
if (assertTypeGate()) { /* counted below */ } else failures += 1

console.log(`\n链接自检结果：${failures === 0 ? '3/3 通过，全绿' : `存在失败（${failures} 项）`}`)
process.exit(failures === 0 ? 0 : 1)
