/**
 * Excluded because a tool writing here mid-review is never the reviewer's doing. Match path
 * segments exactly: `.memtraceignore` is tracked configuration, not a tool-runtime artifact.
 */
const TOOL_RUNTIME_DIRS = new Set(['.memdb', '.memtrace', '.serena']);

export const isToolRuntimePath = (rel: string): boolean => rel.split('/').some((seg) => TOOL_RUNTIME_DIRS.has(seg));
