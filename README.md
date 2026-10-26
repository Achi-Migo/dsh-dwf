# dsh-dwf

Dynamic workflows for **DeepSeek Harness** — a workflow engine that replaces the
official `workflowEngine` slot with a compiled, replayable, resumable one.

`dsh-dwf` brings the ZCode-style workflow contract to DSH: a **TypeScript-checked
script facade** instead of plain JS, a **replay journal** in SQLite, a
**deterministic guest sandbox**, persistent **actor subagents**, and a
**model pool** that spreads load across providers and fails over on quota errors.

> **License:** source-available, **non-commercial**, **attribution required**.
> See [LICENSE](LICENSE) and [NOTICE](NOTICE). Commercial use needs written
> permission. This is not an OSI-approved open-source license.

---

## What you get

| Capability | Detail |
|---|---|
| Typed workflow scripts | `agent<T>()` results are validated against a JSON Schema generated from a script-local TS interface — the facade is checked at compile time |
| Replay journal | Every run, event, node and actor is persisted in SQLite (`dwf_run` / `dwf_event` / `dwf_node` / `dwf_actor`); the model tool reads the same database the engine writes |
| Deterministic guest | Scripts run in a restricted realm: no `Date.now()`, no `Math.random()`, no filesystem, no network — a run can be replayed |
| Persistent actors | One `agent()` handle keeps its conversation across asks (FIFO per actor) |
| Model pool | Unbound actors spread across providers (`spread` or `round-robin`); deterministic provider failures cool down and fail over |
| Stall detection | A deadlocked or stalled script settles as a clean error instead of hanging the run |
| Background runs | `run_in_background` via the host job registry |

## Requirements

- **Node.js ≥ 22.6** (the package ships TypeScript sources and relies on native
  type stripping; developed and tested on Node 24)
- **DSH 0.2.1-rc.3** (pinned; the engine implements the `workflowEngine` seam of
  that release)

## Install

`dsh-dwf` resolves its `@deepseek-ai/*` imports from the DSH host, so it must be
installed **into a DSH profile** — not into a bare project (a plain `npm i`
outside DSH leaves the peer packages unresolved, by design).

```bash
# from GitHub
dsh plugin --profile personal add github:Achi-Migo/dsh-dwf

# or from a packed tarball
npm pack && dsh plugin --profile personal add ./zakza-dsh-dwf-0.1.0.tgz
```

Then disable the official engine + tool so only one workflow surface is mounted
(add to `$DSH_HOME/profiles/personal/cordis.patch.yml`):

```yaml
- id: workflow-ptc
  disabled: true
- id: tool-workflow
  disabled: true
```

The bundle patch (`cordis.patch.yml` in this package) inserts two rows:
`dwf-engine` (publishes the `workflowEngine` service) and `dwf` (registers the
`dwf` model tool). Both must point at the **same** `dbPath` — that database is
the single source of truth shared by engine and tool.

Set `dbPath` explicitly in your profile layer; an empty value means `./dwf.db`
relative to the host process cwd:

```yaml
- id: dwf-engine
  config:
    toolName: dwf
    dbPath: /absolute/path/to/dwf.db
    modelPool: 'providerA/model-x,providerB/model-y'
```

Config fields: `toolName`, `dbPath`, `maxConcurrency`, `maxTotalAgents`,
`maxResultChars`, `enableRunInBackground`, `modelPool`, `poolPolicy`
(`spread` | `round-robin`), `poolCooldownMs`, `failoverAttempts`.

## Writing a workflow

The model calls the `dwf` tool with a script. Scripts are TypeScript bodies with
top-level `await` and a final `return`:

```ts
phase("Review the changed files");

const reviewer = agent("reviewer", {
  system: "You review code. Report only real defects.",
  model: "providerA/model-x",
});

interface Review {
  /** File the finding is in. */
  path: string;
  /** One sentence: what is wrong. */
  problem: string;
  /** low | medium | high */
  severity: string;
}

const review = await reviewer.ask<Review>("Review src/parser.ts");
log(`found ${review.severity} issue in ${review.path}`);
await report(review);

return { ok: true, path: review.path };
```

Facade: `agent` / `ask<T>` / `model` / `phase` / `log` / `report` /
`publishArtifact` / `channel` / `future` / `world` (`run`, `read`) /
`files` (`glob`, `read`, `grep`) / `git` (`changedFiles`, `diff`, `status`,
`log`) / `args` / `hole`.

## Verification status

Verified on Windows + Node 24.20.0 against DSH 0.2.1-rc.3 in a `personal`
profile, with a real host boot and journal reconciliation:

- typecheck, stall/unit/integration suites and the no-host smoke suite: green
- real-machine smoke: report-then-return script completes (no false stall);
  an actor round-trip returns a real model reply
- `dsh-workflow-gate` coexistence: the gate's verdict equals the command exit
  code, no model involved

Known boundaries (deliberate deferrals, not bugs):

- workflow-script `amend`/resume caching and `SaveWorkflow` are placeholders
- artifact presets (chart/table/metrics/board) are placeholders; `report` items
  and artifact rows are recorded in the journal instead
- the host exposes no confirmation-surface, artifact-card or completion-
  notification API at this DSH version, so phase/command preview and artifact
  cards are not wired
- `hole()` answers with a deterministic "unavailable" error rather than parking
  the run

## Repository layout

```
src/compile/   TS → JS lowering, facade checking, JSON Schema, phase graph
src/engine/    engine, run lifecycle, scheduler, actor pool, effects, artifacts
src/journal/   SQLite schema, store, projection, caps
src/guest/     deterministic realm, prelude, channel primitives, protocol
src/tool/      model-facing tools (create/get/list, mirror, recorder)
assets/        facade declaration, guest templates, journal DDL
test/          smoke, stub-check, compile/engine/tool/pool/integration suites
```

## Acknowledgements

Provenance, upstream projects and required attribution are in
[NOTICE](NOTICE). In short: dsh-dwf is an independent reimplementation of
ZCode's dynamic-workflow runtime, built on the DeepSeek Harness plugin
contract. It redistributes no ZCode code and no `@deepseek-ai/*` package.

## Contributing

Issues and pull requests are welcome for non-commercial purposes. By
contributing you agree your contribution is licensed under [LICENSE](LICENSE).
Keep the NOTICE intact.
