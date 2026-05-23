#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    rows = conn.execute(
        "SELECT uuid, password FROM accounts WHERE protocol='tuic' AND status IN ('active','trial') ORDER BY username"
    ).fetchall()

    users = {}
    for uuid, password in rows:
        if uuid and password:
            users[uuid] = password

    if not users:
        users["00000000-0000-0000-0000-000000000000"] = "placeholder"

    config = {
        "server": f"[::]:{args.port}",
        "users": users,
        "certificate": "/etc/tuic/server.crt",
        "private_key": "/etc/tuic/server.key",
        "congestion_control": "bbr",
        "alpn": ["h3"],
        "udp_relay_ipv6": True,
        "zero_rtt_handshake": False,
        "auth_timeout": "3s",
        "task_negotiation_timeout": "3s",
        "max_external_packet_size": 1500
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
