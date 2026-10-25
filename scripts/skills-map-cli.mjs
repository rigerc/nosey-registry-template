#!/usr/bin/env node
// Human (programmatic) and automation-mode editor for skills-map.json.
//
// Programmatic mode (default): readable reports, prompts when interactive.
// Automation mode (--json): one JSON document per command, no prompts, stable
// exit codes: 0 ok, 1 validation issues, 2 usage or I/O error, 3 schema source
// failure. Mutations are idempotent, checked with offline parser rules before
// writing, and written atomically. `validate` uses the live Nosey schemas and
// fails closed, exactly like validate-registry.mjs.
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import {assertSupportedNode, defaultRoot, isDirect} from './lib/cli.mjs';
import {buildManifest, MANIFEST_DIAGNOSTICS} from './generate-manifest.mjs';
import {loadSchemas, validateDocuments} from './validate-registry.mjs';
import {
  MAP_FILE, MAP_SCHEMA_URL, addCombination, addCombinationSkills, addExternalSkill, addStringListItems,
  addTechnology, addTechnologySkills, builtinIdSet, checkMapAgainstSchema, checkMapDocument, createMapDocument,
  isValidRegistryId, issue, readManifestDocument, readManifestSkillIds, readMapFile, removeCombinationSkills,
  removeCombinations, removeExternalSkills, removeStringListItems, removeTechnologySkills, removeTechnologies,
  sectionValue, serializeMap, setRegistryId, writeMapFile,
} from './lib/skills-map.mjs';

const DETECT_LIMIT = 1024 * 1024;
const BATCH_LIMIT = 1024 * 1024;
const EXIT_OK = 0, EXIT_ISSUES = 1, EXIT_ERROR = 2, EXIT_SCHEMA = 3;

const USAGE = `Usage: node scripts/skills-map-cli.mjs <command> [options]

Commands:
  validate                            Validate skills-map.json (live schemas, fail-closed)
  create --registry-id owner/repo    Create a fresh skills-map.json
  show [section]                      Print the map or one normalized section
  discover                            Preview local skill IDs and paths without writing a manifest
  batch <operations.json>             Apply several add/remove/set operations as one validated write
  add <target> [operands] [flags]    Add entries (idempotent)
  remove <target> [operands] [flags] Remove entries (cascades associations)
  set registry-id owner/repo         Change registryId and remap local skill references

Targets for add/remove:
  always-recommend <skillId>...
  external <id> --name <n> --source <owner/repo> --skill <name> [--description <d>]
  technology <id> --name <n> --detect <json|@file|-> [--skill <skillId>...]
  technology-skills <technologyId> --skill <skillId>...
  combination <id> --name <n> --requires <id,id,...> [--skill <skillId>...]
  combination-skills <combinationId> --skill <skillId>...
  frontend-bonus-skill <value>...   frontend-package <value>...   frontend-extension <value>...

Removing technology-skills or combination-skills without --skill drops the whole entry.

Batch files contain a nonempty JSON array of argument arrays, for example
[["add","technology-skills","react","--skill","owner/repo/one"],["add","frontend-package","vite"]].
Only add, remove, and set operations are allowed; global options are rejected.

Sections for show:
  always-recommend  external-skills  technologies  technology-skills  combinations
  combination-skills  frontend-bonus-skills  frontend-packages  frontend-extensions
  registry-id  schema-version   (or the exact map field name)

Options:
  --root <dir>        Registry root (default: the root containing this script)
  --json              Automation mode: one JSON document per command, never prompts
  --dry-run           Report the would-be result without writing
  -i, --interactive   Guided prompts for every map section (not with --json or --dry-run)
  --schemas <dir>     Local schema fixtures for validate only (production fetches live schemas)
  --registry-id <id>  Registry ID for create
  --name --source --skill --description --detect --requires   Target-specific values
  --force             Overwrite an existing map (create)
  --quiet             Suppress notices, warnings, and reminders
  --no-color          Disable colored output

Exit codes: 0 ok, 1 validation issues, 2 usage or I/O error, 3 schema source failure.`;

function parseArguments(argv) {
  if (argv.length === 0 || argv[0].startsWith('-')) throw new Error(USAGE);
  const command = argv[0];
  const flags = {
    json: false, dryRun: false, quiet: false, force: false, noColor: false,
    root: defaultRoot(import.meta.url), schemasDir: undefined, registryId: undefined,
    name: undefined, source: undefined, description: undefined, detect: undefined,
    requires: undefined, skills: [],
  };
  const valueFlags = {
    '--root': 'root', '--schemas': 'schemasDir', '--registry-id': 'registryId',
    '--name': 'name', '--source': 'source', '--description': 'description',
    '--detect': 'detect', '--requires': 'requires',
  };
  const operands = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skill') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--skill requires a value\n${USAGE}`);
      flags.skills.push(argv[++i]);
    } else if (Object.hasOwn(valueFlags, arg)) {
      const key = valueFlags[arg];
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value\n${USAGE}`);
      flags[key] = argv[++i];
    } else if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--no-color') flags.noColor = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown or unexpected option: ${arg}\n${USAGE}`);
    else operands.push(arg);
  }
  return {command, flags, operands};
}

function colorEnabled(flags) {
  return !flags.noColor && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}
function paint(text, color, enabled) {
  return enabled ? `\x1b[${color}m${text}\x1b[0m` : text;
}
function printJson(document) { console.log(JSON.stringify(document, null, 2)); }
function severityColor(severity) {
  if (severity === 'error') return 31;
  if (severity === 'warning') return 33;
  return 36;
}
function printIssueLine(item, color) {
  const location = item.path ? ` ${item.path}:` : '';
  console.error(`${paint(item.severity.padEnd(7), severityColor(item.severity), color)}${location} ${item.message}`);
}
function reportFailure(flags, command, exitCode, code, message) {
  if (flags.json) {
    printJson({ok: false, command, exitCode, issues: [issue('error', code, '', message)]});
  } else {
    console.error(`${paint('error', 31, colorEnabled(flags))}: ${message}`);
  }
  return exitCode;
}
function countSeverities(issues) {
  const summary = {errors: 0, warnings: 0, notices: 0};
  for (const item of issues) {
    if (item.severity === 'error') summary.errors++;
    else if (item.severity === 'warning') summary.warnings++;
    else summary.notices++;
  }
  return summary;
}
function printIssues(flags, issues) {
  const color = colorEnabled(flags);
  for (const item of issues) printIssueLine(item, color);
  return issues;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function parseDetectArgument(value) {
  let textValue;
  if (value === '-') textValue = await readStdin();
  else if (value.startsWith('@')) {
    const file = path.resolve(value.slice(1));
    let info;
    try { info = await lstat(file); } catch (error) { throw new Error(`Cannot read detect file: ${error.message}`); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > DETECT_LIMIT) throw new Error(`Invalid detect file: ${file}`);
    textValue = await readFile(file, 'utf8');
  } else textValue = value;
  let detect;
  try { detect = JSON.parse(textValue); } catch (error) { throw new Error(`--detect is not valid JSON: ${error.message}`); }
  if (detect === null || typeof detect !== 'object' || Array.isArray(detect)) throw new Error('--detect must be a JSON object');
  return detect;
}

// --- validate ---------------------------------------------------------------

async function runValidate({flags, operands}) {
  if (operands.length > 0) throw new Error(`validate takes no operands\n${USAGE}`);
  let schemas;
  try { schemas = await loadSchemas({schemasDir: flags.schemasDir}); }
  catch (error) { return reportFailure(flags, 'validate', EXIT_SCHEMA, 'schema-unavailable', error.message); }
  let map;
  try { map = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, 'validate', EXIT_ERROR, 'map-unreadable', error.message); }

  const issues = checkMapAgainstSchema(map, schemas.map);
  if (issues.length === 0) {
    let manifestState = null;
    try { manifestState = await readManifestDocument(flags.root); }
    catch (error) { issues.push(issue('error', 'manifest-unreadable', '', error.message)); }
    // A missing manifest is a warning; an unreadable one already pushed an error.
    const manifestUsable = Boolean(manifestState && !manifestState.missing);
    let localSkillIds = null;
    if (manifestUsable) {
      const skills = manifestState.manifest?.skills;
      if (Array.isArray(skills)) localSkillIds = new Set(skills.filter((entry) => entry?.id && typeof entry.id === 'string').map((entry) => entry.id));
    } else if (manifestState?.missing) {
      issues.push(issue('warning', 'manifest-missing', '', 'skills-manifest.json not found; registry integration checks skipped'));
    }
    const builtinTechnologies = builtinIdSet(schemas.map['x-builtInTechnologies']);
    const builtinCombinations = builtinIdSet(schemas.map['x-builtInCombinations']);
    if ((Array.isArray(map.technologies) && map.technologies.length > 0) || (Array.isArray(map.technologySkills) && map.technologySkills.length > 0)) {
      if (!Array.isArray(schemas.map['x-builtInTechnologies'])) issues.push(issue('error', 'builtin-inventory-missing', '', 'Nosey map schema does not publish x-builtInTechnologies; cannot validate built-in technology references'));
    }
    if ((Array.isArray(map.combinations) && map.combinations.length > 0) || (Array.isArray(map.combinationSkills) && map.combinationSkills.length > 0)) {
      if (!Array.isArray(schemas.map['x-builtInCombinations'])) issues.push(issue('error', 'builtin-inventory-missing', '', 'Nosey map schema does not publish x-builtInCombinations; cannot validate built-in combination references'));
    }
    issues.push(...checkMapDocument(map, {localSkillIds, builtinTechnologies, builtinCombinations}));
    if (!issues.some((item) => item.severity === 'error') && manifestUsable) {
      try { await validateDocuments({root: flags.root, manifest: manifestState.manifest, map, schemas}); }
      catch (error) { issues.push(issue('error', 'integration', '', error.message)); }
    }
  }

  const summary = countSeverities(issues);
  if (flags.json) {
    printJson({ok: summary.errors === 0, command: 'validate', issues, summary});
  } else if (summary.errors === 0) {
    const color = colorEnabled(flags);
    console.log(paint('skills-map.json is valid (schema, parser rules, and registry integration checked).', 32, color));
    if (!flags.quiet) for (const item of issues.filter((item) => item.severity !== 'error')) printIssueLine(item, color);
  } else {
    printIssues(flags, issues);
    console.error(`Found ${summary.errors} error(s), ${summary.warnings} warning(s).`);
  }
  return summary.errors === 0 ? EXIT_OK : EXIT_ISSUES;
}

// --- create -----------------------------------------------------------------

async function promptRegistryId() {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  try { return await rl.question('Registry ID (owner/repository): '); } finally { rl.close(); }
}

async function runCreate({flags, operands}) {
  if (operands.length > 0) throw new Error(`create takes no operands\n${USAGE}`);
  let registryId = flags.registryId;
  if (registryId === undefined) {
    if (!flags.json && !flags.quiet && process.stdin.isTTY) registryId = await promptRegistryId();
    else throw new Error(`create requires --registry-id owner/repository\n${USAGE}`);
  }
  registryId = registryId.trim();
  if (!isValidRegistryId(registryId)) throw new Error(`invalid registry ID: ${registryId} (expected owner/repository)`);

  let exists = false;
  try { await lstat(path.join(flags.root, MAP_FILE)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists && !flags.force) throw new Error(`skills-map.json already exists; use --force to overwrite`);

  const doc = createMapDocument(registryId);
  const issues = checkMapDocument(doc);
  const summary = countSeverities(issues);
  if (summary.errors > 0) {
    if (flags.json) printJson({ok: false, command: 'create', changed: false, written: false, issues, summary});
    else printIssues(flags, issues);
    return EXIT_ISSUES;
  }
  if (flags.dryRun) {
    if (flags.json) printJson({ok: true, command: 'create', dryRun: true, changed: true, registryId, content: serializeMap(doc), issues});
    else console.log(serializeMap(doc));
    return EXIT_OK;
  }
  try { await writeMapFile(flags.root, doc); }
  catch (error) { return reportFailure(flags, 'create', EXIT_ERROR, 'write-failed', error.message); }
  if (flags.json) printJson({ok: true, command: 'create', changed: true, written: true, registryId, issues});
  else console.log(`Created ${MAP_FILE} for registry ${JSON.stringify(registryId)} (schemaVersion 2, schema ${MAP_SCHEMA_URL}).`);
  return EXIT_OK;
}

// --- show -------------------------------------------------------------------

async function runShow({flags, operands}) {
  if (operands.length > 1) throw new Error(`show takes at most one section name\n${USAGE}`);
  let map;
  try { map = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, 'show', EXIT_ERROR, 'map-unreadable', error.message); }
  if (operands.length === 0) {
    if (flags.json) printJson({ok: true, command: 'show', section: null, value: map});
    else console.log(serializeMap(map));
    return EXIT_OK;
  }
  const alias = operands[0];
  const value = sectionValue(map, alias);
  if (value === undefined) throw new Error(`unknown section: ${alias}\n${USAGE}`);
  if (flags.json) printJson({ok: true, command: 'show', section: alias, value});
  else console.log(JSON.stringify(value, null, 2));
  return EXIT_OK;
}

// --- add / remove / set -----------------------------------------------------

function requireValues(values, label) {
  if (values.length === 0) throw new Error(`${label} requires at least one value`);
  for (const value of values) if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} values must be nonempty strings`);
  return values;
}

async function applyMutation(doc, command, target, rest, flags) {
  const one = (label) => {
    if (rest.length < 1) throw new Error(`${command} ${target} requires ${label}`);
    return rest[0];
  };
  switch (`${command} ${target}`) {
    case 'add always-recommend': return addStringListItems(doc, 'alwaysRecommend', requireValues(rest, 'add always-recommend'), 'always-recommend');
    case 'remove always-recommend': return removeStringListItems(doc, 'alwaysRecommend', requireValues(rest, 'remove always-recommend'), 'always-recommend');
    case 'add external': {
      const id = one('an external skill ID');
      if (flags.name === undefined || flags.source === undefined) throw new Error('add external requires --name and --source');
      if (flags.skills.length === 0) throw new Error('add external requires --skill <upstream skill name>');
      return addExternalSkill(doc, {id, name: flags.name, source: flags.source, skill: flags.skills[0], description: flags.description});
    }
    case 'remove external': return removeExternalSkills(doc, requireValues(rest, 'remove external'));
    case 'add technology': {
      const id = one('a technology ID');
      if (flags.name === undefined) throw new Error('add technology requires --name');
      if (flags.detect === undefined) throw new Error('add technology requires --detect <json|@file|->');
      return addTechnology(doc, {id, name: flags.name, detect: await parseDetectArgument(flags.detect), skills: flags.skills});
    }
    case 'remove technology': return removeTechnologies(doc, requireValues(rest, 'remove technology'));
    case 'add technology-skills': {
      const id = one('a technology ID');
      if (flags.skills.length === 0) throw new Error('add technology-skills requires --skill <skillId>');
      return addTechnologySkills(doc, id, flags.skills);
    }
    case 'remove technology-skills': {
      const id = one('a technology ID');
      return removeTechnologySkills(doc, id, flags.skills.length > 0 ? flags.skills : null);
    }
    case 'add combination': {
      const id = one('a combination ID');
      if (flags.name === undefined) throw new Error('add combination requires --name');
      if (flags.requires === undefined) throw new Error('add combination requires --requires <id,id,...>');
      const requires = flags.requires === '' ? [] : flags.requires.split(',');
      return addCombination(doc, {id, name: flags.name, requires, skills: flags.skills});
    }
    case 'remove combination': return removeCombinations(doc, requireValues(rest, 'remove combination'));
    case 'add combination-skills': {
      const id = one('a combination ID');
      if (flags.skills.length === 0) throw new Error('add combination-skills requires --skill <skillId>');
      return addCombinationSkills(doc, id, flags.skills);
    }
    case 'remove combination-skills': {
      const id = one('a combination ID');
      return removeCombinationSkills(doc, id, flags.skills.length > 0 ? flags.skills : null);
    }
    case 'add frontend-bonus-skill': return addStringListItems(doc, 'frontendBonusSkills', requireValues(rest, 'add frontend-bonus-skill'), 'frontend-bonus-skill');
    case 'remove frontend-bonus-skill': return removeStringListItems(doc, 'frontendBonusSkills', requireValues(rest, 'remove frontend-bonus-skill'), 'frontend-bonus-skill');
    case 'add frontend-package': return addStringListItems(doc, 'frontendPackages', requireValues(rest, 'add frontend-package'), 'frontend-package');
    case 'remove frontend-package': return removeStringListItems(doc, 'frontendPackages', requireValues(rest, 'remove frontend-package'), 'frontend-package');
    case 'add frontend-extension': return addStringListItems(doc, 'webFrontendExtensions', requireValues(rest, 'add frontend-extension'), 'frontend-extension');
    case 'remove frontend-extension': return removeStringListItems(doc, 'webFrontendExtensions', requireValues(rest, 'remove frontend-extension'), 'frontend-extension');
    default: throw new Error(`Unknown ${command} target: ${target}\n${USAGE}`);
  }
}

async function runEdit(parsed, buildResult) {
  const {command, flags} = parsed;
  let map;
  try { map = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, command, EXIT_ERROR, 'map-unreadable', error.message); }
  const doc = structuredClone(map);
  const result = await buildResult(doc);
  const commandName = command === 'set' ? 'set registry-id' : `${command} ${parsed.operands[0]}`;
  return commitMap(flags, commandName, doc, result);
}

async function commitMap(flags, commandName, doc, result) {
  if (!result.changed) {
    if (flags.json) printJson({ok: true, command: commandName, changed: false, ops: [], notices: result.notices, warnings: []});
    else {
      console.log('No changes needed.');
      if (!flags.quiet) for (const notice of result.notices) console.error(`notice: ${notice}`);
    }
    return EXIT_OK;
  }

  let warnings = [];
  const {ids, warning} = await readManifestSkillIds(flags.root);
  if (warning !== undefined) warnings.push(issue('warning', 'manifest-unavailable', '', warning));
  // Integration references are warnings here: the manifest is generated from
  // this map and may legitimately be stale until regeneration. `validate`
  // reports them as errors.
  const issues = checkMapDocument(doc, {localSkillIds: ids, undeclaredSkillSeverity: 'warning'});
  const errors = issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    warnings = [...warnings, ...issues.filter((item) => item.severity !== 'error')];
    if (flags.json) printJson({ok: false, command: commandName, changed: false, written: false, issues: [...errors, ...warnings], notices: result.notices});
    else {
      console.error(`${MAP_FILE} was not changed: validation of the edited map failed.`);
      printIssues(flags, [...errors, ...warnings]);
    }
    return EXIT_ISSUES;
  }
  warnings = [...warnings, ...issues.filter((item) => item.severity !== 'error')];

  if (flags.dryRun) {
    if (flags.json) printJson({ok: true, command: commandName, dryRun: true, changed: true, ops: result.ops, notices: result.notices, warnings, content: serializeMap(doc)});
    else {
      console.log(`--- ${MAP_FILE} (dry run, ${result.ops.length} operation(s)) ---`);
      process.stdout.write(serializeMap(doc));
    }
    return EXIT_OK;
  }
  try { await writeMapFile(flags.root, doc); }
  catch (error) { return reportFailure(flags, commandName, EXIT_ERROR, 'write-failed', error.message); }

  if (flags.json) {
    printJson({ok: true, command: commandName, changed: true, written: true, ops: result.ops, notices: result.notices, warnings, reminder: 'Run node scripts/generate.mjs to refresh generated files.'});
  } else {
    const color = colorEnabled(flags);
    console.log(paint(`Updated ${MAP_FILE} (${result.ops.length} operation(s)).`, 32, color));
    if (!flags.quiet) {
      for (const notice of result.notices) console.error(`notice: ${notice}`);
      for (const item of warnings) printIssueLine(item, color);
      console.error('Run node scripts/generate.mjs to refresh generated files.');
    }
  }
  return EXIT_OK;
}

async function runMutate(parsed) {
  const {command, operands} = parsed;
  const [target, ...rest] = operands;
  if (target === undefined) throw new Error(`${command} requires a target\n${USAGE}`);
  return runEdit(parsed, (doc) => applyMutation(doc, command, target, rest, parsed.flags));
}

async function runSet(parsed) {
  const {command, operands, flags} = parsed;
  const [target, ...rest] = operands;
  if (target !== 'registry-id' || rest.length !== 1) throw new Error(`set requires: set registry-id owner/repository\n${USAGE}`);
  const newId = rest[0].trim();
  if (!isValidRegistryId(newId)) throw new Error(`invalid registry ID: ${newId} (expected owner/repository)`);
  return runEdit({...parsed, operands: ['registry-id']}, (doc) => setRegistryId(doc, newId));
}

// --- discover ---------------------------------------------------------------

async function runDiscover({flags, operands}) {
  if (operands.length > 0) throw new Error(`discover takes no operands\n${USAGE}`);
  let map;
  try { map = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, 'discover', EXIT_ERROR, 'map-unreadable', error.message); }
  let previous = {};
  try {
    const state = await readManifestDocument(flags.root);
    if (!state.missing && state.manifest && typeof state.manifest === 'object') previous = state.manifest;
  } catch { /* a stale or broken manifest must not block read-only discovery */ }
  let manifest;
  try { manifest = await buildManifest(flags.root, map, previous); }
  catch (error) { return reportFailure(flags, 'discover', EXIT_ERROR, 'discover-failed', error.message); }
  const diagnostics = manifest[MANIFEST_DIAGNOSTICS] ?? [];
  const skills = (Array.isArray(manifest.skills) ? manifest.skills : []).map(({id, name, path: skillPath, description}) => ({
    id, name, path: skillPath, ...(description ? {description} : {}),
  }));
  if (flags.json) printJson({ok: true, command: 'discover', registryId: map.registryId, skills, diagnostics});
  else {
    for (const skill of skills) console.log(`${skill.id}\t${skill.path}\t${skill.name}`);
    if (!flags.quiet) for (const diagnostic of diagnostics) console.error(`warning: ${diagnostic}`);
  }
  return EXIT_OK;
}

// --- batch ------------------------------------------------------------------

const BATCH_GLOBAL_FLAGS = new Set(['--json', '--dry-run', '--quiet', '--force', '--no-color', '--root', '--schemas']);

async function readOperations(file) {
  let info;
  try { info = await lstat(file); } catch (error) { throw new Error(`Cannot read operations file: ${error.message}`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > BATCH_LIMIT) throw new Error(`Invalid operations file: ${file}`);
  let operations;
  try { operations = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Operations file is not valid JSON: ${error.message}`); }
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('Operations file must contain a nonempty JSON array of argument arrays');
  for (const [index, operation] of operations.entries()) {
    if (!Array.isArray(operation) || operation.length === 0 || operation.some((item) => typeof item !== 'string')) {
      throw new Error(`batch[${index}] must be a nonempty array of strings`);
    }
    for (const item of operation) {
      const flagName = item.split('=')[0];
      if (BATCH_GLOBAL_FLAGS.has(flagName)) throw new Error(`batch[${index}]: global option ${flagName} is not allowed inside a batch`);
    }
  }
  return operations;
}

async function runBatch({flags, operands}) {
  if (operands.length !== 1) throw new Error(`batch requires exactly one operations file\n${USAGE}`);
  const operations = await readOperations(path.resolve(operands[0]));
  let map;
  try { map = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, 'batch', EXIT_ERROR, 'map-unreadable', error.message); }
  const doc = structuredClone(map);
  const ops = [];
  const notices = [];
  let changed = false;
  for (const [index, operation] of operations.entries()) {
    let result;
    try {
      const parsed = parseArguments(operation);
      if (parsed.command === 'set') {
        const [target, ...rest] = parsed.operands;
        if (target !== 'registry-id' || rest.length !== 1) throw new Error('set requires: set registry-id owner/repository');
        const newId = rest[0].trim();
        if (!isValidRegistryId(newId)) throw new Error(`invalid registry ID: ${newId} (expected owner/repository)`);
        result = setRegistryId(doc, newId);
      } else if (parsed.command === 'add' || parsed.command === 'remove') {
        const [target, ...rest] = parsed.operands;
        if (target === undefined) throw new Error(`${parsed.command} requires a target`);
        result = await applyMutation(doc, parsed.command, target, rest, parsed.flags);
      } else {
        throw new Error(`only add, remove, and set operations are allowed (found ${parsed.command})`);
      }
    } catch (error) {
      throw new Error(`batch[${index}] (${operation.join(' ')}): ${error.message}`);
    }
    if (result.changed) changed = true;
    ops.push(...result.ops);
    notices.push(...result.notices);
  }
  return commitMap(flags, 'batch', doc, {changed, ops, notices});
}

// --- interactive ------------------------------------------------------------

const CANCEL = Symbol('cancel');

const INTERACTIVE_SECTIONS = [
  {number: 1, label: 'always-recommend', field: 'alwaysRecommend', kind: 'list', target: 'always-recommend'},
  {number: 2, label: 'external skills', field: 'externalSkills', kind: 'external'},
  {number: 3, label: 'technologies', field: 'technologies', kind: 'technology'},
  {number: 4, label: 'technology skills', field: 'technologySkills', kind: 'association', target: 'technology-skills', idLabel: 'Technology ID'},
  {number: 5, label: 'combinations', field: 'combinations', kind: 'combination'},
  {number: 6, label: 'combination skills', field: 'combinationSkills', kind: 'association', target: 'combination-skills', idLabel: 'Combination ID'},
  {number: 7, label: 'frontend bonus skills', field: 'frontendBonusSkills', kind: 'list', target: 'frontend-bonus-skill'},
  {number: 8, label: 'frontend packages', field: 'frontendPackages', kind: 'list', target: 'frontend-package'},
  {number: 9, label: 'frontend extensions', field: 'webFrontendExtensions', kind: 'list', target: 'frontend-extension'},
];

function splitValues(text) {
  return text.split(/[\s,]+/u).filter(Boolean);
}

function printInteractiveSummary(doc) {
  const counts = INTERACTIVE_SECTIONS
    .map((section) => `${section.number}:${section.label}=${Array.isArray(doc[section.field]) ? doc[section.field].length : 0}`)
    .join('  ');
  console.log(`\n${MAP_FILE} (${typeof doc.registryId === 'string' ? doc.registryId : 'no registryId'})\n${counts}`);
}

async function askRequired(ask, label) {
  const value = await ask(`${label}: `);
  if (value === null || value === '') {
    console.log('Cancelled.');
    return CANCEL;
  }
  return value;
}

async function interactiveMutation(section, mode, doc, ask) {
  const flags = {skills: []};
  if (section.kind === 'list') {
    const raw = await askRequired(ask, `${mode === 'add' ? 'Values to add' : 'Values to remove'} (comma or space separated)`);
    if (raw === CANCEL) return null;
    const values = splitValues(raw);
    if (values.length === 0) { console.log('No values supplied.'); return null; }
    return applyMutation(doc, mode, section.target, values, flags);
  }
  if (section.kind === 'external') {
    const id = await askRequired(ask, 'External skill ID');
    if (id === CANCEL) return null;
    if (mode === 'remove') return applyMutation(doc, 'remove', 'external', [id], flags);
    const name = await askRequired(ask, 'Display name');
    if (name === CANCEL) return null;
    const source = await askRequired(ask, 'Upstream source (owner/repo)');
    if (source === CANCEL) return null;
    const skill = await askRequired(ask, 'Upstream skill name');
    if (skill === CANCEL) return null;
    const description = (await ask('Description (optional): ')) ?? '';
    return applyMutation(doc, 'add', 'external', [id], {
      name, source, skills: [skill], description: description || undefined,
    });
  }
  if (section.kind === 'technology') {
    const id = await askRequired(ask, 'Technology ID');
    if (id === CANCEL) return null;
    if (mode === 'remove') return applyMutation(doc, 'remove', 'technology', [id], flags);
    const name = await askRequired(ask, 'Display name');
    if (name === CANCEL) return null;
    const detectText = await ask('Detect JSON, @file, or blank for {}: ');
    if (detectText === null) return null;
    if (detectText === '-') { console.error('error: stdin detect is not available in interactive mode'); return null; }
    if (detectText !== '') {
      try { await parseDetectArgument(detectText); }
      catch (error) { console.error(`error: ${error.message}`); return null; }
    }
    const skillsText = (await ask('Skill IDs (optional, comma or space separated): ')) ?? '';
    return applyMutation(doc, 'add', 'technology', [id], {name, detect: detectText === '' ? '{}' : detectText, skills: splitValues(skillsText)});
  }
  if (section.kind === 'combination') {
    const id = await askRequired(ask, 'Combination ID');
    if (id === CANCEL) return null;
    if (mode === 'remove') return applyMutation(doc, 'remove', 'combination', [id], flags);
    const name = await askRequired(ask, 'Display name');
    if (name === CANCEL) return null;
    const requiresText = (await ask('Required technology IDs (comma or space separated): ')) ?? '';
    const skillsText = (await ask('Skill IDs (optional, comma or space separated): ')) ?? '';
    return applyMutation(doc, 'add', 'combination', [id], {
      name, requires: splitValues(requiresText), skills: splitValues(skillsText),
    });
  }
  const id = await askRequired(ask, section.idLabel);
  if (id === CANCEL) return null;
  const skillsText = (await ask(`Skill IDs (${mode === 'remove' ? 'blank removes the whole entry' : 'required'}): `)) ?? '';
  return applyMutation(doc, mode, section.target, [id], {skills: splitValues(skillsText)});
}

function createPromptReader() {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY)});
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      process.stdout.write(prompt);
      const {value, done} = await lines.next();
      return done ? null : String(value).trim();
    },
    close() { rl.close(); },
  };
}

async function runInteractive(flags) {
  if (flags.json || flags.dryRun) throw new Error('--interactive cannot be combined with --json or --dry-run');
  let current;
  try { current = await readMapFile(flags.root); }
  catch (error) { return reportFailure(flags, 'interactive', EXIT_ERROR, 'map-unreadable', error.message); }
  let doc = structuredClone(current);
  const reader = createPromptReader();
  const ask = reader.ask;
  try {
    console.log(`Editing ${MAP_FILE} in ${path.resolve(flags.root)}. Enter q at any prompt to quit.`);
    for (;;) {
      printInteractiveSummary(doc);
      const choice = await ask('Section (1-9, s=show map, q=quit): ');
      if (choice === null || /^(q|quit|exit)$/iu.test(choice)) break;
      if (choice === '' || /^s/iu.test(choice)) { process.stdout.write(serializeMap(doc)); continue; }
      const section = INTERACTIVE_SECTIONS.find((item) => String(item.number) === choice);
      if (!section) { console.log('Unknown section.'); continue; }
      process.stdout.write(`${JSON.stringify(doc[section.field] ?? [], null, 2)}\n`);
      const action = await ask('Action (a=add, r=remove, b=back): ');
      if (action === null || /^(q|quit|exit)$/iu.test(action)) break;
      if (action === '' || /^b/iu.test(action)) continue;
      const mode = /^a/iu.test(action) ? 'add' : /^r/iu.test(action) ? 'remove' : null;
      if (mode === null) { console.log('Unknown action.'); continue; }
      const candidate = structuredClone(doc);
      let result;
      try { result = await interactiveMutation(section, mode, candidate, ask); }
      catch (error) { console.error(`error: ${error.message}`); continue; }
      if (result === null) continue;
      if (!result.changed) { console.log('No changes needed.'); continue; }

      const {ids, warning} = await readManifestSkillIds(flags.root);
      if (warning !== undefined) console.error(`warning: ${warning}`);
      const issues = checkMapDocument(candidate, {localSkillIds: ids, undeclaredSkillSeverity: 'warning'});
      const errors = issues.filter((item) => item.severity === 'error');
      const warnings = issues.filter((item) => item.severity !== 'error');
      if (errors.length > 0) {
        printIssues(flags, errors);
        console.error(`${MAP_FILE} was not changed: the edited map failed validation.`);
        continue;
      }
      try { await writeMapFile(flags.root, candidate); }
      catch (error) { return reportFailure(flags, 'interactive', EXIT_ERROR, 'write-failed', error.message); }
      doc = candidate;
      console.log(`Updated ${MAP_FILE} (${result.ops.length} operation(s)). Run node scripts/generate.mjs to refresh generated files.`);
      if (!flags.quiet) for (const item of warnings) printIssueLine(item, colorEnabled(flags));
    }
  } finally { reader.close(); }
  return EXIT_OK;
}

// --- main -------------------------------------------------------------------

async function main(argv) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (argv[0] === '--interactive' || argv[0] === '-i') {
    const parsed = parseArguments(['interactive', ...argv.slice(1)]);
    if (parsed.operands.length > 0) throw new Error(`--interactive takes no operands\n${USAGE}`);
    return await runInteractive(parsed.flags);
  }
  const parsed = parseArguments(argv);
  switch (parsed.command) {
    case 'validate': return await runValidate(parsed);
    case 'create': return await runCreate(parsed);
    case 'show': return await runShow(parsed);
    case 'discover': return await runDiscover(parsed);
    case 'batch': return await runBatch(parsed);
    case 'add': case 'remove': return await runMutate(parsed);
    case 'set': return await runSet(parsed);
    default: throw new Error(`Unknown command: ${parsed.command}\n${USAGE}`);
  }
}

if (isDirect(import.meta.url)) {
  try {
    assertSupportedNode();
    process.exitCode = await main(process.argv.slice(2)) ?? EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) {
      printJson({ok: false, command: process.argv[2], exitCode: EXIT_ERROR, issues: [issue('error', 'error', '', message)]});
    } else {
      console.error(`${paint('error', 31, Boolean(process.stdout.isTTY) && !process.argv.includes('--no-color') && !process.env.NO_COLOR)}: ${message}`);
    }
    process.exitCode = EXIT_ERROR;
  }
}
