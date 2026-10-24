# Registry agent guide

This guide is for agents maintaining this skill registry.

## Skills

Add each skill under `skills/<name>/SKILL.md` with useful frontmatter and instructions. Nested skill directories are supported. Skill IDs use `<registryId>/<relative-directory-under-skills>`.

## Mappings and generation

Edit `skills-map.json` to map local or declared external skills to technologies and combinations. `skills-map.json` is the identity and mapping source; `skills-manifest.json` and the README catalog are generated outputs.

Run `node scripts/generate-manifest.mjs` and `node scripts/generate-readme.mjs` after changing skills or mappings. Review and commit the generated files with the source change.

## Checks

Use Node.js 22 or newer. Run `node --test`, `npm run check`, and `git diff --check`. Run the standalone `agnix` command when changing skill content; it checks skill quality and frontmatter.
