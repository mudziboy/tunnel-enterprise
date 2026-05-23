#!/usr/bin/env bash
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Jalankan sebagai root" >&2; exit 1; }
CONF=/etc/sysctl.d/99-tunnel-go-network.conf
cat > "$CONF" <<'EOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.tcp_fastopen=3
net.ipv4.tcp_mtu_probing=1
net.ipv4.tcp_keepalive_time=600
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=5
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_tw_reuse=1
net.ipv4.ip_local_port_range=1024 65535
net.core.somaxconn=65535
net.core.netdev_max_backlog=250000
fs.file-max=1000000
EOF
modprobe tcp_bbr >/dev/null 2>&1 || true
sysctl --system >/dev/null
mkdir -p /etc/systemd/system.conf.d /etc/security/limits.d
cat > /etc/systemd/system.conf.d/99-tunnel-go-limits.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=1000000
DefaultLimitNPROC=65535
EOF
cat > /etc/security/limits.d/99-tunnel-go.conf <<'EOF'
* soft nofile 1000000
* hard nofile 1000000
root soft nofile 1000000
root hard nofile 1000000
EOF
echo "BBR/TCP tuning applied"
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc 2>/dev/null || true
