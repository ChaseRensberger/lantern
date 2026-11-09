.PHONY: setup frontend build run check integration browser-check

setup:
	bun install --cwd frontend --frozen-lockfile

frontend:
	bun run --cwd frontend build

build: frontend
	go build -o bin/lantern .

run: build
	./bin/lantern

check: frontend
	test -z "$$(gofmt -l main.go assets.go internal examples)"
	go vet ./...
	go test -race ./...
	bun run --cwd frontend lint
	bun run --cwd frontend format:check
	bun run --cwd frontend test
	frontend/node_modules/.bin/oxlint scripts --deny-warnings
	frontend/node_modules/.bin/oxfmt --check scripts

integration:
	go test -race -tags integration -count=1 ./internal/debugger

browser-check: frontend
	bun scripts/verify-browser.ts
