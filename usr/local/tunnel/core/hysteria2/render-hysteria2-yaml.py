#!/usr/bin/env python3
import argparse
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
        "SELECT username, password FROM accounts WHERE protocol='hysteria2' AND status IN ('active','trial') ORDER BY username"
    ).fetchall()

    passwords = [password or username for username, password in rows]
    if not passwords:
        passwords = ["placeholder"]

    lines = [
        f"listen: :{args.port}",
        "tls:",
        "  cert: /etc/hysteria/server.crt",
        "  key: /etc/hysteria/server.key",
        "auth:",
        "  type: password",
        "  password: " + passwords[0],
        "masquerade:",
        "  type: proxy",
        "  proxy:",
        "    url: https://www.bing.com",
        "    rewriteHost: true",
        ""
    ]

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")

if __name__ == "__main__":
    main()
