#!/usr/bin/env bash
set -Eeuo pipefail

REPO_USER="${REPO_USER:-mudziboy}"
REPO_NAME="${REPO_NAME:-tunnel-enterprise}"
BRANCH="${BRANCH:-main}"
INSTALL_PROFILE="${1:-standard}"

# Untuk private repo, default lebih aman pakai GitHub API tarball.
ARCHIVE_URL="${ARCHIVE_URL:-https://api.github.com/repos/${REPO_USER}/${REPO_NAME}/tarball/${BRANCH}}"

# Bisa diisi raw URL biasa, atau GitHub Contents API URL.
# Private repo disarankan pakai GitHub Contents API:
# https://api.github.com/repos/mudziboy/daftar/contents/allow.txt?ref=main
WHITELIST_RAW_URL="${WHITELIST_RAW_URL:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

red='\033[0;31m'; green='\033[0;32m'; yellow='\033[1;33m'; cyan='\033[0;36m'; nc='\033[0m'
ok(){ printf "%b\n" "${green}[OK]${nc} $*"; }
info(){ printf "%b\n" "${cyan}[INFO]${nc} $*"; }
warn(){ printf "%b\n" "${yellow}[WARN]${nc} $*"; }
err(){ printf "%b\n" "${red}[ERR]${nc} $*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Jalankan sebagai root"; exit 1; }
case "$INSTALL_PROFILE" in base|minimal|standard|full) ;; *) err "Profile tidak valid. Gunakan: base, minimal, standard, full"; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive

install_bootstrap_deps(){
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y curl wget tar gzip ca-certificates bash coreutils findutils sed grep gawk jq sqlite3
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl wget tar gzip ca-certificates bash coreutils findutils sed grep gawk jq sqlite
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl wget tar gzip ca-certificates bash coreutils findutils sed grep gawk jq sqlite
  else
    err "Package manager tidak didukung"
    exit 1
  fi
}

public_ip(){
  curl -4fsS --max-time 8 https://ipv4.icanhazip.com 2>/dev/null | tr -d ' \t\r\n' || true
}

github_headers(){
  if [ -n "$GITHUB_TOKEN" ]; then
    printf '%s\n' \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: tunnel-go-installer"
  else
    printf '%s\n' -H "User-Agent: tunnel-go-installer"
  fi
}

# Download biasa. Cocok untuk API tarball dan public URL.
download_with_token(){
  local url="$1" output="$2"
  if [ -n "$GITHUB_TOKEN" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: tunnel-go-installer" \
      "$url" -o "$output"
  else
    curl -fsSL -H "User-Agent: tunnel-go-installer" "$url" -o "$output"
  fi
}

raw_to_contents_api(){
  local url="$1"
  # https://raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH
  if [[ "$url" =~ ^https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.*)$ ]]; then
    local owner="${BASH_REMATCH[1]}"
    local repo="${BASH_REMATCH[2]}"
    local ref="${BASH_REMATCH[3]}"
    local path="${BASH_REMATCH[4]}"
    printf 'https://api.github.com/repos/%s/%s/contents/%s?ref=%s\n' "$owner" "$repo" "$path" "$ref"
    return 0
  fi
  printf '%s\n' "$url"
}

# Download whitelist. Untuk private repo, pakai Contents API + Accept raw.
download_whitelist(){
  local url="$1" output="$2" api_url
  api_url="$(raw_to_contents_api "$url")"

  if [[ "$api_url" == https://api.github.com/repos/*/contents/* ]]; then
    if [ -z "$GITHUB_TOKEN" ]; then
      err "GITHUB_TOKEN wajib untuk mengambil allow.txt dari private repo via GitHub API"
      return 1
    fi
    curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: tunnel-go-installer" \
      "$api_url" -o "$output"
    return $?
  fi

  download_with_token "$url" "$output"
}

profile_allowed(){
  local requested="$1" allowed="$2" r a
  requested="$(echo "$requested" | tr '[:upper:]' '[:lower:]' | xargs)"
  allowed="$(echo "$allowed" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$requested" in base) r=1 ;; minimal) r=2 ;; standard) r=3 ;; full|menu) r=4 ;; *) r=0 ;; esac
  case "$allowed" in base) a=1 ;; minimal) a=2 ;; standard) a=3 ;; full|menu) a=4 ;; *) a=0 ;; esac
  [ "$r" -le "$a" ]
}

expiry_valid(){
  local expiry="$1" today
  expiry="$(echo "$expiry" | tr '[:upper:]' '[:lower:]' | xargs)"
  today="$(date -u '+%Y-%m-%d')"
  if [[ "$expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    [[ "$expiry" > "$today" || "$expiry" == "$today" ]]
    return
  fi
  if [[ "$expiry" =~ ^[0-9]+$ ]]; then
    [ "$expiry" -gt 0 ]
    return
  fi
  [ "$expiry" = "lifetime" ] || [ "$expiry" = "permanent" ]
}

verify_whitelist_bootstrap(){
  if [ -z "$WHITELIST_RAW_URL" ]; then
    echo
    echo "Masukkan URL RAW/API file whitelist GitHub."
    echo "Private repo disarankan: https://api.github.com/repos/mudziboy/daftar/contents/allow.txt?ref=main"
    echo "RAW juga boleh, installer akan dikonversi otomatis ke GitHub Contents API."
    read -rp "WHITELIST_RAW_URL: " WHITELIST_RAW_URL
  fi

  [ -n "$WHITELIST_RAW_URL" ] || { err "WHITELIST_RAW_URL wajib diisi"; exit 1; }

  local ip tmp match ip_col status allowed expiry owner note extra
  ip="$(public_ip)"
  [ -n "$ip" ] || { err "Gagal mendeteksi IP VPS"; exit 90; }

  tmp="$(mktemp)"
  if ! download_whitelist "$WHITELIST_RAW_URL" "$tmp"; then
    err "Gagal mengambil file whitelist"
    echo "Pastikan:"
    echo "1. Repo mudziboy/daftar benar-benar private/public sesuai token."
    echo "2. File allow.txt sudah berada di branch main."
    echo "3. GITHUB_TOKEN punya permission Contents: Read untuk repo mudziboy/daftar."
    echo "4. Untuk fine-grained PAT, repo mudziboy/daftar harus dipilih dalam Repository access."
    exit 90
  fi

  match="$(awk -F'|' -v ip="$ip" '
    /^[[:space:]]*#/ { next }
    NF < 1 { next }
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
      if ($1 == ip) print $0
    }
  ' "$tmp" | tail -n1 || true)"
  rm -f "$tmp"

  [ -n "$match" ] || { err "IP VPS belum terdaftar: $ip"; exit 90; }

  IFS='|' read -r ip_col status allowed expiry owner note extra <<< "$match"
  status="$(echo "${status:-active}" | tr '[:upper:]' '[:lower:]' | xargs)"
  allowed="$(echo "${allowed:-standard}" | tr '[:upper:]' '[:lower:]' | xargs)"
  expiry="$(echo "${expiry:-lifetime}" | tr '[:upper:]' '[:lower:]' | xargs)"

  [ "$status" = "active" ] || { err "IP tidak aktif: $status"; exit 90; }
  profile_allowed "$INSTALL_PROFILE" "$allowed" || { err "Profile tidak diizinkan. Request=$INSTALL_PROFILE Allowed=$allowed"; exit 90; }
  expiry_valid "$expiry" || { err "Whitelist expired: $expiry"; exit 90; }

  ok "IP VPS valid di whitelist: $ip"
}

download_repo(){
  info "Mengunduh repo ${REPO_USER}/${REPO_NAME}:${BRANCH}"
  download_with_token "$ARCHIVE_URL" "$TMP_DIR/repo.tar.gz"
  tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"
  SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ] || { err "Source repo tidak ditemukan setelah extract"; exit 1; }
}

install_structure(){
  install -d /usr/local/tunnel /etc/tunnel /etc/tunnel/runtime/locks /etc/tunnel/backups /etc/tunnel/users
  rm -f /usr/local/tunnel/lib/license /usr/local/tunnel/tools/license-check /usr/local/tunnel/tools/license-info /usr/bin/tunnel-license-check 2>/dev/null || true

  cp -a "$SRC_DIR/usr/local/tunnel/." /usr/local/tunnel/
  cp -a "$SRC_DIR/etc/tunnel/." /etc/tunnel/ 2>/dev/null || true

  rm -f /usr/local/tunnel/lib/license /usr/local/tunnel/tools/license-check /usr/local/tunnel/tools/license-info /usr/bin/tunnel-license-check 2>/dev/null || true

  find /usr/local/tunnel -type f -exec sed -i 's/\r$//' {} \;
  find /usr/local/tunnel -type f -exec chmod 755 {} \;
  find /usr/local/tunnel -type f \( -name "*.json" -o -name "*.js" -o -name "*.service" -o -name "*.yaml" -o -name "*.txt" -o -name "*.md" \) -exec chmod 644 {} \;
  find /etc/tunnel -type f -exec chmod 600 {} \; 2>/dev/null || true
  chmod 644 /etc/tunnel/config.env /etc/tunnel/ports.env /etc/tunnel/domain 2>/dev/null || true

  cat > /etc/tunnel/whitelist.env <<EOF
WHITELIST_RAW_URL="$WHITELIST_RAW_URL"
WHITELIST_CACHE_TTL=21600
WHITELIST_FAIL_OPEN=0
EOF
  chmod 600 /etc/tunnel/whitelist.env

  ln -sf /usr/local/tunnel/bin/menu /usr/bin/menu
  ln -sf /usr/local/tunnel/bin/install-profile /usr/local/tunnel/install-profile
  ln -sf /usr/local/tunnel/tools/diagnostic /usr/bin/tunnel-diagnostic
  ln -sf /usr/local/tunnel/tools/ssh-vpn-diagnose /usr/bin/tunnel-ssh-vpn-diagnose
  ln -sf /usr/local/tunnel/tools/repair-ssh-login /usr/bin/tunnel-repair-ssh-login
  ln -sf /usr/local/tunnel/tools/health-check /usr/bin/tunnel-health
  ln -sf /usr/local/tunnel/guard/tunnel-guard /usr/bin/tunnel-guard
  ln -sf /usr/local/tunnel/tools/connection-optimizer /usr/bin/tunnel-connection-optimizer
  ln -sf /usr/local/tunnel/tools/connection-doctor /usr/bin/tunnel-connection-doctor
  ln -sf /usr/local/tunnel/tools/check-dependencies /usr/bin/tunnel-check-deps
  ln -sf /usr/local/tunnel/tools/db-status /usr/bin/tunnel-db-status
  ln -sf /usr/local/tunnel/tools/whitelist-check /usr/bin/tunnel-whitelist-check
  ln -sf /usr/local/tunnel/tools/network-optimizer /usr/bin/tunnel-network-optimizer
  ln -sf /usr/local/tunnel/tools/bbr.sh /usr/bin/bbr.sh
  ln -sf /usr/local/tunnel/tools/service-doctor /usr/bin/tunnel-service-doctor
  ln -sf /usr/local/tunnel/tools/config-validator /usr/bin/tunnel-config-validator
  ln -sf /usr/local/tunnel/tools/safe-reload /usr/bin/tunnel-safe-reload
  ln -sf /usr/local/tunnel/tools/vps-info /usr/bin/tunnel-vps-info
  ln -sf /usr/local/tunnel/node/node-status /usr/bin/tunnel-node-status
  ln -sf /usr/local/tunnel/node/node-capacity /usr/bin/tunnel-node-capacity
  ln -sf /usr/local/tunnel/node/node-register /usr/bin/tunnel-node-register
  ln -sf /usr/local/tunnel/core/job-runner /usr/bin/tunnel-job-runner
  ln -sf /usr/local/tunnel/core/session-monitor /usr/bin/tunnel-session-monitor
  ln -sf /usr/local/tunnel/core/traffic-accounting /usr/bin/tunnel-traffic-accounting
}

optional_run(){
  local label="$1"
  shift
  if [ ! -x "$1" ] && ! command -v "$1" >/dev/null 2>&1; then
    warn "$label dilewati: command tidak ditemukan: $1"
    return 0
  fi
  if "$@"; then
    ok "$label selesai"
  else
    warn "$label gagal atau dilewati. Bisa diulang dari menu."
  fi
}

run_profile(){
  info "Menjalankan profile: $INSTALL_PROFILE"

  /usr/local/tunnel/tools/install-dependencies
  /usr/local/tunnel/tools/setup-domain
  /usr/local/tunnel/tools/db-init
  /usr/local/tunnel/node/node-register >/dev/null 2>&1 || true
  /usr/local/tunnel/node/install-node-agent >/dev/null 2>&1 || true
  /usr/local/tunnel/tools/whitelist-check "$INSTALL_PROFILE"

  case "$INSTALL_PROFILE" in
    base)
      ok "Base structure selesai"
      ;;
    minimal)
      /usr/local/tunnel/core/ssh/install-ssh
      /usr/local/tunnel/proxy/websocket/install-ws-proxy
      optional_run "Xray" /usr/local/tunnel/core/xray/install-xray
      optional_run "Xray systemd" /usr/local/tunnel/core/xray/install-systemd
      optional_run "Xray config" /usr/local/tunnel/core/xray/render-xray-config --all
      ;;
    standard)
      /usr/local/tunnel/core/ssh/install-ssh
      /usr/local/tunnel/proxy/websocket/install-ws-proxy
      /usr/local/tunnel/proxy/nginx/install-nginx
      /usr/local/tunnel/proxy/haproxy/install-haproxy
      optional_run "Xray" /usr/local/tunnel/core/xray/install-xray
      optional_run "Xray systemd" /usr/local/tunnel/core/xray/install-systemd
      optional_run "Xray config" /usr/local/tunnel/core/xray/render-xray-config --all
      optional_run "ZiVPN" /usr/local/tunnel/core/zivpn/install-zivpn
      optional_run "Network optimizer" /usr/local/tunnel/tools/network-optimizer
      optional_run "Connection optimizer" /usr/local/tunnel/tools/connection-optimizer
      optional_run "Tunnel guard" /usr/local/tunnel/tools/install-guard
      optional_run "UDP accounting" /usr/local/tunnel/tools/install-udp-accounting
      optional_run "Security hardening" /usr/local/tunnel/tools/security-hardening
      optional_run "Auto backup" /usr/local/tunnel/tools/auto-backup
      ;;
    full)
      /usr/local/tunnel/core/ssh/install-ssh
      /usr/local/tunnel/proxy/websocket/install-ws-proxy
      /usr/local/tunnel/proxy/nginx/install-nginx
      /usr/local/tunnel/proxy/haproxy/install-haproxy
      optional_run "Xray" /usr/local/tunnel/core/xray/install-xray
      optional_run "Xray systemd" /usr/local/tunnel/core/xray/install-systemd
      optional_run "Xray config" /usr/local/tunnel/core/xray/render-xray-config --all
      optional_run "OpenVPN" /usr/local/tunnel/core/openvpn/install-openvpn
      optional_run "ZiVPN" /usr/local/tunnel/core/zivpn/install-zivpn
      optional_run "Sing-box" /usr/local/tunnel/core/sing-box/install-sing-box
      optional_run "Hysteria2" timeout 300 /usr/local/tunnel/core/hysteria2/install-hysteria2
      optional_run "TUIC" /usr/local/tunnel/core/tuic/install-tuic
      optional_run "WireGuard" /usr/local/tunnel/core/wireguard/install-wireguard
      optional_run "API" /usr/local/tunnel/api/install-api
      optional_run "Node heartbeat" /usr/local/tunnel/node/install-node-agent
      optional_run "Network optimizer" /usr/local/tunnel/tools/network-optimizer
      optional_run "Connection optimizer" /usr/local/tunnel/tools/connection-optimizer
      optional_run "Tunnel guard" /usr/local/tunnel/tools/install-guard
      optional_run "UDP accounting" /usr/local/tunnel/tools/install-udp-accounting
      optional_run "Security hardening" /usr/local/tunnel/tools/security-hardening
      optional_run "Auto backup" /usr/local/tunnel/tools/auto-backup
      ;;
  esac
}

install_bootstrap_deps
verify_whitelist_bootstrap
download_repo
install_structure
run_profile

ok "Instalasi Tunnel Enterprise selesai"
echo "Command utama: menu, tunnel-health, tunnel-service-doctor, tunnel-node-status, tunnel-vps-info, tunnel-whitelist-check"
