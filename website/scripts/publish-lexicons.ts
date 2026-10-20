/**
 * Publishes the lexicons in lexicons/ (every to.atpota.* schema, and the to.atpota.authFull
 * permission set the sign-in asks for) as com.atproto.lexicon.schema records in atpota.to's
 * repo, so anyone can resolve them:
 *
 *   at://did:plc:qntsxa2i4sb24noi45fx4np2/com.atproto.lexicon.schema/<nsid>
 *
 * Resolution starts from DNS: a schema's NSID minus its last segment, reversed, is its
 * authority domain (to.atpota.garden.tend -> garden.atpota.to), and that domain needs
 *
 *   _lexicon.garden.atpota.to  TXT  "did=did:plc:qntsxa2i4sb24noi45fx4np2"
 *
 * One TXT record per authority domain (atpota.to, garden.atpota.to, poe.atpota.to, ...).
 * DNS isn't on Vercel, so this script can't add them; it checks them and says which to add.
 *
 *   npm run publish:lexicons -- --dry-run   check the files, DNS and what's published; write nothing
 *   ATP_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run publish:lexicons
 *   ... --vercel                            the build step (vercel.json): see below
 *
 * Safe to run again: a schema that already matches is left alone. A file that's gone is not
 * unpublished (others may rely on it); the script only says so.
 *
 * --vercel runs on every Vercel build. Outside production (VERCEL_ENV) it does nothing.
 * In production it publishes when ATP_APP_PASSWORD is set (keep it a Production-only
 * variable, so preview builds of other branches never see it), then checks that every
 * to.atpota permission set the sign-in scope includes (src/blog/auth.ts SCOPE) resolves:
 * DNS points at atpota.to and the published schema matches the file. If not, the build
 * fails, because an authorization server that can't resolve a set refuses every sign-in.
 * Anything else that's off is a warning.
 *
 * Remember that published lexicons are a contract: loosen or add optional fields, and give
 * a schema a new NSID rather than changing what it already allows.
 */

import { resolveTxt } from 'node:dns/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { SCOPE } from '../src/blog/auth.js';
import { canonical, pdsFor, xrpc } from './publish-guides.js';

type Fetch = typeof fetch;

export const LEXICON_DID = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const LEXICON_HANDLE = 'atpota.to';
export const SCHEMA_NSID = 'com.atproto.lexicon.schema';
/** Only this namespace is published from here. */
export const NAMESPACE = 'to.atpota';

const NSID_RE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+\.[a-zA-Z][a-zA-Z0-9]{0,62}$/;
/** Resources a permission set may not carry (the client has to ask for these itself). */
const NOT_IN_SETS = new Set(['blob', 'account', 'identity']);

export interface Lexicon {
  file: string;
  id: string;
  doc: Record<string, unknown>;
}

export interface PublishDeps {
  env?: Record<string, string | undefined>;
  fetch?: Fetch;
  log?: (line: string) => void;
  root?: string;
  txt?: (name: string) => Promise<string[][]>;
}

/** to.atpota.garden.tend -> garden.atpota.to */
export function authorityDomain(nsid: string): string {
  return nsid.split('.').slice(0, -1).reverse().join('.');
}

/** to.atpota.garden.tend -> to.atpota.garden */
function group(nsid: string): string {
  return nsid.split('.').slice(0, -1).join('.');
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith('.json') ? [path] : [];
  });
}

/** Problems with a permission set: anything outside its own NSID group, wildcards, or resources sets can't hold. */
export function permissionSetProblems(id: string, main: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const own = `${group(id)}.`;
  const permissions = Array.isArray(main.permissions) ? (main.permissions as Record<string, unknown>[]) : null;
  if (!permissions?.length) return ['has no permissions'];
  if (typeof main.title !== 'string' || !main.title) problems.push('has no title');
  for (const p of permissions) {
    const resource = String(p?.resource);
    if (p?.type !== 'permission') problems.push('a permission without type "permission"');
    if (NOT_IN_SETS.has(resource)) problems.push(`${resource} permissions can't be in a set`);
    const names = resource === 'repo' ? p.collection : resource === 'rpc' ? p.lxm : null;
    if (!Array.isArray(names) || !names.length) {
      problems.push(`a ${resource} permission names nothing`);
      continue;
    }
    for (const name of names as unknown[]) {
      if (typeof name !== 'string' || name === '*' || !NSID_RE.test(name)) problems.push(`${resource} names ${String(name)}, not an NSID`);
      else if (!name.startsWith(own)) problems.push(`${name} is outside ${group(id)}`);
    }
    if (resource === 'rpc' && p.inheritAud !== true && typeof p.aud !== 'string') problems.push(`rpc ${String((names as unknown[])[0])} has no aud`);
  }
  return problems;
}

/** Every lexicon under lexicons/, checked: well formed, in the to.atpota namespace, at the path its id says. */
export function loadLexicons(root: string): Lexicon[] {
  const dir = resolve(root, 'lexicons');
  const problems: string[] = [];
  const found: Lexicon[] = [];
  for (const path of files(dir).sort()) {
    const file = relative(root, path).split(sep).join('/');
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      problems.push(`${file}: not JSON`);
      continue;
    }
    const id = doc.id;
    if (doc.lexicon !== 1 || typeof id !== 'string' || !NSID_RE.test(id)) {
      problems.push(`${file}: needs "lexicon": 1 and an NSID "id"`);
      continue;
    }
    if (!id.startsWith(`${NAMESPACE}.`)) problems.push(`${file}: ${id} is outside ${NAMESPACE}`);
    if (file !== `lexicons/${id.split('.').join('/')}.json`) problems.push(`${file}: ${id} belongs at lexicons/${id.split('.').join('/')}.json`);
    const main = (doc.defs as Record<string, Record<string, unknown>> | undefined)?.main;
    if (!main || typeof main.type !== 'string') problems.push(`${file}: needs defs.main with a type`);
    else if (main.type === 'permission-set') for (const p of permissionSetProblems(id, main)) problems.push(`${file}: ${p}`);
    found.push({ file, id, doc });
  }
  if (problems.length) throw new Error(`lexicons/ has problems:\n  ${problems.join('\n  ')}`);
  return found;
}

/** The to.atpota permission sets a scope string includes ("include:to.atpota.authFull?aud=..."). */
export function includedSets(scope: string): string[] {
  return scope
    .split(' ')
    .filter((s) => s.startsWith('include:'))
    .map((s) => s.slice('include:'.length).split('?')[0]!)
    .filter((nsid) => nsid.startsWith(`${NAMESPACE}.`));
}

/** The record to publish for a lexicon file. */
export function schemaRecord(doc: Record<string, unknown>): Record<string, unknown> {
  return { $type: SCHEMA_NSID, ...doc };
}

/** Same schema, whatever the key order or $type. */
export function sameSchema(published: Record<string, unknown>, doc: Record<string, unknown>): boolean {
  const { $type: _t, ...rest } = published;
  return canonical(rest) === canonical(doc);
}

export async function main(args: string[], deps: PublishDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? ((line: string) => console.log(line));
  const root = deps.root ?? process.cwd();
  const txt = deps.txt ?? resolveTxt;
  const dryRun = args.includes('--dry-run');
  const vercel = args.includes('--vercel');

  if (vercel && env.VERCEL_ENV !== 'production') {
    log(`lexicons: not a production build (${env.VERCEL_ENV ?? 'local'}), nothing published`);
    return 0;
  }

  let lexicons: Lexicon[];
  try {
    lexicons = loadLexicons(root);
  } catch (error) {
    log(String((error as Error).message));
    return 1;
  }
  const required = new Set(includedSets(SCOPE));
  for (const nsid of required) {
    if (!lexicons.some((l) => l.id === nsid)) {
      log(`the sign-in scope includes ${nsid}, but lexicons/ has no such permission set`);
      return 1;
    }
  }
  log(`${lexicons.length} lexicons for ${LEXICON_HANDLE} (${LEXICON_DID})${dryRun ? ', dry run' : ''}`);

  let pds: string;
  try {
    pds = await pdsFor(doFetch, LEXICON_DID);
  } catch (error) {
    log(String((error as Error).message));
    return 1;
  }
  const published = async (id: string): Promise<Record<string, unknown> | null> => {
    const params = new URLSearchParams({ repo: LEXICON_DID, collection: SCHEMA_NSID, rkey: id });
    const res = await xrpc<{ value?: Record<string, unknown>; error?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.getRecord?${params}`);
    if (res.status === 200 && res.body?.value) return res.body.value;
    if (res.status === 400 && res.body?.error === 'RecordNotFound') return null;
    throw new Error(`reading ${id} failed (${res.status})`);
  };

  // publish
  const password = env.ATP_APP_PASSWORD?.trim();
  if (dryRun) {
    // just the checks below
  } else if (!password) {
    log(vercel ? 'ATP_APP_PASSWORD is not set: nothing published, checking what is already there' : 'set ATP_APP_PASSWORD (an app password for atpota.to), or pass --dry-run');
    if (!vercel) return 1;
  } else {
    const identifier = env.ATP_IDENTIFIER?.trim() || LEXICON_HANDLE;
    const session = await xrpc<{ accessJwt?: string; did?: string; message?: string }>(doFetch, `${pds}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (session.status !== 200 || !session.body?.accessJwt) {
      log(`sign-in failed (${session.status}): ${session.body?.message ?? 'no message'}`);
      return 1;
    }
    if (session.body.did !== LEXICON_DID) {
      log(`signed in as ${session.body.did}, but the lexicons live in ${LEXICON_DID}; nothing written`);
      return 1;
    }
    const auth = { authorization: `Bearer ${session.body.accessJwt}` };
    try {
      for (const lex of lexicons) {
        const current = await published(lex.id);
        if (current && sameSchema(current, lex.doc)) {
          log(`unchanged  ${lex.id}`);
          continue;
        }
        const put = await xrpc<{ message?: string }>(doFetch, `${pds}/xrpc/com.atproto.repo.putRecord`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ repo: LEXICON_DID, collection: SCHEMA_NSID, rkey: lex.id, record: schemaRecord(lex.doc), validate: false }),
        });
        if (put.status !== 200) throw new Error(`writing ${lex.id} failed (${put.status}): ${put.body?.message ?? ''}`);
        log(`${current ? 'updated   ' : 'created   '} ${lex.id}`);
      }
    } catch (error) {
      log(String((error as Error).message));
      return 1;
    }
  }

  // check: what's published matches, and DNS points here
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = (id: string, text: string) => (required.has(id) ? errors : warnings).push(`${id}: ${text}`);
  const dns = new Map<string, Promise<boolean>>();
  const pointsHere = (domain: string) => {
    if (!dns.has(domain)) {
      dns.set(
        domain,
        txt(`_lexicon.${domain}`)
          .then((records) => records.some((chunks) => chunks.join('') === `did=${LEXICON_DID}`))
          .catch(() => false),
      );
    }
    return dns.get(domain)!;
  };
  const domains = new Map<string, string[]>();
  for (const lex of lexicons) domains.set(authorityDomain(lex.id), [...(domains.get(authorityDomain(lex.id)) ?? []), lex.id]);
  for (const [domain, ids] of domains) {
    if (await pointsHere(domain)) continue;
    const text = `add DNS  _lexicon.${domain}  TXT  "did=${LEXICON_DID}"  (for ${ids.join(', ')})`;
    (ids.some((id) => required.has(id)) ? errors : warnings).push(text);
  }
  for (const lex of lexicons) {
    let current: Record<string, unknown> | null = null;
    try {
      current = await published(lex.id);
    } catch (error) {
      problem(lex.id, String((error as Error).message));
      continue;
    }
    if (!current) problem(lex.id, 'not published');
    else if (!sameSchema(current, lex.doc)) problem(lex.id, 'published, but different from the file');
  }
  if (!dryRun) {
    const listed = await xrpc<{ records?: { uri?: string }[] }>(doFetch, `${pds}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: LEXICON_DID, collection: SCHEMA_NSID, limit: '100' })}`);
    for (const r of listed.body?.records ?? []) {
      const id = r.uri?.split('/').pop();
      if (id?.startsWith(`${NAMESPACE}.`) && !lexicons.some((l) => l.id === id)) warnings.push(`${id}: published, but no longer in lexicons/ (left as is)`);
    }
  }

  for (const w of warnings) log(`warning   ${w}`);
  for (const e of errors) log(`error     ${e}`);
  if (errors.length) {
    log('the sign-in scope includes a permission set that does not resolve yet, so sign-in would fail');
    return 1;
  }
  log(warnings.length ? 'done, with warnings' : 'all published and resolvable');
  return 0;
}
