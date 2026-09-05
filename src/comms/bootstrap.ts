import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseAddress } from './address.js';
import { CommsLog, DEFAULT_COMMS_PATH, DEFAULT_ROOM } from './log.js';
import { DEFAULT_PROJECTS_PATH, loadProjectRegistry } from '../projects.js';
import { initOperatorToken, OPERATOR_TOKEN_PATH } from './server.js';

export interface CommsBootstrapOptions {
  commsDbPath?: string;
  operatorTokenPath?: string;
  projectsPath?: string;
}

export interface CommsBootstrapResult {
  commsDb: { path: string; existed: boolean };
  operatorToken: { path: string; action: 'created' | 'rotated' | 'kept' };
  rooms: { name: string; created: boolean }[];
  skippedProjectRooms: { name: string; reason: string }[];
  registryError: string | null;
}

/** Ensure the durable comms prerequisites without rotating the operator trust root. */
export function bootstrapComms(opts: CommsBootstrapOptions = {}): CommsBootstrapResult {
  // Resolve the db the SAME way createCommsServer does (server.ts: env.HEDDLE_COMMS_DB ||
  // DEFAULT_COMMS_PATH) so `heddle comms init` provisions exactly the file the broker will open —
  // an explicit opts path (tests) still wins. `||` matches the server: an empty env value falls back.
  const commsDbPath = opts.commsDbPath ?? (process.env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
  const operatorTokenPath = opts.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
  const projectsPath = opts.projectsPath ?? DEFAULT_PROJECTS_PATH;
  // Provision the comms dir owner-only, but only when THIS call creates it: mkdir-recursive never
  // re-modes an existing directory, so a machine's existing ~/.heddle keeps its mode and only a
  // fresh (e.g. a new pack user's) one is hardened to 0700. The operator token is 0600 regardless.
  mkdirSync(dirname(commsDbPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(operatorTokenPath), { recursive: true, mode: 0o700 });
  const existed = existsSync(commsDbPath);
  const log = new CommsLog(commsDbPath);

  try {
    const operatorToken = initOperatorToken({ path: operatorTokenPath, rotate: false });
    const rooms: CommsBootstrapResult['rooms'] = [];
    const skippedProjectRooms: CommsBootstrapResult['skippedProjectRooms'] = [];

    const fleetExisted = log.room(DEFAULT_ROOM) !== null;
    log.ensureDefaultRooms();
    rooms.push({ name: DEFAULT_ROOM, created: !fleetExisted });

    let registryError: string | null = null;
    let projects: ReturnType<typeof loadProjectRegistry>['projects'] = [];
    try {
      projects = loadProjectRegistry(projectsPath).projects;
    } catch (err) {
      registryError = (err as Error).message;
    }

    for (const project of projects) {
      if (parseAddress(project.defaultRoom)?.kind !== 'room') {
        skippedProjectRooms.push({ name: project.defaultRoom, reason: 'defaultRoom is not a valid room address' });
        continue;
      }
      const existing = log.room(project.defaultRoom);
      if (existing && !existing.open) {
        // A pre-existing CLOSED room is not reopened here: createRoom is ON CONFLICT DO NOTHING and
        // reopening is broker governance (createRoom's own contract). Report it rather than silently
        // claim a usable room — non-member agents cannot post to a closed room.
        skippedProjectRooms.push({ name: project.defaultRoom, reason: 'room already exists but is closed; left as-is (reopening is broker governance)' });
        continue;
      }
      log.createRoom({ name: project.defaultRoom, by: 'operator', open: true });
      rooms.push({ name: project.defaultRoom, created: existing === null });
    }

    return {
      commsDb: { path: commsDbPath, existed },
      operatorToken,
      rooms,
      skippedProjectRooms,
      registryError,
    };
  } finally {
    log.close();
  }
}
