# Self-contained registry checks, inspired by ianlewis/repo-template.
.DEFAULT_GOAL := help
.PHONY: help generate test check manifest-check readme-check

help:
	@printf 'Nosey registry template\n\n'
	@printf '  make generate  Regenerate manifest and README catalog\n'
	@printf '  make test      Run generator and setup tests\n'
	@printf '  make check     Check generated files and run tests\n'

generate:
	node scripts/generate-manifest.mjs
	node scripts/generate-readme.mjs

test:
	node --test scripts/*.test.mjs

manifest-check:
	node scripts/generate-manifest.mjs --check

readme-check:
	node scripts/generate-readme.mjs --check

check: manifest-check readme-check test
