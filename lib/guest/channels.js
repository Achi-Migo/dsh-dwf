/**
 * Channel/future guest primitives, transplanted from the ZCode guest template
 * (assets/guest-channel-future.js): unbounded FIFO channels with waiter queues
 * and compaction; send never waits; close is idempotent; a receiver parked on
 * an open empty channel counts toward deadlock detection.
 */
export const CHANNEL_PRIMITIVES_SOURCE = String.raw `
// —— 流水线原语：channel / future（guest-template-00 移植）——
var __channels = [];
var __parkedReceivers = 0;
var __CHANNEL_COMPACT_MIN = 1024;
var __END = Object.freeze({ value: undefined, done: true });

function __channel(name) {
  var label = name === undefined || name === null ? "channel #" + (__channels.length + 1) : String(name);
  var state = { label: label, items: [], head: 0, waiters: [], waitHead: 0, closed: false };
  __channels.push(state);
  function compact() {
    if (state.head >= __CHANNEL_COMPACT_MIN && state.head * 2 >= state.items.length) {
      state.items = state.items.slice(state.head);
      state.head = 0;
    }
    if (state.waitHead >= __CHANNEL_COMPACT_MIN && state.waitHead * 2 >= state.waiters.length) {
      state.waiters = state.waiters.slice(state.waitHead);
      state.waitHead = 0;
    }
  }
  function takeWaiter() {
    if (state.waitHead >= state.waiters.length) return undefined;
    var waiter = state.waiters[state.waitHead];
    state.waiters[state.waitHead] = undefined;
    state.waitHead += 1;
    __parkedReceivers -= 1;
    compact();
    return waiter;
  }
  function next() {
    if (state.head < state.items.length) {
      var item = state.items[state.head];
      state.items[state.head] = undefined;
      state.head += 1;
      compact();
      return Promise.resolve({ value: item, done: false });
    }
    if (state.closed) return Promise.resolve(__END);
    return new Promise(function (resolve) {
      state.waiters.push({ resolve: resolve });
      __parkedReceivers += 1;
    });
  }
  var ch = {
    send: function (item) {
      if (state.closed) throw Object.assign(new Error('channel "' + label + '" is closed'), { name: 'ChannelClosed', code: 'ChannelClosed' });
      var waiter = takeWaiter();
      if (waiter !== undefined) waiter.resolve({ value: item, done: false });
      else state.items.push(item);
    },
    close: function () {
      if (state.closed) return;
      state.closed = true;
      for (;;) {
        var waiter = takeWaiter();
        if (waiter === undefined) break;
        waiter.resolve(__END);
      }
    },
    // for-await 中途 break/抛错的收尾路径（拍板表#3，原件 :69-71）：return() 让
    // 「迭代器已结束」落到接收者一侧——再次 next() 得 __END，不再停在空通道上等死锁。
    [Symbol.asyncIterator]: function () {
      var iterator = {
        next: next,
        return: function () { return Promise.resolve(__END); },
      };
      iterator[Symbol.asyncIterator] = function () { return iterator; };
      return iterator;
    },
  };
  return ch;
}

function __future(body) {
  return Promise.resolve().then(body);
}

// —— 裸名暴露（D2 修复）：facade.d.ts:285/291 以全局声明 channel()/future()，
// lower.ts 对二者不做改写（stay direct，见 lower.ts 头注释），guest realm 此前只有
// __channel/__future——用户脚本编译通过、运行必 ReferenceError（integration.test.mjs
// 文件头「新发现一」）。与 prelude.ts 的 model/agent/phase 同约定：裸名绑在程序
// 函数体作用域，脚本不得重声明占用 facade 保留面。用别名（非包装函数）保证
// channel === __channel 的同一函数身份（channels.test.mjs 验收第 4 条）。
var channel = __channel;
var future = __future;
`;
