FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /recorder .

FROM alpine:3.22
RUN apk add --no-cache ffmpeg ca-certificates \
    && mkdir -p /data/clips /data/buffer && chown -R 1000:1000 /data
COPY --from=build /recorder /usr/local/bin/recorder
# Mesmo UID do app (usuário "node"): os dois mexem nos arquivos de /data/clips
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/recorder"]
