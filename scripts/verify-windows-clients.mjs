// Native CLI launch canary. Run only on a disposable Windows x64 runner with Node 22+.
// Usage: node scripts/verify-windows-clients.mjs
// Installs into RUNNER_TEMP only; never changes user/machine PATH or performs provider login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnProbe } from '../dist/adapters/subprocess.js';

async function main() {
  assert.equal(process.platform, 'win32', 'Run this artifact on native Windows only');
  assert.equal(process.arch, 'x64', 'The pinned Cursor archive is Windows x64');
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22+ is required');
  assert(process.env.RUNNER_TEMP, 'Use a disposable CI runner with RUNNER_TEMP');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const cli = join(repo, 'dist', 'cli.js');
  assert(existsSync(cli), 'Build Heddle before running the smoke');
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot && /^[a-z]:[\\/]/i.test(systemRoot), 'An absolute SystemRoot is required');
  const node = process.execPath;
  const npm = join(dirname(node), 'npm.cmd');
  assert(existsSync(npm), 'Expected the official Node installation to include npm.cmd');
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'heddle-provider-smoke-'));
  const prefix = join(root, 'npm-prefix');
  const smokeHome = join(root, 'home');
  const localAppData = join(smokeHome, 'AppData', 'Local');
  const cursorRoot = join(localAppData, 'cursor-agent');
  const cursorVersion = '2026.09.10-fd3934a';
  const emptyNpmConfig = join(root, 'empty.npmrc');
  const npmGlobalConfig = join(root, 'empty-global.npmrc');
  const infrastructure = Object.fromEntries([
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive',
  ].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  const env = {
    ...infrastructure,
    SystemRoot: systemRoot, WINDIR: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [prefix, cursorRoot, dirname(node), join(systemRoot, 'System32'), dirname(powershell)].join(';'),
    HOME: smokeHome, USERPROFILE: smokeHome,
    HOMEDRIVE: smokeHome.slice(0, 2), HOMEPATH: smokeHome.slice(2),
    APPDATA: join(smokeHome, 'AppData', 'Roaming'), LOCALAPPDATA: localAppData,
    TEMP: root, TMP: root,
    XDG_CONFIG_HOME: join(smokeHome, '.config'), XDG_CACHE_HOME: join(smokeHome, '.cache'),
    XDG_DATA_HOME: join(smokeHome, '.local', 'share'), XDG_STATE_HOME: join(smokeHome, '.local', 'state'),
    CODEX_HOME: join(smokeHome, '.codex'), CURSOR_CONFIG_DIR: join(smokeHome, '.cursor'),
    NPM_CONFIG_USERCONFIG: emptyNpmConfig, NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    HEDDLE_PROJECTS: join(root, 'projects.json'), HEDDLE_COMMS_DB: join(root, 'comms.db'),
    HEDDLE_LEDGER_DB: join(root, 'ledger.db'), CI: 'true', NO_COLOR: '1', TERM: 'dumb',
  };
  // No spread of process.env: provider/API/cloud credentials and existing account selectors stay out.
  async function checked(label, executable, args, timeoutMs, cwd = root, stdin = '') {
    try {
      const result = await spawnProbe(executable, args, { cwd, env, stdin, timeoutMs, maxStreamBytes: 1024 * 1024 });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(`${label} failed: exit=${result.exitCode}, timedOut=${result.timedOut}\n${result.stdout}\n${result.stderr}`);
      }
      return result;
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The empty root has no credential contents. Establish the same explicit SID/inheritable-DACL
  // fixture contract as the Windows tests, including elevated runner tokens with an admin default owner.
  const privateRootScript = `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$Root = [Console]::In.ReadLine()
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[IO.Directory]::SetAccessControl($Root, $acl)
`;
  await checked('private temporary root', powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', privateRootScript], 30_000, repo, root + '\n');
  for (const path of [prefix, smokeHome, localAppData, env.APPDATA, env.TEMP, env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.CODEX_HOME, env.CURSOR_CONFIG_DIR]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(emptyNpmConfig, '');
  writeFileSync(npmGlobalConfig, '');
  writeFileSync(env.HEDDLE_PROJECTS, '[]\n');

  const packages = [
    { name: '@openai/codex', version: '0.154.0' },
    { name: 'opencode-ai', version: '1.18.31' },
    { name: '@google/gemini-cli', version: '0.60.0' },
  ];
  await checked('pinned npm CLI install', npm, ['install', '--global', '--prefix', prefix,
    '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--fetch-retries=1', '--fetch-timeout=60000',
    ...packages.map(({ name, version }) => `${name}@${version}`)], 300_000);
  for (const { name, version } of packages) {
    const manifest = JSON.parse(readFileSync(join(prefix, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
    assert.equal(manifest.version, version, `${name} installed an unexpected version`);
  }

  const cursorUrl = `https://downloads.cursor.com/lab/${cursorVersion}/windows/x64/agent-cli-package.zip`;
  const response = await fetch(cursorUrl, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `Cursor download returned HTTP ${response.status}`);
  const archiveLength = Number(response.headers.get('content-length'));
  assert(archiveLength > 0 && archiveLength <= 128 * 1024 * 1024, 'Unexpected Cursor download length');
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.length, archiveLength, 'Cursor archive length does not match its response header');
  const archivePath = join(root, 'cursor-package.zip');
  writeFileSync(archivePath, archive);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const cursorVersions = join(cursorRoot, 'versions');
  mkdirSync(cursorVersions, { recursive: true });
  // Use the Framework ZIP API without Utility/Archive module discovery. Paths are data on stdin.
  const extractScript = `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.IO.Compression.FileSystem, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
$archive = [Console]::In.ReadLine()
$destination = [Console]::In.ReadLine()
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
[Console]::Out.Write('CURSOR_ARCHIVE_EXTRACTED')
`;
  const extracted = await checked('unpack pinned Cursor archive', powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass',
      '-Command', extractScript], 60_000, root, `${archivePath}\n${cursorVersions}\n`);
  assert.equal(extracted.stdout.trim(), 'CURSOR_ARCHIVE_EXTRACTED', 'Cursor extraction did not report completion');
  const cursorPackage = join(cursorVersions, 'dist-package');
  const packageFiles = existsSync(cursorPackage) ? readdirSync(cursorPackage) : [];
  const missing = ['node.exe', 'index.js', 'cursor-agent.cmd', 'cursor-agent.ps1'].filter((name) => !packageFiles.includes(name));
  assert.equal(missing.length, 0, `Cursor archive is missing ${missing.join(', ')}; extracted roots: ${readdirSync(cursorVersions).join(', ')}; package files: ${packageFiles.join(', ')}`);
  // Match the official installer's versions/<version> layout and parent-level launchers.
  renameSync(cursorPackage, join(cursorVersions, cursorVersion));
  for (const launcher of ['cursor-agent.cmd', 'cursor-agent.ps1']) {
    copyFileSync(join(cursorVersions, cursorVersion, launcher), join(cursorRoot, launcher));
  }

  const clients = [
    { client: 'codex', bin: join(prefix, 'codex.cmd'), version: '0.154.0' },
    { client: 'cursor', bin: join(cursorRoot, 'cursor-agent.cmd'), version: cursorVersion },
    { client: 'opencode', bin: join(prefix, 'opencode.cmd'), version: '1.18.31' },
    { client: 'gemini', bin: join(prefix, 'gemini.cmd'), version: '0.60.0' },
  ];
  const results = [];
  for (const { client, bin, version } of clients) {
    assert(existsSync(bin), `${client} native Windows shim is missing: ${bin}`);
    // Spaces deliberately exercise the native shim/argument path, without arbitrary cmd metacharacters.
    const workspace = join(root, `workspace ${client}`);
    mkdirSync(workspace);
    const result = await checked(`${client} through Heddle`, node,
      ['--disable-warning=ExperimentalWarning', cli, 'launch', client, '--dir', workspace,
        '--agent', 'codex-d', '--bin', bin, '--', '--version'], 45_000, workspace);
    const versionPattern = new RegExp(`(?:^|\\s)${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`);
    assert(versionPattern.test(result.stdout), `${client} did not report its pinned version on stdout: ${result.stdout}`);
    const record = { client, expectedVersion: version, stdout: result.stdout.trim(), exitCode: result.exitCode };
    results.push(record);
    process.stdout.write(JSON.stringify(record) + '\n');
  }
  writeFileSync(join(root, 'smoke-results.json'), JSON.stringify({ cursorUrl, archiveSha256, results }, null, 2) + '\n');
  process.stdout.write(`PASS: four pinned provider CLIs launched through Heddle; artifacts retained at ${root}\n`);
  process.stdout.write(`Cursor archive SHA-256 (observed, not an independent authenticity proof): ${archiveSha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
