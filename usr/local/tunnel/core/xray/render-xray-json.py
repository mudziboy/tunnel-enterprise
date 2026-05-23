#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

def clients_for(conn, protocol, transport):
    rows = conn.execute(
        "SELECT username, uuid, password FROM accounts WHERE protocol=? AND transport=? AND status IN ('active','trial') ORDER BY username",
        (protocol, transport)
    ).fetchall()

    clients = []
    for username, uuid, password in rows:
        if protocol in ("vmess", "vless"):
            clients.append({"id": uuid, "email": username, "level": 0})
        elif protocol == "trojan":
            clients.append({"password": password or uuid, "email": username, "level": 0})
        elif protocol == "shadowsocks":
            clients.append({"method": "aes-256-gcm", "password": password or uuid, "email": username})
    return clients

def fallback_client(protocol):
    if protocol in ("vmess", "vless"):
        return [{"id": "00000000-0000-0000-0000-000000000000", "email": "placeholder", "level": 0}]
    if protocol == "trojan":
        return [{"password": "placeholder", "email": "placeholder", "level": 0}]
    if protocol == "shadowsocks":
        return [{"method": "aes-256-gcm", "password": "placeholder", "email": "placeholder"}]
    return []

def inbound(protocol, port, network, clients, ws_path=None, grpc_service=None):
    item = {
        "listen": "127.0.0.1",
        "port": int(port),
        "protocol": protocol,
        "settings": {},
        "streamSettings": {"network": network},
        "sniffing": {"enabled": True, "destOverride": ["http", "tls"]}
    }

    if protocol == "vless":
        item["settings"] = {"decryption": "none", "clients": clients}
    elif protocol == "vmess":
        item["settings"] = {"clients": [{"id": c["id"], "alterId": 0, "email": c["email"], "level": c.get("level", 0)} for c in clients]}
    elif protocol == "trojan":
        item["settings"] = {"clients": clients, "udp": True}
    elif protocol == "shadowsocks":
        item["settings"] = {"clients": clients, "network": "tcp,udp"}

    if network == "ws":
        item["streamSettings"]["wsSettings"] = {"path": ws_path}
    if network == "grpc":
        item["streamSettings"]["grpcSettings"] = {"serviceName": grpc_service}

    return item

def build_config(args):
    conn = sqlite3.connect(args.db)

    ws_clients = clients_for(conn, args.protocol, "ws")
    grpc_clients = clients_for(conn, args.protocol, "grpc")

    if not ws_clients:
        ws_clients = fallback_client(args.protocol)
    if not grpc_clients:
        grpc_clients = fallback_client(args.protocol)

    config = {
        "stats": {},
        "api": {"tag": "api", "services": ["StatsService"]},
        "policy": {
            "levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}},
            "system": {
                "statsInboundUplink": True,
                "statsInboundDownlink": True,
                "statsOutboundUplink": True,
                "statsOutboundDownlink": True
            }
        },
        "log": {
            "access": "/var/log/xray/access.log",
            "error": "/var/log/xray/error.log",
            "loglevel": "warning"
        },
        "inbounds": [
            inbound(args.protocol, args.ws_port, "ws", ws_clients, ws_path=args.ws_path),
            inbound(args.protocol, args.grpc_port, "grpc", grpc_clients, grpc_service=args.grpc_service),
            {
                "listen": "127.0.0.1",
                "port": int(args.api_port),
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
                "tag": "api"
            }
        ],
        "outbounds": [
            {"protocol": "freedom", "settings": {}},
            {"protocol": "blackhole", "settings": {}, "tag": "block"}
        ],
        "routing": {
            "rules": [
                {
                    "type": "field",
                    "ip": [
                        "10.0.0.0/8",
                        "100.64.0.0/10",
                        "169.254.0.0/16",
                        "172.16.0.0/12",
                        "192.0.0.0/24",
                        "192.0.2.0/24",
                        "192.168.0.0/16",
                        "198.18.0.0/15",
                        "198.51.100.0/24",
                        "203.0.113.0/24",
                        "::1/128",
                        "fc00::/7",
                        "fe80::/10"
                    ],
                    "outboundTag": "block"
                },
                {"type": "field", "inboundTag": ["api"], "outboundTag": "api"}
            ]
        }
    }
    return config

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--ws-port", required=True)
    parser.add_argument("--grpc-port", required=True)
    parser.add_argument("--api-port", required=True)
    parser.add_argument("--ws-path", required=True)
    parser.add_argument("--grpc-service", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    config = build_config(args)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(config, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
