#!/usr/bin/env bash
# Faz o L — instalador para VPS Linux (Ubuntu/Debian recomendados)
# Uso:  ./install.sh            -> instala/reconfigura e sobe tudo
#       ./install.sh update     -> atualiza o código (git pull) e reinicia
#       ./install.sh discord    -> configura (ou altera) bot e login do Discord
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

ask_secret() { # ask_secret VAR "Pergunta" -> não mostra o que é digitado
  local var="$1" prompt="$2" value
  read -rsp "$prompt: " value </dev/tty || true
  echo
  printf -v "$var" '%s' "$value"
}

env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

env_set() { # env_set CHAVE valor  (substitui ou acrescenta no .env)
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

compose() { $SUDO docker compose "$@"; }

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker não encontrado. Instalando pelo script oficial (get.docker.com)…"
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  $SUDO docker compose version >/dev/null 2>&1 || fail "O plugin 'docker compose' não está disponível."
}

# Decide quem cuida do HTTPS: o Caddy do projeto ou um Traefik já existente (Coolify)
detect_proxy() {
  if $SUDO docker network inspect "${TRAEFIK_NETWORK:-coolify}" >/dev/null 2>&1; then
    echo traefik
  elif $SUDO ss -ltnH 'sport = :80' 2>/dev/null | grep -q . \
    && ! $SUDO docker ps --format '{{.Names}}' | grep -q 'caddy'; then
    echo busy
  else
    echo caddy
  fi
}

compose_file_for() {
  case "$1" in
    traefik) echo "docker-compose.yml:docker-compose.traefik.yml" ;;
    *) echo "docker-compose.yml:docker-compose.caddy.yml" ;;
  esac
}

# Instalações antigas não têm COMPOSE_FILE no .env
ensure_compose_file() {
  grep -q '^COMPOSE_FILE=' .env && return 0
  local mode; mode="$(detect_proxy)"
  [ "$mode" = busy ] && mode=caddy
  info "Configurando modo de HTTPS: $mode"
  printf '\n# Quem cuida do HTTPS (gerado pelo install.sh)\nCOMPOSE_FILE=%s\n' "$(compose_file_for "$mode")" >> .env
}

if [ "${1:-}" = "discord" ]; then
  [ -f .env ] || fail "Nada instalado ainda. Rode ./install.sh primeiro."
  DOMAIN="$(env_get DOMAIN)"
  bold "Configurar Discord para https://${DOMAIN}"
  echo "Enter mantém o valor atual. Digite - para apagar um valor."
  echo "Os segredos (Client Secret e token) não aparecem na tela enquanto você digita."
  echo

  for item in \
    "DISCORD_CLIENT_ID|Application ID (Client ID)|plain" \
    "DISCORD_CLIENT_SECRET|Client Secret (OAuth2)|secret" \
    "DISCORD_BOT_TOKEN|Token do bot|secret" \
    "CREATOR_DISCORD_IDS|IDs de usuário do Discord que podem criar canais (vírgula entre eles)|plain"; do
    IFS='|' read -r key label kind <<<"$item"
    current="$(env_get "$key")"
    if [ "$kind" = secret ]; then
      state="vazio"; [ -n "$current" ] && state="já definido"
      ask_secret value "  $label [$state]"
    else
      ask value "  $label" "${current:-}"
    fi
    if [ "$value" = "-" ]; then env_set "$key" ""; elif [ -n "$value" ]; then env_set "$key" "$value"; fi
  done

  info "Reiniciando o app…"
  compose up -d app
  sleep 5
  compose logs --tail 5 app

  CLIENT_ID="$(env_get DISCORD_CLIENT_ID)"
  echo
  if [ -n "$(env_get DISCORD_CLIENT_SECRET)" ]; then
    echo "No Developer Portal > OAuth2 > Redirects, confira se existe:"
    echo "   https://${DOMAIN}/auth/callback"
  fi
  if [ -n "$(env_get DISCORD_BOT_TOKEN)" ] && [ -n "$CLIENT_ID" ]; then
    echo
    echo "Convide o bot para o seu servidor:"
    echo "   https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=19456"
  fi
  exit 0
fi

if [ "${1:-}" = "update" ]; then
  ensure_docker
  [ -f .env ] || fail "Nada instalado ainda. Rode ./install.sh primeiro."
  info "Atualizando código…"
  git pull --ff-only
  ensure_compose_file
  compose pull --ignore-buildable || true
  compose up -d --build --remove-orphans
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
    ensure_compose_file
    compose up -d --build --remove-orphans
    bold "Pronto! Acesse: https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
    exit 0
  fi
fi

PROXY_MODE="$(detect_proxy)"
case "$PROXY_MODE" in
  traefik) info "Coolify/Traefik detectado: o Faz o L vai usar o proxy dele para o HTTPS (sem conflito nas portas 80/443)." ;;
  busy) fail "A porta 80 já está em uso por outro serviço. Libere a porta ou, se for um Traefik, defina TRAEFIK_NETWORK e veja o README." ;;
  caddy) info "Nenhum proxy encontrado: o Faz o L vai usar o Caddy próprio nas portas 80/443." ;;
esac

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
ask CREATOR_DISCORD_IDS "   Seu ID de usuário do Discord (quem pode criar canais; vários separados por vírgula)"
ask DISCORD_BOT_TOKEN "   Token do bot — habilita /live e avisos"

echo
bold "3) Limites"
ask MAX_STREAMERS "   Máximo de pessoas transmitindo ao mesmo tempo" "2"
ask MAX_VIEWERS "   Máximo de espectadores" "15"

info "Gerando segredos e .env…"
umask 077
cat > .env <<EOF
DOMAIN=${DOMAIN}

# Quem cuida do HTTPS (gerado pelo install.sh)
COMPOSE_FILE=$(compose_file_for "$PROXY_MODE")

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
CREATOR_DISCORD_IDS=${CREATOR_DISCORD_IDS}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
EOF

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  info "Liberando portas no firewall (ufw)…"
  for rule in 80/tcp 443/tcp 443/udp 7881/tcp 7882/udp; do $SUDO ufw allow "$rule" >/dev/null; done
fi

info "Construindo e subindo os containers (pode levar alguns minutos)…"
compose up -d --build --remove-orphans

echo
bold "✅ Faz o L está no ar: https://${DOMAIN}"
echo
echo "Portas que precisam estar abertas no firewall do painel da VPS:"
echo "   80/tcp, 443/tcp, 7881/tcp e 7882/udp  (sem 7882/udp e 7881/tcp o vídeo não conecta)"
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
