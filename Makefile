.PHONY: install api web build serve test docker eval e2e demo

# Secrets and local config (JWT_SECRET, ...) come from an untracked .env; see .env.example.
-include .env
export JWT_SECRET SECURE_COOKIES ADDR DB_PATH GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URL \
	CALENDAR_ENC_KEY PUBLIC_URL ANTHROPIC_API_KEY ASSISTANT_MODEL ASSISTANT_DAILY_TOKENS ASSISTANT_EFFORT DEMO \
	CALENDAR_PROVIDER ASSISTANT_PROVIDER

# Switch to the Node version in .nvmrc (Angular 22 needs 24.15+) when nvm is installed, so
# frontend targets work even in a terminal still holding an older Node on its PATH.
NVM_SH = $${NVM_DIR:-$$HOME/.nvm}/nvm.sh
NODE = if [ -s "$(NVM_SH)" ]; then . "$(NVM_SH)" --no-use && nvm use --silent >/dev/null \
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

eval: ## run the assistant's eval set against the real model (costs a few cents; needs ANTHROPIC_API_KEY)
	cd backend && go test -tags evals -run TestEvals -count=1 -v ./internal/assistant

demo: ## the app with a seeded demo account (demo@brewfocus.dev / brewfocus) and no keys needed
	cd backend && DEMO=true go run ./cmd/server

docker: ## build and run the production image (data persists in the brewfocus-data volume)
	docker build -t brew-focus .
	docker run --rm -p 5001:5001 -v brewfocus-data:/data -e JWT_SECRET -e SECURE_COOKIES brew-focus
