import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'savepilot-host-'));
const workspace = join(root, 'workspace');
await mkdir(join(workspace, 'node_modules'), { recursive: true });
await Promise.all([
  writeFile(join(workspace, 'first.txt'), 'first baseline\n'),
  writeFile(join(workspace, 'second.txt'), 'second baseline\n'),
  writeFile(join(workspace, 'node_modules', 'fixture.txt'), 'excluded baseline\n')
]);
const executable = process.env.VSCODE_EXECUTABLE ?? (existsSync('/snap/code/current/usr/share/code/code') ? '/snap/code/current/usr/share/code/code' : 'code');
const args = ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  '--user-data-dir', join(root, 'profile'), '--extensions-dir', join(root, 'extensions'),
  `--extensionDevelopmentPath=${resolve('.')}`, `--extensionTestsPath=${resolve('dist/extension.host.js')}`, workspace];
const headless = process.platform === 'linux';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(headless ? 'xvfb-run' : executable, headless ? ['-a', executable, ...args] : args, { stdio: 'inherit', env });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120_000);
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  clearTimeout(timer);
  if (code !== 0) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
