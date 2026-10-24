import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {buildManifest, generateManifest, MANIFEST_DIAGNOSTICS} from './generate-manifest.mjs';
import {extractFrontmatter} from './lib/frontmatter.mjs';
const exec=promisify(execFile), node=process.env.NODE22_BIN??process.execPath;
const script=fileURLToPath(new URL('./generate-manifest.mjs',import.meta.url));
const map={schemaVersion:2,registryId:'owner/registry'};
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nosey-gen-'));try{await fs.mkdir(path.join(dir,'skills'),{recursive:true});await fs.writeFile(path.join(dir,'skills-map.json'),JSON.stringify(map));return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
async function putSkill(root,rel,content){const file=path.join(root,'skills',rel,'SKILL.md');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}
test('lexically extracts quoted and block metadata, BOM, CRLF, comments and punctuation',()=>{
 const r=extractFrontmatter('\uFEFF---\r\nname: "A: # name" # comment\r\ndescription: >-\r\n  first: line\r\n  second # literal\r\nignored:\r\n  value: no\r\n---\r\nbody');
 assert.deepEqual(r.metadata,{name:'A: # name',description:'first: line second # literal'});assert.deepEqual(r.diagnostics,[]);
 const s=extractFrontmatter("---\nname: 'It''s: # fine'\ndescription: |2+\n    one\n    two\n\n---\n");assert.equal(s.metadata.name,"It's: # fine");assert.equal(s.metadata.description,'  one\n  two\n\n');
});
test('metadata scalars reject plain non-strings and safely ignore quoted comments',()=>{
 for(const scalar of ['name: 42 # comment with " quote','name: true # comment','name: null']){
  const result=extractFrontmatter(`---\n${scalar}\ndescription: "value" # comment containing \\" a quote\n---`);
  assert.equal(result.metadata.name,undefined,scalar);
  assert.equal(result.metadata.description,'value');
  assert.ok(result.diagnostics.length>0);
 }
 const single=extractFrontmatter("---\nname: 'It''s a value' # comment with 'quotes'\n---");
 assert.equal(single.metadata.name,"It's a value");
});
test('plain YAML numeric, special, and timestamp-like spellings are diagnostic while quoted forms stay strings',()=>{
 for(const scalar of ['1_000','0xFF','.nan','2024-01-02','2024-01-02T12:30:00Z','0o77','0b101','1.2e+3']){
  const result=extractFrontmatter(`---\nname: ${scalar} # comment\n---`);
  assert.equal(result.metadata.name,undefined,scalar);
  assert.ok(result.diagnostics.some(message=>message.includes('metadata must be a string scalar')),scalar);
 }
 for(const scalar of ["'1_000'",'"0xFF"',"'.nan'",'"2024-01-02"']){
  const expected=scalar.slice(1,-1);
  const result=extractFrontmatter(`---\nname: ${scalar} # trailing comment\n---`);
  assert.equal(result.metadata.name,expected,scalar);
  assert.deepEqual(result.diagnostics,[]);
 }
});
test('block scalar indicators support either order and preserve more-indented folding',()=>{
 for(const header of ['>-2','>2-']){
  const result=extractFrontmatter(`---\ndescription: ${header}\n  first\n    indented\n  second\n---`);
  assert.equal(result.metadata.description,'first\n  indented\nsecond');
 }
 assert.equal(extractFrontmatter('---\ndescription: >+\n  line\n\n---').metadata.description,'line\n\n');
});
test('unsupported and nonscalar metadata is diagnostic, not a quality failure',()=>{
 const r=extractFrontmatter('---\nname: [complex, value]\ndescription: {not: scalar}\n---');assert.deepEqual(r.metadata,{});assert.equal(r.diagnostics.length,2);
});
test('buildManifest is read-only, deterministic, nested and preserves existing raw fields by path',async()=>fixture(async root=>{
 await putSkill(root,'z/leaf','---\nname: Zed\ndescription: desc # note\n---\n');await putSkill(root,'alpha','---\nname: \n---\n');
 const old={$schema:{custom:true},schemaVersion:1,registryId:'old/old',custom:'preserve',skills:[{id:'old/alpha',path:'skills/alpha/SKILL.md',name:'old',extension:7},{id:'other',path:'skills/removed/SKILL.md',unknown:true}]};
 const before=await fs.readdir(root);const manifest=await buildManifest(root,map,old), diagnostics=manifest[MANIFEST_DIAGNOSTICS];
 assert.deepEqual(Object.keys(manifest).slice(0,4),['$schema','schemaVersion','registryId','skills']);
 assert.deepEqual(manifest.skills.map(s=>s.id),['owner/registry/alpha','owner/registry/z/leaf']);assert.equal(manifest.custom,'preserve');assert.deepEqual(manifest.$schema,{custom:true});assert.equal(manifest.skills[0].extension,7);assert.equal(manifest.skills[0].name,'alpha');assert.equal(manifest.skills[0].description,undefined);assert.equal(manifest.skills[1].description,'desc');assert.ok(diagnostics.some(x=>x.includes('using directory name')));assert.deepEqual(await fs.readdir(root),before);assert.equal((await fs.stat(path.join(root,'skills-manifest.json')).catch(()=>null)),null);
}));
test('missing annotation is canonical; check mode never writes',async()=>fixture(async root=>{
 await putSkill(root,'one','---\nname: One\n---\n');const preview=await buildManifest(root,map,{});assert.equal(preview.$schema,'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json');
 await assert.rejects(generateManifest({root,check:true}),/out of date/);await assert.rejects(fs.stat(path.join(root,'skills-manifest.json')),/ENOENT/);
 await generateManifest({root});const first=await fs.readFile(path.join(root,'skills-manifest.json'),'utf8');await generateManifest({root});assert.equal(await fs.readFile(path.join(root,'skills-manifest.json'),'utf8'),first);await generateManifest({root,check:true});
}));
test('symlink roots fail; links below skills are skipped and diagnosed',async()=>fixture(async root=>{
 await fs.rm(path.join(root,'skills'),{recursive:true});const outside=await fs.mkdtemp(path.join(os.tmpdir(),'nosey-out-'));try{await fs.symlink(outside,path.join(root,'skills')); await assert.rejects(buildManifest(root,map),/not a symlink/);await fs.rm(path.join(root,'skills'));await fs.mkdir(path.join(root,'skills'));await fs.mkdir(path.join(outside,'dir'));await fs.writeFile(path.join(outside,'dir','SKILL.md'),'---\nname: Escape\n---');await fs.symlink(path.join(outside,'dir'),path.join(root,'skills','linked'));const manifest=await buildManifest(root,map);const diagnostics=manifest[MANIFEST_DIAGNOSTICS];assert.equal(manifest.skills.length,0);assert.match(diagnostics[0],/skipped symbolic link/);}finally{await fs.rm(outside,{recursive:true,force:true});}
}));
test('CLI --root and --check work and output files reject symlink/hardlink surprises',async()=>fixture(async root=>{
 await putSkill(root,'one','---\nname: One\n---');await assert.rejects(exec(node,[script,'--check','--root',root]),/out of date/);await assert.rejects(fs.stat(path.join(root,'skills-manifest.json')),/ENOENT/);await exec(node,[script,'--root',root]);await exec(node,[script,'--root',root,'--check']);
 await fs.rm(path.join(root,'skills-manifest.json'));await fs.symlink(path.join(root,'skills-map.json'),path.join(root,'skills-manifest.json'));await assert.rejects(generateManifest({root}),/expected regular file/);await fs.rm(path.join(root,'skills-manifest.json'));await fs.writeFile(path.join(root,'skills-manifest.json'),'{}');await fs.link(path.join(root,'skills-manifest.json'),path.join(root,'hardlink'));await assert.rejects(generateManifest({root}),/hard-linked/);
}));
test('more than 10,000 skill records pass the bounded walk below the schema cap',async()=>fixture(async root=>{
 for(let i=0;i<10_001;i++){
  const folder=path.join(root,'skills','many',`dir-${String(i).padStart(5,'0')}`);
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'SKILL.md'),'---\nname: Item\n---\n');
 }
 const manifest=await buildManifest(root,map);
 assert.equal(manifest.skills.length,10_001);
}));
test('root SKILL.md is diagnosed and generated JSON output is bounded',async()=>fixture(async root=>{
 await fs.writeFile(path.join(root,'skills','SKILL.md'),'---\nname: Root\n---\n');
 const result=await buildManifest(root,map,{});
 assert.equal(result.skills.length,0);
 assert.ok(result[MANIFEST_DIAGNOSTICS].some(value=>value.includes('must be inside a directory')));
 const oversized={large:'x'.repeat(4*1024*1024)};
 await assert.rejects(generateManifest({root,map,previousManifest:oversized}),/generated skills-manifest.json exceeds/);
 await assert.rejects(fs.stat(path.join(root,'skills-manifest.json')),/ENOENT/);
}));
test('raw JSON unknown keys cannot collide with warning metadata or mutate prototypes',async()=>fixture(async root=>{
 await putSkill(root,'one','---\nname: One\n---\n');
 const unknown=JSON.parse('{"diagnostics":{"user":"keep"},"__proto__":{"userMetadata":true},"constructor":{"value":"keep"},"nested":{"diagnostics":1,"__proto__":{"nested":true},"constructor":2}}');
 const result=await buildManifest(root,map,unknown);
 assert.deepEqual(result.diagnostics,{user:'keep'});
 assert.deepEqual(Object.getPrototypeOf(result),Object.prototype);
 assert.equal(Object.hasOwn(result,'__proto__'),true);
 assert.deepEqual(result.__proto__,{userMetadata:true});
 assert.deepEqual(result.constructor,{value:'keep'});
 assert.deepEqual(result.nested,JSON.parse('{"diagnostics":1,"__proto__":{"nested":true},"constructor":2}'));
 assert.deepEqual(result[MANIFEST_DIAGNOSTICS],[]);
}));
