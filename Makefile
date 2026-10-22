# Self-contained registry checks, inspired by ianlewis/repo-template.
.DEFAULT_GOAL := help
.PHONY: help generate test check manifest-check readme-check schema-docs schema-docs-check

help:
	@printf 'Nosey registry template\n\n'
	@printf '  make generate  Regenerate manifest and README catalog\n'
	@printf '  make test      Run generator and setup tests\n'
	@printf '  make check     Check generated files, schema guide and run tests\n'
	@printf '  make schema-docs  Regenerate schema reference tables\n'

generate:
	node scripts/generate-manifest.mjs
	node scripts/generate-readme.mjs
	node scripts/build-schema-docs.mjs

test:
	node --test scripts/*.test.mjs

manifest-check:
	node scripts/generate-manifest.mjs --check

readme-check:
	node scripts/generate-readme.mjs --check

schema-docs:
	node scripts/build-schema-docs.mjs

schema-docs-check:
	node scripts/build-schema-docs.mjs --check

check: manifest-check readme-check schema-docs-check test
