#!/usr/bin/env node
// Dependency-free manifest generator. buildManifest is a read-only preview API.
import {randomUUID} from 'node:crypto';
import {lstat, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {extractFrontmatter} from './lib/frontmatter.mjs';
export const MANIFEST_SCHEMA='https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json';
// Internal generation metadata lives outside the JSON key space: every string key,
// including "diagnostics", is valid user-owned manifest data.
export const MANIFEST_DIAGNOSTICS = Symbol('manifest diagnostics');
const MAP_SCHEMA='https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json';
const JSON_LIMIT=4*1024*1024, SKILL_LIMIT=1024*1024, ENTRY_LIMIT=20_000, WALK_ENTRY_LIMIT=200_000;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const cmp=(a,b)=>a<b?-1:a>b?1:0;
async function readJson(file,limit=JSON_LIMIT){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error(`${file}: expected regular file within ${limit} byte limit`);return JSON.parse(await readFile(file,'utf8'));}

export async function buildManifest(root,map,previousManifest={}) {
  const base=path.resolve(root);
  if(!obj(map)||typeof map.registryId!=='string'||! /^[\w.-]+\/[\w.-]+$/u.test(map.registryId))throw Error('skills-map.json requires a valid registryId');
  const skills=path.join(base,'skills');
  const rootStat=await lstat(skills).catch(e=>e.code==='ENOENT'?undefined:Promise.reject(e));
  if(rootStat&&(!rootStat.isDirectory()||rootStat.isSymbolicLink()))throw Error('skills must be a regular directory, not a symlink');
  const baseReal=await realpath(base), records=[], diagnostics=[];let walked=0;
  async function visit(folder){
    const entries=await readdir(folder,{withFileTypes:true});entries.sort((a,b)=>cmp(a.name,b.name));
    for(const entry of entries){
      // Keep traversal bounded independently of the schema's 20,000 skill-record cap.
      if(++walked>WALK_ENTRY_LIMIT)throw Error(`skills tree exceeds ${WALK_ENTRY_LIMIT} filesystem entries`);
      const full=path.join(folder,entry.name), rel=path.relative(base,full).split(path.sep).join('/'), stat=await lstat(full);
      if(stat.isSymbolicLink()){diagnostics.push(`${rel}: skipped symbolic link`);continue;}
      if(entry.isDirectory()){
        const real=await realpath(full);if(real!==baseReal&&!real.startsWith(baseReal+path.sep)){diagnostics.push(`${rel}: skipped path outside registry root`);continue;}
        await visit(full);continue;
      }
      if(!entry.isFile()||entry.name!=='SKILL.md')continue;
      if(stat.size>SKILL_LIMIT)throw Error(`${rel}: exceeds ${SKILL_LIMIT} byte file limit`);
      const extracted=extractFrontmatter(await readFile(full,'utf8'),{source:rel});diagnostics.push(...extracted.diagnostics);
      const dir=path.posix.dirname(rel).slice('skills/'.length);
      if(dir==='.'||!dir){diagnostics.push(`${rel}: skill must be inside a directory under skills; skipped`);continue;}
      const fallback=path.posix.basename(dir), id=`${map.registryId}/${dir}`;
      const name=extracted.metadata.name?.trim()||fallback;
      if(!extracted.metadata.name?.trim())diagnostics.push(`${rel}: name: missing or blank; using directory name "${fallback}"`);
      const description=extracted.metadata.description?.trim();
      const old=Array.isArray(previousManifest?.skills)?previousManifest.skills.find(x=>x?.path===rel):undefined;
      const record={...(obj(old)?old:{}),id,name,path:rel};
      if(description)record.description=description;else delete record.description;
      records.push(record);
      if(records.length>ENTRY_LIMIT)throw Error(`skills tree exceeds ${ENTRY_LIMIT} manifest skills`);
    }
  }
  if(rootStat)await visit(skills);
  records.sort((a,b)=>cmp(a.id,b.id));
  const output={...(obj(previousManifest)?previousManifest:{}),schemaVersion:1,registryId:map.registryId,skills:records};
  if(!Object.hasOwn(output,'$schema'))output.$schema=MAP_SCHEMA.replace('skills-map','skills-manifest');
  const manifest={};if(Object.hasOwn(output,'$schema'))manifest.$schema=output.$schema;
  // Canonical header order is shared with configure and the checked-in goldens.
  if(Object.hasOwn(output,'schemaVersion'))manifest.schemaVersion=output.schemaVersion;
  if(Object.hasOwn(output,'registryId'))manifest.registryId=output.registryId;
  if(Object.hasOwn(output,'skills'))manifest.skills=output.skills;
  for(const [k,v] of Object.entries(output))if(!['$schema','schemaVersion','registryId','skills'].includes(k))Object.defineProperty(manifest,k,{value:v,enumerable:true,writable:true,configurable:true});
  manifest.schemaVersion=1;manifest.registryId=map.registryId;manifest.skills=records;
  Object.defineProperty(manifest,MANIFEST_DIAGNOSTICS,{value:diagnostics});
  return manifest;
}

export async function generateManifest({root=process.cwd(),check=false,map,previousManifest}={}){
  const base=path.resolve(root), mapDoc=map??await readJson(path.join(base,'skills-map.json')), target=path.join(base,'skills-manifest.json');
  let previous=previousManifest;
  if(previous===undefined){try{previous=await readJson(target);}catch(e){if(e.code!=='ENOENT')throw e;previous={};}}
  const manifest=await buildManifest(base,mapDoc,previous), diagnostics=manifest[MANIFEST_DIAGNOSTICS], output=JSON.stringify(manifest,null,2)+'\n';
  if(Buffer.byteLength(output)>JSON_LIMIT)throw Error(`generated skills-manifest.json exceeds ${JSON_LIMIT} byte limit`);
  let mode=0o666;
  try{const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink())throw Error('skills-manifest.json must be a regular file, not a symlink');if(s.nlink>1)throw Error('skills-manifest.json must not be hard-linked');if(s.size>JSON_LIMIT)throw Error(`skills-manifest.json exceeds ${JSON_LIMIT} byte limit`);mode=s.mode&0o777;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(check){let current='';try{current=await readFile(target,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(current!==output)throw Error('skills-manifest.json is out of date; run the generator');return {manifest,diagnostics,changed:false};}
  const temp=path.join(base,`.skills-manifest.${randomUUID()}.tmp`);
  try{await writeFile(temp,output,{flag:'wx',mode});await rename(temp,target);}finally{await rm(temp,{force:true});}
  return {manifest,diagnostics,changed:true};
}
async function main(args){let root=process.cwd(),check=false;for(let i=0;i<args.length;i++){if(args[i]==='--check')check=true;else if(args[i]==='--root'&&args[i+1])root=args[++i];else throw Error(`unknown or incomplete option: ${args[i]}`);}const result=await generateManifest({root,check});for(const d of result.diagnostics)console.error(`warning: ${d}`);console.log(check?`Manifest is current (${result.manifest.skills.length} skills).`:`Generated skills-manifest.json (${result.manifest.skills.length} skills).`);}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{await main(process.argv.slice(2));}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}}
