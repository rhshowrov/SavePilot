import * as vscode from 'vscode';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChangeTracker, keyOf } from './tracker';
import { AutoSaveProtection } from './protection';
import { ChangesTree, ControlView, fileUri, type ChangeNode, type ControlState } from './views';
import { SnapshotCache, saveBatch, type SaveResult } from './model';

class ReviewSnapshots implements vscode.TextDocumentContentProvider {
  private readonly contents = new SnapshotCache(16 * 1024 * 1024);
  add(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'savepilot-snapshot', path: `/${name}`, query: randomUUID() });
    this.contents.set(uri.toString(), text); return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? 'This session snapshot has expired. Run Review Diff again.';
  }
}

class SavePilot implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('SavePilot');
  private readonly tracker = new ChangeTracker(this.output);
  private readonly snapshots = new ReviewSnapshots();
  private readonly tree: vscode.TreeView<ChangeNode>;
  private readonly controls: ControlView;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private readonly protection: AutoSaveProtection;
  private readonly reviewedVersions = new Map<string, number>();
  private selected: vscode.Uri | undefined;
  private saving = false;
  private stopRequested = false;
  private progress = '';
  private results: SaveResult[] = [];
  private notified = false;
  private notificationTimer: ReturnType<typeof setTimeout> | undefined;
  private notificationDeadline: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.protection = new AutoSaveProtection(context);
    const provider = new ChangesTree(this.tracker);
    this.tree = vscode.window.createTreeView('savepilot.changes', { treeDataProvider: provider, showCollapseAll: true });
    this.controls = new ControlView(context.extensionUri, () => this.controlState(), action => this.run(() => this.controlAction(action)));
    this.disposables.push(this.output, this.tracker, provider, this.tree, this.controls, this.status,
      vscode.workspace.registerTextDocumentContentProvider('savepilot-snapshot', this.snapshots),
      vscode.window.registerWebviewViewProvider('savepilot.controls', this.controls),
      this.tracker.onDidChange(() => this.update()),
      this.tree.onDidChangeSelection(event => { this.selected = event.selection[0]?.type === 'file' ? event.selection[0].uri : undefined; this.controls.update(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('files.autoSave')) this.run(() => this.protection.observeSettingChange());
        if (event.affectsConfiguration('savepilot.autoSaveProtection') || event.affectsConfiguration('savepilot.restoreAutoSave')) this.run(() => this.protection.synchronize());
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.run(() => this.protection.synchronize())));
    const register = (name: string, action: (argument: unknown) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(`savepilot.${name}`, (argument: unknown) => this.run(() => action(argument))));
    };
    register('show', () => vscode.commands.executeCommand('savepilot.changes.focus'));
    register('saveAll', () => this.saveAll());
    register('save', argument => this.saveFile(fileUri(argument)));
    register('open', argument => this.open(fileUri(argument)));
    register('diff', argument => this.diff(fileUri(argument)));
    register('reviewed', argument => this.markReviewed(fileUri(argument)));
    register('reviewAll', () => this.reviewAll());
    register('refresh', () => this.tracker.refresh());
    register('settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:savepilot-local.savepilot'));
    register('protect', () => this.protection.requestEnable());
    register('restore', () => this.protection.requestRestore());
    register('results', () => this.output.show(true));
    this.status.command = 'savepilot.show';
    this.update();
    this.run(() => this.protection.synchronize());
  }

  private async run(action: () => unknown): Promise<void> {
    try { await action(); }
    catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      const choice = await vscode.window.showErrorMessage(`SavePilot: ${message}`, 'Show Details');
      if (choice) this.output.show(true);
    }
  }

  private controlState(): ControlState {
    const config = vscode.workspace.getConfiguration('savepilot');
    const modes = new Set((vscode.workspace.workspaceFolders ?? []).map(folder => vscode.workspace.getConfiguration('files', folder.uri).get<string>('autoSave', 'off')));
    const autoSave = modes.size > 1 ? 'Mixed workspace settings' : [...modes][0] ?? vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
    const dirty = this.tracker.dirty;
    const dirtyKeys = new Set(dirty.map(document => keyOf(document.uri)));
    const selectedKey = this.selected && keyOf(this.selected);
    const disk = selectedKey ? this.tracker.ledger.changes.get(selectedKey) : undefined;
    const document = selectedKey ? this.tracker.document(selectedKey) : undefined;
    const isPending = Boolean(document?.isDirty || disk);
    return {
      unsaved: dirty.length, external: [...this.tracker.ledger.changes.keys()].filter(key => !dirtyKeys.has(key)).length,
      total: this.tracker.total, saving: this.saving, progress: this.progress,
      autoSave: autoSave === 'off' ? 'Off' : autoSave,
      protection: config.get<boolean>('autoSaveProtection', false) && autoSave === 'off',
      monitoring: !vscode.workspace.isTrusted ? 'External monitoring requires workspace trust.' : this.tracker.monitoring
        ? `Disk monitoring since ${this.tracker.monitoringStarted.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : 'External monitoring is off. Editor changes are still shown.',
      issue: this.tracker.monitoringIssue ?? (config.get<boolean>('autoSaveProtection', false) && autoSave !== 'off' ? 'Auto Save is enabled for part of this workspace. Check folder settings.' : ''),
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
      selected: this.selected && isPending ? {
        name: vscode.workspace.asRelativePath(this.selected, true),
        state: document?.isDirty ? disk ? 'Editor and disk both changed. Compare before saving.' : document.isUntitled ? 'New document · Choose a location to save.' : 'Unsaved editor changes'
          : disk?.kind === 'deleted' ? 'Deleted on disk · Review previous content if available.' : 'Already written to disk · Review does not control saving.',
        canSave: Boolean(document?.isDirty && !disk), canReview: Boolean(disk && !document?.isDirty)
      } : null
    };
  }

  private update(): void {
    if (this.disposed) return;
    const state = this.controlState();
    this.tree.message = this.tracker.monitoringIssue ?? (!state.hasWorkspace ? 'Open a folder to monitor workspace changes.' : `${state.unsaved} waiting to save · ${state.external} already on disk`);
    this.tree.badge = state.total && vscode.workspace.getConfiguration('savepilot').get<string>('notifications') !== 'off'
      ? { value: state.total, tooltip: `${state.total} changed files; ${state.unsaved} waiting to save; ${state.external} external-only files to review.` } : undefined;
    this.status.text = this.saving ? `$(sync~spin) SavePilot: ${this.progress}` : `$(save) SavePilot: ${state.unsaved} unsaved · ${state.external} to review`;
    this.status.tooltip = `${state.issue || 'Open SavePilot changes'}\nEditor Auto Save: ${state.autoSave}\nExternal writes are already on disk.`;
    if (state.hasWorkspace) this.status.show(); else this.status.hide();
    this.controls.update();
    void vscode.commands.executeCommand('setContext', 'savepilot.empty', state.total === 0);
    void vscode.commands.executeCommand('setContext', 'savepilot.hasWorkspace', state.hasWorkspace);
    void vscode.commands.executeCommand('setContext', 'savepilot.incomplete', Boolean(this.tracker.monitoringIssue));
    void vscode.commands.executeCommand('setContext', 'savepilot.saving', this.saving);
    this.scheduleNotification(state.total);
  }

  private scheduleNotification(total: number): void {
    if (!total) { this.notified = false; this.clearNotificationTimers(); return; }
    if (this.notified || this.saving) return;
    const config = vscode.workspace.getConfiguration('savepilot');
    if (config.get<string>('notifications') !== 'consolidated') { this.clearNotificationTimers(); return; }
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => this.run(() => this.notify()), config.get<number>('notificationQuietPeriod', 3) * 1000);
    this.notificationDeadline ??= setTimeout(() => this.run(() => this.notify()), 15_000);
  }

  private async notify(): Promise<void> {
    this.clearNotificationTimers();
    if (!this.tracker.total || this.notified || this.saving || this.disposed) return;
    this.notified = true;
    if (this.tree.visible) return;
    const state = this.controlState();
    const message = state.unsaved ? `SavePilot detected ${state.total} changed files: ${state.unsaved} unsaved, ${state.external} already on disk.`
      : `SavePilot detected ${state.external} changes already written to disk.`;
    const saveAction = `Save All (${state.unsaved})`;
    // Saving uses a fresh, explicitly confirmed batch if files changed while the toast was open.
    const batch = this.tracker.dirty.map(document => ({ key: keyOf(document.uri), version: document.version }));
    const action = await vscode.window.showInformationMessage(message, ...['Review Changes', ...(state.unsaved ? [saveAction] : [])]);
    if (this.disposed) return;
    if (action === 'Review Changes') await vscode.commands.executeCommand('savepilot.changes.focus');
    else if (action === saveAction) {
      const current = this.tracker.dirty;
      if (current.length !== batch.length || batch.some(item => this.tracker.document(item.key)?.version !== item.version)) {
        void vscode.window.showInformationMessage('Pending files changed while this notification was open. Review the current batch in SavePilot.');
        await vscode.commands.executeCommand('savepilot.changes.focus');
      } else await this.saveAll();
    }
  }

  private clearNotificationTimers(): void {
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    if (this.notificationDeadline) clearTimeout(this.notificationDeadline);
    this.notificationTimer = undefined; this.notificationDeadline = undefined;
  }

  private async controlAction(action: string): Promise<void> {
    if (action === 'saveAll') await this.saveAll();
    else if (action === 'stop') this.stopRequested = true;
    else if (action === 'refresh') await this.tracker.refresh();
    else if (action === 'protection') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:savepilot-local.savepilot autoSaveProtection');
    else if (action === 'saveSelected') await this.saveFile(this.selected);
    else if (action === 'diffSelected') await this.diff(this.selected);
    else if (action === 'reviewedSelected') await this.markReviewed(this.selected);
  }

  private async open(uri?: vscode.Uri): Promise<void> {
    if (uri) await vscode.window.showTextDocument(uri, { preview: true });
  }

  private async diff(uri?: vscode.Uri): Promise<void> {
    if (!uri) return;
    await this.tracker.refresh();
    const key = keyOf(uri);
    const disk = this.tracker.ledger.changes.get(key);
    const document = this.tracker.document(key);
    const name = posix.basename(uri.path) || 'Untitled';
    if (document?.isDirty) {
      if (document.isUntitled) {
        const empty = this.snapshots.add(name, '');
        await vscode.commands.executeCommand('vscode.diff', empty, uri, `${name}: New document ↔ Unsaved editor`); return;
      }
      let text: string | undefined;
      try { text = await this.tracker.readText(uri); }
      catch (error) { if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error; }
      if (text === undefined) {
        const action = await vscode.window.showWarningMessage('A text comparison is unavailable: the disk file is missing, binary, not UTF-8, or larger than 512 KiB. Open the file to resolve using VS Code.', 'Open File');
        if (action) await this.open(uri); return;
      }
      await vscode.commands.executeCommand('vscode.diff', this.snapshots.add(name, text), uri, `${name}: On disk ↔ Unsaved editor${disk ? ' · Resolve conflict before saving' : ''}`);
      if (disk) void vscode.window.showInformationMessage('Editor and disk both changed. Resolve using VS Code’s file save/conflict controls. SavePilot will not overwrite this conflict through Save All.');
      return;
    }
    if (!disk) { await this.open(uri); return; }
    const baseline = this.tracker.baselines.get(key);
    if (baseline === undefined) {
      const action = await vscode.window.showInformationMessage('A previous version is unavailable. SavePilot keeps bounded, session-only snapshots of opened or reviewed text files.', ...(disk.kind === 'deleted' ? [] : ['Open File']));
      if (action) await this.open(uri); return;
    }
    const current = disk.kind === 'deleted' ? '' : await this.tracker.readText(uri);
    if (current === undefined) { void vscode.window.showInformationMessage('Text diff unavailable for binary, non-UTF-8, or files larger than 512 KiB. Use Open File to inspect.'); return; }
    await this.tracker.refresh();
    if (this.tracker.ledger.changes.get(key)?.revision !== disk.revision) { void vscode.window.showInformationMessage('This file changed again. Run Review Diff to inspect its latest version.'); return; }
    this.reviewedVersions.set(key, disk.revision);
    await vscode.commands.executeCommand('vscode.diff', this.snapshots.add(name, baseline), this.snapshots.add(name, current), `${name}: Last reviewed version ↔ ${disk.kind === 'deleted' ? 'Deleted on disk' : 'Current disk version'} · Already on disk`);
  }

  private async markReviewed(uri?: vscode.Uri): Promise<void> {
    if (!uri) return;
    const key = keyOf(uri);
    const change = this.tracker.ledger.changes.get(key);
    if (!change) return;
    const reviewed = this.reviewedVersions.get(key);
    if (reviewed !== undefined && reviewed !== change.revision) {
      void vscode.window.showInformationMessage('This file changed after your last review. Review its latest version first.'); return;
    }
    if (!await this.tracker.acknowledge(key, change.revision)) {
      void vscode.window.showInformationMessage('The file has unsaved or newer changes. Review it again before acknowledging.'); return;
    }
    this.reviewedVersions.delete(key);
  }

  private async reviewAll(): Promise<void> {
    await this.tracker.refresh();
    const batch = [...this.tracker.ledger.changes.values()].filter(change => !this.tracker.document(change.key)?.isDirty);
    if (!batch.length) return;
    const choice = await vscode.window.showWarningMessage(`Mark ${batch.length} disk changes reviewed? This acknowledges changes already on disk; it does not save or revert files.`, { modal: true }, 'Mark Reviewed');
    if (choice !== 'Mark Reviewed') return;
    let marked = 0;
    for (const change of batch) if (await this.tracker.acknowledge(change.key, change.revision)) { this.reviewedVersions.delete(change.key); marked++; }
    this.progress = `Marked ${marked} disk changes reviewed${marked < batch.length ? '; newer changes remain' : ''}.`; this.update();
  }

  private async saveFile(uri?: vscode.Uri): Promise<void> {
    if (!uri || this.saving) return;
    await this.tracker.refresh();
    if (this.saving) return;
    const key = keyOf(uri);
    const document = this.tracker.document(key);
    if (!document?.isDirty) return;
    if (this.tracker.ledger.changes.has(key)) { await this.diff(uri); return; }
    if (document.isUntitled) {
      this.saving = true; this.update();
      try { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.saveAs'); }
      finally { this.saving = false; this.update(); }
      return;
    }
    await this.saveAll(new Set([key]));
  }

  private async saveAll(only?: ReadonlySet<string>): Promise<void> {
    if (this.saving) return;
    // Lock before asynchronous reconciliation, including single-file commands.
    this.saving = true; this.stopRequested = false; this.clearNotificationTimers(); this.update();
    try {
      const candidates = this.tracker.dirty.filter(document => !only || only.has(keyOf(document.uri)))
        .map(document => ({ key: keyOf(document.uri), version: document.version, needsLocation: document.isUntitled }));
      const versions = new Map(candidates.map(candidate => [candidate.key, candidate.version]));
      await this.tracker.refresh();
      if (!candidates.length) { this.progress = 'No unsaved editor files.'; return; }
      this.results = await vscode.window.withProgress({ location: { viewId: 'savepilot.changes' }, title: 'Saving editor changes' }, async () => saveBatch(candidates, {
        current: key => { const document = this.tracker.document(key); return document ? { version: document.version, dirty: document.isDirty } : undefined; },
        conflict: key => this.tracker.ledger.changes.has(key) || this.tracker.hasPendingActivity(key),
        save: async key => {
          await this.tracker.refresh();
          if (this.tracker.ledger.changes.has(key) || this.tracker.hasPendingActivity(key)) throw new Error('Disk changed before saving. Compare and resolve this file.');
          const document = this.tracker.document(key);
          if (!document || document.version !== versions.get(key)) return false;
          return document.save();
        },
        canceled: () => this.disposed || this.stopRequested,
        report: (completed, total) => { this.progress = `Saving ${completed} of ${total}…`; this.update(); }
      }));
      const saved = this.results.filter(result => result.outcome === 'saved').length;
      const clean = this.results.filter(result => result.outcome === 'clean').length;
      const remaining = this.results.length - saved - clean;
      this.progress = `Saved ${saved} file${saved === 1 ? '' : 's'}${remaining ? ` · ${remaining} need attention` : ''}.`;
      if (clean) this.progress += ` ${clean} no longer pending.`;
      if (!remaining && this.tracker.dirty.length) this.progress += ` ${this.tracker.dirty.length} files still unsaved.`;
      this.output.appendLine(this.progress);
      for (const result of this.results) {
        const path = vscode.workspace.asRelativePath(vscode.Uri.parse(result.candidate.key), true);
        const reason = result.error ?? ({ saved: 'Saved', clean: 'No longer pending; not saved by this batch', failed: 'Save failed or canceled; retry', changed: 'Newer editor changes remain', conflict: 'Editor and disk both changed; compare and resolve', location: 'Choose a location using Save File', canceled: 'Not attempted' }[result.outcome]);
        if (result.outcome !== 'saved' && result.outcome !== 'clean') this.tracker.errors.set(result.candidate.key, reason);
        this.output.appendLine(`${path}: ${reason}`);
      }
      if (remaining && !this.disposed) {
        const failed = new Set(this.results.filter(result => result.outcome === 'failed').map(result => result.candidate.key));
        void vscode.window.showWarningMessage(`SavePilot saved ${saved} files. ${remaining} need attention.`, 'Review Issues', ...(failed.size ? ['Retry Failed'] : []))
          .then(choice => this.run(async () => {
            if (this.disposed) return;
            if (choice === 'Review Issues') { await vscode.commands.executeCommand('savepilot.changes.focus'); this.output.show(true); }
            else if (choice === 'Retry Failed') await this.saveAll(failed);
          }));
      }
    } finally { this.saving = false; this.tracker.changed(); this.update(); }
  }

  dispose(): void {
    this.disposed = true; this.clearNotificationTimers();
    for (const disposable of this.disposables.reverse()) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void { context.subscriptions.push(new SavePilot(context)); }
export function deactivate(): void { /* Restoring settings requires the explicit restore command. */ }
