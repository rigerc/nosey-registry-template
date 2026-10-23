# Self-contained registry operations; no Nosey installation required.
.DEFAULT_GOAL := help
.PHONY: help generate test check manifest-check readme-check validate audit template-state

help:
	@printf 'Registry commands\n'
	@printf '  make generate  Generate manifest and README catalog\n'
	@printf '  make check     Verify generated output, integrity and tests (read-only)\n'
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

# Upstream maintainers only; downstream registries must retain their merge bases.
template-state:
	node scripts/template-state.mjs
