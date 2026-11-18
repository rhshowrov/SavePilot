import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import { ChangeLedger, SnapshotCache, type DiskKind } from './model';

const MAX_FILE = 512 * 1024;
const MAX_PENDING = 5000;
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
export const keyOf = (uri: vscode.Uri): string => uri.toString();

export class ChangeTracker implements vscode.Disposable {
  readonly ledger = new ChangeLedger();
  readonly baselines = new SnapshotCache();
  readonly errors = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly watcherSubscriptions: vscode.Disposable[] = [];
  private readonly pending = new Map<string, { uri: vscode.Uri; kind: DiskKind }>();
  private readonly processing = new Set<string>();
  private readonly saved = new Map<string, { hash?: string; mtime?: number; size?: number }>();
  private readonly revisions = new Map<string, number>();
  private sequence = 0;
  private inventoryGeneration = 0;
  private indexing: Promise<void> = Promise.resolve();
  private readonly knownFiles = new Set<string>();
  private readonly dirtyMembership = new Set<string>();
  private excluded: (path: string) => boolean = () => false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private disposed = false;
  monitoringIssue: string | undefined;
  monitoringStarted = new Date();

  constructor(private readonly output: vscode.OutputChannel) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!this.includes(event.document)) return;
        if (!event.document.isDirty && !this.ledger.changes.has(keyOf(event.document.uri))) void this.capture(event.document.uri);
        this.syncDocument(event.document);
      }),
      vscode.workspace.onDidOpenTextDocument(document => { if (this.includes(document)) { void this.capture(document.uri); this.syncDocument(document); } }),
      vscode.workspace.onDidCloseTextDocument(document => { if (this.dirtyMembership.delete(keyOf(document.uri))) this.changed(); }),
      vscode.workspace.onDidSaveTextDocument(document => { if (this.includes(document)) this.recordEditorSave(document); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.configure(); this.changed(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { this.configure(); this.changed(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('savepilot.externalMonitoring') || event.affectsConfiguration('savepilot.excludedDirectories')) this.configure();
        if (event.affectsConfiguration('files.autoSave') || event.affectsConfiguration('savepilot')) this.changed();
      })
    );
    this.configure();
    for (const document of this.dirty) this.dirtyMembership.add(keyOf(document.uri));
    for (const document of vscode.workspace.textDocuments) if (this.includes(document)) void this.capture(document.uri);
  }

  private syncDocument(document: vscode.TextDocument): void {
    const key = keyOf(document.uri);
    if (document.isDirty === this.dirtyMembership.has(key)) return;
    if (document.isDirty) this.dirtyMembership.add(key); else this.dirtyMembership.delete(key);
    this.changed();
  }

  includes(document: vscode.TextDocument): boolean {
    if (document.uri.scheme === 'savepilot-snapshot' || document.uri.scheme === 'git') return false;
    if (document.isUntitled) return Boolean(vscode.workspace.workspaceFolders?.length);
    return Boolean(vscode.workspace.getWorkspaceFolder(document.uri));
  }

  get dirty(): readonly vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(document => document.isDirty && this.includes(document));
  }
  get total(): number { return this.ledger.total(this.dirty.map(document => keyOf(document.uri))); }
  get monitoring(): boolean {
    return vscode.workspace.isTrusted && vscode.workspace.getConfiguration('savepilot').get<boolean>('externalMonitoring', true);
  }
  document(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(document => keyOf(document.uri) === key && this.includes(document));
  }
  hasPendingActivity(key: string): boolean { return this.pending.has(key) || this.processing.has(key); }

  private configure(): void {
    const generation = ++this.inventoryGeneration;
    for (const item of this.watcherSubscriptions.splice(0)) item.dispose();
    const patterns = vscode.workspace.getConfiguration('savepilot').get<string[]>('excludedDirectories', []);
    this.excluded = patterns.length ? picomatch(patterns, { dot: true }) : () => false;
    // Keep existing review records when monitoring is disabled; acknowledge explicitly.
    if (!this.monitoring) { this.changed(); return; }
    this.monitoringStarted = new Date();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      this.watcherSubscriptions.push(watcher,
        watcher.onDidCreate(uri => this.queue(uri, 'created')),
        watcher.onDidChange(uri => this.queue(uri, 'modified')),
        watcher.onDidDelete(uri => this.queue(uri, 'deleted')));
    }
    // Enumerate paths once, without reading contents. Cap work in very large repositories.
    this.indexing = (async () => {
      try {
        const exclude = patterns.length ? `{${patterns.join(',')}}` : null;
        const files = await vscode.workspace.findFiles('**/*', exclude, 20_001);
        if (this.disposed || generation !== this.inventoryGeneration) return;
        this.knownFiles.clear();
        for (const uri of files.slice(0, 20_000)) this.knownFiles.add(keyOf(uri));
        if (files.length > 20_000) this.monitoringIssue = 'Initial file inventory capped at 20,000 paths. Some deletion events may be unavailable; narrow monitoring exclusions.';
      } catch (error) {
        this.monitoringIssue = 'Initial file inventory failed. Some deletion events may be unavailable.';
        this.output.appendLine(`Inventory failed: ${String(error)}`);
      }
      this.changed();
    })();
    this.changed();
  }

  private queue(uri: vscode.Uri, kind: DiskKind): void {
    if (this.disposed || !this.monitoring || this.excluded(vscode.workspace.asRelativePath(uri, false))) return;
    const key = keyOf(uri);
    if (!this.pending.has(key) && this.pending.size >= MAX_PENDING) {
      this.monitoringIssue = 'Activity limit reached. Disk change status is incomplete; reduce monitored directories.';
      this.changed(); return;
    }
    const previous = this.pending.get(key);
    if (previous?.kind === 'created' && kind === 'deleted' && !this.ledger.changes.has(key)) {
      this.pending.delete(key); this.revisions.delete(key); return;
    }
    this.pending.set(key, { uri, kind: previous?.kind === 'created' && kind === 'modified' ? 'created' : kind });
    this.revisions.set(key, ++this.sequence);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.refresh(); }, 200);
  }

  /** Refresh reconciles queued events; it never silently acknowledges disk changes. */
  async refresh(): Promise<void> {
    if (this.flushing) { await this.flushing; return; }
    this.flushing = this.drain();
    try { await this.flushing; } finally {
      this.flushing = undefined;
      if (this.pending.size && !this.disposed && !this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.refresh(); }, 200);
    }
    this.changed();
  }

  private async drain(): Promise<void> {
    await this.indexing;
    // Process bounded batches with four reads in flight. New events retain their revisions.
    const entries = [...this.pending.entries()];
    for (const [key] of entries) { this.pending.delete(key); this.processing.add(key); }
    for (let offset = 0; offset < entries.length && !this.disposed; offset += 4) {
      const batch = entries.slice(offset, offset + 4);
      await Promise.all(batch.map(async ([key, event]) => {
        const revision = this.revisions.get(key);
        try {
          let kind = event.kind;
          let text: string | undefined;
          let stat: vscode.FileStat | undefined;
          try {
            stat = await vscode.workspace.fs.stat(event.uri);
            if (stat.type & vscode.FileType.Directory) return;
            if (kind === 'deleted') kind = 'modified';
            text = await this.readText(event.uri, stat);
          } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') kind = 'deleted';
            else throw error;
          }
          if (this.disposed || this.revisions.get(key) !== revision) return;
          if (kind === 'deleted') {
            if (!this.knownFiles.delete(key) && !this.ledger.changes.has(key)) {
              // Directory deletes can arrive as one event. Expand known descendants,
              // but never render a directory as a deleted file.
              const prefix = `${key.replace(/\/$/, '')}/`;
              for (const child of this.knownFiles) if (child.startsWith(prefix)) this.queue(vscode.Uri.parse(child), 'deleted');
              return;
            }
          } else if (this.knownFiles.size < 20_000) this.knownFiles.add(key);
          const saved = this.saved.get(key);
          if (saved && kind !== 'deleted' && ((text !== undefined && saved.hash === fingerprint(text))
            || (saved.hash === undefined && saved.mtime === stat?.mtime && saved.size === stat?.size))) {
            this.ledger.changes.delete(key);
            if (text !== undefined) this.baselines.set(key, text);
            return;
          }
          if (!this.ledger.changes.has(key) && this.ledger.changes.size >= MAX_PENDING) {
            this.monitoringIssue = 'Review queue limit reached (5,000 files). Additional changes may be missing.'; return;
          }
          const baseline = this.baselines.get(key);
          if (!this.ledger.changes.has(key) && text !== undefined && baseline === text) return;
          this.ledger.record(key, kind);
          if (kind === 'created' && baseline === undefined) this.baselines.set(key, '');
        } catch (error) {
          this.monitoringIssue = 'Some disk changes could not be inspected. Check SavePilot output.';
          this.output.appendLine(`Monitoring failed for ${event.uri.toString()}: ${String(error)}`);
        } finally {
          this.processing.delete(key);
          if (!this.pending.has(key)) this.revisions.delete(key);
        }
      }));
      this.changed();
    }
  }

  async readText(uri: vscode.Uri, knownStat?: vscode.FileStat): Promise<string | undefined> {
    const stat = knownStat ?? await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE || stat.type & vscode.FileType.Directory) return undefined;
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_FILE || bytes.includes(0)) return undefined;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return undefined; }
  }

  private async capture(uri: vscode.Uri): Promise<void> {
    const key = keyOf(uri);
    if (uri.scheme === 'untitled' || this.ledger.changes.has(key) || this.baselines.get(key) !== undefined) return;
    const revision = this.revisions.get(key);
    try {
      const text = await this.readText(uri);
      if (!this.disposed && text !== undefined && !this.ledger.changes.has(key) && this.revisions.get(key) === revision) this.baselines.set(key, text);
    } catch { /* A missing or unreadable baseline is represented explicitly in the review UI. */ }
  }

  private recordEditorSave(document: vscode.TextDocument): void {
    const key = keyOf(document.uri);
    const text = document.getText();
    this.saved.delete(key);
    const saved: { hash?: string; mtime?: number; size?: number } = {};
    if (Buffer.byteLength(text, 'utf8') <= MAX_FILE) {
      saved.hash = fingerprint(text);
      this.baselines.set(key, text);
    }
    this.saved.set(key, saved);
    if (this.saved.size > 256) {
      const oldest = this.saved.keys().next().value;
      if (oldest !== undefined) this.saved.delete(oldest);
    }
    this.errors.delete(key);
    this.syncDocument(document);
    // Stat is needed only for large/binary documents whose contents we do not cache.
    if (saved.hash === undefined) void vscode.workspace.fs.stat(document.uri).then(stat => { saved.mtime = stat.mtime; saved.size = stat.size; }, () => undefined);
    this.changed();
  }

  async acknowledge(key: string, revision: number): Promise<boolean> {
    await this.refresh();
    if (this.document(key)?.isDirty) return false;
    if (this.ledger.changes.get(key)?.revision !== revision) return false;
    let text: string | undefined;
    if (this.ledger.changes.get(key)?.kind !== 'deleted') text = await this.readText(vscode.Uri.parse(key));
    await this.refresh();
    if (this.document(key)?.isDirty || this.hasPendingActivity(key)) return false;
    if (!this.ledger.acknowledge(key, revision)) return false;
    this.baselines.delete(key);
    if (text !== undefined) this.baselines.set(key, text);
    this.changed(); return true;
  }

  changed(): void {
    if (this.disposed || this.updateTimer) return;
    this.updateTimer = setTimeout(() => { this.updateTimer = undefined; this.emitter.fire(); }, 100);
  }
  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    for (const subscription of [...this.subscriptions, ...this.watcherSubscriptions]) subscription.dispose();
    this.pending.clear(); this.processing.clear(); this.baselines.clear(); this.saved.clear(); this.revisions.clear(); this.emitter.dispose();
  }
}
