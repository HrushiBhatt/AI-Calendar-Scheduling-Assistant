.PHONY: install api web build serve test e2e audit docker pages pages-build

# Secrets and local config (JWT_SECRET, ...) come from an untracked .env; see .env.example.
-include .env
export JWT_SECRET SECURE_COOKIES TRUSTED_PROXIES ADDR DB_PATH

# Switch to the Node version in .nvmrc (Angular 22 needs 24.15+) when nvm is installed, so
# frontend targets work even in a terminal still holding an older Node on its PATH.
NVM_SH = $${NVM_DIR:-$$HOME/.nvm}/nvm.sh
# CI sets up its own Node, and GitHub's runners have an nvm that doesn't know that version.
NODE = if [ -z "$$CI" ] && [ -s "$(NVM_SH)" ]; then . "$(NVM_SH)" --no-use && nvm use --silent >/dev/null \
	|| { echo "Node $$(cat .nvmrc) isn't installed. Run: nvm install" >&2; exit 1; }; fi;

install: ## fetch Go modules and npm packages
	cd backend && go mod download
	$(NODE) cd frontend && npm install

api: ## Go API on :5001 (Ctrl+C shuts down gracefully; running timers resume on restart)
	cd backend && go run ./cmd/server

web: ## Angular dev server on :4200, proxying /api to :5001
	$(NODE) cd frontend && npx ng serve

build: ## production frontend bundle + static Go binary
	$(NODE) cd frontend && npx ng build
	cd backend && CGO_ENABLED=0 go build -o bin/brewfocus ./cmd/server

serve: build ## one process: Go serves the API and the built app on :5001
	cd backend && GIN_MODE=release ./bin/brewfocus -static ../frontend/dist/brew-focus/browser

test: ## Go tests under the race detector, then Angular unit tests
	cd backend && go vet ./... && go test -race ./...
	$(NODE) cd frontend && npx ng test --watch=false

e2e: ## browser tests against the real Go server
	$(NODE) cd frontend && npm run e2e

audit: ## the security scans CI runs: vulnerable dependencies, risky code, leaked secrets
	cd backend && go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
	cd backend && go run github.com/securego/gosec/v2/cmd/gosec@v2.29.0 -quiet ./...
	cd backend && go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --redact --no-banner --config ../.gitleaks.toml ..
	$(NODE) cd frontend && npm audit --omit=dev --audit-level=high

docker: ## build and run the production image with docker compose, on :5001
	docker compose up --build

pages: ## the browser-only GitHub Pages build on :4200, with no Go server
	$(NODE) cd frontend && npx ng serve --configuration pages

# The site CI publishes. BASE must be the repo's path on github.io, or nothing loads. CI works it
# out from the repo's name, so renaming the repo can't leave the live site blank.
BASE ?= /BrewFocus/
pages-build: ## the GitHub Pages site, in frontend/dist/brew-focus/browser; test it with `cd frontend && npm run e2e:pages`
	$(NODE) cd frontend && npx ng build --configuration pages --base-href "$(BASE)"
	# 404.html boots the app on deep links like /progress; .nojekyll serves files as they are.
	cd frontend/dist/brew-focus/browser && cp index.html 404.html && touch .nojekyll
