#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--listen", required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    rows = conn.execute(
        "SELECT username, password FROM accounts WHERE protocol='zivpn' AND status IN ('active','trial') ORDER BY username"
    ).fetchall()

    passwords = []
    for username, password in rows:
        if password:
            passwords.append(password)
        else:
            passwords.append(username)

    config = {
        "listen": args.listen,
        "cert": args.cert,
        "key": args.key,
        "obfs": "zivpn",
        "auth": {
            "mode": "passwords",
            "config": passwords
        }
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
