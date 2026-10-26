# syntax=docker/dockerfile:1
# One image for the whole app: the Go server serves the API and the built Angular app.

# 1. Build the Angular frontend.
FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build

# 2. Build the Go server. The SQLite driver is pure Go, so this is a static binary.
FROM golang:1.27-alpine AS api
WORKDIR /api
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /brewfocus ./cmd/server && mkdir /data

# 3. A minimal, non-root runtime. The server makes outbound TLS calls to Google and
# Anthropic, so the base must carry CA certificates: distroless "static" does (it is
# "static" plus ca-certificates, tzdata and a nonroot user). The binary also embeds Go's
# zone database (time/tzdata), so each user's IANA zone resolves on any base.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /brewfocus /brewfocus
COPY --from=api --chown=nonroot:nonroot /data /data
COPY --from=web /web/dist/brew-focus/browser /app
ENV STATIC_DIR=/app DB_PATH=/data/brewfocus.db GIN_MODE=release
VOLUME /data
EXPOSE 5001
ENTRYPOINT ["/brewfocus"]
