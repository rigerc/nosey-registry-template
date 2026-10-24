// YAML frontmatter extraction. The generators read metadata only: skill content,
// naming, descriptions, links, and instructions belong to agnix, not to this module.
import {parse} from 'yaml';

/**
 * Returns the frontmatter mapping of a SKILL.md document.
 * A parse failure is reported as an input error; a missing mapping is empty.
 */
export function frontmatter(content, filename) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');

  if (lines[0].trimEnd() !== '---')
    throw new Error(filename + ': missing YAML frontmatter');

  let end = -1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') {
      end = i;

      break;
    }
  }

  if (end === -1) throw new Error(filename + ': unterminated YAML frontmatter');

  let data;

  try {
    data = parse(lines.slice(1, end).join('\n'));
  } catch (error) {
    throw new Error(filename + ': invalid YAML frontmatter (' + error.message + ')');
  }

  if (data === null || data === undefined) return {};

  if (typeof data !== 'object' || Array.isArray(data))
    throw new Error(filename + ': frontmatter must be a YAML mapping');

  return data;
}
