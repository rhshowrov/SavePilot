import * as vscode from 'vscode';

interface PreviousSetting { readonly value?: string }
const stateKey = 'savepilot.previousAutoSave.v1';

/** Own only the workspace override we created; never change a global preference. */
export class AutoSaveProtection {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly context: vscode.ExtensionContext) {}

  synchronize(): Promise<void> {
    return this.enqueue(async () => {
      if (!vscode.workspace.workspaceFolders?.length || !vscode.workspace.isTrusted) return;
      const config = vscode.workspace.getConfiguration('savepilot');
      if (config.get<boolean>('autoSaveProtection', false)) await this.enable();
      else if (config.get<boolean>('restoreAutoSave', true)) await this.restore();
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.pending.then(action);
    this.pending = next.catch(() => undefined);
    return next;
  }

  observeSettingChange(): Promise<void> {
    return this.enqueue(async () => {
      if (this.context.workspaceState.get<PreviousSetting>(stateKey)
        && vscode.workspace.getConfiguration('files').inspect<string>('autoSave')?.workspaceValue !== 'off') {
        await this.context.workspaceState.update(stateKey, undefined);
      }
    });
  }

  private async enable(): Promise<void> {
    if (this.context.workspaceState.get<PreviousSetting>(stateKey)) return;
    const files = vscode.workspace.getConfiguration('files');
    if (files.get<string>('autoSave') === 'off') return;
    const value = files.inspect<string>('autoSave')?.workspaceValue;
    // Record first: restoration remains available if the setting update fails halfway.
    const previous: PreviousSetting = value === undefined ? {} : { value };
    await this.context.workspaceState.update(stateKey, previous);
    try { await files.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace); }
    catch (error) { await this.context.workspaceState.update(stateKey, undefined); throw error; }
  }

  private async restore(): Promise<void> {
    const previous = this.context.workspaceState.get<PreviousSetting>(stateKey);
    if (!previous) return;
    const files = vscode.workspace.getConfiguration('files');
    if (files.inspect<string>('autoSave')?.workspaceValue !== 'off') {
      await this.context.workspaceState.update(stateKey, undefined);
      void vscode.window.showInformationMessage('SavePilot kept your newer Auto Save setting.');
      return;
    }
    await files.update('autoSave', previous.value, vscode.ConfigurationTarget.Workspace);
    await this.context.workspaceState.update(stateKey, undefined);
  }

  async requestEnable(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) { void vscode.window.showInformationMessage('Open a workspace folder first.'); return; }
    if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('Trust this workspace before enabling Auto Save protection.'); return; }
    const choice = await vscode.window.showInformationMessage(
      'Turn off editor Auto Save in this workspace? Programs and AI agents can still write directly to disk.',
      { modal: true }, 'Enable for Workspace');
    if (choice !== 'Enable for Workspace') return;
    await vscode.workspace.getConfiguration('savepilot').update('autoSaveProtection', true, vscode.ConfigurationTarget.Workspace);
    await this.synchronize();
  }

  async requestRestore(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    // Explicit restore works even when automatic restoration is disabled.
    await vscode.workspace.getConfiguration('savepilot').update('autoSaveProtection', false, vscode.ConfigurationTarget.Workspace);
    await this.enqueue(() => this.restore());
  }
}
