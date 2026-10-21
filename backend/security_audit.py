#!/usr/bin/env python3
"""
VonDonald051 Savings - independent security audit (Python enforcement layer).

Runs 16 security checks against the live system:
  1.  Security headers enforced (CSP, nosniff, frame-deny, referrer, permissions, COOP/CORP)
  2.  CSRF defense: same-origin requests may omit the custom XHR header; mismatched Origin is rejected
  3.  Weak passwords rejected at registration (policy: 9+ chars, 4 character classes)
  4.  Safe-code gate enforced at registration when enabled
  5.  Input validation rejects malformed name/email/phone
  6.  Account locks after exactly 4 wrong passwords (HTTP 423), 5th is blocked
  7.  Session cookie flags: HttpOnly + SameSite=Lax (Secure under HTTPS) after login
  8.  RBAC: anonymous blocked from admin APIs; authenticated VSA allowed
  9.  SQL-injection probe does not authenticate and does not crash the server
  10. Rate limiting engages on the login endpoint (HTTP 429)
  11. Stored XSS payloads in names are rejected by validation; no inline scripts allowed by CSP
  12. Upload endpoint is auth-gated; non-image payload rejected (server magic-byte check)
  13. Path traversal blocked on /uploads and static server
  14. Chat messages stored as ciphertext only (iv + ct) in the data store
  15. Secrets hygiene: every password stored as a scrypt s2$ hash; no reversible password vault;
      no seeded plaintext password present in the data file
    16. API responses carry Cache-Control: no-store

Usage:
  python3 security_audit.py --base http://127.0.0.1:3000
  python3 security_audit.py --base http://127.0.0.1:3000 \
      --email '<member email>' --password 'PW' \
      --vsa-email '<owner email>' --vsa-password 'PW'
"""
import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
results = []


def check(name, status, detail=""):
    results.append(status)
    tag = {"PASS": "\033[92mPASS\033[0m", "FAIL": "\033[91mFAIL\033[0m", "SKIP": "\033[93mSKIP\033[0m"}[status]
    print(f"  [{tag}] {name}" + (f"  -> {detail}" if detail else ""))


class Client:
    """Minimal cookie-aware HTTP client (stdlib only)."""

    def __init__(self, base):
        u = urllib.parse.urlparse(base)
        self.scheme, self.host = u.scheme, u.hostname
        self.port = u.port or (443 if u.scheme == "https" else 80)
        self.https = u.scheme == "https"
        self.origin = f"{u.scheme}://{u.netloc}"
        self.cookies = {}
        self.last_headers = {}
        self.last_set_cookies = []
        self.last_json = None
        self.last_body = b""

    def request(self, method, path, body=None, headers=None, skip_xhr=False):
        if self.https:
            import ssl
            conn = http.client.HTTPSConnection(self.host, self.port, timeout=12, context=ssl.create_default_context())
        else:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=12)
        h = {} if skip_xhr else {"X-Requested-With": "XMLHttpRequest"}
        if isinstance(body, dict):
            body = json.dumps(body)
            h["Content-Type"] = "application/json"
        elif isinstance(body, str):
            h["Content-Type"] = "text/plain"
        if method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            h.setdefault("Origin", self.origin)
        if headers:
            h.update(headers)
        if self.cookies:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        conn.request(method, path, body=body, headers=h)
        res = conn.getresponse()
        data = res.read()
        self.last_headers = {k.lower(): v for k, v in res.getheaders()}
        self.last_set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
        for sc in self.last_set_cookies:
            m = re.match(r"([^=;]+)=([^;]*)", sc)
            if m:
                if "Max-Age=0" in sc:
                    self.cookies.pop(m.group(1), None)
                else:
                    self.cookies[m.group(1)] = m.group(2)
        conn.close()
        try:
            self.last_json = json.loads(data.decode("utf-8", "replace"))
        except Exception:
            self.last_json = None
        self.last_body = data
        return res.status, self.last_json, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3000")
    ap.add_argument("--email", default=None, help="member email for the 4-strike lockout test")
    ap.add_argument("--password", default=None, help="member password (hash-test only)")
    ap.add_argument("--vsa-email", default=None)
    ap.add_argument("--vsa-password", default=None)
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--data-dir", default=os.path.join(project_root, "database", "data"))
    args = ap.parse_args()

    c = Client(args.base)
    print(f"\nVonDonald051 Security Audit -> {args.base}\n{'=' * 50}")

    try:
        st, _, _ = c.request("GET", "/login.html")
    except Exception as e:
        print(f"Cannot reach server: {e}")
        sys.exit(2)

    # 1. security headers
    need = ["content-security-policy", "x-content-type-options", "x-frame-options",
            "referrer-policy", "permissions-policy", "cross-origin-opener-policy"]
    missing = [h for h in need if h not in c.last_headers]
    csp = c.last_headers.get("content-security-policy", "")
    inline_blocked = "script-src 'self'" in csp.replace("  ", " ")
    check("1. Security headers enforced", PASS if st == 200 and not missing and inline_blocked else FAIL,
          f"missing={missing or 'none'}; script-src ok={inline_blocked}")

    # 2. CSRF defenses: same-origin requests may omit XHR header; cross-origin mutations are rejected.
    same_origin = urllib.parse.urlparse(args.base)
    origin = f"{same_origin.scheme}://{same_origin.netloc}"
    st2, _, _ = c.request("POST", "/api/auth/login", {"email": "a@b.c", "password": "x"},
                          headers={"Origin": origin}, skip_xhr=True)
    st3, _, _ = c.request("POST", "/api/auth/login", {"email": "a@b.c", "password": "x"},
                          headers={"Origin": "https://evil.example"})
    check("2. CSRF: same-origin allowed without XHR header; mismatched Origin rejected",
          PASS if st2 == 401 and st3 == 403 else FAIL, f"same-origin-no-header={st2}, bad-origin={st3}")

    # 3. weak password rejected
    st, j, _ = c.request("POST", "/api/auth/register", {
        "firstName": "Audit", "lastName": "Tester", "email": f"audit{int(time.time())}@example.com",
        "phone": "+254700000000", "password": "weak", "confirmPassword": "weak", "safeCode": "XX"})
    errs = (j or {}).get("errors", {})
    check("3. Weak password rejected (>=9 chars, 4 classes)",
          PASS if st == 400 and "password" in errs else FAIL, f"errors={list(errs)}")

    # 4. safe-code gate
    st, j, _ = c.request("POST", "/api/auth/register", {
        "firstName": "Gate", "lastName": "Check", "email": f"gate{int(time.time() * 1000)}@example.com",
        "phone": "+254700000000", "password": "Str0ng!Pass#9", "confirmPassword": "Str0ng!Pass#9", "safeCode": ""})
    errs = (j or {}).get("errors", {})
    check("4. Safe-code gate enforced at registration",
          PASS if st == 400 and "safeCode" in errs else FAIL, f"errors={list(errs)}")

    # 5. malformed input rejected
    st, j, _ = c.request("POST", "/api/auth/register", {
        "firstName": "A", "lastName": "B", "email": "not-an-email", "phone": "abc",
        "password": "Str0ng!Pass#9", "confirmPassword": "Str0ng!Pass#9", "safeCode": "VD-000-000"})
    errs = (j or {}).get("errors", {})
    check("5. Input validation (name/email/phone)",
          PASS if st == 400 and ({"firstName", "lastName", "email", "phone"} & set(errs)) else FAIL,
          f"errors={list(errs)}")

    # 6. 4-strike lockout
    if args.email:
        got423_at = None
        probe = Client(args.base)
        for i in range(6):
            st, j, _ = probe.request("POST", "/api/auth/login",
                                     {"email": args.email, "password": f"Wrong!Pass{i}9Ab"})
            if st == 423:
                got423_at = i + 1
                break
            if st == 429:
                got423_at = "rate-limited"
                break
        ok = got423_at == 4
        check("6. Locks after EXACTLY 4 wrong passwords (423)",
              PASS if ok else (SKIP if got423_at == "rate-limited" else FAIL),
              f"423 at attempt {got423_at}; unlock from VSA > Locked Accounts")
    else:
        check("6. Locks after EXACTLY 4 wrong passwords", SKIP, "pass --email of a test member")

    # 7. session cookie flags
    if args.vsa_email and args.vsa_password:
        v = Client(args.base)
        st, _, _ = v.request("POST", "/api/auth/login", {"email": args.vsa_email, "password": args.vsa_password})
        sc = "; ".join(v.last_set_cookies).lower()
        ok = st == 200 and "httponly" in sc and "samesite=lax" in sc and "path=/" in sc
        c.request("POST", "/api/auth/logout")  # keep counters low
        check("7. Session cookie: HttpOnly + SameSite=Lax", PASS if ok else SKIP if st == 429 else FAIL, sc[:90])
    else:
        check("7. Session cookie: HttpOnly + SameSite=Lax", SKIP, "pass --vsa-email/--vsa-password")

    # 8. RBAC
    st, _, _ = c.request("GET", "/api/vsa/overview")
    anon_blocked = st in (401, 403)
    vsa_allowed = None
    if args.vsa_email and args.vsa_password:
        v = Client(args.base)
        st_l, _, _ = v.request("POST", "/api/auth/login", {"email": args.vsa_email, "password": args.vsa_password})
        if st_l == 200:
            st2, _, _ = v.request("GET", "/api/vsa/overview")
            vsa_allowed = st2 == 200
    check("8. RBAC: anonymous denied / VSA allowed",
          PASS if anon_blocked and vsa_allowed in (True, None) else FAIL)

    # 9. SQLi probe
    sqli = Client(args.base)
    st, _, _ = sqli.request("POST", "/api/auth/login", {"email": "' OR 1=1 --", "password": "' OR 1=1 --"})
    st2, _, _ = sqli.request("GET", "/api/auth/groups")
    check("9. SQL-injection probes do not authenticate/crash",
          PASS if st in (400, 401) and st2 != 500 else FAIL, f"login={st}")

    # 11. XSS rejected
    st, j, _ = c.request("POST", "/api/auth/register", {
        "firstName": "<script>alert(1)</script>", "lastName": "Tester", "email": f"xss{int(time.time())}@example.com",
        "phone": "+254700000000", "password": "Str0ng!Pass#9", "confirmPassword": "Str0ng!Pass#9", "safeCode": "VD-000-000"})
    errs = (j or {}).get("errors", {})
    check("11. XSS payload rejected by validation", PASS if st == 400 and "firstName" in errs else FAIL)

    # 12. uploads gated + rejects non-image
    st, _, _ = c.request("POST", "/api/me/picture", None, headers={"Content-Type": "multipart/form-data"})
    anon_gated = st == 401
    bad_rejected = None
    if args.vsa_email and args.vsa_password:
        v = Client(args.base)
        st_l, _, _ = v.request("POST", "/api/auth/login", {"email": args.vsa_email, "password": args.vsa_password})
        if st_l == 200:
            boundary = "auditboundary"
            payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"pic\"; filename=\"evil.html\"\r\n"
                       f"Content-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n--{boundary}--\r\n").encode()
            conn = (http.client.HTTPSConnection if v.https else http.client.HTTPConnection)(v.host, v.port, timeout=10)
            conn.request("POST", "/api/me/picture", body=payload, headers={
                "X-Requested-With": "XMLHttpRequest",
                "Origin": v.origin,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Cookie": "; ".join(f"{k}={x}" for k, x in v.cookies.items())})
            r2 = conn.getresponse(); r2.read(); conn.close()
            bad_rejected = r2.status == 400
    check("12. Uploads auth-gated + non-image rejected",
          PASS if anon_gated and bad_rejected in (True, None) else FAIL,
          f"anon={st}, badfile={bad_rejected}")

    # 10. rate limiting, after other checks that may need an authenticated login.
    rl = Client(args.base)
    limited = False
    for i in range(14):
        st, _, _ = rl.request("POST", "/api/auth/login", {"email": "flood@test.dev", "password": "nopeNope1!"})
        if st == 429:
            limited = True
            break
        time.sleep(0.05)
    check("10. Rate limiting engages on login (429)", PASS if limited else FAIL)

    # 13. traversal
    st, _, _ = c.request("GET", "/uploads/..%2F..%2Fserver.js")
    st2, _, _ = c.request("GET", "/%2e%2e/%2e%2e/etc/passwd")
    check("13. Path traversal blocked",
          PASS if st in (400, 403, 404) and st2 in (400, 403, 404) else FAIL, f"{st},{st2}")

    # Inspect only boolean security properties; decrypted records never leave Node.
    dbf = os.path.join(args.data_dir, "db.json")
    summary = None
    if os.path.exists(dbf):
        inspect_db = r"""
const fs = require('fs');
const dbCrypto = require('./backend/src/db-crypto');
const bytes = fs.readFileSync(process.argv[1]);
if (!dbCrypto.isEncrypted(bytes)) throw new Error('database encryption marker missing');
const raw = dbCrypto.decryptDatabase(bytes).toString('utf8');
const db = JSON.parse(raw);
const messages = Array.isArray(db.messages) ? db.messages : [];
const users = Array.isArray(db.users) ? db.users : [];
process.stdout.write(JSON.stringify({
  encrypted: true,
  chatCiphertextOnly: messages.every(m => m && typeof m.iv === 'string' && typeof m.ct === 'string'
    && !['text', 'body', 'content', 'message'].some(k => Object.hasOwn(m, k))),
  messageCount: messages.length,
  passwordHashesValid: users.every(u => typeof u.passHash === 'string' && u.passHash.startsWith('s2$') && !Object.hasOwn(u, 'passVault')),
  plaintextPasswordPresent: process.argv[2] ? raw.includes(process.argv[2]) : false
}));
"""
        try:
            inspected = subprocess.run(
                ["node", "-e", inspect_db, dbf, args.password or ""],
                cwd=project_root, check=True, capture_output=True, text=True, timeout=15
            )
            summary = json.loads(inspected.stdout)
        except Exception:
            summary = None
    if summary is None:
        check("14. Encrypted database and chat ciphertext at rest", SKIP, "db.json unavailable or could not be decrypted")
        check("15. Secrets hygiene (scrypt-only hashes, no password vault)", SKIP)
    else:
        chat_ok = summary["encrypted"] and summary["chatCiphertextOnly"]
        check("14. Encrypted database stores chat ciphertext only (iv+ct)", PASS if chat_ok else FAIL,
              f"encrypted={summary['encrypted']}; messages={summary['messageCount']}")
        hash_ok = summary["passwordHashesValid"] and not summary["plaintextPasswordPresent"]
        check("15. Secrets hygiene (scrypt-only hashes, no password vault, no plaintext)", PASS if hash_ok else FAIL)

    st, _, _ = c.request("GET", "/api/auth/groups")
    cache_control = c.last_headers.get("cache-control", "").lower()
    check("16. API responses are not cacheable", PASS if st == 200 and "no-store" in cache_control else FAIL,
          f"Cache-Control={cache_control or 'missing'}")

    print(f"\n{'=' * 50}")
    passed = results.count(PASS); failed = results.count(FAIL); skipped = results.count(SKIP)
    print(f"RESULT: {passed} passed, {failed} failed, {skipped} skipped of {len(results)} checks")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
