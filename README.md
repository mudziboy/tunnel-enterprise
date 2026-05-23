# Tunnel Go Enterprise v5.5

Distributed Node Agent + VPN Service Manager + Business Protocol Layer.

v5.5 menambahkan protocol registry, package catalog, multi-protocol create account, formatted account messages, WireGuard IP pool, dan API endpoint yang disiapkan untuk bot Telegram/web panel.

Lihat `RELEASE-V5.5-BUSINESS-PROTOCOL-LAYER.txt` untuk detail.

# Tunnel Go Enterprise v5.2 Node Enforcement

Paket ini adalah lanjutan dari v5.1 Node Agent. Fokus v5.2 adalah enforcement lokal per VPS agar setiap node bisa menjaga resource sendiri tanpa bergantung penuh ke bot/web panel pusat.

## Core architecture

- Distributed Node Agent
- Local SQLite database per VPS: `/etc/tunnel/tunnel.db`
- Whitelist IP + API key security
- Local autokill per node
- Session monitor per node
- Traffic accounting base per node
- Quota manager per node
- IP limit enforcer per node
- Event/outbox sync readiness untuk panel pusat

## Perintah utama

```bash
menu
tunnel-health
tunnel-service-doctor
tunnel-vps-info
tunnel-node-status
tunnel-node-capacity
tunnel-network-optimizer
bbr.sh
/usr/local/tunnel/core/session-monitor
/usr/local/tunnel/core/traffic-accounting
/usr/local/tunnel/core/quota-manager
/usr/local/tunnel/core/ip-limit-enforcer
/usr/local/tunnel/guard/tunnel-guard
/usr/local/tunnel/tools/install-guard
```

## Endpoint penting v5.2

```text
GET    /health
GET    /api/node
GET    /api/node/status
GET    /api/node/capacity
GET    /api/services
GET    /api/accounts
POST   /api/accounts
POST   /api/accounts/:username/lock
POST   /api/accounts/:username/unlock
GET    /api/sessions
GET    /api/sessions/:username
GET    /api/traffic
GET    /api/traffic/:username
GET    /api/quota
GET    /api/ip-limit
POST   /api/enforcement/run
GET    /api/events
GET    /api/outbox
POST   /api/node/heartbeat
POST   /api/node/events/sync
```

## Catatan v5.2

- Autokill sudah diarahkan ke dispatcher enforcement per protokol.
- IP limit berjalan dari snapshot sesi aktif.
- Quota berjalan dari traffic usage yang tersedia.
- WireGuard traffic accounting sudah menggunakan counter delta dari `wg show all transfer`.
- Xray traffic accounting disiapkan untuk Xray Stats API pada `127.0.0.1:10085` jika stats API diaktifkan.
- SSH/Dropbear session limit berjalan; bandwidth per-user presisi penuh untuk SSH/Dropbear masih perlu integrasi nftables/iptables marking di versi berikutnya.
- Tetap tidak memakai license server. Security memakai `allow.txt`, `api.key`, dan `api.keys.json`.


## v5.3 Node Accounting

v5.3 menambahkan accounting hybrid yang lebih dalam:

- nftables counter untuk SSH/Dropbear berbasis UID lokal jika `nft` tersedia.
- fallback iptables owner counter jika nftables tidak tersedia.
- collector terpusat: `/usr/local/tunnel/core/accounting-collector`.
- rule sync: `/usr/local/tunnel/core/accounting-rule-sync`.
- command praktis: `tunnel-accounting install|sync|collect|table|json|reset`.
- API baru: `/api/accounting/*`.
- database baru: `accounting_rules`, `accounting_snapshots`, `accounting_events`.

Catatan teknis: Xray/Sing-box tidak berjalan sebagai UID Linux per user, sehingga per-user accounting untuk Xray tetap memakai stats API. WireGuard tetap memakai `wg show transfer`. SSH/Dropbear memakai UID accounting karena akun SSH adalah user Linux.

## v5.4 UDP/ZiVPN Accounting + Anti-Abuse

v5.4 menambahkan accounting UDP/ZiVPN yang lebih terukur dan anti-abuse policy lokal per node.

Fitur baru:

- `udp-port-mapper` untuk mapping port/range UDP per user.
- `udp-accounting-rule-sync` untuk membuat counter nftables/iptables.
- `udp-accounting-collector` untuk membaca delta RX/TX dan menyimpan ke SQLite.
- `udp-enforcer` untuk block/unblock UDP per user.
- `anti-abuse-policy` untuk mendeteksi session spike, IP spike, UDP spike, dan daily bandwidth abuse.
- API endpoint `/api/udp/*` dan `/api/anti-abuse/*`.
- systemd timer `tunnel-udp-accounting.timer` dan `tunnel-anti-abuse.timer`.

Perintah utama:

```bash
tunnel-udp-accounting assign <username> <start_port> [end_port] [protocol]
tunnel-udp-accounting mapper list
tunnel-udp-accounting sync auto
tunnel-udp-accounting collect --json
tunnel-udp-accounting block <username>
tunnel-udp-accounting unblock <username>
tunnel-udp-accounting abuse --json
/usr/local/tunnel/tools/install-udp-accounting
```

File konfigurasi:

```text
/etc/tunnel/zivpn-ports.map
/etc/tunnel/anti-abuse.env
```

Catatan: accounting UDP per user paling akurat jika setiap user memiliki port/range sendiri. Jika semua user berbagi satu port/range, counter hanya akurat pada level port/range, bukan user individual.
