/**
 * The guest program prelude: facade bridge + stall detection, transplanted
 * from the ZCode guest templates (assets/guest-prelude.js, guest-channel-future.js).
 * The compile layer rewrites effectful facade calls to the `__*` shims below;
 * `agent`/`model`/`channel`/`future`/`phase`/`log`/`hole` stay direct.
 *
 * Host bindings (PTC binding global `dwfHost`):
 *   begin()                   → WorkerInit (review B7: meta/args/limits enter here)
 *   request(msg)              → Promise<Json>; FIFO per arrival; response resolves/rejects
 *   event(msg)                → void; fire-and-forget, shared FIFO with requests
 *   complete(result)          → void; idempotent settlement
 * Stall detection is guest-owned (setImmediate is banned): after the last
 * in-flight request settles, a queued microtask cascade re-runs
 * __checkStalled. The false-positive guard for normal completion is the
 * __settled flag — __start flips it when body() resolves with __pending===0
 * and no parked channel receivers (the await-last-then-return shape). Pending
 * requests or parked receivers leave settled false so stall checks still fire.
 */
export const GUEST_PRELUDE_SOURCE = String.raw `
"use strict";
// ============ dsh-dwf guest prelude ============
var __settled = false;
var __pending = 0;
var __nextLocal = 0;
var __agentNames = new Set();
var __agentsStarted = 0;

function __emitEvent(type, args) { dwfHost.event({ type: type, args: args }); }

function __queueStallCheck() {
  // guest 自查（宿主无反向通道）：连排微任务让排队的脚本续体先跑；
  // 之后仍无在飞请求且未结算 = 永不推进。
	  // 误报守卫是 __settled 置位（D1）：body() resolve 且 pending===0 时
	  // __start 置位，__checkStalled 直接短路——await last; return 收尾链
	  // 慢于本级联也不会误报 ScriptStalled（真机首例：两 ask completed 后
	  // run 以 Stalled 结算）。pending>0 时不置位，让最后一条请求的自查仍能
	  // 收尾（smoke 2 fire-and-forget）。8 级级联保留作纵深防御。
	  var ticks = 8;
  function step() {
    if (--ticks > 0) { Promise.resolve().then(step); return; }
    __checkStalled();
  }
  Promise.resolve().then(step);
}

function __request(siteId, op, args) {
  if (__settled) throw new Error("the run has already settled");
  __pending += 1;
  var msg = { siteId: siteId, op: op, args: args };
  return Promise.resolve(dwfHost.request(msg)).then(
    function (value) { __pending -= 1; if (__pending === 0) __queueStallCheck(); return value; },
    function (error) { __pending -= 1; if (__pending === 0) __queueStallCheck(); throw error; }
  );
}

function __complete(ok, value, error) {
  if (__settled) return;
  __settled = true;
  dwfHost.complete({ ok: ok, value: value === undefined ? null : value, error: error === undefined ? undefined : { message: String(error && error.message ? error.message : error), name: error && error.name ? String(error.name) : undefined } });
}

// —— 停滞检测（guest-template-01 移植）：无在飞请求 + 有挂起接收者 = 永不推进 ——
globalThis.__checkStalled = function () {
  if (__settled || __pending > 0) return false;  var waiting = [];
  for (var i = 0; i < __channels.length; i++) {
    var ch = __channels[i];
    var count = ch.waiters.length - ch.waitHead;
    if (count > 0) waiting.push(count + " on \"" + ch.label + "\"");
  }
  var err;
  if (waiting.length > 0) {
    err = new Error("Deadlock: " + __parkedReceivers + " receiver(s) waiting (" + waiting.join(", ") + ") with no request in flight, so nothing can ever send again. Close each channel from the stage that produces into it (ch.close() in a finally) once its producers are done.");
    err.name = "ChannelDeadlock";
    err.code = "ChannelDeadlock";
  } else {
    err = new Error("Stalled: the script is suspended with no request in flight and no channel receiver waiting, so nothing can ever resolve what it awaits (a promise that is never settled).");
    err.name = "ScriptStalled";
    err.code = "ScriptStalled";
  }
  __complete(false, undefined, err);
  return true;
};
globalThis.__checkStalled.ifReachable = true;

// ============ facade：模型声明 ============
function model(id) {
  if (typeof id !== "string" || id.length === 0) throw new Error("model() requires a non-empty string literal");
  // 键名 modelRef（拍板表#5）：facade.d.ts:5 声明的唯一事实源。
  return { modelRef: String(id) };
}

// ============ facade：子代理 ============
function personaOf(p) {
  if (p === undefined) return {};
  if (typeof p === "string") return { system: p };
  if (p !== null && typeof p === "object") return { system: typeof p.system === "string" ? p.system : undefined, model: p.model && p.model.modelRef ? String(p.model.modelRef) : (typeof p.model === "string" ? p.model : undefined) };
  throw new Error("persona must be a string or {system, model}");
}

function agent(name, persona) {
  var p = personaOf(persona);
  var named = name !== undefined && name !== null && String(name).length > 0;
  if (named) {
    var key = String(name);
    if (__agentNames.has(key)) throw new Error('duplicate subagent name "' + key + '": names are identities within a run; give loop-created agents computed names');
    __agentNames.add(key);
  }
  var label = named ? String(name) : "subagent " + (++__nextLocal);
  var siteId = "actor#" + (++__agentsStarted);
  var tail = Promise.resolve();
  var actor = {
    __label: label,
    __siteId: siteId,
    ask: function (instructions) {
      throw new Error("ask() must be called with an explicit type argument or plain instructions (compiled call form)");
    },
    __submit: function (site, instructions, schema) {
      var run = function () {
        return __request(site, "ask", { actor: label, actorSiteId: siteId, instructions: String(instructions), schema: schema === undefined ? null : schema });
      };
      tail = tail.then(run, run); // 同 actor FIFO：先到的 ask 先结算
      return tail;
    },
  };
  // named 标志（#7）：宿主查重只对显式名——自动 label（named:false）可与显式名
  // 撞形而不误报 duplicate；缺省（无字段）按显式处理，旧事件保形。
  __emitEvent("declare-actor", { siteId: siteId, label: label, persona: p, named: named });
  return actor;
}

// ============ facade：世界（lowered 调用；siteId 由编译层打点） ============
function __worldRun(siteId, cmd, args, timeoutMs) {
  return __request(siteId, "world-run", { cmd: String(cmd), args: args === undefined ? [] : args, timeoutMs: timeoutMs === undefined ? null : timeoutMs });
}
function __worldRead(siteId, op, args) {
  return __request(siteId, "world-read", { op: String(op), args: args === undefined ? [] : args });
}
function __ask(receiver, siteId, instructions, schema) {
  if (receiver === null || receiver === undefined || typeof receiver.__submit !== "function") throw new Error("ask() must be called on an agent() handle");
  return receiver.__submit(siteId, instructions, schema);
}

// ============ facade：hole（编译层三重载分流） ============
function __hole(siteId, name, prompt) {
  return __request(siteId, "hole", { name: String(name), prompt: prompt === undefined ? "" : String(prompt) });
}
function __holeFilled(siteId, body) {
  // #8：不按 siteId 缓存 body——facade 语义是「body 在 hole 的位置原地运行」，
  // 是代码不是 memo；缓存闭包会让循环第二 iteration 绑定首次的 let 绑定值。
  return body();
}

// ============ facade：进度与产物 ============
function phase(name) { __emitEvent("phase-entered", { name: String(name) }); }
function log(message) { __emitEvent("log", { message: String(message) }); }
function __report(siteId, item, artifactId) {
  // report 是 request（评审 B8）：caps 拒收必须折回脚本使 run 以 error 结算。
  return __request(siteId, "report", { item: item === undefined ? null : item, artifactId: artifactId === undefined ? null : String(artifactId) });
}
function __publishArtifact(siteId, op, args) {
  return __request(siteId, "publish-artifact", { op: String(op), args: args === undefined ? [] : args });
}
function __declareArtifact(siteId, op, args) {
  // 预置产物是声明：同步 void，与 report 共享 FIFO——到达顺序承重。
  __emitEvent("declare-artifact", { siteId: siteId, op: String(op), args: args === undefined ? [] : args });
}

// ============ 启动：取 WorkerInit，暴露 args，装配用户体 ============
var __init = null;
globalThis.args = {};
function __start(body) {
  // PTC 绑定调用必须携带无损 JSON 实参（真实 NodePtcRuntime 对 undefined
  // 实参按 "binding arguments must be lossless JSON" 拒绝，p0-real-machine ③
  // 首次真机跑实锤）；begin 的载荷语义为空，故传 null。
  return Promise.resolve(dwfHost.begin(null)).then(function (init) {
    __init = init;
    // args 浅冻结一层（拍板表#1，原件 guest-prelude.js:108）：挡手滑重新赋值，非安全边界。
    globalThis.args = Object.freeze(init && init.args ? init.args : {});
    return body();
  }).then(function (value) {
    // D1 修复：body() 正常 resolve 且无在飞、无停泊接收者时置 __settled，
    // 堵死 await-report-then-return 收尾链上的误报窗口；不调 dwfHost.complete
    // ——成功仍由返回值经 PTC 返回路径结算（拍板表 P0-C 不变）。
    // pending>0：fire-and-forget，留给最后一条请求的自查收尾（smoke 2）。
    // 有停泊接收者：真 ChannelDeadlock，不置位，让自查报 Deadlock（smoke 3）。
    if (__pending === 0) {
      var parked = false;
      for (var i = 0; i < __channels.length; i++) {
        var ch = __channels[i];
        if (ch.waiters.length - ch.waitHead > 0) { parked = true; break; }
      }
      if (!parked) __settled = true;
    }
    return value;
  }, function (error) {
    // 脚本体异常折算（拍板表#6，原件 guest-prelude.js:172-179）：折成 complete{ok:false}，
    // 不把错误隐式外推给宿主 run 层；折算后本 promise 正常 resolve，便于外层收尾。
    __complete(false, undefined, error);
  });
}
`;
