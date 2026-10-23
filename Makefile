# Registry operations; npm ci installs the validator. No Nosey installation required.
.DEFAULT_GOAL := help
.PHONY: help generate test check manifest-check readme-check validate audit

help:
	@printf 'Registry commands\n'
	@printf '  make generate  Generate manifest and README catalog\n'
	@printf '  make check     Check generated output, latest schemas and tests (read-only)\n'
	@printf '  make validate  Validate JSON using latest Nosey schemas (requires network)\n'
	@printf '  make audit     Audit skills using agnix (installed separately)\n'

generate:
	node scripts/generate-manifest.mjs
	node scripts/generate-readme.mjs

manifest-check:
	node scripts/generate-manifest.mjs --check

readme-check:
	node scripts/generate-readme.mjs --check

validate:
	node scripts/validate-registry.mjs

test:
	node --test scripts/*.test.mjs

check: manifest-check readme-check validate test

audit:
	agnix .
