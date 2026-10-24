// A deliberately small YAML frontmatter reader for manifest metadata only.
const KEYS = new Set(['name', 'description']);
function note(out, source, key, message) { out.push(`${source}: ${key}: ${message}`); }
function comment(value) { return value.replace(/(^|\s)#.*$/u, '$1'); }
function parseValue(raw, source, key, diagnostics) {
  let value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    if (end <= 0 || (value.slice(end + 1).trim() && !/^\s+#/u.test(value.slice(end + 1)))) { note(diagnostics, source, key, 'invalid single-quoted scalar; ignoring it'); return {invalid:true}; }
    return {value:value.slice(1,end).replaceAll("''", "'")};
  }
  if (value.startsWith('"')) {
    const end = (() => { for (let i=1;i<value.length;i++) { if (value[i]==='\\') { i++; continue; } if (value[i]==='"') return i; } return -1; })();
    try { if (end<0 || (value.slice(end+1).trim() && !/^\s+#/u.test(value.slice(end+1)))) throw Error(); const quoted=value.slice(0,end+1); if (/\\[0-7xNuU]/.test(quoted)) throw Error(); return {value:JSON.parse(quoted)}; }
    catch { note(diagnostics, source, key, 'unsupported or invalid double-quoted scalar; ignoring it'); return {invalid:true}; }
  }
  if (/^[>|]/u.test(value)) {
    const m = /^([>|])([1-9])?([+-])?$/u.exec(value);
    if (!m) { note(diagnostics, source, key, 'unsupported block scalar header; ignoring it'); return {invalid:true}; }
    return {block:m};
  }
  if (/^[\[{&*!|>@`]/u.test(value) || /^(?:null|~|true|false|[-+]?(?:\d|\.\d))\s*$/iu.test(value)) {
    note(diagnostics, source, key, 'metadata must be a string scalar; ignoring non-string or unsupported value'); return {invalid:true};
  }
  return {value:comment(value).trimEnd()};
}
export function extractFrontmatter(content, {source='SKILL.md'} = {}) {
  const diagnostics=[];
  const lines=content.replace(/^\uFEFF/u,'').replaceAll('\r\n','\n').replaceAll('\r','\n').split('\n');
  if (lines[0] !== '---') return {metadata:{}, diagnostics:[`${source}: missing YAML frontmatter; using metadata fallbacks`]};
  const end=lines.findIndex((line,index)=>index>0 && /^(?:---|\.\.\.)(?:\s+#.*)?\s*$/u.test(line));
  if (end<0) return {metadata:{}, diagnostics:[`${source}: unterminated YAML frontmatter; using metadata fallbacks`]};
  const values=new Map();
  for (let i=1;i<end;i++) {
    const pair=/^([A-Za-z][\w-]*):(?:[ \t]+(.*)|[ \t]*)$/u.exec(lines[i]);
    if (!pair || !KEYS.has(pair[1])) continue;
    const key=pair[1]; if (values.has(key)) note(diagnostics,source,key,'duplicate key; using last occurrence');
    const parsed=parseValue(pair[2]??'',source,key,diagnostics);
    if (!parsed.block) { values.set(key,parsed.invalid?undefined:parsed.value); continue; }
    const m=parsed.block; let cursor=i+1;
    while(cursor<end && (lines[cursor]==='' || /^[ \t]+/u.test(lines[cursor]))) cursor++;
    const rawLines=lines.slice(i+1,cursor); i=cursor-1;
    const nonblank=rawLines.filter(line=>line.trim());
    const indent=m[2]?Number(m[2]):(nonblank.length?Math.min(...nonblank.map(line=>/^ */u.exec(line)[0].length)):0);
    if(nonblank.some(line=>/^ */u.exec(line)[0].length<indent)){note(diagnostics,source,key,'inconsistent block indentation; ignoring it');values.set(key,undefined);continue;}
    const block=rawLines.map(line=>line.slice(Math.min(indent,line.length)));
    let value;
    if(m[1]==='|') value=block.join('\n');
    else { value=''; for(let j=0;j<block.length;j++){if(j)value+=block[j-1]!==''&&block[j]!==''?' ':'\n';value+=block[j];} }
    if(m[3]==='-') value=value.replace(/\n+$/u,''); else if(m[3]==='+') value+='\n'; else value=value.replace(/\n*$/u,'')+'\n';
    values.set(key,value);
  }
  const metadata={}; for(const key of KEYS){const value=values.get(key);if(typeof value==='string')metadata[key]=value;}
  return {metadata,diagnostics};
}
