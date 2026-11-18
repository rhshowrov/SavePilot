/** A bounded, session-only cache. No file contents are persisted by SavePilot. */
export class SnapshotCache {
  private readonly values = new Map<string, string>();
  private bytes = 0;
  constructor(readonly maxBytes = 8 * 1024 * 1024, readonly maxFileBytes = 512 * 1024) {}
  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: string, value: string): void {
    this.delete(key);
    const size = Buffer.byteLength(value, 'utf8');
    if (size > this.maxFileBytes || size > this.maxBytes) return;
    this.values.set(key, value);
    this.bytes += size;
    while (this.bytes > this.maxBytes) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  delete(key: string): void {
    const value = this.values.get(key);
    if (value === undefined) return;
    this.bytes -= Buffer.byteLength(value, 'utf8');
    this.values.delete(key);
  }
  clear(): void { this.values.clear(); this.bytes = 0; }
}

export type DiskKind = 'modified' | 'created' | 'deleted';
export interface DiskChange { readonly key: string; readonly kind: DiskKind; readonly revision: number }

/** Coalesces repeated writes to one pending item without losing its origin. */
export class ChangeLedger {
  readonly changes = new Map<string, DiskChange>();
  private revision = 0;
  record(key: string, kind: DiskKind): void {
    const previous = this.changes.get(key);
    if (previous?.kind === 'created' && kind === 'deleted') { this.changes.delete(key); return; }
    const nextKind = previous?.kind === 'created' ? 'created'
      : previous?.kind === 'deleted' && kind === 'created' ? 'modified' : kind;
    this.changes.set(key, { key, kind: nextKind, revision: ++this.revision });
  }
  acknowledge(key: string, revision: number): boolean {
    if (this.changes.get(key)?.revision !== revision) return false;
    return this.changes.delete(key);
  }
  total(dirtyKeys: Iterable<string>): number { return new Set([...dirtyKeys, ...this.changes.keys()]).size; }
}

export interface SaveCandidate {
  readonly key: string;
  readonly version: number;
  readonly needsLocation: boolean;
}
export type SaveOutcome = 'saved' | 'clean' | 'failed' | 'changed' | 'conflict' | 'location' | 'canceled';
export interface SaveResult { readonly candidate: SaveCandidate; readonly outcome: SaveOutcome; readonly error?: string }
export interface SaveHost {
  current(key: string): { version: number; dirty: boolean } | undefined;
  conflict(key: string): boolean;
  save(key: string): Promise<boolean>;
  canceled(): boolean;
  report(completed: number, total: number): void;
}

/** Sequential saves avoid multiplying formatter/watcher work and native save dialogs. */
export async function saveBatch(candidates: readonly SaveCandidate[], host: SaveHost): Promise<SaveResult[]> {
  const results: SaveResult[] = [];
  for (const candidate of candidates) {
    const current = host.current(candidate.key);
    let outcome: SaveOutcome;
    let error: string | undefined;
    if (host.canceled()) outcome = 'canceled';
    else if (!current || !current.dirty) outcome = 'clean';
    else if (host.conflict(candidate.key)) outcome = 'conflict';
    else if (candidate.needsLocation) outcome = 'location';
    else if (current.version !== candidate.version) outcome = 'changed';
    else {
      try {
        const saved = await host.save(candidate.key);
        outcome = !saved ? 'failed' : host.current(candidate.key)?.dirty ? 'changed' : 'saved';
      } catch (cause) {
        outcome = 'failed';
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    results.push(error === undefined ? { candidate, outcome } : { candidate, outcome, error });
    host.report(results.length, candidates.length);
  }
  return results;
}
