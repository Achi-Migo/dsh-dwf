/** Run with the real harness peers installed: node --test test/session-history.integration.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'

const types = ['dwf/run-start', 'dwf/agent-start', 'dwf/agent-end', 'dwf/run-end']
const events = [
  { type: types[0], data: { runId: 'test-run', name: 'history-smoke' } },
  { type: types[1], data: { runId: 'test-run', seq: 1, label: 'smoke', childId: 'test-child' } },
  { type: types[2], data: { runId: 'test-run', seq: 1, outcome: 'completed' } },
  { type: types[3], data: { runId: 'test-run', stopReason: 'completed' } },
].map((event, seq) => ({ ...event, seq, time: 1 }))
const meta = { id: 'history-smoke' }

test('module load admits existing DWF history before any recorder is constructed', async () => {
  // Match the original failure without rewriting the persisted envelopes.
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has(types[0]), false)
  assert.throws(() => validateStoredEvents(meta, structuredClone(events), 'test-log'), /dwf\/run-start/)
  await import('../lib/tool/recorder.js')
  assert.doesNotThrow(() => validateStoredEvents(meta, structuredClone(events), 'test-log'))
  assert.equal(events.some(event => event.ignorable === true), false)
  assert.throws(() => validateStoredEvents(meta, [
    { type: 'unknown-plugin/required-event', seq: 0, time: 1, data: {} },
  ], 'test-log'), /unknown to this harness/)
})
