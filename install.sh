#!/usr/bin/env bash
# Faz o L — instalador para VPS Linux (Ubuntu/Debian recomendados)
# Uso:  ./install.sh            -> instala/reconfigura e sobe tudo
#       ./install.sh update     -> atualiza o código (git pull) e reinicia
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo" || fail "Rode como root ou instale o sudo."
fi

rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "$1" || true; }

ask() { # ask VAR "Pergunta" "padrão"
  local var="$1" prompt="$2" default="${3:-}" value
  if [ -n "$default" ]; then
    read -rp "$prompt [$default]: " value </dev/tty || true
    value="${value:-$default}"
  else
    read -rp "$prompt: " value </dev/tty || true
  fi
  printf -v "$var" '%s' "$value"
}

compose() { $SUDO docker compose "$@"; }

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker não encontrado. Instalando pelo script oficial (get.docker.com)…"
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  $SUDO docker compose version >/dev/null 2>&1 || fail "O plugin 'docker compose' não está disponível."
}

if [ "${1:-}" = "update" ]; then
  ensure_docker
  info "Atualizando código…"
  git pull --ff-only
  compose pull caddy livekit
  compose up -d --build
  bold "Atualizado! ✅"
  exit 0
fi

bold "
  ███████  █████  ███████      ██████      ██
  ██      ██   ██    ███      ██    ██     ██
  █████   ███████   ███       ██    ██     ██
  ██      ██   ██  ███        ██    ██     ██
  ██      ██   ██ ███████      ██████      ███████
"
echo "  Transmissão de tela com quase zero de delay para o seu Discord."
echo

ensure_docker

if [ -f .env ]; then
  ask RECONF ".env já existe. Reconfigurar do zero? (s/N)" "N"
  if [[ ! "$RECONF" =~ ^[sSyY] ]]; then
    info "Mantendo .env atual. Subindo os containers…"
    compose up -d --build
    bold "Pronto! Acesse: https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
    exit 0
  fi
fi

PUBLIC_IP="$(curl -4fsS --max-time 5 https://api.ipify.org || true)"

echo
bold "1) Domínio"
echo "   Crie um registro DNS do tipo A apontando para ${PUBLIC_IP:-o IP desta VPS}."
echo "   Ex.: live.seudominio.com  (dica grátis: duckdns.org)"
ask DOMAIN "   Domínio"
[ -n "$DOMAIN" ] || fail "Domínio é obrigatório (navegadores só liberam captura de tela em HTTPS)."

echo
bold "2) Discord (Enter para pular qualquer item)"
echo "   Crie uma aplicação em https://discord.com/developers/applications"
ask DISCORD_CLIENT_ID "   Application ID (Client ID)"
ask DISCORD_CLIENT_SECRET "   Client Secret (OAuth2) — habilita login com Discord"
ask DISCORD_GUILD_ID "   ID do servidor (restringe o acesso aos membros)"
ask DISCORD_BOT_TOKEN "   Token do bot — habilita /live e avisos"
DISCORD_NOTIFY_CHANNEL_ID=""
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  ask DISCORD_NOTIFY_CHANNEL_ID "   ID do canal para avisos de 'ao vivo'"
fi

echo
bold "3) Limites"
ask MAX_STREAMERS "   Máximo de pessoas transmitindo ao mesmo tempo" "2"
ask MAX_VIEWERS "   Máximo de espectadores" "15"

info "Gerando segredos e .env…"
umask 077
cat > .env <<EOF
DOMAIN=${DOMAIN}

LIVEKIT_API_KEY=API$(rand 12)
LIVEKIT_API_SECRET=$(rand 48)
LIVEKIT_NODE_IP=${PUBLIC_IP}
LIVEKIT_VERSION=v1.13.11

SESSION_SECRET=$(rand 48)

MAX_STREAMERS=${MAX_STREAMERS}
MAX_VIEWERS=${MAX_VIEWERS}
ROOM_NAME=faz-o-l

DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET}
DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
DISCORD_NOTIFY_CHANNEL_ID=${DISCORD_NOTIFY_CHANNEL_ID}
EOF

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  info "Liberando portas no firewall (ufw)…"
  for rule in 80/tcp 443/tcp 443/udp 7881/tcp 7882/udp; do $SUDO ufw allow "$rule" >/dev/null; done
fi

info "Construindo e subindo os containers (pode levar alguns minutos)…"
compose up -d --build

echo
bold "✅ Faz o L está no ar: https://${DOMAIN}"
echo
echo "Portas que precisam estar abertas no painel da VPS: 80/tcp, 443/tcp, 7881/tcp, 7882/udp"
if [ -n "$DISCORD_CLIENT_SECRET" ]; then
  echo
  echo "No Discord Developer Portal > OAuth2 > Redirects, adicione:"
  echo "   https://${DOMAIN}/auth/callback"
fi
if [ -n "$DISCORD_BOT_TOKEN" ] && [ -n "$DISCORD_CLIENT_ID" ]; then
  echo
  echo "Convide o bot para o seu servidor:"
  echo "   https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&scope=bot+applications.commands&permissions=19456"
fi
echo
echo "Logs:        docker compose logs -f"
echo "Atualizar:   ./install.sh update"
