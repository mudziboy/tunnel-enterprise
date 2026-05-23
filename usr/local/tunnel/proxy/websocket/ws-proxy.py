#!/usr/bin/env python3
import os
import socket
import threading
import select
import sys

LISTEN_HOST = os.environ.get("WS_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("WS_PROXY_PORT", "1010"))
TARGET_SSH = int(os.environ.get("SSH_PORT", "22"))
TARGET_DROPBEAR = int(os.environ.get("DROPBEAR_PORT", "109"))
TARGET_OPENVPN = int(os.environ.get("OPENVPN_TCP_PORT", "1194"))
ALLOWED_TARGETS = {
    "ssh": ("127.0.0.1", TARGET_SSH),
    "dropbear": ("127.0.0.1", TARGET_DROPBEAR),
    "openvpn": ("127.0.0.1", TARGET_OPENVPN),
}
DEFAULT_TARGET = ALLOWED_TARGETS[os.environ.get("WS_DEFAULT_TARGET", "dropbear") if os.environ.get("WS_DEFAULT_TARGET", "dropbear") in ALLOWED_TARGETS else "dropbear"]
BUFLEN = 65535
IDLE_TIMEOUT = int(os.environ.get("WS_IDLE_TIMEOUT", "3600"))
CONNECT_TIMEOUT = int(os.environ.get("WS_CONNECT_TIMEOUT", "10"))
RESPONSE_MODE = os.environ.get("WS_RESPONSE_MODE", "auto").lower()
RESP_101 = b"HTTP/1.1 101 Switching Protocol\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: tunnel-go\r\n\r\n"
RESP_200 = b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: Tunnel-Go\r\nConnection: keep-alive\r\n\r\n"

def keepalive(sock):
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    for opt, val in ((getattr(socket, "TCP_KEEPIDLE", None), 30), (getattr(socket, "TCP_KEEPINTVL", None), 10), (getattr(socket, "TCP_KEEPCNT", None), 3)):
        if opt is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, opt, val)
            except OSError:
                pass

def find_header(data, name):
    prefix = (name + ":").lower()
    for line in data.splitlines():
        if line.lower().startswith(prefix):
            return line.split(":", 1)[1].strip()
    return ""

def target_from_request(req):
    low = req.lower()
    x_target = find_header(low, "x-tunnel-target")
    if x_target in ALLOWED_TARGETS:
        return ALLOWED_TARGETS[x_target]
    x_real = find_header(low, "x-real-host")
    if x_real:
        if x_real.endswith(":22"):
            return ALLOWED_TARGETS["ssh"]
        if x_real.endswith(":109") or x_real.endswith(":143"):
            return ALLOWED_TARGETS["dropbear"]
        if x_real.endswith(":1194"):
            return ALLOWED_TARGETS["openvpn"]
    if "/openvpn" in low:
        return ALLOWED_TARGETS["openvpn"]
    if "/ssh" in low and "/sshws" not in low:
        return ALLOWED_TARGETS["ssh"]
    return DEFAULT_TARGET

def response_for(req):
    if RESPONSE_MODE == "200":
        return RESP_200
    if RESPONSE_MODE == "101":
        return RESP_101
    return RESP_101 if "upgrade: websocket" in req.lower() else RESP_200

class Handler(threading.Thread):
    def __init__(self, client, addr):
        super().__init__(daemon=True)
        self.client = client
        self.addr = addr
        self.target = None
    def close(self):
        for s in (self.client, self.target):
            try:
                if s:
                    s.shutdown(socket.SHUT_RDWR)
                    s.close()
            except Exception:
                pass
    def run(self):
        try:
            keepalive(self.client)
            self.client.settimeout(CONNECT_TIMEOUT)
            raw = self.client.recv(BUFLEN)
            if not raw:
                return
            req = raw.decode("latin1", errors="ignore")
            host, port = target_from_request(req)
            self.target = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT)
            keepalive(self.target)
            self.client.sendall(response_for(req))
            self.client.settimeout(None)
            self.target.settimeout(None)
            sockets = [self.client, self.target]
            idle = 0
            while True:
                readable, _, errors = select.select(sockets, [], sockets, 1)
                if errors:
                    break
                if not readable:
                    idle += 1
                    if idle >= IDLE_TIMEOUT:
                        break
                    continue
                idle = 0
                for s in readable:
                    data = s.recv(BUFLEN)
                    if not data:
                        return
                    if s is self.client:
                        self.target.sendall(data)
                    else:
                        self.client.sendall(data)
        except Exception:
            pass
        finally:
            self.close()

def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    keepalive(server)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(4096)
    while True:
        client, addr = server.accept()
        Handler(client, addr).start()

if __name__ == "__main__":
    main()
