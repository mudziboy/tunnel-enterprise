#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    rows = conn.execute(
        "SELECT username, password FROM accounts WHERE protocol='sing-box' AND status IN ('active','trial') ORDER BY username"
    ).fetchall()

    users = []
    for username, password in rows:
        users.append({"name": username, "password": password or username})

    config = {
        "log": {"level": "info", "timestamp": True},
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": 10808,
                "users": users
            }
        ],
        "outbounds": [
            {"type": "direct", "tag": "direct"},
            {"type": "block", "tag": "block"}
        ],
        "route": {
            "rules": [
                {"ip_is_private": True, "outbound": "block"}
            ],
            "final": "direct"
        }
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
