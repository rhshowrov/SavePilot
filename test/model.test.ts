import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCache, ChangeLedger, saveBatch, type SaveHost, type SaveCandidate } from '../src/model';

test('snapshots bound UTF-8 bytes, refresh LRU access, and reject oversized replacements', () => {
  const cache = new SnapshotCache(8, 6);
  cache.set('a', 'éé'); cache.set('b', 'abcd');
  assert.equal(cache.get('a'), 'éé');
  cache.set('c', '1234');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'éé');
  cache.set('a', 'oversized');
  assert.equal(cache.get('a'), undefined);
  cache.clear(); assert.equal(cache.get('c'), undefined);
});

test('empty snapshots are valid baselines for newly created files', () => {
  const cache = new SnapshotCache(); cache.set('new', ''); assert.equal(cache.get('new'), '');
});

test('disk change ledger coalesces repeated modifications while invalidating old review versions', () => {
  const ledger = new ChangeLedger(); ledger.record('a', 'modified');
  const revision = ledger.changes.get('a')!.revision;
  ledger.record('a', 'modified');
  assert.equal(ledger.changes.size, 1);
  assert.equal(ledger.acknowledge('a', revision), false);
  assert.equal(ledger.acknowledge('a', ledger.changes.get('a')!.revision), true);
});

test('creation followed by edits stays created; creation then deletion disappears', () => {
  const ledger = new ChangeLedger(); ledger.record('a', 'created'); ledger.record('a', 'modified');
  assert.equal(ledger.changes.get('a')?.kind, 'created');
  ledger.record('a', 'deleted'); assert.equal(ledger.changes.size, 0);
});

test('delete followed by recreate is a modification, not a new file', () => {
  const ledger = new ChangeLedger(); ledger.record('a', 'deleted'); ledger.record('a', 'created');
  assert.equal(ledger.changes.get('a')?.kind, 'modified');
});

test('badge counts distinct files when dirty and external states overlap', () => {
  const ledger = new ChangeLedger(); ledger.record('a', 'modified'); ledger.record('b', 'modified');
  assert.equal(ledger.total(['a', 'c']), 3);
});

const candidate = (key: string, needsLocation = false): SaveCandidate => ({ key, version: 1, needsLocation });
function fixture() {
  const documents = new Map<string, { version: number; dirty: boolean }>();
  const conflicts = new Set<string>(); const attempts: string[] = [];
  let stopped = false;
  const host: SaveHost = {
    current: key => documents.get(key), conflict: key => conflicts.has(key),
    save: async key => { attempts.push(key); documents.set(key, { version: 1, dirty: false }); return true; },
    canceled: () => stopped, report: () => undefined
  };
  return { documents, conflicts, attempts, host, stop: () => { stopped = true; } };
}

test('Save All skips changed versions, conflicts, and untitled files without invoking save', async () => {
  const f = fixture();
  for (const key of ['changed', 'conflict', 'untitled']) f.documents.set(key, { version: key === 'changed' ? 2 : 1, dirty: true });
  f.conflicts.add('conflict');
  const results = await saveBatch([candidate('changed'), candidate('conflict'), candidate('untitled', true)], f.host);
  assert.deepEqual(results.map(result => result.outcome), ['changed', 'conflict', 'location']);
  assert.deepEqual(f.attempts, []);
});

test('Save All continues after a failure and reports the actual partial result', async () => {
  const f = fixture();
  f.documents.set('a', { version: 1, dirty: true }); f.documents.set('b', { version: 1, dirty: true });
  f.host.save = async key => { if (key === 'a') throw new Error('permission denied'); f.documents.set(key, { version: 1, dirty: false }); return true; };
  const results = await saveBatch([candidate('a'), candidate('b')], f.host);
  assert.equal(results[0]?.outcome, 'failed'); assert.equal(results[0]?.error, 'permission denied');
  assert.equal(results[1]?.outcome, 'saved');
});

test('edits that arrive during saving remain pending', async () => {
  const f = fixture(); f.documents.set('a', { version: 1, dirty: true });
  f.host.save = async () => { f.documents.set('a', { version: 2, dirty: true }); return true; };
  assert.equal((await saveBatch([candidate('a')], f.host))[0]?.outcome, 'changed');
});

test('stopping a batch preserves completed saves and does not attempt remaining files', async () => {
  const f = fixture(); for (const key of ['a', 'b']) f.documents.set(key, { version: 1, dirty: true });
  f.host.report = () => f.stop();
  const results = await saveBatch([candidate('a'), candidate('b')], f.host);
  assert.deepEqual(results.map(result => result.outcome), ['saved', 'canceled']);
  assert.deepEqual(f.attempts, ['a']);
});

test('a save that returns false is never reported successful', async () => {
  const f = fixture(); f.documents.set('a', { version: 1, dirty: true }); f.host.save = async () => false;
  assert.equal((await saveBatch([candidate('a')], f.host))[0]?.outcome, 'failed');
});

test('documents that are already clean require no extra save', async () => {
  const f = fixture(); f.documents.set('a', { version: 1, dirty: false });
  assert.equal((await saveBatch([candidate('a')], f.host))[0]?.outcome, 'clean');
  assert.deepEqual(f.attempts, []);
});
