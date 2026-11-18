import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${message}`);
}
async function edit(document: vscode.TextDocument, text: string): Promise<void> {
  const change = new vscode.WorkspaceEdit(); change.insert(document.uri, new vscode.Position(0, 0), text);
  assert.equal(await vscode.workspace.applyEdit(change), true);
}

/** Runs inside a completely isolated VS Code profile and disposable workspace. */
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]; assert.ok(folder);
  const config = vscode.workspace.getConfiguration('savepilot');
  await config.update('notifications', 'badgeOnly', vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('files').update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.getExtension('savepilot-local.savepilot'); assert.ok(extension);
  await extension.activate();
  await vscode.commands.executeCommand('savepilot.show');
  await delay(600);

  const first = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'first.txt'));
  const second = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'second.txt'));
  await vscode.window.showTextDocument(first);
  await delay(250);
  await edit(first, 'edited first\n'); await edit(second, 'edited second\n');
  assert.ok(first.isDirty && second.isDirty);
  await vscode.commands.executeCommand('savepilot.diff', first.uri);
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)), 'Native diff opened');
  await vscode.commands.executeCommand('savepilot.saveAll');
  assert.equal(first.isDirty, false); assert.equal(second.isDirty, false);
  assert.match(await readFile(first.uri.fsPath, 'utf8'), /^edited first/);
  console.log('PASS: native sidebar activation, editor diff, and bulk saving');

  await delay(600);
  await edit(first, 'second manual edit\n');
  await vscode.commands.executeCommand('savepilot.saveAll');
  assert.equal(first.isDirty, false, 'Own saves must not create false external conflicts');
  console.log('PASS: own save event suppression');

  // An excluded directory must not hide its dirty editor files.
  const excluded = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'node_modules', 'fixture.txt'));
  await edit(excluded, 'editor change\n');
  await vscode.commands.executeCommand('savepilot.saveAll');
  assert.equal(excluded.isDirty, false);
  console.log('PASS: excluded directories still include unsaved editor documents');

  await delay(500);
  await edit(first, 'pending conflict\n');
  await writeFile(first.uri.fsPath, 'external disk version\n');
  await delay(1000);
  await vscode.commands.executeCommand('savepilot.saveAll');
  assert.equal(first.isDirty, true, 'Save All must skip a disk/editor conflict');
  assert.equal(await readFile(first.uri.fsPath, 'utf8'), 'external disk version\n');
  // Discard only this disposable test document, using the native editor command.
  await vscode.window.showTextDocument(first);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('savepilot.reviewed', first.uri);
  console.log('PASS: direct external writes are preserved and conflicts are skipped');

  const created = vscode.Uri.joinPath(folder.uri, 'external-created.txt');
  await writeFile(created.fsPath, 'created externally\n');
  await delay(800);
  await vscode.commands.executeCommand('savepilot.diff', created);
  let activeDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeDiff instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(activeDiff.original)).getText(), '');
  assert.equal((await vscode.workspace.openTextDocument(activeDiff.modified)).getText(), 'created externally\n');
  await vscode.commands.executeCommand('savepilot.reviewed', created);
  await unlink(created.fsPath);
  await delay(800);
  await vscode.commands.executeCommand('savepilot.diff', created);
  activeDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeDiff instanceof vscode.TabInputTextDiff);
  assert.equal((await vscode.workspace.openTextDocument(activeDiff.original)).getText(), 'created externally\n');
  assert.equal((await vscode.workspace.openTextDocument(activeDiff.modified)).getText(), '');
  await vscode.commands.executeCommand('savepilot.reviewed', created);
  console.log('PASS: external creation and deletion diffs retain accurate baselines');

  const files = vscode.workspace.getConfiguration('files');
  await files.update('autoSave', undefined, vscode.ConfigurationTarget.Workspace);
  await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
  await config.update('autoSaveProtection', true, vscode.ConfigurationTarget.Workspace);
  await until(() => vscode.workspace.getConfiguration('files').inspect<string>('autoSave')?.workspaceValue === 'off', 'workspace protection enabled');
  await config.update('autoSaveProtection', false, vscode.ConfigurationTarget.Workspace);
  await until(() => vscode.workspace.getConfiguration('files').inspect<string>('autoSave')?.workspaceValue === undefined, 'inheritance restored');
  assert.equal(vscode.workspace.getConfiguration('files').get('autoSave'), 'afterDelay');
  console.log('PASS: Auto Save protection restores inherited preferences');

  await config.update('autoSaveProtection', true, vscode.ConfigurationTarget.Workspace);
  await until(() => vscode.workspace.getConfiguration('files').get('autoSave') === 'off', 'protection reenabled');
  await files.update('autoSave', 'onFocusChange', vscode.ConfigurationTarget.Workspace);
  await config.update('autoSaveProtection', false, vscode.ConfigurationTarget.Workspace);
  await delay(500);
  assert.equal(vscode.workspace.getConfiguration('files').inspect<string>('autoSave')?.workspaceValue, 'onFocusChange');
  console.log('PASS: newer manual Auto Save choices are preserved');
  console.log('SavePilot extension-host integration checks passed.');
}
