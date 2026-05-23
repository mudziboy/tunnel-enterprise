#!/usr/bin/env python3
import argparse
import sqlite3
from pathlib import Path

def read(path):
    p = Path(path)
    return p.read_text().strip() if p.exists() else ""

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    private_key = read("/etc/wireguard/server_private.key")
    conn = sqlite3.connect(args.db)
    rows = conn.execute(
        "SELECT username, uuid FROM accounts WHERE protocol='wireguard' AND status IN ('active','trial') ORDER BY username"
    ).fetchall()

    lines = [
        "[Interface]",
        "Address = 10.66.66.1/24",
        f"ListenPort = {args.port}",
        f"PrivateKey = {private_key}",
        "PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $(ip route | awk '/default/ {print $5; exit}') -j MASQUERADE",
        "PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $(ip route | awk '/default/ {print $5; exit}') -j MASQUERADE",
        ""
    ]

    base = 2
    for idx, (username, public_key) in enumerate(rows, start=base):
        if not public_key:
            continue
        lines += [
            f"# {username}",
            "[Peer]",
            f"PublicKey = {public_key}",
            f"AllowedIPs = 10.66.66.{idx}/32",
            ""
        ]

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")

if __name__ == "__main__":
    main()
