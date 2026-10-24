#!/usr/bin/env node
/**
 * skills-map — atomic CLI editor for Nosey `skills-map.json` (schemaVersion 1 & 2).
 *
 * Adapted from the user-supplied skills-map.mjs editor.
 * Zero dependencies. Requires Node.js 22 or newer.
 *
 * Atomicity guarantees
 *   - All edits (one command, or a whole `batch`) are applied in memory first.
 *     Command or validation failures before replacement leave the map unchanged.
 *   - The file is replaced via write-to-temp -> fsync -> rename (same directory),
 *     so readers never observe a partially written file.
 *   - An exclusive lock file (<file>.lock) serialises concurrent editors; the
 *     file is (re)read *after* the lock is held, so no lost updates.
 *   - The result is validated by the repository validator using live schemas
 *     and an in-memory manifest preview, then read back/verified after writing.
 *     Registry identity changes belong to configure-registry.mjs.
 *
 * Run `skills-map.mjs --help` for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {assertSupportedNode, defaultRoot, isDirect} from './lib/cli.mjs';
import {buildManifest, MANIFEST_DIAGNOSTICS} from './generate-manifest.mjs';
import {loadSchemas, validateDocuments} from './validate-registry.mjs';

const MAP_SCHEMA = 'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json';
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const SOURCE_RE = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const canonSource = (s) => { const m = SOURCE_RE.exec(s); return m ? `${m[1]}/${m[2]}` : null; };

/* ───────────────────────────── utilities ───────────────────────────── */

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
const fail = (msg, code = 1) => { throw new CliError(msg, code); };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && /\S/.test(v);
const dedupe = (a) => [...new Set(a)];
const clone = (v) => (v === undefined ? v : structuredClone(v));

/* ───────────────────────────── arg parsing ───────────────────────────── */

const BOOL = new Set([
  'dry-run', 'backup', 'force', 'quiet', 'help',
  'prune', 'keep-refs', 'clear-skills', 'clear-description',
]);
const SHORT = { f: 'file', n: 'dry-run', q: 'quiet', h: 'help' };
const GLOBAL_FLAGS = ['root', 'file', 'dry-run', 'backup', 'force', 'quiet', 'help', 'schemas'];

function parseArgs(argv) {
  const pos = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    let key, val;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      val = eq === -1 ? undefined : a.slice(eq + 1);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      key = SHORT[a[1]];
      if (!key) fail(`unknown option ${a}`, 2);
    } else { pos.push(a); continue; }
    if (BOOL.has(key)) {
      if (val !== undefined && !['true', 'false'].includes(val)) fail(`--${key} expects true or false`, 2);
      flags[key] = [val === undefined || val === 'true'];
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) fail(`option --${key} needs a value`, 2);
      val = argv[++i];
    }
    (flags[key] ||= []).push(val);
  }
  return { pos, flags };
}
const has = (f, k) => f[k] !== undefined;
const one = (f, k) => (f[k] ? f[k][f[k].length - 1] : undefined);
const many = (f, k) => f[k] || [];
const flag = (f, k) => has(f, k) && f[k][f[k].length - 1] === true;

function jsonArg(v, label) {
  try {
    const text = v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8') : v;
    return JSON.parse(text);
  } catch (e) { return fail(`${label}: invalid JSON (${e.message})`, 2); }
}

/* ───────────────────────────── skill-reference helpers ───────────────────────────── */

function* skillLists(m) {
  for (const k of ['alwaysRecommend', 'frontendBonusSkills']) if (Array.isArray(m[k])) yield m[k];
  for (const k of ['technologies', 'combinations', 'technologySkills', 'combinationSkills'])
    for (const x of m[k] || []) if (isObj(x) && Array.isArray(x.skills)) yield x.skills;
}
/** fn(skillId) -> new id, or null to drop. Mutates in place; returns number of changed refs. */
function mapSkillRefs(m, fn) {
  let n = 0;
  for (const list of skillLists(m)) {
    const next = [];
    for (const s of list) {
      const r = fn(s);
      if (r !== s) n++;
      if (r !== null && !next.includes(r)) next.push(r);
    }
    list.splice(0, list.length, ...next);
  }
  return n;
}
const countSkillRefs = (m, id) => { let n = 0; for (const l of skillLists(m)) n += l.filter((s) => s === id).length; return n; };
const arr = (m, key) => { if (m[key] == null) m[key] = []; return m[key]; };

/* ───────────────────────────── command implementations ───────────────────────────── */

const DETECT_FLAGS = {
  package: 'packages', 'python-package': 'pythonPackages', 'composer-package': 'composerPackages',
  'go-module': 'goModules', 'rust-crate': 'rustCrates', 'elixir-package': 'elixirPackages',
  'config-file': 'configFiles', 'file-ext': 'fileExtensions', gem: 'gems',
};
const DETECT_OPTS = [...Object.keys(DETECT_FLAGS), 'package-pattern', 'detect-json', 'unset-detect'];

const parseRegexArg = (s) => {
  const mt = /^\/(.*)\/([a-z]*)$/s.exec(s);
  return mt ? (mt[2] ? { source: mt[1], flags: mt[2] } : { source: mt[1] }) : { source: s };
};

function applyDetectFlags(base, f) {
  const d = clone(base);
  for (const [fl, key] of Object.entries(DETECT_FLAGS)) if (has(f, fl)) d[key] = dedupe(many(f, fl));
  if (has(f, 'package-pattern')) d.packagePatterns = many(f, 'package-pattern').map(parseRegexArg);
  for (const k of many(f, 'unset-detect')) delete d[k];
  return d;
}
const detectBase = (f, fallback) => {
  if (!has(f, 'detect-json')) return fallback;
  const j = jsonArg(one(f, 'detect-json'), '--detect-json');
  if (!isObj(j)) fail('--detect-json must be a JSON object', 2);
  return j;
};

const needId = (pos, what) => { if (!isText(pos[0])) fail(`usage: ${what} <id> ...`, 2); return pos[0]; };
const findBy = (list, key, id, label) => {
  const x = (list || []).find((e) => e[key] === id);
  if (!x) fail(`${label} "${id}" not found`);
  return x;
};

function guardRefs(ctx, f, id, count, label, prune) {
  if (!count) return;
  if (flag(f, 'prune')) { prune(); ctx.log(`pruned ${count} reference(s) to ${label} "${id}"`); }
  else if (!flag(f, 'keep-refs'))
    fail(`${label} "${id}" is still referenced ${count} time(s); use --prune to remove the references or --keep-refs to leave them`);
}

const COMMANDS = Object.create(null);
const def = (name, spec) => { COMMANDS[name] = spec; };

/* — read-only — */
def('show', {
  ro: true, usage: 'show [key]', desc: 'print the whole map, or one top-level key, as JSON',
  run(ctx, pos) {
    if (pos[0] && !Object.hasOwn(ctx.m, pos[0])) fail(`key "${pos[0]}" is not present`);
    const v = pos[0] ? ctx.m[pos[0]] : ctx.m;
    if (v === undefined) fail(`key "${pos[0]}" is not present`);
    ctx.out(JSON.stringify(v, null, 2));
  },
});
def('discover', {
  ro: true, usage: 'discover', desc: 'preview current local skill IDs, paths and metadata without writing a manifest',
  run(ctx) { ctx.out(JSON.stringify(ctx.manifest, null, 2)); },
});
def('validate', {
  ro: true, usage: 'validate', desc: 'validate the map against live schemas and current local/external skill declarations',
  run(ctx) { ctx.log('valid (using an in-memory manifest preview)'); },
});

/* — creation — */
def('init', {
  creates: true, usage: 'init --registry-id <id> [--schema-version 1|2] [--schema-ref <path>]',
  desc: 'create a new skills-map.json (use --force only to replace an existing map)',
  opts: ['registry-id', 'schema-version', 'schema-ref'],
  run(ctx, pos, f) {
    const registryId = one(f, 'registry-id');
    if (!isText(registryId)) fail('init requires --registry-id', 2);
    const v = Number(one(f, 'schema-version') ?? 2);
    if (![1, 2].includes(v)) fail('--schema-version must be 1 or 2', 2);
    const m = {};
    m.$schema = one(f, 'schema-ref') ?? MAP_SCHEMA;
    m.schemaVersion = v;
    m.registryId = registryId;
    m.alwaysRecommend = [];
    if (v === 2) m.externalSkills = [];
    Object.assign(m, {
      technologies: [], technologySkills: [], combinations: [], combinationSkills: [],
      frontendBonusSkills: [], frontendPackages: [], webFrontendExtensions: [],
    });
    ctx.m = m;
    ctx.log(`initialised schemaVersion ${v} map for "${registryId}"`);
  },
});

/* — scalar fields — */
def('version set', {
  usage: 'version set <1|2>', desc: 'set schemaVersion (1 cannot keep externalSkills)',
  run(ctx, pos) {
    const v = Number(pos[0]);
    if (![1, 2].includes(v)) fail('usage: version set <1|2>', 2);
    if (v === 1 && 'externalSkills' in ctx.m) {
      if (Array.isArray(ctx.m.externalSkills) && ctx.m.externalSkills.length)
        fail('cannot downgrade to schemaVersion 1: externalSkills is not empty (remove them first)');
      delete ctx.m.externalSkills;
    }
    ctx.m.schemaVersion = v;
    ctx.log(`schemaVersion -> ${v}`);
  },
});

/* — flat string lists — */
const STRING_LISTS = {
  always: 'alwaysRecommend', 'frontend-bonus': 'frontendBonusSkills',
  'frontend-packages': 'frontendPackages', 'frontend-extensions': 'webFrontendExtensions',
};
for (const [noun, key] of Object.entries(STRING_LISTS)) {
  const items = (pos, usage) => {
    if (!pos.length) fail(`usage: ${usage}`, 2);
    pos.forEach((s) => { if (typeof s !== 'string' || !s) fail('items must be non-empty strings', 2); });
    return dedupe(pos);
  };
  def(`${noun} add`, {
    usage: `${noun} add <item...>`, desc: `append to ${key} (duplicates skipped)`,
    run(ctx, pos) {
      const l = arr(ctx.m, key);
      const added = items(pos, `${noun} add <item...>`).filter((s) => !l.includes(s));
      l.push(...added);
      ctx.log(`${key}: +${added.length}${pos.length - added.length ? ` (${pos.length - added.length} already present)` : ''}`);
    },
  });
  def(`${noun} remove`, {
    usage: `${noun} remove <item...>`, desc: `remove from ${key}`,
    run(ctx, pos) {
      const l = arr(ctx.m, key);
      const rm = items(pos, `${noun} remove <item...>`);
      const missing = rm.filter((s) => !l.includes(s));
      if (missing.length) fail(`${key}: not present: ${missing.join(', ')}`);
      l.splice(0, l.length, ...l.filter((s) => !rm.includes(s)));
      ctx.log(`${key}: -${rm.length}`);
    },
  });
  def(`${noun} set`, {
    usage: `${noun} set [item...]`, desc: `replace ${key} wholesale`,
    run(ctx, pos) { ctx.m[key] = dedupe(pos); ctx.log(`${key}: set to ${ctx.m[key].length} item(s)`); },
  });
  def(`${noun} clear`, {
    usage: `${noun} clear`, desc: `empty ${key}`,
    run(ctx) { ctx.m[key] = []; ctx.log(`${key}: cleared`); },
  });
}

/* — per-id recommendations (technologySkills / combinationSkills) — */
function recCommands(noun, key, idField, label) {
  const entry = (m, id) => (m[key] || []).find((e) => e[idField] === id);
  def(`${noun} add`, {
    usage: `${noun} add <${label}Id> <skill...>`, desc: `add skills to ${key}[${idField}] (entry created if missing)`,
    run(ctx, pos) {
      const id = needId(pos, `${noun} add`);
      if (pos.length < 2) fail(`usage: ${noun} add <${label}Id> <skill...>`, 2);
      let e = entry(ctx.m, id);
      if (!e) { e = { [idField]: id, skills: [] }; arr(ctx.m, key).push(e); }
      const added = dedupe(pos.slice(1)).filter((s) => !e.skills.includes(s));
      e.skills.push(...added);
      ctx.log(`${key}["${id}"]: +${added.length}`);
    },
  });
  def(`${noun} remove`, {
    usage: `${noun} remove <${label}Id> [skill...]`, desc: 'remove listed skills, or the whole entry if none listed',
    run(ctx, pos) {
      const id = needId(pos, `${noun} remove`);
      const e = entry(ctx.m, id);
      if (!e) fail(`${key}: no entry for "${id}"`);
      if (pos.length === 1) { ctx.m[key] = ctx.m[key].filter((x) => x !== e); ctx.log(`${key}: removed entry "${id}"`); return; }
      const rm = pos.slice(1);
      const missing = rm.filter((s) => !e.skills.includes(s));
      if (missing.length) fail(`${key}["${id}"]: not present: ${missing.join(', ')}`);
      e.skills = e.skills.filter((s) => !rm.includes(s));
      ctx.log(`${key}["${id}"]: -${rm.length}`);
    },
  });
  def(`${noun} set`, {
    usage: `${noun} set <${label}Id> [skill...]`, desc: 'replace the skills of an entry (created if missing)',
    run(ctx, pos) {
      const id = needId(pos, `${noun} set`);
      let e = entry(ctx.m, id);
      if (!e) { e = { [idField]: id, skills: [] }; arr(ctx.m, key).push(e); }
      e.skills = dedupe(pos.slice(1));
      ctx.log(`${key}["${id}"]: set to ${e.skills.length} skill(s)`);
    },
  });
}
recCommands('tech-skills', 'technologySkills', 'technologyId', 'technology');
recCommands('combo-skills', 'combinationSkills', 'combinationId', 'combination');

/* — external skills — */
const requireV2 = (m) => { if (m.schemaVersion !== 2) fail('externalSkills requires schemaVersion 2 (run "version set 2" first)'); };
def('external add', {
  usage: 'external add [id] --source <owner/repo> --skill <name> [--name <n>] [--description <d>]',
  desc: 'declare an external skill (id defaults to <owner>/<repo>/<skill>, name to <skill>)',
  opts: ['source', 'skill', 'name', 'description'],
  run(ctx, pos, f) {
    requireV2(ctx.m);
    const source = one(f, 'source'); const skill = one(f, 'skill');
    if (!source || !skill) fail('external add requires --source and --skill', 2);
    let id = pos[0];
    if (!id) {
      const c = canonSource(source);
      if (!c) fail(`cannot derive id: "${source}" is not a GitHub owner/repo; pass <id> explicitly`, 2);
      id = `${c}/${skill}`;
    }
    const list = arr(ctx.m, 'externalSkills');
    if (list.some((x) => x.id === id)) fail(`external skill "${id}" already exists`);
    const x = { id, name: one(f, 'name') ?? skill, source, skill };
    if (has(f, 'description')) x.description = one(f, 'description');
    list.push(x);
    ctx.log(`external skill added: ${id}`);
  },
});
def('external update', {
  usage: 'external update <id> [--name n] [--source s] [--skill k] [--description d | --clear-description] [--new-id id]',
  desc: 'edit an external skill; --new-id also rewrites every reference',
  opts: ['name', 'source', 'skill', 'description', 'clear-description', 'new-id'],
  run(ctx, pos, f) {
    requireV2(ctx.m);
    const id = needId(pos, 'external update');
    const x = findBy(ctx.m.externalSkills, 'id', id, 'external skill');
    for (const k of ['name', 'source', 'skill']) if (has(f, k)) x[k] = one(f, k);
    if (has(f, 'description')) x.description = one(f, 'description');
    if (flag(f, 'clear-description')) delete x.description;
    if (has(f, 'new-id')) {
      const nid = one(f, 'new-id');
      if (ctx.m.externalSkills.some((o) => o !== x && o.id === nid)) fail(`external skill "${nid}" already exists`);
      x.id = nid;
      const n = mapSkillRefs(ctx.m, (s) => (s === id ? nid : s));
      ctx.log(`renamed ${id} -> ${nid} (${n} reference(s) updated)`);
    }
    ctx.log(`external skill updated: ${id}`);
  },
});
def('external remove', {
  opts: ['prune', 'keep-refs'],
  usage: 'external remove <id> [--prune | --keep-refs]', desc: 'remove an external skill; refuses if referenced unless --prune/--keep-refs',
  run(ctx, pos, f) {
    requireV2(ctx.m);
    const id = needId(pos, 'external remove');
    findBy(ctx.m.externalSkills, 'id', id, 'external skill');
    guardRefs(ctx, f, id, countSkillRefs(ctx.m, id), 'external skill', () => {
      const had = new Set([...(ctx.m.technologySkills || []), ...(ctx.m.combinationSkills || [])].filter((e) => e.skills.length));
      mapSkillRefs(ctx.m, (s) => (s === id ? null : s));
      // drop recommendation entries that this prune emptied (they would be dead weight)
      for (const k of ['technologySkills', 'combinationSkills'])
        if (ctx.m[k]) ctx.m[k] = ctx.m[k].filter((e) => !(had.has(e) && e.skills.length === 0));
    });
    ctx.m.externalSkills = ctx.m.externalSkills.filter((x) => x.id !== id);
    ctx.log(`external skill removed: ${id}`);
  },
});

/* — technologies — */
def('tech add', {
  usage: 'tech add <id> --name <n> [detect flags] [--skill <id>...]',
  desc: 'declare a technology. Detect flags: --package --python-package --composer-package --go-module --rust-crate --elixir-package --config-file --file-ext --gem --package-pattern /re/flags --detect-json <json|@file>',
  opts: ['name', 'skill', ...DETECT_OPTS],
  run(ctx, pos, f) {
    const id = needId(pos, 'tech add');
    const list = arr(ctx.m, 'technologies');
    if (list.some((t) => t.id === id)) fail(`technology "${id}" already exists`);
    if (!one(f, 'name')) fail('tech add requires --name', 2);
    const t = { id, name: one(f, 'name'), detect: applyDetectFlags(detectBase(f, {}), f) };
    if (has(f, 'skill')) t.skills = dedupe(many(f, 'skill'));
    list.push(t);
    ctx.log(`technology added: ${id}`);
    if (!Object.keys(t.detect).length) ctx.warn(`technology "${id}" has an empty detect config and will never be detected`);
  },
});
def('tech update', {
  usage: 'tech update <id> [--name n] [detect flags] [--unset-detect key] [--skill id... | --clear-skills] [--new-id id]',
  desc: 'edit a technology. A detect flag replaces that detect key; --detect-json replaces all of detect first',
  opts: ['name', 'skill', 'clear-skills', 'new-id', ...DETECT_OPTS],
  run(ctx, pos, f) {
    const id = needId(pos, 'tech update');
    const t = findBy(ctx.m.technologies, 'id', id, 'technology');
    if (has(f, 'name')) t.name = one(f, 'name');
    t.detect = applyDetectFlags(detectBase(f, t.detect || {}), f);
    if (has(f, 'skill')) t.skills = dedupe(many(f, 'skill'));
    if (flag(f, 'clear-skills')) delete t.skills;
    if (has(f, 'new-id')) {
      const nid = one(f, 'new-id');
      if (ctx.m.technologies.some((o) => o !== t && o.id === nid)) fail(`technology "${nid}" already exists`);
      if ((ctx.m.technologySkills || []).some((e) => e.technologyId === nid)) fail(`technologySkills already has an entry for "${nid}"`);
      t.id = nid;
      for (const e of ctx.m.technologySkills || []) if (e.technologyId === id) e.technologyId = nid;
      for (const c of ctx.m.combinations || []) c.requires = dedupe(c.requires.map((r) => (r === id ? nid : r)));
      ctx.log(`renamed technology ${id} -> ${nid} (references updated)`);
    }
    ctx.log(`technology updated: ${id}`);
  },
});
def('tech remove', {
  opts: ['prune', 'keep-refs'],
  usage: 'tech remove <id> [--prune | --keep-refs]', desc: 'remove a technology; refuses if referenced unless --prune/--keep-refs',
  run(ctx, pos, f) {
    const id = needId(pos, 'tech remove');
    findBy(ctx.m.technologies, 'id', id, 'technology');
    const refs = (ctx.m.technologySkills || []).filter((e) => e.technologyId === id).length
      + (ctx.m.combinations || []).filter((c) => c.requires.includes(id)).length;
    guardRefs(ctx, f, id, refs, 'technology', () => {
      ctx.m.technologySkills = (ctx.m.technologySkills || []).filter((e) => e.technologyId !== id);
      for (const c of ctx.m.combinations || []) c.requires = c.requires.filter((r) => r !== id);
    });
    ctx.m.technologies = ctx.m.technologies.filter((t) => t.id !== id);
    ctx.log(`technology removed: ${id}`);
  },
});

/* — combinations — */
const splitCsv = (vals) => dedupe(vals.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean));
def('combo add', {
  usage: 'combo add <id> --name <n> --requires <techId[,techId]>... [--skill <id>...]', desc: 'declare a combination',
  opts: ['name', 'requires', 'skill'],
  run(ctx, pos, f) {
    const id = needId(pos, 'combo add');
    const list = arr(ctx.m, 'combinations');
    if (list.some((c) => c.id === id)) fail(`combination "${id}" already exists`);
    if (!one(f, 'name')) fail('combo add requires --name', 2);
    const c = { id, name: one(f, 'name'), requires: splitCsv(many(f, 'requires')) };
    if (has(f, 'skill')) c.skills = dedupe(many(f, 'skill'));
    list.push(c);
    ctx.log(`combination added: ${id}`);
    if (!c.requires.length) ctx.warn(`combination "${id}" has no required technologies`);
  },
});
def('combo update', {
  usage: 'combo update <id> [--name n] [--requires a,b] [--skill id... | --clear-skills] [--new-id id]', desc: 'edit a combination',
  opts: ['name', 'requires', 'skill', 'clear-skills', 'new-id'],
  run(ctx, pos, f) {
    const id = needId(pos, 'combo update');
    const c = findBy(ctx.m.combinations, 'id', id, 'combination');
    if (has(f, 'name')) c.name = one(f, 'name');
    if (has(f, 'requires')) c.requires = splitCsv(many(f, 'requires'));
    if (has(f, 'skill')) c.skills = dedupe(many(f, 'skill'));
    if (flag(f, 'clear-skills')) delete c.skills;
    if (has(f, 'new-id')) {
      const nid = one(f, 'new-id');
      if (ctx.m.combinations.some((o) => o !== c && o.id === nid)) fail(`combination "${nid}" already exists`);
      if ((ctx.m.combinationSkills || []).some((e) => e.combinationId === nid)) fail(`combinationSkills already has an entry for "${nid}"`);
      c.id = nid;
      for (const e of ctx.m.combinationSkills || []) if (e.combinationId === id) e.combinationId = nid;
      ctx.log(`renamed combination ${id} -> ${nid} (references updated)`);
    }
    ctx.log(`combination updated: ${id}`);
  },
});
def('combo remove', {
  opts: ['prune', 'keep-refs'],
  usage: 'combo remove <id> [--prune | --keep-refs]', desc: 'remove a combination; refuses if referenced unless --prune/--keep-refs',
  run(ctx, pos, f) {
    const id = needId(pos, 'combo remove');
    findBy(ctx.m.combinations, 'id', id, 'combination');
    const refs = (ctx.m.combinationSkills || []).filter((e) => e.combinationId === id).length;
    guardRefs(ctx, f, id, refs, 'combination', () => {
      ctx.m.combinationSkills = ctx.m.combinationSkills.filter((e) => e.combinationId !== id);
    });
    ctx.m.combinations = ctx.m.combinations.filter((c) => c.id !== id);
    ctx.log(`combination removed: ${id}`);
  },
});

/* — skill id maintenance — */
def('skill rename', {
  usage: 'skill rename <old> <new>', desc: 'rewrite every reference to a skill id (and the externalSkills id if it is one)',
  run(ctx, pos) {
    if (pos.length !== 2) fail('usage: skill rename <old> <new>', 2);
    const [from, to] = pos;
    const n = mapSkillRefs(ctx.m, (s) => (s === from ? to : s));
    const ext = (ctx.m.externalSkills || []).find((x) => x.id === from);
    if (ext) ext.id = to;
    if (!n && !ext) fail(`skill "${from}" is not referenced anywhere`);
    ctx.log(`skill ${from} -> ${to}: ${n} reference(s)${ext ? ' + external declaration' : ''}`);
  },
});
def('skill remove', {
  usage: 'skill remove <id...>', desc: 'drop skill ids from every recommendation list (does not touch externalSkills)',
  run(ctx, pos) {
    if (!pos.length) fail('usage: skill remove <id...>', 2);
    const set = new Set(pos);
    const n = mapSkillRefs(ctx.m, (s) => (set.has(s) ? null : s));
    if (!n) fail('none of those skills are referenced');
    ctx.log(`removed ${n} reference(s)`);
  },
});

/* — batch — */
def('batch', {
  usage: 'batch [file|-]', desc: 'apply many commands as ONE transaction. Input: JSON array of string argv arrays',
  run(ctx, pos) {
    if (pos.length > 1) fail('usage: batch [file|-]', 2);
    let text;
    try { text = fs.readFileSync(!pos[0] || pos[0] === '-' ? 0 : pos[0], 'utf8'); }
    catch (e) { fail(`batch: cannot read input (${e.message})`, 2); }
    let ops;
    try { ops = JSON.parse(text); } catch (e) { fail(`batch: input is not valid JSON (${e.message})`, 2); }
    if (!Array.isArray(ops)) fail('batch: input must be a JSON array', 2);
    ops.forEach((op, i) => {
      if (!Array.isArray(op) || op.some((arg) => typeof arg !== 'string')) fail(`batch[${i}]: must be an array of strings`, 2);
      const argv = op;
      const { pos: p } = parseArgs(argv);
      if (['batch', 'init', 'show', 'discover', 'validate'].includes(p[0])) fail(`batch[${i}]: "${p[0]}" is not allowed in a batch`, 2);
      try { dispatch(ctx, argv, { inBatch: true }); }
      catch (e) { if (e instanceof CliError) e.message = `batch[${i}] (${argv.join(' ')}): ${e.message}`; throw e; }
    });
    ctx.log(`batch: ${ops.length} command(s) applied`);
  },
});

/* ───────────────────────────── dispatch ───────────────────────────── */

function resolveCommand(pos) {
  if (pos.length >= 2 && COMMANDS[`${pos[0]} ${pos[1]}`]) return [COMMANDS[`${pos[0]} ${pos[1]}`], 2];
  if (pos.length >= 1 && COMMANDS[pos[0]]) return [COMMANDS[pos[0]], 1];
  return [null, 0];
}

function dispatch(ctx, argv, { inBatch = false, validateOnly = false } = {}) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, used] = resolveCommand(pos);
  if (!cmd) fail(`unknown command: ${pos.slice(0, 2).join(' ') || '(none)'}  (try --help)`, 2);
  const allowed = new Set([...(cmd.opts || []), ...(inBatch ? [] : GLOBAL_FLAGS)]);
  for (const k of Object.keys(flags)) {
    if (inBatch && GLOBAL_FLAGS.includes(k)) fail(`--${k} is a global option and cannot be used inside a batch`, 2);
    if (!allowed.has(k)) fail(`unknown option --${k} for "${pos.slice(0, used).join(' ')}"`, 2);
  }
  const args = pos.slice(used);
  const name = pos.slice(0, used).join(' ');
  let maxArgs = Infinity;
  if (name === 'skill rename') maxArgs = 2;
  else if (['init', 'validate', 'discover'].includes(name) || name.endsWith(' clear')) maxArgs = 0;
  else if (['show', 'batch', 'version set'].includes(name) || /^(tech|combo|external) /.test(name)) maxArgs = 1;
  if (args.length > maxArgs) fail(`too many arguments for "${name}"`, 2);
  for (const [a, b] of [['prune', 'keep-refs'], ['skill', 'clear-skills'], ['description', 'clear-description']])
    if (has(flags, a) && flag(flags, b)) fail(`--${a} and --${b} cannot be combined`, 2);
  if (has(flags, 'force') && name !== 'init') fail('--force is supported only by init; validation cannot be bypassed', 2);
  if (!validateOnly) return cmd.run(ctx, args, flags);
}

/* ───────────────────────────── file I/O (atomic) ───────────────────────────── */

async function acquireLock(file) {
  const lock = `${file}.lock`;
  // Never steal a lock based on its age or PID: a live transaction may be waiting
  // on I/O, and removing a supposedly stale lock races other waiting editors.
  for (let i = 0; i < 30; i++) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(100);
      continue;
    }
    const owned = fs.fstatSync(fd);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.removeListener('exit', release);
      try {
        const current = fs.lstatSync(lock);
        if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lock);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    try { fs.writeFileSync(fd, JSON.stringify({pid: process.pid, time: Date.now()})); }
    catch (error) { release(); throw error; }
    finally { fs.closeSync(fd); }
    process.once('exit', release);
    return release;
  }
  fail(`could not acquire lock ${lock}; inspect the owner and remove an abandoned lock manually`);
}

function readDocument(file, {optional = false, editable = false} = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || (editable && before.nlink > 1) || before.size > MAX_DOCUMENT_BYTES)
    fail(`${file}: expected a regular ${editable ? 'non-hard-linked ' : ''}file within ${MAX_DOCUMENT_BYTES} bytes`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail(`${file}: changed while opening`);
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    const after = fs.fstatSync(fd);
    if (length > MAX_DOCUMENT_BYTES || after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail(`${file}: changed or exceeded byte limit while reading`);
    return bytes.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function parseDocument(raw, file) {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
}

function atomicWrite(file, content, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    let directoryFd;
    try { directoryFd = fs.openSync(dir, 'r'); fs.fsyncSync(directoryFd); }
    catch { /* directory fsync is not supported on all platforms */ }
    finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/* Formatting: keep the file's indent / EOL / BOM / trailing newline; inline short scalar arrays. */
function detectStyle(raw) {
  if (raw == null) return { indent: '  ', crlf: false, bom: false, finalNl: true, inline: true };
  const text = raw.replace(/^\uFEFF/, '');
  const im = /^\r?\n?[ \t]*\{?\r?\n([ \t]+)"/m.exec(text) || /\n([ \t]+)"/.exec(text);
  return {
    indent: im ? (im[1][0] === '\t' ? '\t' : im[1]) : '  ',
    crlf: /\r\n/.test(text),
    bom: raw.charCodeAt(0) === 0xfeff,
    finalNl: /\n$/.test(text),
    inline: /\[\s*"[^"\n]*"(?:\s*,\s*"[^"\n]*")*\s*\]/.test(text) || !/\[\s*\n/.test(text),
  };
}
function stringify(v, st, level = 0) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const pad = st.indent.repeat(level + 1);
  const end = st.indent.repeat(level);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (st.inline && v.every((x) => x === null || typeof x !== 'object')) {
      const s = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (s.length + level * st.indent.length <= 88) return s;
    }
    return `[\n${v.map((x) => pad + stringify(x, st, level + 1)).join(',\n')}\n${end}]`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${stringify(v[k], st, level + 1)}`).join(',\n')}\n${end}}`;
}
function serialize(m, st) {
  let s = stringify(m, st) + (st.finalNl ? '\n' : '');
  if (st.crlf) s = s.replace(/\n/g, '\r\n');
  return (st.bom ? '\uFEFF' : '') + s;
}

/* ───────────────────────────── main ───────────────────────────── */

const HELP = () => {
  const lines = [
    'skills-map — atomic editor for Nosey skills-map.json',
    '',
    'Usage: node scripts/skills-map.mjs [global options] <command> [args]',
    '',
    'Global options:',
    '      --root <dir>     registry root (default: script repository)',
    '  -f, --file <path>    explicit map path; registry root is its parent (exclusive with --root)',
    '  -n, --dry-run        print the resulting JSON to stdout, write nothing',
    '      --backup         keep the previous file as <file>.bak',
    '      --force          init only: replace an existing map after validation',
    '      --schemas <dir>  explicit test fixtures only; otherwise fetch fixed live Nosey URLs',
    '  -q, --quiet          suppress progress messages',
    '  -h, --help',
    '',
    'Commands:',
  ];
  const seen = new Set();
  for (const c of Object.values(COMMANDS)) {
    if (seen.has(c)) continue; seen.add(c);
    lines.push(`  ${c.usage}`, `      ${c.desc}`);
  }
  lines.push('',
    'Examples:',
    '  node scripts/skills-map.mjs init --registry-id acme/agent-skills',
    '  node scripts/skills-map.mjs external add --source acme/upstream-skills --skill example-testing',
    '  node scripts/skills-map.mjs tech-skills add react acme/upstream-skills/example-testing',
    '  node scripts/skills-map.mjs tech add my-fw --name "My FW" --package my-fw --config-file my-fw.config.ts',
    '  node scripts/skills-map.mjs always add acme/skills/core/safety',
    '  node scripts/skills-map.mjs --dry-run external remove acme/upstream-skills/example-testing --prune',
    '  node scripts/skills-map.mjs --dry-run batch /tmp/mapping-operations.json',
    '',
    'Edits validate an in-memory manifest preview; manifest and README are never written.',
    'Use configure-registry.mjs for registry identity changes, then generate.mjs after mapping.',
    'Exit codes: 0 ok / no change, 1 failure, 2 usage error.');
  return lines.join('\n');
};

export async function main(argv) {
  assertSupportedNode();
  const {pos, flags} = parseArgs(argv);
  if (flag(flags, 'help') || !pos.length || pos[0] === 'help') { process.stdout.write(HELP() + '\n'); return; }
  const [cmd] = resolveCommand(pos);
  if (!cmd) fail(`unknown command: ${pos.slice(0, 2).join(' ')}`, 2);
  if (has(flags, 'root') && has(flags, 'file')) fail('--root and --file are mutually exclusive', 2);
  const requestedFile = has(flags, 'file') ? path.resolve(one(flags, 'file')) : path.join(path.resolve(one(flags, 'root') ?? defaultRoot(import.meta.url)), 'skills-map.json');
  // Canonicalize the parent so different directory aliases share one lock.
  const root = fs.realpathSync(path.dirname(requestedFile));
  const file = path.join(root, path.basename(requestedFile));
  if (['skills-manifest.json', 'README.md', 'AGENTS.md'].includes(path.basename(file))) fail('--file must target a map, not a generated document or guide', 2);
  const quiet = flag(flags, 'quiet'), dry = flag(flags, 'dry-run');
  const messages = [];
  const ctx = {
    m: null, manifest: null,
    log: (s) => messages.push(['log', s]),
    warn: (s) => messages.push(['warn', s]),
    out: (s) => process.stdout.write(s + '\n'),
  };
  const flush = () => {
    for (const [kind, s] of messages)
      if (kind === 'warn' || !quiet) process.stderr.write(`${kind === 'warn' ? 'warning: ' : ''}${s}\n`);
  };
  // Reject unknown flags/argument shapes before network requests or lock creation.
  dispatch(ctx, argv, {validateOnly: true});
  const schemas = cmd.ro && pos[0] !== 'validate' ? null : await loadSchemas({schemasDir: one(flags, 'schemas')});
  const release = cmd.ro || dry ? () => {} : await acquireLock(file);
  try {
    // Existence is checked AFTER acquiring the lock, including init.
    const raw = readDocument(file, {optional: true, editable: !cmd.ro});
    const exists = raw !== null;
    if (cmd.creates && exists && !flag(flags, 'force')) fail(`${file} already exists (use --force to overwrite)`);
    if (!cmd.creates && !exists) fail(`${file} not found (create it with "init")`);
    const before = exists ? parseDocument(raw, file) : null;
    if (exists && !isObj(before)) fail(`${file} must contain a JSON object`);
    ctx.m = clone(before);
    const preview = async () => {
      const previousRaw = readDocument(path.join(root, 'skills-manifest.json'), {optional: true});
      const previous = previousRaw === null ? {} : parseDocument(previousRaw, 'skills-manifest.json');
      if (!isObj(previous)) fail('skills-manifest.json must contain a JSON object');
      if (previousRaw !== null && previous.registryId !== ctx.m.registryId) fail('registryId disagrees with existing manifest; use configure-registry.mjs for identity changes');
      const manifest = await buildManifest(root, ctx.m, previous);
      for (const warning of manifest[MANIFEST_DIAGNOSTICS]) ctx.warn(warning);
      return manifest;
    };
    if (pos[0] === 'discover') ctx.manifest = await preview();
    dispatch(ctx, argv);
    if (before && ctx.m.registryId !== before.registryId) fail('registryId changes require configure-registry.mjs');
    if (schemas) {
      ctx.manifest = await preview();
      await validateDocuments({root, manifest: ctx.manifest, map: ctx.m, schemas});
    }
    if (cmd.ro) { flush(); return; }
    if (before !== null && JSON.stringify(before) === JSON.stringify(ctx.m)) {
      if (dry) process.stdout.write(raw);
      ctx.log('no changes'); flush(); return;
    }
    const content = serialize(ctx.m, detectStyle(raw));
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) fail('result exceeds document byte limit');
    if (dry) { process.stdout.write(content); ctx.log('(dry run) nothing written'); flush(); return; }
    // Detect non-cooperating writers and target swaps before replacing anything.
    if (readDocument(file, {optional: true, editable: true}) !== raw) fail('map changed during transaction; retry');
    const mode = exists ? fs.lstatSync(file).mode & 0o777 : 0o644;
    if (flag(flags, 'backup') && raw !== null) atomicWrite(`${file}.bak`, raw, mode);
    atomicWrite(file, content, mode);
    if (fs.readFileSync(file, 'utf8') !== content) fail('post-write verification failed (map was replaced)');
    ctx.log(`wrote ${path.relative(process.cwd(), file) || file}`);
    flush();
  } finally { release(); }
}

if (isDirect(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = error instanceof CliError ? error.code : 1;
  }
}
