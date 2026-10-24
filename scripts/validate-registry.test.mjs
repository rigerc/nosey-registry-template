import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {loadSchemas, validateDocuments, validateRegistry} from './validate-registry.mjs';

const schemas = {
  manifest: {type:'object',required:['schemaVersion','registryId','skills'],properties:{schemaVersion:{const:1},registryId:{type:'string'},skills:{type:'array',items:{type:'object',required:['id','name','path'],properties:{id:{type:'string'},name:{type:'string'},path:{type:'string'}}}}}},
  map: {type:'object',required:['schemaVersion','registryId'],properties:{schemaVersion:{enum:[1,2]},registryId:{type:'string'},externalSkills:{type:'array'},technologies:{type:'array'},technologySkills:{type:'array'},combinations:{type:'array'},combinationSkills:{type:'array'}},'x-builtInTechnologies':[{id:'react',name:'React'}],'x-builtInCombinations':[{id:'react:next',name:'React + Next'}]},
};
const manifest = {schemaVersion:1,registryId:'acme/demo',skills:[{id:'acme/demo/nested/one',name:'One',path:'skills/nested/one/SKILL.md'}]};
const map = {schemaVersion:2,registryId:'acme/demo',technologies:[],technologySkills:[],combinations:[],combinationSkills:[],alwaysRecommend:['acme/demo/nested/one'],externalSkills:[]};
async function fixture(t, {external = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(),'nosey-validator-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'skills/nested/one'),{recursive:true});
  await writeFile(path.join(root,'skills/nested/one/SKILL.md'),'not parsed or validated by registry checks');
  if (external) await writeFile(path.join(root,'registry.json'),'{malformed and ignored');
  return root;
}
const validate = (root, m = manifest, mp = map, sch = schemas) => validateDocuments({root,manifest:m,map:mp,schemas:sch});

test('validates in-memory docs, exact local path IDs, and ignores registry.json', async (t) => {
  const root = await fixture(t,{external:true});
  assert.deepEqual(await validate(root),{valid:true});
});

test('path component types are determined by position, including directories named SKILL.md', async (t) => {
  const root = await fixture(t);
  const path = 'skills/SKILL.md/tool/SKILL.md';
  await mkdir(`${root}/skills/SKILL.md/tool`, {recursive:true});
  await writeFile(`${root}/${path}`, 'metadata is outside registry validation');
  const nested = {...manifest,skills:[{id:'acme/demo/SKILL.md/tool',name:'Nested',path}]};
  assert.deepEqual(await validate(root,nested,{...map,alwaysRecommend:['acme/demo/SKILL.md/tool']}),{valid:true});

  await writeFile(`${root}/skills/SKILL.md/tool/not-a-directory`, 'file');
  const invalidPath = 'skills/SKILL.md/tool/not-a-directory/child/SKILL.md';
  const invalid = {...manifest,skills:[{id:'acme/demo/SKILL.md/tool/not-a-directory/child',name:'Invalid',path:invalidPath}]};
  await assert.rejects(validate(root,invalid),/invalid component/);
});

test('rejects identity, id/path mismatch, dangling refs, duplicates and unsafe filesystem entries', async (t) => {
  const root = await fixture(t);
  await assert.rejects(validate(root,{...manifest,registryId:'other/demo'}),/registryId do not match/);
  await assert.rejects(validate(root,{...manifest,skills:[{...manifest.skills[0],id:'acme/demo/wrong'}]}),/ID and path do not match/);
  await assert.rejects(validate(root,manifest,{...map,alwaysRecommend:['absent']}),/Skill not declared/);
  await assert.rejects(validate(root,{...manifest,skills:[...manifest.skills,...manifest.skills]}),/Duplicate skill IDs/);
  const linkRoot = await mkdtemp(path.join(os.tmpdir(),'nosey-validator-link-'));
  t.after(() => rm(linkRoot,{recursive:true,force:true}));
  await mkdir(path.join(linkRoot,'skills/nested'),{recursive:true});
  await symlink(path.join(root,'skills/nested/one'),path.join(linkRoot,'skills/nested/one'));
  await assert.rejects(validate(linkRoot),/symlink/);
});

test('enforces local/external collisions and GitHub source parser shape', async (t) => {
  const root = await fixture(t);
  const shortManifest = {...manifest,skills:[{id:'acme/demo/one',name:'One',path:'skills/one/SKILL.md'}]};
  await mkdir(path.join(root,'skills/one'),{recursive:true});
  await writeFile(path.join(root,'skills/one/SKILL.md'),'');
  const external = {id:'acme/demo/one',name:'External',source:'owner/repo',skill:'one'};
  await assert.rejects(validate(root,shortManifest,{...map,externalSkills:[external]}),/collision/);
  await assert.rejects(validate(root,manifest,{...map,externalSkills:[{...external,id:'o/r/one',source:'https://example.com/o/r'}]}),/GitHub owner\/repository/);
  await assert.rejects(validate(root,manifest,{...map,schemaVersion:1,externalSkills:[]}),/requires skills-map.json schemaVersion 2/);
});

test('validates technology, combination, association, regex and MCP parser rules', async (t) => {
  const root = await fixture(t);
  const populated = {...map,technologies:[{id:'react-local',name:'React Local',detect:{packagePatterns:[{source:'x',flags:'gg'}]}}]};
  await assert.rejects(validate(root,manifest,populated),/stateful regex flags/);
  await assert.rejects(validate(root,manifest,{...map,technologies:[{id:'react-local',name:'React',detect:{extra:true}}]}),/Unknown detection field/);
  await assert.rejects(validate(root,manifest,{...map,technologies:[{id:'react-local',name:'React',detect:{mcpServers:[{configFiles:['../.mcp.json'],packages:['x']}]}}]}),/Invalid mcpServers.configFiles/);
  await assert.rejects(validate(root,manifest,{...map,combinations:[{id:'combo',name:'Combo',requires:['unknown']}]}),/Unknown technology in combination/);
  await assert.rejects(validate(root,manifest,{...map,combinationSkills:[{combinationId:'missing',skills:[]}]}),/Unknown combination reference/);
  await validate(root,manifest,{...map,technologies:[{id:'empty-regex-ok',name:'Empty regex',detect:{packagePatterns:[{source:'',flags:''}]}}]});
});

test('fails clearly when combination inventory is required but absent', async (t) => {
  const root = await fixture(t);
  const schemaSet = structuredClone(schemas); delete schemaSet.map['x-builtInCombinations'];
  await assert.rejects(validate(root,manifest,{...map,combinations:[{id:'local',name:'Local',requires:[]}]},schemaSet),/does not publish x-builtInCombinations/);
  assert.deepEqual(await validate(root,manifest,map,schemaSet),{valid:true});
});

test('requires published builtin inventories when resolving IDs and rejects malformed catalogs', async (t) => {
  const root = await fixture(t);
  const missingTech = structuredClone(schemas); delete missingTech.map['x-builtInTechnologies'];
  await assert.rejects(validate(root,manifest,{...map,technologySkills:[{technologyId:'react',skills:[]}]},missingTech),/does not publish x-builtInTechnologies/);
  const badInventory = structuredClone(schemas); badInventory.map['x-builtInCombinations'] = [{name:'missing id'}];
  await assert.rejects(validate(root,manifest,{...map,combinations:[{id:'local',name:'Local',requires:[]}]},badInventory),/x-builtInCombinations/);
});

test('loadSchemas fetches the two exact URLs with no-store manual redirects every time', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({url,options});
    const name = url.endsWith('skills-map.schema.json') ? 'map' : 'manifest';
    return Response.json(schemas[name]);
  };
  await loadSchemas({request}); await loadSchemas({request});
  assert.equal(calls.length,4);
  assert.deepEqual(calls.map((x)=>x.url).sort(),[
    'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json',
    'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json',
    'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json',
    'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json',
  ].sort());
  for (const {options} of calls) { assert.equal(options.cache,'no-store'); assert.equal(options.redirect,'manual'); assert.ok(options.signal instanceof AbortSignal); }
});

test('transport reports HTTP, redirects, malformed JSON, body caps and outages with URL context', async () => {
  const scenarios = [
    [() => new Response('',{status:404}),/HTTP 404.*skills-map\.schema\.json/],
    [() => new Response('',{status:302,headers:{location:'https://evil.invalid'}}),/Redirect refused.*skills-map\.schema\.json/],
    [() => new Response('{bad'),/Invalid JSON.*skills-map\.schema\.json/],
    [() => new Response('x'.repeat(2*1024*1024+1)),/exceeds 2097152 bytes.*skills-map\.schema\.json/],
    [() => {throw new Error('offline')},/Cannot load Nosey schema.*skills-map\.schema\.json.*offline/],
  ];
  for (const [response, pattern] of scenarios) {
    const request = async (requested) => requested.endsWith('skills-map.schema.json') ? response() : Response.json(schemas.manifest);
    await assert.rejects(loadSchemas({request}),pattern);
  }
  const streamedOverflow = new Response(new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(2 * 1024 * 1024));
    controller.enqueue(new Uint8Array(1));
    controller.close();
  }}));
  await assert.rejects(loadSchemas({request: async (requested) => requested.endsWith('skills-map.schema.json') ? streamedOverflow : Response.json(schemas.manifest)}),/exceeds 2097152 bytes.*skills-map\.schema\.json/);
  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = () => AbortSignal.abort(new DOMException('timed out','TimeoutError'));
    await assert.rejects(loadSchemas({request: async (_requested, options) => { throw options.signal.reason; }}),/Cannot load Nosey schema.*timed out/);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('fixture schema directory is explicit and unsupported schema drift fails closed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'nosey-schemas-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'skills-manifest.schema.json'),JSON.stringify(schemas.manifest));
  await writeFile(path.join(dir,'skills-map.schema.json'),JSON.stringify({...schemas.map,properties:{...schemas.map.properties,featureFlags:{unevaluatedProperties:false}}}));
  await assert.rejects(loadSchemas({schemasDir:dir}),/unsupported keyword/);
});

test('fixture schemas must be bounded regular files and cannot be symlinks', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'nosey-schemas-safe-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const manifestFile = path.join(dir,'skills-manifest.schema.json');
  const mapFile = path.join(dir,'skills-map.schema.json');
  await writeFile(manifestFile,JSON.stringify(schemas.manifest));
  await writeFile(mapFile,JSON.stringify(schemas.map));
  assert.deepEqual(await loadSchemas({schemasDir:dir}),schemas);

  await rm(manifestFile);
  await symlink(mapFile,manifestFile);
  await assert.rejects(loadSchemas({schemasDir:dir}),/regular file/);
  await rm(manifestFile);
  await mkdir(manifestFile);
  await assert.rejects(loadSchemas({schemasDir:dir}),/regular file/);
  await rm(manifestFile,{recursive:true});
  await writeFile(manifestFile,' '.repeat(2*1024*1024+1));
  await assert.rejects(loadSchemas({schemasDir:dir}),/exceeds 2097152 bytes/);
});
