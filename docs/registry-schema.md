# Registry schema reference

A registry document is checked at three independent levels. Passing one does not imply passing
another, and this guide keeps them separate because only the first is described by a JSON Schema.

| Level                | What it checks                                                                                                                                                                      | Where it runs                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Structural schema    | Types, required properties, allowed values, array bounds, version discrimination                                                                                                    | Your editor, `npm run docs:schema:check`, Nosey's CI               |
| Parser               | Everything the schema checks, plus named parser-only rules: uniqueness by property, regular-expression compilation, UTF-16 source limits, path normalization, external source shape | `nosey registry validate`, any Nosey command that loads a registry |
| Registry integration | `registryId` agreement across documents, skill file existence and containment, dangling skill/technology/combination references, external identity conflicts                        | `nosey registry validate`, `mergeRegistries`                       |

## Documents

| Document               | Schema                                                                                     | Instance `schemaVersion` |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| `skills-manifest.json` | [`skills-manifest.schema.json`](../schemas/skills-manifest.schema.json) | `1`                      |
| `skills-map.json`      | [`skills-map.schema.json`](../schemas/skills-map.schema.json)           | `1` or `2`               |
| `registry.json`        | No schema: the initializer validates it with an internal object schema                     | `1`                      |

Both schemas are hand-authored JSON Schema 2020-12 documents. Each declares an absolute `$id` and
references only fragments of its own `$defs`, so validation never fetches anything over the network.

## Editor annotations

The template documents start with a relative annotation, for example
`"$schema": "./schemas/skills-manifest.schema.json"`. It is an editor convention, not contract data:

- Parsers ignore every unknown document-root key, including `$schema`, and do not constrain its value.
  A non-string annotation is accepted.
- Writers preserve an existing annotation verbatim, including a custom URL, and keep its absence for
  legacy templates that ship no `schemas/` directory.
- `nosey registry init` copies `schemas/` into the new registry, so the relative reference resolves
  inside a copied registry and never points back into a Nosey checkout.
- No Nosey command reads, dereferences, or downloads an annotation target.

## Compatibility rules

This pass is annotation-only: parsers keep their current acceptance, normalized return values, error
messages, and CLI output. Two invariants are enforced by the conformance fixtures checked into
`tests/fixtures/registry-schema/`:

1. A document Nosey accepts always validates against its schema.
2. A schema-valid document may still fail a named parser-only rule. Agreement in the other direction —
   schema-invalid but parser-accepted — is a bug in the schema.

Agreement on a finite fixture corpus is a drift check, not a proof for every input, so each fixture
declares its schema verdict and parser verdict independently instead of only comparing them.

## Version applicability

`skills-map.json` version 2 adds `externalSkills`. A version 1 map must not contain the property at all,
not even as `null` or `[]`. Version 1 maps remain valid indefinitely; no migration is required, and
version 2 does not change how local skills are declared.

## Unknown keys

Unknown keys are ignored at the document root and inside skill records, technology and combination
records, association records, regular-expression objects, and content blocks. Two places reject them:
`detect` and external skill records. Unknown keys are never rewritten by Nosey, except that `registry
init` re-serializes documents from its typed model and therefore keeps only known keys plus `$schema`.

## IDs, paths, and sources

Three different ID rules exist and must not be conflated:

- **Local skill IDs** are `<registryId>/<relative-directory-under-skills>`, for example
  `acme/skills/group/example`. Nested folders are supported and no segment count is enforced.
- **Initializer registry IDs** must be `owner/repository` when passed to
  `nosey registry init --registry-id`. That is an authoring rule for the initializer, not a parser rule.
- **External skill IDs** are exactly three segments of `[A-Za-z0-9_.@-]`, and no segment may be a single
  or double dot. The upstream `skill` name is one such segment.

Manifest paths must be repository-relative and end in `/SKILL.md`. Absolute paths, backslashes, NUL,
unnormalized paths (repeated separators, trailing slash), and `.`/`..` segments are rejected by the
parser; the schema encodes only the rules that can never reject a parser-accepted path.

External `source` accepts GitHub `owner/repo`, `https://github.com/owner/repo`, and
`git@github.com:owner/repo`, with optional `.git` and trailing slash. Its shape and case-insensitive
canonical form are parser-only rules, because JSON Schema patterns cannot express case-insensitive
matching or inline flags.

## Regular expressions

Regular expressions are serialized as `{ "source": ..., "flags": ... }`. `source` may be empty and is
bounded at 512 UTF-16 code units by the parser; `maxLength` counts code points, so a pattern made of
supplementary characters can be schema-valid and still fail the parser. Accepted flags are `d`, `i`,
`m`, `s`, `u`, and `v`, with `u` and `v` never combined. `g` and `y` are rejected because detection must
be deterministic, `x` is not a Node flag, and any invalid expression fails at compile time.

## Validation and continuous integration

- `nosey registry validate <dir>` is the full validation entry point for authors who have Nosey. It
  reports `{valid, source, registryId, skills, errors}` as JSON and exits nonzero on failure.
- Nosey's root CI enforces schema/parser conformance, the annotation lifecycle, guide freshness, template
  generator checks, and a validated template registry.
- A generated registry's own CI installs nothing beyond Node: it runs the generator tests and both
  `--check` modes. It does not install Nosey or a schema validator and does not claim schema or full
  registry validation.

## Generated tables

The tables below are generated from the schemas themselves, including their descriptions, constraints,
examples, and `x-parserOnly`/`x-normalization` annotations. The schema tables are generated in Nosey's source repository. After changing a
schema, run `npm run docs:schema` there and synchronize this document.

<!-- BEGIN GENERATED SCHEMA TABLES -->
### `skills-manifest.json` (Nosey skills manifest (schemaVersion 1))

Structural contract for skills-manifest.json. This schema is not a registry validator: parser-only rules (uniqueness by property, path normalization, UTF-16 regex limits, external source shape) and registry-level integration rules (registryId agreement, skill file existence, dangling references, external identity conflicts) are listed instead of encoded.

| Field | Type | Required | Constraints | Version | Description and rules |
| --- | --- | --- | --- | --- | --- |
| `$schema` | any | no | — | 1 | Conventional editor annotation only. Nosey ignores it, registry writers preserve it verbatim, and it is unconstrained here: a non-string value is accepted too. |
| `schemaVersion` | integer | yes | must equal `1` | 1 | Manifest format version. Only 1 is accepted. |
| `registryId` | string | yes | pattern `\S`; minLength 1 | 1 | Identity shared with registry.json and skills-map.json. The owner/repository shape is an initializer authoring rule, not a parser rule. Normalization: Rewritten by registry init, which remaps this prefix in local skill IDs. |
| `skills` | array | yes | maxItems 20000 | 1 | Every locally declared skill. Duplicate ids or paths are rejected by the parser only. |
| `skills[]` | object | — | unknown keys ignored | 1 | One locally declared skill. Unknown keys inside a record are ignored by the parser. |
| `skills[].id` | string | yes | pattern `\S`; minLength 1 | 1 | Unique among manifest skills; duplicates are rejected by the parser only. Normalization: Generated as <registryId>/<relative directory under skills>; init remaps the registryId prefix and leaves external IDs untouched. |
| `skills[].name` | string | yes | pattern `\S`; minLength 1 | 1 | The parser's text() rule: a string containing at least one non-whitespace character. Empty strings, whitespace-only strings, and non-strings are rejected. The pattern matches exactly the characters trim() removes, including U+00A0, U+1680, U+2028, U+202F, and U+FEFF. |
| `skills[].path` | string | yes | pattern `/SKILL\.md$`; must not match `\\`; minLength 1 | 1 | Unique among manifest skills; duplicates are rejected by the parser only. The file must exist and stay inside the registry (integration rule). Parser-only: `parser-only:path-normalization`, `parser-only:path-lexical-edges`. |
| `skills[].description` | string | no | pattern `\S`; minLength 1 | 1 | Optional. When present it must pass text(), so null and whitespace-only values are rejected. |

Example:

```json
{
  "$schema": "./schemas/skills-manifest.schema.json",
  "schemaVersion": 1,
  "registryId": "acme/agent-skills",
  "skills": [
    {
      "id": "acme/agent-skills/testing",
      "name": "Testing conventions",
      "path": "skills/testing/SKILL.md",
      "description": "House rules for unit tests."
    }
  ]
}
```

### `skills-map.json` (Nosey skills map (schemaVersion 1 and 2))

Structural contract for skills-map.json. The instance schemaVersion discriminates versions 1 and 2; this schema document has a single revision. This schema is not a registry validator: parser-only rules (uniqueness by property, regex compilation, UTF-16 source limits, external source shape, path normalization) and registry-level integration rules (registryId agreement, skill file existence, dangling references, external identity conflicts) are listed instead of encoded.

| Field | Type | Required | Constraints | Version | Description and rules |
| --- | --- | --- | --- | --- | --- |
| `$schema` | any | no | — | 1 and 2 | Conventional editor annotation only. Nosey ignores it, registry writers preserve it verbatim, and it is unconstrained here: a non-string value is accepted too. |
| `schemaVersion` | integer | yes | one of `1`, `2` | 1 and 2 | Map format version: 1 for local skills only, 2 when externalSkills may appear. |
| `registryId` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | Identity shared with registry.json and skills-manifest.json. The owner/repository shape is an initializer authoring rule, not a parser rule. Normalization: Rewritten by registry init, which remaps this prefix in local skill references. |
| `alwaysRecommend` | array | no | — | 1 and 2 | Skill IDs recommended in every project. Absent means an empty list; null is rejected. |
| `alwaysRecommend[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `externalSkills` | array \| null | no | maxItems 20000 | 2 | Installable skills hosted outside this registry. schemaVersion 2 only: in version 1 any presence, including null and [], is rejected by the parser. Parser-only: `parser-only:unique-by-property`, `parser-only:external-source-shape`. Normalization: In schemaVersion 2, missing or null normalizes to []; in schemaVersion 1 the property must be absent. |
| `externalSkills[]` | object | — | unknown keys rejected | 2 | A skill hosted outside this registry. Unknown keys are rejected here, unlike other records. |
| `externalSkills[].id` | string | yes | pattern `^(?!\.{1,2}/)(?!.*/\.{1,2}(?:/\|$))[A-Za-z0-9_.@-]+/[A-Za-z0-9_.@-]+/[A-Za-z0-9_.@-]+$` | 2 | Exactly three segments of [A-Za-z0-9_.@-], and no segment may be a single or double dot. Unique among external skills; duplicates are rejected by the parser only. |
| `externalSkills[].name` | string | yes | pattern `\S`; minLength 1 | 2 | The parser's text() rule: a string containing at least one non-whitespace character. Empty strings, whitespace-only strings, and non-strings are rejected. The pattern matches exactly the characters trim() removes, including U+00A0, U+1680, U+2028, U+202F, and U+FEFF. |
| `externalSkills[].source` | string | yes | pattern `\S`; minLength 1 | 2 | GitHub owner/repository, https://github.com/owner/repo, or git@github.com:owner/repo, with optional .git and trailing slash. The shape and its case-insensitive canonical form are parser-only rules. Parser-only: `parser-only:external-source-shape`. Normalization: Compared case-insensitively as owner/repo across registries. |
| `externalSkills[].skill` | string | yes | pattern `^(?!\.{1,2}$)[A-Za-z0-9_.@-]+$` | 2 | A single segment of [A-Za-z0-9_.@-] that is not a single or double dot. |
| `externalSkills[].description` | string | no | pattern `\S`; minLength 1 | 2 | Optional. When present it must pass text(), so null and whitespace-only values are rejected. |
| `technologies` | array \| null | no | — | 1 and 2 | Extra technologies with detection rules. Missing or null normalizes to []; any other non-array value is rejected. Normalization: Missing or null normalizes to []. |
| `technologies[]` | object | — | unknown keys ignored | 1 and 2 | A declared technology. Unknown keys are ignored by the parser. |
| `technologies[].id` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | Unique among declared technologies; duplicates are rejected by the parser only. |
| `technologies[].name` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | The parser's text() rule: a string containing at least one non-whitespace character. Empty strings, whitespace-only strings, and non-strings are rejected. The pattern matches exactly the characters trim() removes, including U+00A0, U+1680, U+2028, U+202F, and U+FEFF. |
| `technologies[].detect` | object | yes | unknown keys rejected | 1 and 2 | Required. |
| `technologies[].detect.packages` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.packages[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.pythonPackages` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.pythonPackages[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.composerPackages` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.composerPackages[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.goModules` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.goModules[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.rustCrates` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.rustCrates[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.elixirPackages` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.elixirPackages[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.configFiles` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.configFiles[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.fileExtensions` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.fileExtensions[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.gems` | array | no | — | 1 and 2 | The parser's strings() rule: an array of strings of at least one character each. Whitespace-only elements pass and duplicates are accepted; no reference array is unique. |
| `technologies[].detect.gems[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.packagePatterns` | array | no | — | 1 and 2 | Regular expressions matched against package names. |
| `technologies[].detect.packagePatterns[]` | object | — | unknown keys ignored | 1 and 2 | A regular expression serialized as {source, flags}. Unknown keys are ignored by the parser. Compilation is a parser-only rule: duplicate flags, u together with v, unsupported flags, and invalid expressions are rejected there. Parser-only: `parser-only:regex-compile`, `parser-only:regex-source-utf16-limit`. |
| `technologies[].detect.packagePatterns[].source` | string | yes | maxLength 512 (code points) | 1 and 2 | The pattern body. An empty string is accepted. The parser bounds this at 512 UTF-16 code units while maxLength counts code points, so a long astral pattern can pass here and fail the parser. |
| `technologies[].detect.packagePatterns[].flags` | string | no | pattern `^[dimsuv]*$` | 1 and 2 | Optional flag string. g and y are rejected because detection must be deterministic; x is not a Node flag. |
| `technologies[].detect.configFileContent` | object \| array | no | — | 1 and 2 | One content block or an array of content blocks, including an empty array. |
| `technologies[].detect.configFileContent.patterns` | array | yes | minItems 1; maxItems 64 | 1 and 2 | Between 1 and 64 entries. A string entry is accepted unconstrained, including the empty string, because strings() is not applied to it. |
| `technologies[].detect.configFileContent.patterns[]` | string \| object | — | — | 1 and 2 | — |
| `technologies[].detect.configFileContent.patterns[].source` | string | yes | maxLength 512 (code points) | 1 and 2 | The pattern body. An empty string is accepted. The parser bounds this at 512 UTF-16 code units while maxLength counts code points, so a long astral pattern can pass here and fail the parser. |
| `technologies[].detect.configFileContent.patterns[].flags` | string | no | pattern `^[dimsuv]*$` | 1 and 2 | Optional flag string. g and y are rejected because detection must be deterministic; x is not a Node flag. |
| `technologies[].detect.configFileContent.files` | array | no | — | 1 and 2 | Optional file names this block applies to. |
| `technologies[].detect.configFileContent.files[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.configFileContent.sourceExtensions` | array | no | — | 1 and 2 | Optional source extensions this block applies to. |
| `technologies[].detect.configFileContent.sourceExtensions[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologies[].detect.configFileContent.scanGradleLayout` | boolean | no | — | 1 and 2 | — |
| `technologies[].detect.configFileContent.scanDotNetLayout` | boolean | no | — | 1 and 2 | — |
| `technologies[].detect.configFileContent.allPatterns` | boolean | no | — | 1 and 2 | — |
| `technologies[].detect.configFileContent.maskStrings` | boolean | no | — | 1 and 2 | — |
| `technologies[].detect.configFileContent.stripComments` | string | no | one of `code`, `hash`, `xml` | 1 and 2 | Optional comment syntax to strip before matching. |
| `technologies[].skills` | array | no | — | 1 and 2 | Optional. Absent means an empty list; null is rejected. |
| `technologies[].skills[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `technologySkills` | array | no | — | 1 and 2 | Skill recommendations per technology ID. Absent means an empty list; null is rejected. |
| `technologySkills[]` | object | — | unknown keys ignored | 1 and 2 | Skills recommended when a technology is detected. Unknown keys are ignored by the parser. |
| `technologySkills[].technologyId` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | Unique among technology recommendations; duplicates are rejected by the parser only. |
| `technologySkills[].skills` | array | yes | — | 1 and 2 | Required. |
| `technologySkills[].skills[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `combinations` | array \| null | no | — | 1 and 2 | Skill combinations that require several technologies. Missing or null normalizes to []; any other non-array value is rejected. Normalization: Missing or null normalizes to []. |
| `combinations[]` | object | — | unknown keys ignored | 1 and 2 | A declared skill combination. Unknown keys are ignored by the parser. |
| `combinations[].id` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | Unique among declared combinations; duplicates are rejected by the parser only. |
| `combinations[].name` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | The parser's text() rule: a string containing at least one non-whitespace character. Empty strings, whitespace-only strings, and non-strings are rejected. The pattern matches exactly the characters trim() removes, including U+00A0, U+1680, U+2028, U+202F, and U+FEFF. |
| `combinations[].requires` | array | yes | — | 1 and 2 | Required. An empty array is accepted. |
| `combinations[].requires[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `combinations[].skills` | array | no | — | 1 and 2 | Optional. Absent means an empty list; null is rejected. |
| `combinations[].skills[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `combinationSkills` | array | no | — | 1 and 2 | Skill recommendations per combination ID. Absent means an empty list; null is rejected. |
| `combinationSkills[]` | object | — | unknown keys ignored | 1 and 2 | Skills recommended when a combination matches. Unknown keys are ignored by the parser. |
| `combinationSkills[].combinationId` | string | yes | pattern `\S`; minLength 1 | 1 and 2 | Unique among combination recommendations; duplicates are rejected by the parser only. |
| `combinationSkills[].skills` | array | yes | — | 1 and 2 | Required. |
| `combinationSkills[].skills[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `frontendBonusSkills` | array | no | — | 1 and 2 | Skills recommended for detected web frontends. Absent means an empty list; null is rejected. |
| `frontendBonusSkills[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `frontendPackages` | array | no | — | 1 and 2 | Packages that mark a project as a web frontend. Absent means an empty list; null is rejected. |
| `frontendPackages[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |
| `webFrontendExtensions` | array | no | — | 1 and 2 | File extensions that mark a project as a web frontend. Absent means an empty list; null is rejected. |
| `webFrontendExtensions[]` | string | — | minLength 1 | 1 and 2 | The parser's strings() rule for reference arrays: every element is a string of at least one character. Unlike text(), whitespace-only elements pass. Duplicates are accepted here. |

Example:

```json
{
  "$schema": "./schemas/skills-map.schema.json",
  "schemaVersion": 2,
  "registryId": "acme/agent-skills",
  "alwaysRecommend": [],
  "externalSkills": [
    {
      "id": "acme/upstream-skills/example-testing",
      "name": "External testing guidance",
      "source": "acme/upstream-skills",
      "skill": "example-testing"
    }
  ],
  "technologies": [],
  "technologySkills": [
    {
      "technologyId": "react",
      "skills": [
        "acme/upstream-skills/example-testing"
      ]
    }
  ],
  "combinations": [],
  "combinationSkills": [],
  "frontendBonusSkills": [],
  "frontendPackages": [],
  "webFrontendExtensions": []
}
```

### Parser-only rules referenced by these schemas

Annotation text never enforces these rules. `nosey registry validate` does, and each name below appears next to the fields it governs.

- `parser-only:content-pattern-empty-string`
- `parser-only:external-source-shape`
- `parser-only:path-lexical-edges`
- `parser-only:path-normalization`
- `parser-only:regex-compile`
- `parser-only:regex-source-utf16-limit`
- `parser-only:unique-by-property`
<!-- END GENERATED SCHEMA TABLES -->

## Deferred: CLI diagnostics

No `--schema` flag and no change to the `registry validate --json` error shape ships with these schemas.
A later proposal must keep `errors: string[]`, define document identity and JSON pointers where each
error originates, retain array indices, and specify how a diagnostics channel represents filesystem and
cross-document failures before any of that is implemented.
