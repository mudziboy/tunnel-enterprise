const express = require("express");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const app = express();
app.use(express.json({ limit: "10mb" }));
const DB = "/etc/tunnel/tunnel.db";
const VERSION = "5.5.0";
function readFile(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function readEnv(path, key) { const s = readFile(path); const m = s.match(new RegExp(`^${key}=(.*)$`, "m")); return m ? m[1].replace(/^[\'\"]|[\'\"]$/g, "") : ""; }
const PORT = Number(process.env.TUNNEL_API_PORT || readEnv("/etc/tunnel/ports.env", "TUNNEL_API_PORT") || 5889);
function sh(cmd, args = [], timeout = 15000) { try { return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return (e.stdout?.toString()?.trim() || e.stderr?.toString()?.trim() || ""); } }
function jsonFile(path, fallback) { try { return JSON.parse(readFile(path)); } catch { return fallback; } }
function sql(q) { return sh("sqlite3", ["-json", DB, q], 10000); }
function sqlRows(q) { try { return JSON.parse(sql(q) || "[]"); } catch { return []; } }
function sqlExec(q) { return sh("sqlite3", [DB, q], 10000); }
function esc(s) { return String(s ?? "").replace(/'/g, "''"); }
function ok(res, data = {}, message = "OK") { res.json({ success: true, message, data }); }
function fail(res, code, message, status = 400, details = {}) { res.status(status).json({ success: false, error_code: code, message, details }); }
function clientIp(req) { return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].replace(/^::ffff:/, "").trim(); }
function allowedByIp(req) { const ip = clientIp(req); const allow = readFile("/etc/tunnel/allow.txt").split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#")); if (allow.length === 0) return true; return allow.includes(ip) || allow.includes("0.0.0.0/0") || ip === "127.0.0.1" || ip === "::1"; }
function safeCompare(a,b){ const A=Buffer.from(String(a||"")); const B=Buffer.from(String(b||"")); return A.length===B.length && crypto.timingSafeEqual(A,B); }
function apiKeyValid(req) { const got = String(req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || ""); if (!got) return false; const primary = readFile("/etc/tunnel/api.key").trim(); if (primary && safeCompare(got, primary)) return true; const keys = jsonFile("/etc/tunnel/api.keys.json", { keys: [] }).keys || []; return keys.some(k => k && k.enabled !== false && k.key === got); }
function auth(req, res, next) { if (req.path === "/health") return next(); if (!allowedByIp(req)) return fail(res, "AUTH_IP_NOT_ALLOWED", "IP tidak ada di whitelist", 403, { ip: clientIp(req) }); if (!apiKeyValid(req)) return fail(res, "AUTH_INVALID_KEY", "API key tidak valid", 401); next(); }
app.use(auth);
function ensureDb() { sh("/usr/local/tunnel/tools/db-init", [], 20000); }
ensureDb();
function addAudit(actor, action, target, detail) { sqlExec(`INSERT INTO audit_logs(actor,action,target,detail) VALUES('${esc(actor)}','${esc(action)}','${esc(target)}','${esc(String(detail).slice(0,2000))}');`); }
function runJson(cmd,args=[],timeout=15000){ const out=sh(cmd,args,timeout); try{return JSON.parse(out||"null")}catch{return {raw:out}} }
function dispatchCreate(payload){ const out = sh("/usr/local/tunnel/core/protocol-dispatcher", ["create", JSON.stringify(payload)], 60000); try { return JSON.parse(out); } catch { return { success:false, error_code:"DISPATCHER_INVALID_RESPONSE", raw:out }; } }
function packageById(id){ const pkgs = jsonFile("/etc/tunnel/packages.json", {packages:[]}).packages || []; return pkgs.find(p => p.id === id); }
app.get("/health", (req, res) => ok(res, { status: "online", version: VERSION, hostname: os.hostname() }));
app.get("/api/node", (req, res) => ok(res, jsonFile("/etc/tunnel/node.json", {})));
app.get("/api/node/status", (req, res) => ok(res, runJson("/usr/local/tunnel/node/node-status", [], 15000)));
app.get("/api/node/capacity", (req, res) => ok(res, runJson("/usr/local/tunnel/node/node-capacity", [], 10000)));
app.post("/api/node/maintenance/:mode", (req, res) => { const mode = req.params.mode === "on" ? "on" : "off"; const out = sh("/usr/local/tunnel/node/node-maintenance", [mode]); addAudit("api", "node.maintenance", mode, out); ok(res, { output: out }); });
app.post("/api/node/drain/:mode", (req, res) => { const mode = req.params.mode === "on" ? "on" : "off"; const out = sh("/usr/local/tunnel/node/node-drain", [mode]); addAudit("api", "node.drain", mode, out); ok(res, { output: out }); });
app.post("/api/node/heartbeat", (req,res)=> ok(res, runJson("/usr/local/tunnel/node/node-heartbeat", [], 15000)));
app.post("/api/node/events/sync", (req,res)=> { const out=sh("/usr/local/tunnel/node/node-event-sync", [], 30000); ok(res,{output:out}); });
app.get("/api/vps-info", (req, res) => ok(res, runJson("/usr/local/tunnel/tools/vps-info", ["--json"], 15000)));
app.get("/api/services", (req, res) => ok(res, runJson("/usr/local/tunnel/tools/health-check", ["--json"], 15000)));
app.post("/api/services/:name/restart", (req, res) => { const svc = req.params.name; const job = sh("/usr/local/tunnel/core/job-runner", ["add", "reload_service", JSON.stringify({ service: svc })]); addAudit("api", "service.restart.request", svc, job); ok(res, { job_id: job }, "Job created"); });
app.get("/api/protocols", (req,res)=> ok(res, jsonFile("/etc/tunnel/protocols.json", {protocols:{}})));
app.get("/api/protocols/:name", (req,res)=> { const reg=jsonFile("/etc/tunnel/protocols.json", {protocols:{}}).protocols || {}; ok(res, reg[req.params.name] || null); });
app.get("/api/packages", (req,res)=> ok(res, jsonFile("/etc/tunnel/packages.json", {packages:[]})));
app.get("/api/packages/:id", (req,res)=> ok(res, packageById(req.params.id) || null));
app.post("/api/packages/sync", (req,res)=> { const out=sh("/usr/local/tunnel/core/package-manager", ["sync-db"], 15000); ok(res,{output:out}); });
app.get("/api/accounts", (req, res) => ok(res, sqlRows("SELECT id,username,protocol,transport,quota_gb,ip_limit,device_limit,expired_at,status,node_id,note FROM accounts ORDER BY id DESC LIMIT 1000;")));
app.get("/api/accounts/:username", (req, res) => ok(res, { accounts: sqlRows(`SELECT * FROM accounts WHERE username='${esc(req.params.username)}';`), protocols: sqlRows(`SELECT protocol,engine,uuid,port,client_ip,config_uri,message,status,expired_at FROM account_protocol_details WHERE username='${esc(req.params.username)}' ORDER BY protocol;`) }));
app.post("/api/accounts", (req, res) => { const b = req.body || {}; const username = String(b.username || ""); if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return fail(res, "ACCOUNT_USERNAME_INVALID", "Username tidak valid"); const result = dispatchCreate(b); if (!result.success) return fail(res, result.error_code || "ACCOUNT_CREATE_FAILED", result.message || "Gagal membuat akun", 400, result); addAudit("api", "account.create", username, JSON.stringify({ protocols:b.protocols || b.protocol || [] })); ok(res, result, "Account created"); });
app.post("/api/accounts/from-package", (req,res)=> { const b=req.body||{}; const pkg=packageById(String(b.package_id||b.packageId||"")); if(!pkg) return fail(res,"PACKAGE_NOT_FOUND","Package tidak ditemukan",404); const payload = { ...b, protocols: pkg.protocols, expired_days: b.expired_days || pkg.duration_days, quota_gb: b.quota_gb ?? pkg.quota_gb, ip_limit: b.ip_limit ?? pkg.ip_limit, device_limit: b.device_limit ?? pkg.device_limit }; const result = dispatchCreate(payload); if(!result.success) return fail(res,result.error_code||"PACKAGE_CREATE_FAILED",result.message||"Gagal membuat package",400,result); sqlExec(`INSERT INTO package_orders(order_id,package_id,username,protocols,total_price,status,payload) VALUES('${esc(crypto.randomUUID())}','${esc(pkg.id)}','${esc(payload.username)}','${esc(JSON.stringify(pkg.protocols))}',${Number(pkg.price||0)},'created','${esc(JSON.stringify(payload))}');`); addAudit("api","account.create.from_package",payload.username,pkg.id); ok(res,{ package:pkg, account:result },"Package account created"); });
app.get("/api/accounts/:username/message", (req,res)=> { const rows=sqlRows(`SELECT protocol,message FROM account_protocol_details WHERE username='${esc(req.params.username)}' ORDER BY protocol;`); ok(res,{username:req.params.username,message:rows.map(r=>r.message).join("\n\n"),items:rows}); });
app.post("/api/accounts/:username/renew", (req, res) => { const days = Number(req.body?.days || req.body?.expired_days || 30); const exp = sh("date", ["-u", "-d", `+${days} days`, "+%Y-%m-%d"]); sqlExec(`UPDATE accounts SET expired_at='${esc(exp)}', status='active', updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}'; UPDATE account_protocol_details SET expired_at='${esc(exp)}',status='active',updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}';`); addAudit("api", "account.renew", req.params.username, String(days)); ok(res, { username: req.params.username, expired_at: exp }); });
app.post("/api/accounts/:username/lock", (req, res) => { sqlExec(`UPDATE accounts SET status='locked', note='manual lock', updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}'; UPDATE account_protocol_details SET status='locked',updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}';`); sh("/usr/local/tunnel/core/enforcement-actions", ["apply", req.params.username, req.body?.protocol || "all", "manual_lock"], 15000); addAudit("api", "account.lock", req.params.username, "manual"); ok(res, { username: req.params.username, status: "locked" }); });
app.post("/api/accounts/:username/unlock", (req, res) => { sqlExec(`UPDATE accounts SET status='active', note='', updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}'; UPDATE account_protocol_details SET status='active',updated_at=CURRENT_TIMESTAMP WHERE username='${esc(req.params.username)}';`); addAudit("api", "account.unlock", req.params.username, "manual"); ok(res, { username: req.params.username, status: "active" }); });
app.delete("/api/accounts/:username", (req, res) => { sh("/usr/local/tunnel/core/wireguard/ip-pool-manager", ["release", req.params.username], 5000); sqlExec(`DELETE FROM accounts WHERE username='${esc(req.params.username)}'; DELETE FROM account_protocol_details WHERE username='${esc(req.params.username)}'; DELETE FROM account_protocols WHERE username='${esc(req.params.username)}';`); addAudit("api", "account.delete", req.params.username, "manual"); ok(res, { username: req.params.username }); });
app.get("/api/sessions", (req, res) => ok(res, runJson("/usr/local/tunnel/core/session-monitor", ["--json"], 15000)));
app.get("/api/sessions/:username", (req, res) => ok(res, sqlRows(`SELECT username,protocol,remote_ip,last_seen_at,source FROM sessions WHERE username='${esc(req.params.username)}' ORDER BY last_seen_at DESC;`)));
app.post("/api/sessions/:username/kill", (req, res) => { const u = req.params.username; sh("pkill", ["-KILL", "-u", u], 5000); addAudit("api", "session.kill", u, "manual"); ok(res, { username: u }); });
app.get("/api/traffic", (req, res) => ok(res, runJson("/usr/local/tunnel/core/traffic-accounting", ["--json"], 20000)));
app.get("/api/traffic/:username", (req, res) => ok(res, sqlRows(`SELECT username,protocol,SUM(uplink_bytes) uplink_bytes,SUM(downlink_bytes) downlink_bytes,SUM(uplink_bytes+downlink_bytes) total_bytes FROM traffic_usage WHERE username='${esc(req.params.username)}' GROUP BY username,protocol;`)));
app.get("/api/quota", (req,res)=> ok(res, runJson("/usr/local/tunnel/core/quota-manager", ["--json"], 25000)));
app.get("/api/ip-limit", (req,res)=> ok(res, runJson("/usr/local/tunnel/core/ip-limit-enforcer", ["--json"], 25000)));
app.post("/api/enforcement/run", (req,res)=> { const out=sh("/usr/local/tunnel/guard/tunnel-guard", [], 60000); addAudit("api","enforcement.run","guard",out); ok(res,{output:out}); });
app.get("/api/events", (req,res)=> ok(res, sqlRows("SELECT * FROM events ORDER BY id DESC LIMIT 300;")));
app.get("/api/outbox", (req,res)=> ok(res, sqlRows("SELECT * FROM outbox ORDER BY id DESC LIMIT 300;")));
app.get("/api/jobs", (req, res) => ok(res, sqlRows("SELECT job_id,type,status,result,created_at,started_at,finished_at FROM jobs ORDER BY id DESC LIMIT 200;")));
app.get("/api/jobs/:id", (req, res) => ok(res, sqlRows(`SELECT * FROM jobs WHERE job_id='${esc(req.params.id)}';`)[0] || null));
app.post("/api/jobs/:id/run", (req, res) => { const out = sh("/usr/local/tunnel/core/job-runner", ["run", req.params.id], 60000); ok(res, { output: out }); });
app.get("/api/whitelist", (req, res) => ok(res, readFile("/etc/tunnel/allow.txt").split(/\r?\n/).filter(x => x.trim() && !x.trim().startsWith("#"))));
app.post("/api/whitelist", (req, res) => { const ip = String(req.body?.ip || "").trim(); if (!/^[a-zA-Z0-9:.\/-]+$/.test(ip)) return fail(res, "WHITELIST_INVALID", "IP/domain tidak valid"); fs.appendFileSync("/etc/tunnel/allow.txt", `\n${ip}\n`); addAudit("api", "whitelist.add", ip, ""); ok(res, { ip }); });
app.get("/api/logs/:type", (req, res) => { const type = req.params.type.replace(/[^a-zA-Z0-9._-]/g, ""); const candidates = [`/usr/local/tunnel/logs/${type}.log`, `/var/log/${type}.log`]; const file = candidates.find(fs.existsSync); ok(res, { file: file || null, content: file ? readFile(file).split(/\r?\n/).slice(-300).join("\n") : "" }); });
app.get("/api/accounting/backend", (req,res)=> ok(res, { backend: sh("/usr/local/tunnel/core/accounting-backend-detect", [], 5000) }));
app.get("/api/accounting/rules", (req,res)=> ok(res, sqlRows("SELECT * FROM accounting_rules ORDER BY id DESC LIMIT 500;")));
app.post("/api/accounting/sync", (req,res)=> { const backend = String(req.body?.backend || "auto"); const out = sh("/usr/local/tunnel/core/accounting-rule-sync", [backend], 30000); addAudit("api","accounting.sync",backend,out); ok(res,{backend,output:out}); });
app.post("/api/accounting/collect", (req,res)=> { const out = runJson("/usr/local/tunnel/core/accounting-collector", ["--json"], 30000); addAudit("api","accounting.collect","hybrid",JSON.stringify(out).slice(0,1000)); ok(res,out); });
app.get("/api/accounting/snapshots", (req,res)=> ok(res, sqlRows("SELECT * FROM accounting_snapshots ORDER BY id DESC LIMIT 500;")));
app.post("/api/accounting/reset", (req,res)=> { const scope = String(req.body?.scope || "soft"); const out = sh("/usr/local/tunnel/core/accounting-reset", [scope], 30000); addAudit("api","accounting.reset",scope,out); ok(res,{scope,output:out}); });
app.get("/api/udp/rules", (req,res)=> ok(res, sqlRows("SELECT * FROM udp_port_rules ORDER BY start_port ASC LIMIT 1000;")));
app.post("/api/udp/rules", (req,res)=> { const b=req.body||{}; const user=String(b.username||""); const start=String(b.start_port||""); const end=String(b.end_port||start); const proto=String(b.protocol||"zivpn"); if(!/^[a-zA-Z0-9._:-]{1,64}$/.test(user)) return fail(res,"UDP_USERNAME_INVALID","Username tidak valid"); const out=sh("/usr/local/tunnel/core/udp-port-mapper",["assign",user,start,end,proto],15000); addAudit("api","udp.rule.assign",user,out); ok(res,{output:out}); });
app.delete("/api/udp/rules/:username", (req,res)=> { const proto=String(req.query.protocol||"zivpn"); const out=sh("/usr/local/tunnel/core/udp-port-mapper",["release",req.params.username,proto],15000); addAudit("api","udp.rule.release",req.params.username,out); ok(res,{output:out}); });
app.post("/api/udp/sync", (req,res)=> { const backend=String(req.body?.backend||"auto"); const out=sh("/usr/local/tunnel/core/udp-accounting-rule-sync",[backend],30000); addAudit("api","udp.sync",backend,out); ok(res,{backend,output:out}); });
app.post("/api/udp/collect", (req,res)=> { const out=runJson("/usr/local/tunnel/core/udp-accounting-collector",["--json"],30000); addAudit("api","udp.collect","collector",JSON.stringify(out).slice(0,1000)); ok(res,out); });
app.get("/api/udp/snapshots", (req,res)=> ok(res, sqlRows("SELECT * FROM udp_accounting_snapshots ORDER BY id DESC LIMIT 500;")));
app.post("/api/udp/:username/block", (req,res)=> { const out=sh("/usr/local/tunnel/core/udp-enforcer",["block",req.params.username],20000); addAudit("api","udp.block",req.params.username,out); ok(res,{output:out}); });
app.post("/api/udp/:username/unblock", (req,res)=> { const out=sh("/usr/local/tunnel/core/udp-enforcer",["unblock",req.params.username],30000); addAudit("api","udp.unblock",req.params.username,out); ok(res,{output:out}); });
app.get("/api/anti-abuse/events", (req,res)=> ok(res, sqlRows("SELECT * FROM abuse_events ORDER BY id DESC LIMIT 500;")));
app.post("/api/anti-abuse/run", (req,res)=> { const out=runJson("/usr/local/tunnel/core/anti-abuse-policy",["--json"],60000); addAudit("api","anti-abuse.run","policy",JSON.stringify(out).slice(0,1000)); ok(res,out); });
app.get("/api/anti-abuse/policy", (req,res)=> ok(res, { file: "/etc/tunnel/anti-abuse.env", content: readFile("/etc/tunnel/anti-abuse.env") }));
app.get("/api/audit", (req, res) => ok(res, sqlRows("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300;")));
app.listen(PORT, "0.0.0.0", () => console.log(`Tunnel Go Node Agent API v${VERSION} listening on ${PORT}`));
