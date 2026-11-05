# syntax=docker/dockerfile:1
# One image for the whole app: the Go server serves the API and the built Angular app.
# It's a multi-stage build, so Node and the Go compiler are used to build but never shipped.
# Base images are pinned by digest, so a build can't silently pick up a replaced image.
# Dependabot proposes new digests weekly (.github/dependabot.yml).

# 1. Build the Angular frontend.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build

# 2. Build the Go server. The SQLite driver is pure Go, so CGO can stay off and this makes one
# static binary with nothing else to install. -trimpath and -s -w drop build paths and debug data.
FROM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS api
WORKDIR /api
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /brewfocus ./cmd/server && mkdir /data

# 3. The runtime: only the binary and the built app, running as a non-root user. There's no shell
# or package manager for an attacker to use. This works because the Go build above is fully static.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=api /brewfocus /brewfocus
COPY --from=api --chown=nonroot:nonroot /data /data
COPY --from=web /web/dist/brew-focus/browser /app
# Release mode refuses to start without a strong JWT_SECRET. Set SECURE_COOKIES=false only
# to try the image over plain HTTP in a browser that won't send Secure cookies to localhost.
ENV STATIC_DIR=/app DB_PATH=/data/brewfocus.db GIN_MODE=release SECURE_COOKIES=true
VOLUME /data
EXPOSE 5001
ENTRYPOINT ["/brewfocus"]
