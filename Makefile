.PHONY: install web test build e2e audit

# Switch to the Node version in .nvmrc (Angular 22 needs 24.15+) when nvm is installed, so
# targets work even in a terminal still holding an older Node on its PATH.
NVM_SH = $${NVM_DIR:-$$HOME/.nvm}/nvm.sh
# CI sets up its own Node, and GitHub's runners have an nvm that doesn't know that version.
NODE = if [ -z "$$CI" ] && [ -s "$(NVM_SH)" ]; then . "$(NVM_SH)" --no-use && nvm use --silent >/dev/null \
	|| { echo "Node $$(cat .nvmrc) isn't installed. Run: nvm install" >&2; exit 1; }; fi;

# The site's path on github.io. It must match the repo's name, or nothing loads. CI works it out
# from the repo itself, so renaming the repo can't leave the live site blank.
BASE ?= /BrewFocus/

install: ## download dependencies
	$(NODE) cd frontend && npm install

web: ## the app on http://localhost:4200
	$(NODE) cd frontend && npx ng serve

test: ## unit tests
	$(NODE) cd frontend && npx ng test --watch=false

build: ## the site GitHub Pages serves, in frontend/dist/brew-focus/browser
	$(NODE) cd frontend && npx ng build --base-href "$(BASE)"
	# 404.html boots the app on deep links like /progress; .nojekyll serves files as they are.
	cd frontend/dist/brew-focus/browser && cp index.html 404.html && touch .nojekyll

e2e: build ## browser tests against that site, served the way Pages serves it
	$(NODE) cd frontend && PAGES_BASE="$(BASE)" npm run e2e

audit: ## the security scans CI runs: vulnerable dependencies and leaked secrets
	$(NODE) cd frontend && npm audit --omit=dev --audit-level=high
	go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --redact --no-banner --config .gitleaks.toml .
