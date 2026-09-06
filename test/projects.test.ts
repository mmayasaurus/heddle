import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectRegistry, projectForAgent, projectForCwd } from '../src/projects.js';
import type { ProjectRegistry } from '../src/projects.js';
import { useTempResources } from './helpers.js';

const SPINVENTORY_AGENTS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
  '1', '2', '3', '4', '5', '6',
];

const validRegistry = {
  schemaVersion: 1,
  projects: [
    {
      name: 'Spinventory',
      workspaceRoots: ['/Users/maya/dev/Spinventory-Rebuild-App'],
      agentIds: SPINVENTORY_AGENTS,
      linearTeam: 'SPI',
      defaultRoom: '#spinventory',
      launcher: 'resume-sessions-spi.sh',
      tracker: 'linear',
    },
    {
      name: 'heddle',
      workspaceRoots: ['/Users/maya/dev/heddle', '/Users/maya/dev/heddle-dashboard'],
      agentIds: ['R', 'S', 'T', 'U', 'V', 'W'],
      linearTeam: 'HED',
      defaultRoom: '#heddle',
      launcher: 'resume-sessions-hed.sh',
      tracker: 'linear',
    },
  ],
};

describe('loadProjectRegistry', () => {
  const { tempDir } = useTempResources('heddle-projects-test-');

  it('returns an empty registry when the file is absent', () => {
    const path = join(tempDir(), 'missing.json');
    expect(loadProjectRegistry(path)).toEqual({ schemaVersion: 1, projects: [] });
  });

  it('parses a valid two-project registry', () => {
    const path = join(tempDir(), 'projects.json');
    writeFileSync(path, JSON.stringify(validRegistry));
    expect(loadProjectRegistry(path)).toEqual(validRegistry);
  });

  it('throws naming the found and expected schemaVersion when missing', () => {
    const path = join(tempDir(), 'no-version.json');
    writeFileSync(path, JSON.stringify({ projects: [] }));
    expect(() => loadProjectRegistry(path)).toThrow(/schemaVersion undefined, expected 1/);
  });

  it('throws naming the found and expected schemaVersion when it does not match', () => {
    const path = join(tempDir(), 'wrong-version.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, projects: [] }));
    expect(() => loadProjectRegistry(path)).toThrow(/schemaVersion 2, expected 1/);
  });

  it('throws on unparseable JSON', () => {
    const path = join(tempDir(), 'bad.json');
    writeFileSync(path, '{not json');
    expect(() => loadProjectRegistry(path)).toThrow(/not valid JSON/);
  });

  it('throws when a project is missing a required field', () => {
    const path = join(tempDir(), 'missing-field.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ workspaceRoots: ['/x'], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/projects\[0\]\.name/);
  });

  it('throws when a project has a non-array workspaceRoots', () => {
    const path = join(tempDir(), 'bad-roots.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: '/x', agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.workspaceRoots must be a non-empty array of non-blank strings/);
  });

  it('throws when a project has a non-array agentIds', () => {
    const path = join(tempDir(), 'bad-agents.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['/x'], agentIds: 'A', linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.agentIds must be a non-empty array of non-blank strings/);
  });

  it('throws when a workspaceRoots element is an empty/blank string', () => {
    const path = join(tempDir(), 'blank-root.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['/x', '   '], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    // A blank element must be rejected outright — an empty/blank workspaceRoot resolves to cwd, which is dangerous.
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.workspaceRoots must be a non-empty array of non-blank strings/);
  });

  it('throws when an agentIds element is an empty string', () => {
    const path = join(tempDir(), 'blank-agent.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['/x'], agentIds: ['A', ''], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.agentIds must be a non-empty array of non-blank strings/);
  });

  it('throws naming a non-absolute workspaceRoot', () => {
    const path = join(tempDir(), 'relative-root.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['relative/path'], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.workspaceRoots contains a non-absolute path "relative\/path"/);
  });

  it('normalizes workspaceRoots to resolved absolute paths at load', () => {
    const path = join(tempDir(), 'unnormalized-root.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['/a/./b/../c'], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(loadProjectRegistry(path).projects[0].workspaceRoots).toEqual(['/a/c']);
  });

  it('throws when an agent id is claimed by more than one project', () => {
    const path = join(tempDir(), 'dup-agent.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [
        { name: 'X', workspaceRoots: ['/x'], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' },
        { name: 'Y', workspaceRoots: ['/y'], agentIds: ['A'], linearTeam: 'Y', defaultRoom: '#y', launcher: 'y.sh' },
      ],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/agent id "A" is claimed by both "X" and "Y"/);
  });

  it('throws on a case-only-differing duplicate agent id across projects', () => {
    const path = join(tempDir(), 'dup-agent-case.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [
        { name: 'X', workspaceRoots: ['/x'], agentIds: ['A'], linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' },
        { name: 'Y', workspaceRoots: ['/y'], agentIds: ['a'], linearTeam: 'Y', defaultRoom: '#y', launcher: 'y.sh' },
      ],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/agent id "a" is claimed by both "X" and "Y"/);
  });

  it('throws a distinct error for a present-but-unreadable file (not "not valid JSON", not an empty registry)', () => {
    // A directory at `path` makes existsSync true (present) but readFileSync throw EISDIR (unreadable).
    const dirPath = tempDir();
    expect(() => loadProjectRegistry(dirPath)).toThrow(/exists but could not be read/);
    expect(() => loadProjectRegistry(dirPath)).not.toThrow(/not valid JSON/);
  });

  it('returns an empty registry (indistinguishable from absent) when the file is present with zero projects', () => {
    // Documents why cli.ts's `projects` case needs its own existsSync check: the loader alone
    // cannot tell "absent" from "present but empty" apart — both come back as { projects: [] }.
    const path = join(tempDir(), 'empty-projects.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, projects: [] }));
    expect(loadProjectRegistry(path)).toEqual({ schemaVersion: 1, projects: [] });
  });
});

describe('tracker field (HED-408)', () => {
  const { tempDir } = useTempResources('heddle-tracker-test-');
  const write = (extra: Record<string, unknown>): string => {
    const path = join(tempDir(), 'projects.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'P', workspaceRoots: ['/p'], agentIds: ['A'], linearTeam: 'P', defaultRoom: '#p', launcher: 'p.sh', ...extra }],
    }));
    return path;
  };

  it('defaults to linear when tracker is absent (pre-HED-408 registries load unchanged)', () => {
    expect(loadProjectRegistry(write({})).projects[0].tracker).toBe('linear');
  });

  it('carries an explicit tracker value', () => {
    expect(loadProjectRegistry(write({ tracker: 'github' })).projects[0].tracker).toBe('github');
    expect(loadProjectRegistry(write({ tracker: 'linear' })).projects[0].tracker).toBe('linear');
  });

  it('throws loudly on an unknown tracker value (hand-edit typo)', () => {
    expect(() => loadProjectRegistry(write({ tracker: 'jira' }))).toThrow(/tracker must be one of/);
  });
});

describe('projectForCwd', () => {
  const { tempDir } = useTempResources('heddle-projectforcwd-test-');
  const reg: ProjectRegistry = {
    schemaVersion: 1,
    projects: [
      { name: 'Outer', workspaceRoots: ['/a'], agentIds: ['A'], linearTeam: 'OUT', defaultRoom: '#outer', launcher: 'outer.sh', tracker: 'linear' },
      { name: 'Inner', workspaceRoots: ['/a/b'], agentIds: ['B'], linearTeam: 'IN', defaultRoom: '#inner', launcher: 'inner.sh', tracker: 'linear' },
    ],
  };

  it('matches an exact root', () => {
    expect(projectForCwd(reg, '/a')?.name).toBe('Outer');
  });

  it('matches a cwd nested under a root', () => {
    expect(projectForCwd(reg, '/a/x/y')?.name).toBe('Outer');
  });

  it('picks the LONGEST matching root when roots nest', () => {
    expect(projectForCwd(reg, '/a/b/c')?.name).toBe('Inner');
  });

  it('does not match a root that only shares a string prefix, not a path segment', () => {
    // root /a/foo must not match cwd /a/foobar — isolated registry so nothing else can match instead.
    const onlyFoo: ProjectRegistry = {
      schemaVersion: 1,
      projects: [{ name: 'Foo', workspaceRoots: ['/a/foo'], agentIds: ['F'], linearTeam: 'FOO', defaultRoom: '#foo', launcher: 'foo.sh', tracker: 'linear' }],
    };
    expect(projectForCwd(onlyFoo, '/a/foobar')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(projectForCwd(reg, '/z/unrelated')).toBeNull();
  });

  it('matches a differently-cased cwd against a registered root (case-insensitive filesystem tradeoff)', () => {
    expect(projectForCwd(reg, '/A/x')?.name).toBe('Outer');
  });

  it('canonicalizes symlinks so a symlinked cwd matches its real registered root', () => {
    // Portable — no reliance on the OS's own /tmp→/private or /var symlink (CI is Linux): build a
    // real dir plus a symlink pointing at it, both inside the temp dir. Register the REAL dir as the
    // root; look it up through the SYMLINK path. Both sides realpath to the same place → they match.
    const base = tempDir();
    const realRoot = join(base, 'real-project');
    const linkRoot = join(base, 'linked-project');
    mkdirSync(join(realRoot, 'sub'), { recursive: true });
    symlinkSync(realRoot, linkRoot); // linkRoot → realRoot

    // Register through the real loader so the root is canonicalized at load, exactly like production
    // (a literal registry would skip toProject's canonicalize and defeat the point of the test).
    const path = join(base, 'projects.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'Real', workspaceRoots: [realRoot], agentIds: ['A'], linearTeam: 'R', defaultRoom: '#r', launcher: 'r.sh' }],
    }));
    const symlinkReg = loadProjectRegistry(path);

    // Exact symlinked root, and a real path reached through the symlink, both resolve to realRoot.
    expect(projectForCwd(symlinkReg, linkRoot)?.name).toBe('Real');
    expect(projectForCwd(symlinkReg, join(linkRoot, 'sub'))?.name).toBe('Real');
  });
});

describe('projectForAgent', () => {
  const reg: ProjectRegistry = {
    schemaVersion: 1,
    projects: [
      { name: 'Spinventory', workspaceRoots: ['/x'], agentIds: ['A', 'B'], linearTeam: 'SPI', defaultRoom: '#spinventory', launcher: 'spi.sh', tracker: 'linear' },
      { name: 'heddle', workspaceRoots: ['/y'], agentIds: ['R', 'S'], linearTeam: 'HED', defaultRoom: '#heddle', launcher: 'hed.sh', tracker: 'linear' },
    ],
  };

  it('finds the project owning an agent id', () => {
    expect(projectForAgent(reg, 'R')?.name).toBe('heddle');
  });

  it('matches letters case-insensitively', () => {
    expect(projectForAgent(reg, 'r')?.name).toBe('heddle');
    expect(projectForAgent(reg, 'a')?.name).toBe('Spinventory');
  });

  it('returns null when no project has the agent id', () => {
    expect(projectForAgent(reg, 'Z')).toBeNull();
  });
});
