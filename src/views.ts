import * as vscode from 'vscode';
import { posix } from 'node:path';
import { ChangeTracker, keyOf } from './tracker';
import type { DiskChange } from './model';

type Group = 'unsaved' | 'external';
export type ChangeNode = { readonly type: 'group'; readonly group: Group }
  | { readonly type: 'folder'; readonly group: Group; readonly folder: vscode.WorkspaceFolder }
  | { readonly type: 'file'; readonly uri: vscode.Uri; readonly group: Group };

export function fileUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value && typeof value === 'object' && 'type' in value && value.type === 'file' && 'uri' in value && value.uri instanceof vscode.Uri) return value.uri;
  return undefined;
}

export class ChangesTree implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly tracker: ChangeTracker) { this.subscription = tracker.onDidChange(() => this.emitter.fire(undefined)); }

  private files(group: Group): vscode.Uri[] {
    const dirty = this.tracker.dirty;
    const dirtyKeys = new Set(dirty.map(document => keyOf(document.uri)));
    const files = group === 'unsaved' ? dirty.map(document => document.uri)
      : [...this.tracker.ledger.changes.keys()].filter(key => !dirtyKeys.has(key)).map(key => vscode.Uri.parse(key));
    return files.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (!node) return this.tracker.total ? [{ type: 'group', group: 'unsaved' }, { type: 'group', group: 'external' }] : [];
    if (node.type === 'file') return [];
    const files = this.files(node.group);
    if (node.type === 'folder') return files.filter(uri => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === node.folder.uri.toString())
      .map(uri => ({ type: 'file', uri, group: node.group }));
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => files.some(uri => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()));
      return [...folders.map(folder => ({ type: 'folder' as const, folder, group: node.group })),
        ...files.filter(uri => !vscode.workspace.getWorkspaceFolder(uri)).map(uri => ({ type: 'file' as const, uri, group: node.group }))];
    }
    return files.map(uri => ({ type: 'file', uri, group: node.group }));
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(node.group === 'unsaved' ? 'Waiting to save' : 'Already on disk · Review', vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.group; item.description = String(this.files(node.group).length);
      item.tooltip = node.group === 'external' ? 'These changes have already reached disk. Reviewing does not control saving.' : 'Unsaved editor documents. Save All acts only on this group.';
      return item;
    }
    if (node.type === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${node.group}:${node.folder.uri.toString()}`;
      item.iconPath = vscode.ThemeIcon.Folder; return item;
    }
    const key = keyOf(node.uri);
    const disk = this.tracker.ledger.changes.get(key);
    const document = this.tracker.document(key);
    const dirty = Boolean(document?.isDirty);
    const conflict = dirty && disk !== undefined;
    const item = new vscode.TreeItem(posix.basename(node.uri.path) || document?.fileName || 'Untitled');
    item.id = `${node.group}:${key}`;
    item.resourceUri = node.uri;
    const path = vscode.workspace.asRelativePath(node.uri, true);
    const directory = posix.dirname(path);
    const status = conflict ? 'Editor and disk both changed' : dirty ? document?.isUntitled ? 'New · Not saved' : 'Unsaved' : diskLabel(disk);
    item.description = `${directory === '.' ? '' : `${directory} · `}${status}`;
    item.contextValue = conflict ? 'conflict' : dirty ? 'unsaved' : disk?.kind === 'deleted' ? 'deleted' : 'external';
    item.iconPath = conflict ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : dirty ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(disk?.kind === 'deleted' ? 'diff-removed' : disk?.kind === 'created' ? 'diff-added' : 'file', new vscode.ThemeColor('textLink.foreground'));
    item.tooltip = `${path}\n${status}${this.tracker.errors.has(key) ? `\n${this.tracker.errors.get(key)}` : ''}`;
    item.command = { command: disk?.kind === 'deleted' && !dirty ? 'savepilot.diff' : 'savepilot.open', title: 'Open File', arguments: [node] };
    item.accessibilityInformation = { label: `${item.label as string}, ${path}, ${status}` };
    return item;
  }
  dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}

function diskLabel(change?: DiskChange): string {
  return change?.kind === 'created' ? 'Created on disk' : change?.kind === 'deleted' ? 'Deleted on disk' : 'Modified on disk';
}

export interface ControlState {
  unsaved: number; external: number; total: number; saving: boolean; progress: string;
  autoSave: string; protection: boolean; monitoring: string; issue: string;
  hasWorkspace: boolean; selected: { name: string; state: string; canSave: boolean; canReview: boolean } | null;
}

/** Only the action strip is a webview; navigation and code review stay native. */
export class ControlView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly extensionUri: vscode.Uri, private readonly state: () => ControlState,
    private readonly action: (action: string) => void) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'controls.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'controls.js'));
    const source = view.webview.cspSource;
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source}; script-src ${source};"><link rel="stylesheet" href="${css}"><title>SavePilot workspace control</title></head><body>
      <p id="summary" role="status" aria-live="polite">Checking workspace…</p>
      <div class="actions"><button id="save" data-action="saveAll" class="primary" disabled>Save All</button><button id="stop" data-action="stop" hidden title="Completed saves remain saved">Stop Remaining Saves</button><button data-action="refresh" title="Refresh changes">Refresh</button></div>
      <p id="progress" role="status" aria-live="polite" hidden></p>
      <p class="quiet" id="disk-note">External writes are already on disk.</p>
      <button id="protection" class="text" data-action="protection"></button>
      <p class="quiet" id="monitoring"></p><p id="issue" role="status" hidden></p>
      <section id="selected" hidden aria-label="Selected file"><p id="filename"></p><p class="quiet" id="file-state"></p><div class="actions"><button id="save-file" class="primary" data-action="saveSelected">Save File</button><button data-action="diffSelected">Review Diff</button><button id="reviewed" data-action="reviewedSelected">Mark Reviewed</button></div></section>
      <script src="${js}"></script></body></html>`;
    const allowed = new Set(['saveAll', 'stop', 'refresh', 'protection', 'saveSelected', 'diffSelected', 'reviewedSelected']);
    this.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || !('action' in message) || typeof message.action !== 'string') return;
      if (message.action === 'ready') this.update();
      else if (allowed.has(message.action)) this.action(message.action);
    }), view.onDidChangeVisibility(() => { if (view.visible) this.update(); }), view.onDidDispose(() => { this.view = undefined; }));
  }
  update(): void { if (this.view?.visible) void this.view.webview.postMessage(this.state()); }
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); }
}
