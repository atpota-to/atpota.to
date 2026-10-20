import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SET = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lexicons/to/atpota/authFull.json'), 'utf8')) as {
  defs: { main: { permissions: { resource: string; collection?: string[]; lxm?: string[]; action?: string[]; aud?: string }[] } };
};

export const AUTH_FULL = SET.defs.main;

/** The actions atpotato's permission set grants on a collection, or null if it doesn't name it. */
export function grants(collection: string): string[] | null {
  const p = AUTH_FULL.permissions.find((perm) => perm.resource === 'repo' && perm.collection?.includes(collection));
  return p ? (p.action ?? ['create', 'update', 'delete']) : null;
}
