/**
 * Append-only journal store. Single-writer in-process: per-run event sequences
 * and per-site ordinals are assigned here monotonically (review B11) with a
 * MAX+1 recovery for a reopened database.
 */
import { createHash } from 'node:crypto';
export class JournalStore {
    db;
    sequences = new Map();
    ordinals = new Map();
    constructor(db) {
        this.db = db;
    }
    /** 每 run 一个写手：方法绑定到该 run 的 id，结算时计数器随之回收。 */
    writerFor(runId) {
        return {
            beginRun: (run) => this.beginRun(run),
            appendEvent: (event) => this.appendEvent(runId, event),
            recordNode: (node) => this.recordNode(runId, node),
            recordActor: (siteId, ordinal, name, persona, sessionId) => this.recordActor(runId, siteId, ordinal, name, persona, sessionId),
            settleRun: (outcome) => this.settleRun(runId, outcome),
        };
    }
    nextSequence(runId) {
        const next = (this.sequences.get(runId) ?? this.maxSequence(runId)) + 1;
        this.sequences.set(runId, next);
        return next;
    }
    maxSequence(runId) {
        const row = this.db.prepare('select coalesce(max(sequence), 0) as s from dwf_event where run_id = ?').get(runId);
        return row?.s ?? 0;
    }
    nextOrdinal(runId, siteId) {
        const key = `${runId}\u0000${siteId}`;
        const next = (this.ordinals.get(key) ?? this.maxOrdinal(runId, siteId)) + 1;
        this.ordinals.set(key, next);
        return next;
    }
    maxOrdinal(runId, siteId) {
        const row = this.db
            .prepare('select coalesce(max(ordinal), 0) as o from dwf_node where run_id = ? and site_id = ?')
            .get(runId, siteId);
        return row?.o ?? 0;
    }
    static inputHash(input) {
        return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
    }
    beginRun(run) {
        const now = Date.now();
        this.db
            .prepare(`insert into dwf_run (id, parent_session_id, cwd, name, script_text, script_hash, args_json, caps_max_concurrency, status, time_created, time_updated)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
            .run(run.id, run.parentSessionId ?? null, run.cwd ?? null, run.name, run.script, createHash('sha256').update(run.script).digest('hex'), run.args === undefined ? null : JSON.stringify(run.args), run.capsMaxConcurrency ?? null, now, now);
        this.appendEvent(run.id, { type: 'run-started' });
    }
    appendEvent(runId, event) {
        this.db
            .prepare('insert into dwf_event (run_id, sequence, type, payload_json, time_created) values (?, ?, ?, ?, ?)')
            .run(runId, this.nextSequence(runId), event.type, JSON.stringify(event.payload ?? null), Date.now());
    }
    recordNode(runId, node) {
        const ordinal = this.nextOrdinal(runId, node.siteId);
        const now = Date.now();
        this.db
            .prepare(`insert into dwf_node (run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, input_json, status, result_json, error_json, artifact_id, time_created, time_updated)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(runId, node.siteId, ordinal, node.kind, node.actorSiteId ?? null, node.actorOrdinal ?? null, node.actorSeq ?? null, JournalStore.inputHash(node.input), JSON.stringify(node.input), node.status, node.result === undefined ? null : JSON.stringify(node.result), node.error === undefined ? null : JSON.stringify({ message: node.error }), node.artifactId ?? null, now, now);
        return { siteId: node.siteId, ordinal };
    }
    recordActor(runId, siteId, ordinal, name, persona, sessionId) {
        const now = Date.now();
        const personaModel = persona !== undefined && typeof persona === 'object' && persona !== null && !Array.isArray(persona)
            ? persona.model
            : undefined;
        this.db
            .prepare(`insert or replace into dwf_actor (run_id, site_id, ordinal, name, persona_json, resolved_model, session_id, time_created, time_updated)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(runId, siteId, ordinal, name ?? null, persona === undefined ? null : JSON.stringify(persona), personaModel !== undefined && typeof personaModel === 'string' ? personaModel : null, sessionId ?? null, now, now);
        this.appendEvent(runId, { type: 'actor-created', payload: { siteId, ordinal, ...(name === undefined ? {} : { name }) } });
    }
    settleRun(runId, outcome) {
        this.db
            .prepare(`update dwf_run set status = ?, result_json = ?, failure_json = ?, spent_tokens = coalesce(?, spent_tokens), time_updated = ? where id = ?`)
            .run(outcome.status, outcome.result === undefined ? null : JSON.stringify(outcome.result), outcome.failure === undefined ? null : JSON.stringify({ message: outcome.failure }), outcome.spentTokens ?? null, Date.now(), runId);
        this.appendEvent(runId, { type: 'run-settled', payload: { status: outcome.status } });
        // 结算即回收该 run 的计数器条目（拍板表#10：计数器不跨 run 滞留）。
        this.sequences.delete(runId);
        for (const key of this.ordinals.keys()) {
            if (key.startsWith(`${runId}\u0000`))
                this.ordinals.delete(key);
        }
    }
}
