#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { installUsagePollSystemd } from './usage-poll-systemd.js';

// A separate entry point keeps Linux scheduling independent of client/MCP setup.
try {
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'start-interval': { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write('Usage: node dist/usage-poll-systemd-bin.js [--start-interval <seconds>] [--dry-run] [--json]\nInstalls and activates a Linux systemd user timer for usage poll-claude.\n');
  } else {
    if (values['start-interval'] !== undefined && !/^[1-9]\d*$/.test(values['start-interval'])) {
      throw new Error('--start-interval must be a positive integer in seconds');
    }
    const report = installUsagePollSystemd({ dryRun: values['dry-run'],
      startIntervalSecs: values['start-interval'] === undefined ? undefined : Number(values['start-interval']) });
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const file of report.files) {
        process.stdout.write(`${report.dryRun ? 'would ' : ''}${file.action}: ${file.path}\n`);
        if (file.backupPath) process.stdout.write(`backup: ${file.backupPath}\n`);
        if (report.dryRun) process.stdout.write(`${file.contents}\n`);
      }
      for (const command of report.commands) process.stdout.write(`${report.dryRun ? 'would run' : 'ran'}: systemctl --user ${command.join(' ')}\n`);
      process.stdout.write(report.activated ? 'Timer active; use journalctl --user -u io.heddle.usage-poll-claude.service to inspect poll results.\n' : 'Preview only; executable permissions and user-manager state are checked when installing.\n');
    }
  }
} catch (error) {
  process.stderr.write(`usage-poll-systemd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
