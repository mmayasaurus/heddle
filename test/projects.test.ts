import { writeFileSync } from 'node:fs';
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
    },
    {
      name: 'heddle',
      workspaceRoots: ['/Users/maya/dev/heddle', '/Users/maya/dev/heddle-dashboard'],
      agentIds: ['R', 'S', 'T', 'U', 'V', 'W'],
      linearTeam: 'HED',
      defaultRoom: '#heddle',
      launcher: 'resume-sessions-hed.sh',
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
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.workspaceRoots must be an array of strings/);
  });

  it('throws when a project has a non-array agentIds', () => {
    const path = join(tempDir(), 'bad-agents.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      projects: [{ name: 'X', workspaceRoots: ['/x'], agentIds: 'A', linearTeam: 'X', defaultRoom: '#x', launcher: 'x.sh' }],
    }));
    expect(() => loadProjectRegistry(path)).toThrow(/project "X"\.agentIds must be an array of strings/);
  });
});

describe('projectForCwd', () => {
  const reg: ProjectRegistry = {
    schemaVersion: 1,
    projects: [
      { name: 'Outer', workspaceRoots: ['/a'], agentIds: ['A'], linearTeam: 'OUT', defaultRoom: '#outer', launcher: 'outer.sh' },
      { name: 'Inner', workspaceRoots: ['/a/b'], agentIds: ['B'], linearTeam: 'IN', defaultRoom: '#inner', launcher: 'inner.sh' },
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
      projects: [{ name: 'Foo', workspaceRoots: ['/a/foo'], agentIds: ['F'], linearTeam: 'FOO', defaultRoom: '#foo', launcher: 'foo.sh' }],
    };
    expect(projectForCwd(onlyFoo, '/a/foobar')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(projectForCwd(reg, '/z/unrelated')).toBeNull();
  });
});

describe('projectForAgent', () => {
  const reg: ProjectRegistry = {
    schemaVersion: 1,
    projects: [
      { name: 'Spinventory', workspaceRoots: ['/x'], agentIds: ['A', 'B'], linearTeam: 'SPI', defaultRoom: '#spinventory', launcher: 'spi.sh' },
      { name: 'heddle', workspaceRoots: ['/y'], agentIds: ['R', 'S'], linearTeam: 'HED', defaultRoom: '#heddle', launcher: 'hed.sh' },
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
