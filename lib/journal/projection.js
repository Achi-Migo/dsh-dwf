/** Read-side projections over the journal (GetWorkflowRun / ListWorkflowRuns). */
import { CAPS } from "./caps.js";
function mapSummary(row) {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        cwd: row.cwd === null ? undefined : row.cwd,
        timeCreated: row.time_created,
        timeUpdated: row.time_updated,
        nodesTotal: row.nodes_total,
        nodesCompleted: row.nodes_completed,
        nodesFailed: row.nodes_failed,
    };
}
export function listRuns(db, limit) {
    const rows = db
        .prepare(`select r.*, 
         (select count(*) from dwf_node n where n.run_id = r.id) as nodes_total,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'completed') as nodes_completed,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'failed') as nodes_failed
       from dwf_run r order by r.time_created desc limit ?`)
        .all(limit);
    return rows.map(mapSummary);
}
export function runProjection(db, runId) {
    const row = db
        .prepare(`select r.*,
         (select count(*) from dwf_node n where n.run_id = r.id) as nodes_total,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'completed') as nodes_completed,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'failed') as nodes_failed
       from dwf_run r where r.id = ?`)
        .get(runId);
    if (row === undefined)
        return undefined;
    // 展示帽探测（DESIGN §3.4）：多取一条判断是否超帽；超帽截到 maxNodes 并置 nodesUnlisted，
    // 记账不阻断——dwf_node 里的事实完整保留，仅投影列表截断。
    const nodeRows = db
        .prepare('select site_id, ordinal, kind, status, actor_site_id, artifact_id from dwf_node where run_id = ? order by id limit ?')
        .all(runId, CAPS.maxNodes + 1);
    const nodesUnlisted = nodeRows.length > CAPS.maxNodes ? true : undefined;
    const nodes = nodeRows
        .slice(0, CAPS.maxNodes)
        .map((n) => ({
        siteId: n.site_id,
        ordinal: n.ordinal,
        kind: n.kind,
        status: n.status,
        actorSiteId: n.actor_site_id === null ? undefined : n.actor_site_id,
        artifactId: n.artifact_id === null ? undefined : n.artifact_id,
    }));
    const events = db.prepare('select sequence, type, time_created from dwf_event where run_id = ? order by sequence').all(runId).map((e) => ({ sequence: e.sequence, type: e.type, timeCreated: e.time_created }));
    return { ...mapSummary(row), nodes, events, nodesUnlisted };
}
