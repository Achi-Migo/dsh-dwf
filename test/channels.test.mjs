/**
 * D2 修复回归（integration.test.mjs 文件头「新发现一」）：facade.d.ts:285/291 以
 * 全局声明 channel()/future()，lower.ts 不改写二者（stay direct，见 lower.ts 头注释
 * 「不参与 lowering（guest 前导直供）」），guest realm 此前只有 __channel/__future——
 * 用户脚本编译通过、运行必 ReferenceError。修复：CHANNEL_PRIMITIVES_SOURCE 末尾
 * `var channel = __channel; var future = __future;`（与 prelude.ts 的 model/agent/phase
 * 裸名同约定）。
 *
 * 作用域形态对齐真装配（run.ts:518-522；integration.test.mjs 头注释同款仿真）：
 * 原语源 + 测试体包进同一个 async IIFE——裸名与用户体同层闭包可见。测试体按纯 JS
 * 书写（真 PTC 边界剥型，vm 直跑不剥）。
 *
 * 命令：node --import ./test/runtime-stubs.mjs --test test/channels.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { CHANNEL_PRIMITIVES_SOURCE } from '../src/guest/channels.ts'

/** 原语源 + guest 测试体一体函数体（async IIFE，顶层 await/return 合法）。
 * 返回值经 JSON 往返物化为宿主 plain 对象（integration.test.mjs 头注释「跨 realm
 * 纪律」：vm 内建原型与宿主不同，直接 assert 会被 deepEqual 的原型判等拒收）。 */
async function guestRun(body) {
  const program = `return (async () => {\n${CHANNEL_PRIMITIVES_SOURCE}\n${body}\n})()`
  const fn = vm.compileFunction(program, [], { parsingContext: vm.createContext({}) })
  return JSON.parse(JSON.stringify(await fn()))
}

test('裸名 channel() round-trip：send/接收/close，close 幂等，close 后 send 抛 ChannelClosed', { timeout: 5000 }, async () => {
  const out = await guestRun(`
    const out = { got: [] }
    const ch = channel('pipes')
    out.shape = typeof ch.send + '/' + typeof ch.close + '/' + typeof ch[Symbol.asyncIterator]
    ch.send('x')
    ch.send('y')
    try {
      for await (const v of ch) {
        out.got.push(v)
        if (v === 'y') break
      }
      out.breakClean = true
    } catch (e) {
      out.breakClean = 'threw: ' + e.message
    }
    out.openAfterBreak = (() => { ch.send('z'); return true })()
    ch.close()
    out.closeIdempotent = (() => { ch.close(); return true })()
    out.sendAfterClose = (() => {
      try { ch.send('w'); return 'ok' } catch (e) { return e.code || e.name }
    })()
    const it = ch[Symbol.asyncIterator]()
    out.residual = (await it.next()).value
    const end = await it.next()
    out.residualEnd = end.done === true && end.value === undefined
    return out
  `)
  assert.equal(out.shape, 'function/function/function')
  assert.deepEqual(out.got, ['x', 'y'])
  assert.equal(out.breakClean, true)
  assert.equal(out.openAfterBreak, true, 'break 只收尾迭代器，通道仍开、send 仍可入队')
  assert.equal(out.closeIdempotent, true)
  assert.equal(out.sendAfterClose, 'ChannelClosed')
  assert.equal(out.residual, 'z', 'close 后缓冲残留值仍可取尽')
  assert.equal(out.residualEnd, true)
})

test('裸名 channel() 的 for-await 中途 break 经 iterator.return() 收尾（spy 实证恰好调一次）', { timeout: 5000 }, async () => {
  const out = await guestRun(`
    const out = { got: [] }
    const ch = channel('spy')
    ch.send(1)
    ch.send(2)
    let returnCalled = 0
    const origFactory = ch[Symbol.asyncIterator]
    ch[Symbol.asyncIterator] = function () {
      const it = origFactory.call(ch)
      const rawReturn = it.return
      it.return = function () { returnCalled += 1; return rawReturn.call(it) }
      return it
    }
    for await (const v of ch) {
      out.got.push(v)
      if (v === 1) break
    }
    out.returnCalled = returnCalled
    out.iteratorHasReturn = typeof origFactory.call(ch).return === 'function'
    return out
  `)
  assert.deepEqual(out.got, [1])
  assert.equal(out.returnCalled, 1, 'for-await 中途 break 应触发 iterator.return() 收尾恰好一次')
  assert.equal(out.iteratorHasReturn, true)
})

test('裸名 future()：同步抛转拒绝，正常体照常结算', { timeout: 5000 }, async () => {
  const out = await guestRun(`
    const out = {}
    out.happy = await future(function () { return 42 })
    try {
      await future(function () { throw new Error('boom-sync') })
      out.syncThrow = 'resolved?!'
    } catch (e) {
      out.syncThrow = e.message
    }
    return out
  `)
  assert.equal(out.happy, 42)
  assert.equal(out.syncThrow, 'boom-sync', 'future 体同步抛错应折成拒绝而非逃逸')
})

test('裸名 channel/future 与 __channel/__future 为同一函数', { timeout: 5000 }, async () => {
  const out = await guestRun(`
    const out = {}
    out.bareNames = typeof channel + '/' + typeof future
    out.sameChannel = channel === __channel
    out.sameFuture = future === __future
    out.distinctChannels = channel('a') !== channel('b')
    return out
  `)
  assert.equal(out.bareNames, 'function/function')
  assert.equal(out.sameChannel, true)
  assert.equal(out.sameFuture, true)
  assert.equal(out.distinctChannels, true)
})
