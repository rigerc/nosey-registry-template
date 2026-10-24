// A deliberately small YAML frontmatter reader for manifest metadata only.
// Plain scalars are accepted only when they are unambiguously strings under the
// supported subset. This is not a general YAML 1.2 parser; quote ambiguous
// numeric, boolean, null, and timestamp-like metadata to preserve it as text.
const KEYS = new Set(['name', 'description']);
function note(out, source, key, message) { out.push(`${source}: ${key}: ${message}`); }
function comment(value) { return value.replace(/(^|\s)#.*$/u, '$1'); }
function quotedEnd(value, quote) {
  for (let i = 1; i < value.length; i++) {
    if (quote === '"' && value[i] === '\\') { i++; continue; }
    if (quote === "'" && value[i] === "'" && value[i + 1] === "'") { i++; continue; }
    if (value[i] === quote) return i;
  }
  return -1;
}
function onlyCommentOrSpace(value) {
  const tail = value.trimStart();
  return !tail || tail.startsWith('#');
}
function parseValue(raw, source, key, diagnostics) {
  let value = raw.trim();
  if (value.startsWith("'")) {
    const end = quotedEnd(value, "'");
    if (end <= 0 || !onlyCommentOrSpace(value.slice(end + 1))) { note(diagnostics, source, key, 'invalid single-quoted scalar; ignoring it'); return {invalid:true}; }
    return {value:value.slice(1,end).replaceAll("''", "'")};
  }
  if (value.startsWith('"')) {
    const end = quotedEnd(value, '"');
    try { if (end<0 || !onlyCommentOrSpace(value.slice(end+1))) throw Error(); const quoted=value.slice(0,end+1); if (/\\[0-7xNuU]/.test(quoted)) throw Error(); return {value:JSON.parse(quoted)}; }
    catch { note(diagnostics, source, key, 'unsupported or invalid double-quoted scalar; ignoring it'); return {invalid:true}; }
  }
  if (/^[>|]/u.test(value)) {
    const m = /^([>|])(?:(?:([1-9])([+-]?)|([+-])([1-9]?)))?$/u.exec(value);
    if (!m) { note(diagnostics, source, key, 'unsupported block scalar header; ignoring it'); return {invalid:true}; }
    return {block:{style:m[1], indent:m[2]||m[5]||'', chomping:m[3]||m[4]||''}};
  }
  const plain = comment(value).trim();
  const yamlNumber = /^[+-]?(?:(?:0|[1-9][\d_]*)(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?|\.[\d_]+(?:[eE][+-]?[\d_]+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+)$/iu;
  const yamlTimestamp = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]?(?:Z|[+-]\d{2}:\d{2}))?)?$/u;
  if (/^[\[{&*!|>@`]/u.test(plain) || /^(?:null|~|true|false|\.nan|[+-]?\.inf)$/iu.test(plain) || yamlNumber.test(plain) || yamlTimestamp.test(plain) || /^(?:yes|no|on|off)$/iu.test(plain)) {
    note(diagnostics, source, key, 'metadata must be a string scalar; ignoring non-string or unsupported value'); return {invalid:true};
  }
  return {value:plain};
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
    const indent=m.indent?Number(m.indent):(nonblank.length?Math.min(...nonblank.map(line=>/^ */u.exec(line)[0].length)):0);
    if(nonblank.some(line=>/^ */u.exec(line)[0].length<indent)){note(diagnostics,source,key,'inconsistent block indentation; ignoring it');values.set(key,undefined);continue;}
    const block=rawLines.map(line=>line.trim()?line.slice(Math.min(indent,line.length)):'');
    let value;
    if(m.style==='|') value=block.join('\n');
    else { value=''; for(let j=0;j<block.length;j++){if(j)value+=block[j-1]!==''&&block[j]!==''&&!/^ /u.test(block[j-1])&&!/^ /u.test(block[j])?' ':'\n';value+=block[j];} }
    if(m.chomping==='-') value=value.replace(/\n+$/u,''); else if(m.chomping==='+') value+='\n'; else value=value.replace(/\n*$/u,'')+'\n';
    values.set(key,value);
  }
  const metadata={}; for(const key of KEYS){const value=values.get(key);if(typeof value==='string')metadata[key]=value;}
  return {metadata,diagnostics};
}
