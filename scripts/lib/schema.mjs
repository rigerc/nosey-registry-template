// The canonical public schema URLs. Registries reference these latest `main` URLs
// and never vendor copies, so validation always compares against the current contract.
export const MANIFEST_SCHEMA_URL =
  'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-manifest.schema.json';

export const MAP_SCHEMA_URL =
  'https://raw.githubusercontent.com/rigerc/nosey/main/schemas/registry/skills-map.schema.json';

/**
 * `$schema` is a conventional editor annotation, not contract data. An existing
 * value is preserved verbatim, including a custom URL; the canonical latest URL
 * is written only when the document declares nothing.
 */
export function composeDocument(source, canonical, body) {
  const declared =
    source && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, '$schema')
      ? source['$schema']
      : canonical;

  return {$schema: declared, ...body};
}
