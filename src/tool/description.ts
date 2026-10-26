/**
 * The script-authoring contract shown to the model, rewritten for THIS plugin's
 * facade (assets/facade.d.ts) — review B12's third mandatory fork replacement.
 *
 * The official tool-workflow DESCRIPTION documents an `agent` hook that takes
 * the prompt as its first argument plus opts, pipeline/parallel over plain
 * JavaScript. That contract is wrong for this
 * engine: our facade is `agent(name?, persona?)` whose handle carries
 * `.ask<T>()`, concurrency is channel/future, scripts are TypeScript-checked
 * against the facade (ordinary `interface` declarations double as ask schemas),
 * and world I/O goes through `world.run` / `files.*` / `git.*`. Copying the
 * official text would make the model write scripts against hooks that do not
 * exist here, so this file replaces it wholesale. Every claim below traces to
 * a facade.d.ts declaration or a DESIGN §3.3/§6.2 decision.
 */

/** Tool-level description: the hooks, their exact semantics, and the caps. */
export const DESCRIPTION = `Run a deterministic workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

The script is TypeScript checked against a fixed facade before it runs: write ordinary code plus plain \`interface\` declarations (no imports/exports — meta travels in the meta parameter, not code), use top-level await freely, and end with \`return <json value>\`.

Script-body hooks (the facade is the full contract):
- \`agent(name?, persona?): Agent\` — create a subagent: one conversation that keeps its context across asks. persona is a model id string or \`{ system?, model? }\`, frozen at creation; omit it for the run's default model. A non-empty name is an identity: unique within the run (a duplicate literal is a compile error, a computed duplicate fails the run) and the key cached work is matched by. Every call starts a new, empty conversation — share the returned value to share one.
- \`handle.ask<T>(instructions): Promise<T>\` — give that subagent one task. With a type argument, \`T\` is an interface you declared in this script (e.g. \`interface Answer { score: number; reason: string }\`, plain declaration, no \`declare\` modifier); the answer comes back validated against a schema built from it. Without one, the answer is the child's final reply text. Asks issued while the subagent is busy wait their turn, first in, first out.
- \`model("modelId" | "providerId/modelId")\` — declare a model subagents may run on (optional \`$level\` suffix); string literal only, availability checked at launch. Pass a declared id (or the ModelRef) as persona.model to choose per subagent. If the deployment configures a model pool, subagents created WITHOUT an explicit model are auto-assigned from that pool (spread across providers, with automatic failover on provider rate-limit/quota errors — pool-assigned models only; an explicitly chosen model stays pinned). Which model actually served each ask is recorded in the run journal.
- \`phase("title")\` — marks the start of a named progress phase; the name must be a compile-time string literal (enforced at compile time). The rest is not enforced in this release: the call is optional, it need not be a standalone statement, and a phase containing no ask or world.run is accepted.
- \`log(message)\` — narrate progress to the user. \`args\` — the tool call's args input, verbatim; always an object, values unknown, so narrow them (String(args.target), typeof guards).
- \`report(item, artifactId?)\` — publish one intermediate result while the run is going. The item must be JSON-serializable (plain objects/arrays/strings/numbers/booleans/null); a function, class instance, Date or promise is rejected when the call runs — the publish throws a catchable error (this is not checked at compile time). Caps fail the whole run, not the call: 65,536 items per run, 1 MiB per item, 1 GiB per run.
- \`artifact.file(id, path, opts?)\` / \`artifact.markdown(id, content, opts?)\` — publish what the user keeps: asynchronous, resolve to \`{ id, version }\`, and reject catchably (missing file, outside the workspace, over the cap). The id is a compile-time literal, at most 64 characters of [A-Za-z0-9_.-]; republishing an id mints the next version. The chart/table/metrics/board preset declarations are reserved vocabulary — not available in this release: declaring them is silently ignored, and the run fails only when a tagged report (\`report(item, "id")\`) names one, because the id matches no declared preset.
- \`world.run(cmd, args?, { timeoutMs }?)\` — run a command with fixed argv, never a shell (no pipes, redirection or expansion); cwd is the workspace; Node builtins are reachable via world.run("node", ["-e", code]). cmd must be a compile-time string literal — the command set is shown to the user for confirmation. A completed process RESOLVES, nonzero exit included, as \`{ exitCode, stdout, stderr }\`; the promise rejects only on spawn failure or timeout (default 300000 ms).
- \`files.glob(pattern)\` / \`files.read(path)\` / \`files.grep(pattern, glob?)\` and \`git.changedFiles(base?)\` / \`git.diff(base?, path?)\` / \`git.status()\` / \`git.log(count?)\` — read-only workspace views; there is no write from inside the script (writing is a subagent's task). Pattern semantics: grep patterns run as JavaScript RegExp (an approximation of the ripgrep-compatible contract, not the rg binary), and glob patterns support only \`*\` within one path segment, \`**\` across segments and \`?\` for a single character — brace alternation like \`{a,b}\` is not supported. Results are recorded, so a replayed run gets the same answer back. Oversized results and caps reject rather than truncate.
- \`hole(name, prompt?)\` — a typed gap: a branch decided later. The two filled overloads — \`hole(name, body)\` / \`hole(name, prompt, body)\` — run body locally in the hole's place. An unfilled hole currently fails deterministically (HOLE_UNAVAILABLE, catchable): catch and proceed, or end the run; it never hangs the run waiting to be filled.
- \`channel<T>(name?)\` — a typed FIFO stream between concurrent stages: \`send(item)\` is synchronous and never waits, \`close()\` ends the stream (idempotent), and a stage drains it with \`for await\`. A channel nobody closes fails the run as ChannelDeadlock once nothing can send to it again. \`future(body)\` runs an async block concurrently (it starts immediately, not when awaited); \`Promise.all\` works as usual.

The workflow itself runs in a deterministic sandbox: no filesystem, network, timer, Date.now()/Math.random(), or Node.js APIs — subagents and world.run do the work, and every effect is recorded so runs are replayable. Misused hooks (bad arguments, unknown options, tripped caps) end the whole script instead of producing null.`

/** The `script` parameter description: parameter-level rules live here, not in DESCRIPTION. */
export const SCRIPT_PARAM_DESCRIPTION =
  'The script body, TypeScript-checked against the workflow facade: plain code plus ordinary `interface` declarations '
    + '(an interface doubles as the answer schema of `handle.ask<T>()`), no imports/exports, top-level await allowed. '
    + 'End with `return <value>`; the JSON-serializable value is this tool\'s result. '
    + 'The hook reference (agent/ask/channel/world.run/hole/report/artifact/files/git/phase/log/args) is in the tool description above.'
