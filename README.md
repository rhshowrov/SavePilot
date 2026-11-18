# SavePilot

**Your workspace. Your changes. Your control.**

SavePilot is a small VS Code extension for deliberate editor saving and reviewing detected filesystem changes. It works independently of the AI coding agent you use.

## Install and try it

1. In VS Code, run **Extensions: Install from VSIX…**.
2. Select `savepilot-0.1.0.vsix` from this folder.
3. Open the SavePilot Activity Bar icon, or run **SavePilot: Show Changes**.
4. Run **SavePilot: Enable Workspace Auto Save Protection** if you want editor Auto Save turned off here.

The publisher identifier `savepilot-local` is for local development and packaging; this extension has not been published to the Marketplace.

## Everyday use

- **Waiting to save** lists dirty text documents in the current workspace, including unsaved untitled documents while a workspace is open. Documents inside monitoring exclusions remain visible.
- **Already on disk · Review** lists observed filesystem modifications, creations, and deletions that still need acknowledgement.
- Select a row to preview the file. Use **Review Diff** to compare it. Native preview tabs can be pinned by double-clicking their tabs.
- Select a dirty row to access the orange **Save File** button, or use its inline save action.
- **Save All** saves the eligible dirty documents in this workspace. It never rewrites external-only entries. Newly dirty documents are left for the next batch.
- **Mark Reviewed** acknowledges a disk change. It does not save, revert, stage, or commit it. If the file changed since its displayed diff, review it again first.
- **Refresh** reconciles queued events and editor state; it never dismisses review items. It does not reconstruct changes missed while VS Code was closed or monitoring was disabled.

Unsaved content plus an unreviewed disk change is treated conservatively as a conflict. SavePilot skips it in bulk saves. Compare, then use VS Code's normal save/conflict controls to resolve it; alternatively, acknowledge the disk version before beginning new editor edits.

Untitled documents require **Save File** and a native Save As dialog. Bulk save does not open a series of location dialogs. A stopped batch retains completed saves and leaves the rest pending. Save operations still run the editor's usual format-on-save and save participants.

## Orange buttons and themes

SavePilot-owned primary buttons use FieldTask primary **#FF6600**, with **#E65C00** hover. Dark button text maintains readable contrast on orange. Other surfaces, text, selection, focus, and secondary buttons inherit the VS Code theme, including high-contrast themes. Native dialogs, notifications, and toolbar icons keep their theme styling. SavePilot does not modify your global theme to recolor them.

## Auto Save protection

Protection is opt-in and changes only the workspace `files.autoSave` override. The previous explicit value, or the absence of an override, is remembered in workspace state. Turning protection off normally restores it. **SavePilot: Restore Previous Auto Save Setting** also performs an explicit restore when automatic restoration is disabled.

If you change Auto Save afterward, SavePilot relinquishes ownership and preserves your newer choice. Multi-root folder overrides are respected: the controls warn if part of the workspace still has Auto Save enabled. Trust the workspace before enabling protection.

**Protection cannot prevent direct filesystem writes or explicit saves by another extension, agent, or developer.** It does not promise to eliminate all editor performance issues. Restore your preference before uninstalling: crashes, forced shutdown, and uninstall cannot guarantee restoration. If necessary, remove the workspace `files.autoSave` override manually in VS Code Settings.

## Settings

Run **SavePilot: Open Settings**.

| Setting | Default | Behavior |
| --- | --- | --- |
| `savepilot.autoSaveProtection` | `false` | Turn off editor Auto Save at workspace scope |
| `savepilot.restoreAutoSave` | `true` | Restore previous setting when protection is turned off |
| `savepilot.notifications` | `consolidated` | `consolidated`, `badgeOnly`, or `off` |
| `savepilot.notificationQuietPeriod` | `3` | Seconds of quiet before notifying; maximum batch delay is 15 seconds |
| `savepilot.externalMonitoring` | `true` | Monitor filesystem events in trusted workspaces |
| `savepilot.excludedDirectories` | Dependency/build/VCS folders | Workspace-relative globs for external monitoring only |

Consolidated notifications appear once per pending batch, with **Review Changes** and **Save All** when relevant. Opening the SavePilot list suppresses the activity toast. New changes while that same batch remains pending update the list and badge without repeated notifications. A stale notification never saves an expanded or edited batch automatically.

## Monitoring and review limits

- Monitoring begins after activation and only covers events delivered by VS Code. External tools are not reliably identifiable; a disk event is not proof of a particular actor.
- One initial inventory enumerates at most **20,000 file paths**, without reading their contents, to recognize file and directory deletions. An incomplete inventory is reported. Watcher support depends on the filesystem provider and VS Code's watcher settings.
- Filesystem events are coalesced for 200 ms and processed with at most four reads in flight. Queues are capped at **5,000 entries**; overflow is reported rather than showing an all-clear state.
- Prior text snapshots exist only for opened/reviewed files and some observed creations. Existing unopened files may have **no previous version** available. SavePilot does not silently substitute a Git baseline.
- Each text snapshot is limited to **512 KiB**. The baseline cache is capped at **8 MiB**, and diff snapshots at **16 MiB**, with least-recently-used eviction. Binary and non-UTF-8 files remain listed but do not get text diffs.
- Filesystem history and file content snapshots are **session-only**, not persisted. There is no telemetry, external service, AI-agent integration, or file-content upload.
- A baseline can expire. Reopening a diff explains this; the extension does not claim full history or backups.
- SavePilot cannot freeze an actively editing agent. It checks document versions and known conflicts before saving, and checks final dirty status afterward. VS Code provides final disk conflict detection.
- This version tracks text documents. Notebook and custom-editor save lifecycles are not included.

## Development

Use **Node.js 22.15+ or 24** for the development tools. The packaged extension targets VS Code **1.96+** and its Node 20 extension host.

```bash
npm ci
npm run build
npm test
npm run test:integration
npm run package
```

Press **F5** to run the extension in an Extension Development Host. Build output is a single bundled extension file; there is no frontend framework and no runtime `node_modules` directory to ship.

Integration tests launch a separate VS Code profile and disposable workspace, with a 120-second timeout. Set `VSCODE_EXECUTABLE` if VS Code is not on PATH or in the detected Linux Snap location. Linux tests require `xvfb-run`. They change settings and files only inside the temporary test profile/workspace. Electron needs permission to run outside restrictive process sandboxes.

The automated suite covers save-batch safety, partial failures, cancellation, bounded snapshots, stale review versions, native diff commands, actual editor saves, external-write conflicts, exclusions, external creation/deletion, and Auto Save restoration. Interactive accessibility, theme appearance, multi-root, remote providers, and platform-specific behavior should also be checked manually before a public release.

## License

All rights reserved. This private development project is not currently licensed for redistribution.
