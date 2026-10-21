ear# VonDonald051 Savings — Secure Multi-Role Management System

A hardened group/savings (chama-style) management system with 5 roles, end-to-end encrypted chat,
WebRTC video calls, email notifications and per-group PDF/CSV reports.

- **Backend:** Node.js with a custom HTTP framework, RFC 6455 WebSocket server, hand-rolled PDF writer,
  raw SMTP client, and bcrypt for the controlled Owner reset flow
- **Frontend:** HTML + CSS + vanilla JS (no frameworks, native `WebSocket`, CSP-safe)
- **Python:** independent security-audit layer — **16 checks**
- **Storage:** atomic JSON store (`database/data/db.json`) — no SQL ⇒ no SQL injection by construction

## Roles & themes

| Role | Dashboard | Animated background |
|---|---|---|
| **Owner (V Super Admin)** | black | moving stars + **one moon** |
| **Super Admin** | black | moving stars |
| **Admin** | black | moving stars; read-only agreements and audit log |
| **Group Admin** | blue | black BMW photo background |
| **Member** | white | moving clouds |

Every dashboard uses a **static, flexible navigation pane pinned to the left**.

## Quick start

The JSON database is encrypted with AES-256-GCM and the application refuses to start without a valid
`DB_ENCRYPTION_KEY`. Generate a 32-byte key with a cryptographic random generator and place it in your
secret manager; never paste it into source or logs. Existing plaintext databases must be migrated
offline before starting the updated server:

```bash
# First setup only, or when provisioning a new database: generate each key and store it
# in your secret manager. Do not replace a key already used by an encrypted database.
openssl rand -hex 32
openssl rand -base64 48

# With the server stopped, retrieve the stored values from your secret manager.
# These prompts do not echo the secrets or put them in shell history.
read -rsp 'DB_ENCRYPTION_KEY: ' DB_ENCRYPTION_KEY; printf '\n'; export DB_ENCRYPTION_KEY
read -rsp 'SYSTEM_BACKUP_KEY: ' SYSTEM_BACKUP_KEY; printf '\n'; export SYSTEM_BACKUP_KEY
export SYSTEM_BACKUP_PATH=/secure/backups/before-db-encryption.vdb
export ENABLE_DATA_ENCRYPTION_MIGRATION=1

node backend/scripts/encrypt-database.js --dry-run
node backend/scripts/encrypt-database.js
```

Change `SYSTEM_BACKUP_PATH` to a new destination outside the app in a protected directory that
already exists. The backup key is independent of the database key; retain both in the secret manager.
After migration, keep `DB_ENCRYPTION_KEY` available to the server process. Do not proceed unless the
dry-run reports the expected account count.

The migration requires the server stopped, creates and verifies an encrypted backup, asks for the exact
confirmation `ENCRYPT DATABASE`, audits the conversion, and atomically replaces the plaintext file.
Keep the database key outside the backup and app host where possible. Restore decrypts the encrypted
backup in memory and writes a newly encrypted database using the currently injected database key.
The encrypted database and backup encryption key are separate keys; losing either has a different
recovery impact.

For local development, the app loads `DB_ENCRYPTION_KEY`, Agreement V2 settings, and optional Google /
phone-login settings from a private `.env` file when those variables are not already present in the
process environment. Keep that file restricted to your user (`chmod 600 .env`); deployment should
continue to inject secrets through the service manager:

```bash
node server.js
```

Use the exact key already associated with `database/data/db.json`; generating a replacement key will make an
existing encrypted database unreadable. The checked-in `.env.example` is a reference only and is not
loaded by the app.

### Local sessions and split frontend/backend ports

Sessions expire after 8 hours by default, or 30 days when “remember me” is selected. A 403 is
normally an authorization or request-origin rejection, not session expiry; expired sessions return
401 from API routes. Development cookies omit `Secure` on HTTP loopback (`localhost`, `*.localhost`,
`127.0.0.1`, or `::1`). Production cookies use `Secure` except for HTTP loopback testing. Use the same
hostname in the browser and API URL; `localhost` and `127.0.0.1` are different cookie hosts.

The normal setup serves frontend and API from one origin and needs no CORS configuration. If the
frontend is on a separate local port, set the exact frontend origin in the backend environment, for
example `CORS_ALLOWED_ORIGINS=http://localhost:5173`, and set
`window.API_BASE_URL = 'http://localhost:3000'` in `frontend/public/js/runtime-config.js`. Include
the scheme and port, with no path and no wildcard. The API uses credentialed CORS and validates
state-changing request origins against this allowlist. Do not use `*` for credentialed CORS.

After changing origins or cookie settings, verify a browser session:

1. Open DevTools → Application/Storage → Cookies for the backend origin and delete its `sid` cookie;
   clear the frontend site data too if you changed its hostname, then reload.
2. Sign in again. In Network → login response, confirm `Set-Cookie` contains `HttpOnly`, `SameSite=Lax`,
   and the expected `Max-Age`; `Secure` should appear on production HTTPS, not HTTP localhost.
3. Confirm the next `/api/me` request sends the `sid` cookie and returns 200. If a request still returns
   403, inspect its JSON `code`: `ORIGIN_MISMATCH` means the frontend origin is not in
   `CORS_ALLOWED_ORIGINS`; `FORBIDDEN_ROLE` means the signed-in account lacks that endpoint’s role.

The system supports existing-account password login and Google OpenID Connect login. In production,
both paths require a one-time phone passcode before a session is created. Google sign-in uses a
server-side authorization-code flow with state, nonce, PKCE, and ID-token signature/claim checks;
Google email must match an existing active system account, and the role always comes from that
account. Twilio Verify sends and checks the SMS code. Account lockouts, secure session cookies, and
role checks remain in effect. Do not enable production until every active account has a phone number
in international format (for example, `+2547…`) and the SMS provider supports those destinations.

Google and SMS sign-in are configured through secret environment variables. For local development,
an OAuth web client may use a loopback callback such as
`http://localhost:3000/api/auth/google/callback`; open the app using the same `localhost` hostname.
Production requires an HTTPS domain and the exact callback
`https://YOUR_DOMAIN/api/auth/google/callback` registered in Google Cloud. Set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`; for phone verification set
`LOGIN_PHONE_OTP_ENABLED=1`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
`TWILIO_VERIFY_SERVICE_SID`. Keep credentials in the deployment secret manager. The login page keeps
Google sign-in disabled until both Google and phone-verification credentials are configured. SMS challenge state is short-lived and held in process memory, so run
only one app process until this state is moved to shared transactional storage.

The API accepts normal same-origin requests without requiring the nonstandard `X-Requested-With`
header. State-changing requests still reject mismatched or malformed `Origin`/`Referer` values.
Middleware 403 responses include a machine-readable `code` such as `ORIGIN_MISMATCH` or
`BAD_ORIGIN`; `FORBIDDEN_ROLE` and endpoint-specific 403s indicate authorization rules. Inspect the
request path and response JSON in the browser's Network panel when troubleshooting; do not share
cookies or credentials.

The general API limit defaults to 1,200 requests per client IP per minute. Set
`API_RATE_LIMIT_PER_MINUTE` in the server environment to tune it. Login and public endpoints keep
their stricter dedicated limits.

## Savings and loan charts

Member dashboards plot each account's verified savings and outstanding loan balance over the last
12 months. Group Admin dashboards show the same measures aggregated across their group's member
accounts; the summary endpoint returns no member names, IDs, or individual balances. Updates are sent
over the authenticated WebSocket after savings and loan changes, with a 30-second refresh fallback.
Pending savings are shown separately and enter the savings line when verified.

```bash
node backend/provision-owner.js   # prompts privately; only works when no user records exist
node server.js                    # http://127.0.0.1:3000   (Node.js >= 18)
```

The server never seeds demo accounts. Use `node backend/provision-owner.js` once after a reset; it prompts for
the first Owner's details and password without echoing the password. Alternatively, provision an empty
database with `OWNER_FIRST_NAME`, `OWNER_LAST_NAME`, `OWNER_EMAIL`, `OWNER_PHONE`, and
`OWNER_PASSWORD` injected by a secret manager. Startup stops if no Owner exists and bootstrap details
are missing. Never put the Owner password in source control or a command line.

## Phase 2 maintenance tools (prepared; never run on deploy)

The JSON store has no SQL transaction or migration engine. The maintenance commands therefore require
the server to be stopped, write an encrypted backup before changing records, stage a replacement JSON
file, and require an exact interactive confirmation. They are explicit operator commands; deployment
does not invoke them.

Inject `SYSTEM_BACKUP_KEY` and paths through a secret manager or service manager. The key must be at
least 32 bytes. Choose unique backup destinations outside this application directory; the commands
refuse paths inside the checkout. Do not place backup-key or owner-password values in command arguments
or logs.

```bash
# With SYSTEM_BACKUP_KEY injected into the process environment:
node backend/scripts/backup.js self-check

# Create and verify an encrypted snapshot of database/data/db.json, other data files, and uploads.
SYSTEM_BACKUP_PATH=/secure/backups/before-change.vdb node backend/scripts/backup.js create /secure/backups/before-change.vdb
node backend/scripts/backup.js verify /secure/backups/before-change.vdb

# Dry runs only report record counts; they do not need backup credentials or change data.
node backend/scripts/reset-accounts.js --dry-run
node backend/scripts/remove-agreements.js --dry-run

# Actual cleanup requires ENABLE_DESTRUCTIVE_MAINTENANCE=1, a new SYSTEM_BACKUP_PATH,
# SYSTEM_BACKUP_KEY, and exact typed confirmation in an interactive terminal.
node backend/scripts/reset-accounts.js
node backend/scripts/remove-agreements.js

# Restore requires the server stopped, a second encrypted pre-restore snapshot destination,
# and the typed phrase RESTORE BACKUP.
node backend/scripts/backup.js restore /secure/backups/before-change.vdb
```

Set `SYSTEM_PRE_RESTORE_BACKUP_PATH` to the encrypted destination for the current state before
restoring. Restore replaces the JSON database and uploads directory with the selected snapshot. It also
restores data files such as the security sentinel file. Keep encrypted backups and the key in separate,
access-controlled locations. Verify a backup before restore. The runtime PID marker prevents maintenance
scripts from proceeding while a server started with this version is running; stop the service first.

The account reset keeps one active Owner, sets its email to `jdonald@gmail.com`, revokes sessions and
user-linked records, sets `passwordChangeRequired`, and reads the new password from
`OWNER_INITIAL_PASSWORD`. It clears that variable inside the script and never prints the value. The
initial password may be changed later from the Owner profile. The reset script uses bcrypt with cost 12; the
ordinary legacy account hasher remains scrypt. Install the declared bcrypt dependency before deploying
this reset version.

Agreement removal also requires an encrypted backup and exact typed confirmation. The backup includes
the encrypted signed and original PDFs in `database/data/private-agreements`; removal clears both legacy and V2
agreement records, profile status flags, and the private PDF directory, then logs the removal in the
hash-linked audit array. Account reset also clears agreement records and private PDFs. The cleanup
commands are not migrations and must never be wired into startup or deployment.

Rollback is a full snapshot restore, not a reverse migration: stop the server, verify the desired
encrypted backup, set `SYSTEM_PRE_RESTORE_BACKUP_PATH` to preserve the current state, and run the restore
command above. Run `node backend/scripts/backup.js self-check` and `node backend/scripts/backup.js verify <backup>` before
relying on a backup. A restore rehearsal using a temporary JSON database, auxiliary data file, and
upload completed successfully; rehearse again on the production host and storage filesystem before cleanup.

## Phase 3 system agreement data and codes

Agreement V2 is opt-in and defaults off (`SYSTEM_AGREEMENTS_V2=0`). It stores records in the new
`systemAgreements` JSON collection; the existing legacy `agreements` collection and routes are not
modified by this migration. No legacy agreement rows are backfilled.

With the server stopped, inject `SYSTEM_BACKUP_KEY`, set a unique outside-app `SYSTEM_BACKUP_PATH`, and
set `ENABLE_SCHEMA_MIGRATIONS=1` only for this operator command:

```bash
node scripts/migrate.js up 001-system-agreements
```

The migration adds an empty agreement collection, counter, and migration journal entry. It can be
reversed while that collection is empty, using another unique encrypted backup and:

```bash
node scripts/migrate.js down 001-system-agreements
```

To enable issuance after the migration, provision `AGREEMENT_CODE_HMAC_KEY` and `AGREEMENT_PDF_SEAL_KEY`
from the secret manager (each minimum 32 bytes), and set `AGREEMENT_VERIFY_BASE_URL` to a short HTTPS
base URL ending at the public `/a` verification route. Local development may use an HTTP loopback URL
such as `http://127.0.0.1:3000/a`; these QR links work only on that same machine. Production always
requires HTTPS. The current QR generator requires the complete verification URL to fit within 53 bytes.
Then set `SYSTEM_AGREEMENTS_V2=1` and restart. `AGREEMENT_PENDING_TTL_DAYS`
defaults to 30 and accepts 1–90 days. The authenticated member endpoints are `POST /api/me/system-agreements`
and `GET /api/me/system-agreements/current`; they use the logged-in member identity and do not accept
client-provided agreement content, member IDs, or codes. With V2 enabled, new member registrations receive
a pending agreement when created. Codes contain 128 bits from a CSPRNG and a
full HMAC-SHA256 checksum. Repeated issuance returns the active pending code for that same member;
expired records are marked `EXPIRED`, and a later issue links to the prior record as a new version.

V2 generates a controlled PDF at `GET /api/me/system-agreements/current.pdf`, includes the current
member profile and a required JPEG or supported PNG photo, adds a QR link to public `GET /a/:token`
verification (status/date only), embeds the code and HMAC seal in PDF metadata, and records the
generated SHA-256 hash. It adds named AcroForm fields including the fixed `member_signature_v1`
signature widget. The HMAC seals canonical template data; this is not a PAdES certificate signature.
Keep the feature flag off until the migration and all signing keys/URL settings are available. Turning it off
immediately hides the V2 endpoints; down migration is safe only before any V2 agreement records exist.

For signed V2 uploads, provision `AGREEMENT_STORAGE_KEY` as 64 hex characters from the secret manager.
The original and signed PDFs are AES-256-GCM encrypted in `data/private-agreements` with mode 0600 files;
they are never served from `/uploads`. The key must be backed up securely because losing it makes those
files unreadable. Install Poppler `pdfinfo`/`pdftoppm`, ZBar `zbarimg`, and ClamAV `clamscan` on the server
(or set `PDFINFO_BIN`, `PDFTOPPM_BIN`, `AGREEMENT_QRSCAN_BIN`, and `AGREEMENT_CLAMSCAN_BIN` to their
executable paths). Uploads fail closed if a required verifier/scanner is unavailable.
`POST /api/me/system-agreements/current.pdf` accepts one `application/pdf` body or one PDF multipart file,
max 8 MB. Members may print the generated one-page agreement, sign by hand, scan it upright, and upload
the scan. The system checks for ink in the signature area and decodes the QR to confirm it belongs to
that member's current system-generated agreement. Annotated PDFs that preserve the original generated
PDF and its seal are also accepted. Empty or unrelated documents, altered original PDFs, and PDFs with
active content are rejected. Accepted uploads must pass ClamAV; on success the status becomes `SIGNED`,
the encrypted file hash and signing time/IP/user agent are stored, and the member can download the stored
PDF at `GET /api/me/system-agreements/current.signed.pdf`.

Agreement status views are role-scoped and read-only: `GET /api/ga/system-agreements` returns only
codes, statuses, group, and dates for the signed-in Group Admin's own group; the corresponding routes
under `/api/admin`, `/api/sa`, and `/api/vsa` return the same metadata across groups to those roles.
None returns member IDs, names, contact details, profile snapshots, or files. Each view is audited.
Notification records created by the system now carry recipient role/ID, group, sender, and read-time
fields. Reads are filtered in the data layer, owners and Super Admins do not see admin/security
notifications, Group Admins cannot read notifications from another group, and list/read/denial access
is audited. Legacy notifications remain visible only to their original direct recipient; historical
owner/security and owner email feed entries are hidden from Owner and Super Admin notification lists.

Chat authorization is enforced by one server policy for REST and WebSocket events. Members may contact
only their own active Group Admin; Group Admins may contact active members in their group and Admins;
Admins may contact other Admins and Group Admins. Member-to-member chats are disabled, and the Owner
and Super Admin have no chat contacts or conversation access. The existing browser E2E AES-GCM
ciphertext format remains in use; attachments are not supported. WebSocket upgrades require a same-origin
Origin and a live session cookie, allow at most four connections per user, and are rechecked for session,
role, group, and account changes every two seconds. Logout, session revocation, group suspension, and
account changes close affected sockets. REST sends are limited to 60/minute per network; WebSocket
payloads are capped at 64 KiB with event rate limits. `CHAT_RETENTION_DAYS` defaults to 365 (allowed
range 1–3650), with a 1000-connection server limit configurable through `WS_MAX_CONNECTIONS`; messages
older than the configured period are hidden immediately and purged by the
daily retention job with an audit entry. Message sends, call invitations/endings, denied access, and
history/contact reads are audited without recording message plaintext. REST and WebSocket event limits
are keyed by user ID.

Verify the realtime layer and security at any time:

```bash
# realtime sockets + video-call signaling (with the server running and test accounts provisioned):
TEST_MEMBER_EMAIL='<member email>' TEST_MEMBER_PW='<member pw>' \
TEST_GA_EMAIL='<group admin email>' TEST_GA_PW='<group admin pw>' \
TEST_VSA_EMAIL='<owner email>' TEST_VSA_PW='<owner pw>' node socket-test.js
# security audit (16 checks):
python3 security_audit.py --base http://127.0.0.1:3000
```

## Flows
cl
- **Registration** requires: First Name, Last Name, Email, Phone Number, Password, Confirm Password **+ Safe Code**.
- **Login** requires Email + Password. **4 wrong passwords ⇒ account locked**; the **Owner**
  unlocks/re-enables it (Locked Accounts tab) and can also disable any login.
- **No account?** → *Request a safe code* page; the **Group Admin approves the request and generates
  a one-time safe code**, which is emailed (when SMTP is configured) and shown to the admin.
- The **safe-code gate can be turned ON/OFF by the V Super Admin** (Safe Codes tab).
- **Chat:** members ↔ their own Group Admin, plus Owner/Super Admin/Admin/Group Admin administrative
  conversations, **end-to-end encrypted** (ECDH P-256 → AES-256-GCM; private keys stay in browsers).
- **Video calls:** browser WebRTC, member ↔ group admin of the same group, registered users only.
  Use `localhost`/`127.0.0.1` or HTTPS (browsers require a secure context for camera/mic).
- **Email notifications for the Owner:** registrations, access requests, safe-code events,
  lockouts/resets, account deletes, settings changes, report downloads. A configured `TEAMS_WEBHOOK_URL`
  also receives an alert after an account reaches four failed logins. Without SMTP
  they are captured in the VSA **Notifications / Email Outbox**; with SMTP (`SMTP_URL` / `SMTP_HOST`…)
  they are really sent.
- **Security monitor:** starts with the server, alerts the Owner and all admin roles on authorization
  denials and after every four failed logins from one IP in a rolling 15-minute window. Configure SMTP
  for email delivery. Detection is deterministic; no external AI provider is configured.
- **Owner** can create up to two Super Admins and two read-only Admins, manage users/groups, verify
  financial reports, **reset account passwords**, and download authorized reports as PDF or CSV.
- Group Admins issue safe codes for member self-registration and verify reported savings, registration fees, loan disbursements, and
  repayments. Only verified savings count toward borrowing limits. New cash loans are principal-only,
  due 14 days after disbursement, with one separate 1% principal fine after the due date.
- Group Admins price weekly items and can classify required Cap/T-shirt items. Members see their own
  item status and only their own account details.
- Every account has an **uploadable profile picture** (PNG/JPG/WEBP ≤ 2MB, magic-byte verified).

## Enforced security measures (X100 hardening checklist)

1. Salted **scrypt** password hashing + constant-time compare
2. Password policy: **≥ 9 chars** + upper/lower/digit/symbol (client + server)
3. **4-strike account lockout** (auto email to VSA)
4. IP **rate limiting** (login 12/10 min, register/request 30/h, API 300/min default, chat 240/min)
5. **HttpOnly + SameSite=Lax** session cookies (Secure in production), sessions killed on reset/delete
6. **CSRF:** mutations require a matching Origin or Referer; missing and cross-origin sources are rejected
7. **RBAC** enforced server-side on every route + server-side dashboard page guards
8. Security headers: **CSP** (no inline scripts), nosniff, frame-deny, referrer, permissions-policy, COOP/CORP (+HSTS on HTTPS)
9. **E2E encrypted chat** (AES-256-GCM per member–admin pair) — server stores ciphertext only
10. Passwords are stored as salted scrypt hashes only; they cannot be revealed by administrators
11. Input validation + output encoding everywhere (names/emails/phone whitelists; DOM built with `textContent`)
12. **Upload allow-list** (real image magic bytes), size cap, random filenames, upload sandbox CSP
13. Path-traversal protection on static/uploads; no directory listing
14. Full **audit trail** + Owner re-authentication for sensitive group, account, and export actions

> "Zero vulnerability" cannot be honestly guaranteed by any system. The 14 controls above and the
> 16-check `security_audit.py` provide useful verification, not proof of security. Run the audit after
> every release and review its skipped checks.

### Run the audit

```bash
python3 security_audit.py --base http://127.0.0.1:3000 \
  --email '<member email>' --password '<member pw>' \
  --vsa-email '<owner email>' --vsa-password '<owner pw>'
```

(The lockout test locks the given member — unlock it from the VSA dashboard after.)

Group Admin accounts are created by Super Admins. Groups are created by the Owner; Super Admins may
rename or suspend them. Group suspensions block member and staff access until the Owner restores the
group.

## Phase 9 automated checks

Run the isolated unit suite with:

```bash
npm test
npm run check
```

The Node test suite uses a temporary JSON data directory and removes it after the run; it does not
modify `data/db.json`. It covers agreement-code integrity, forged/modified/unsigned PDF rejection,
chat role/group combinations, notification recipient scoping, safe-user projection, and middleware
registration. The upload tests exercise structural/signature rejection paths; a staging deployment
still needs integration checks with real `pdfsig` and ClamAV binaries. Run the existing live server
security and socket checks only against dedicated test accounts as described above.

## Production checklist

- Terminate TLS at a maintained reverse proxy; bind the app to `127.0.0.1`, set `NODE_ENV=production`
  and `TRUST_PROXY=1` only when that proxy overwrites forwarded headers. Do not expose the Node port.
- Reference deployment templates: [Nginx TLS proxy](deploy/nginx/vondonald.conf) and [systemd service](deploy/systemd/vondonald.service).
- Replace the Nginx example hostname and certificate paths with the real HTTPS domain. Register
  `https://YOUR_DOMAIN/api/auth/google/callback` as the OAuth client's exact redirect URI and inject
  the Google and Twilio Verify secrets listed above. Production startup intentionally fails if
  Google OIDC or phone OTP is missing.
- Inject Owner bootstrap, SMTP, and Teams secrets from a secret manager; do not copy real values into
  `.env.example`, source control, logs, or shell history. Verify SMTP delivery and lockout alerts.
- Keep `database/data/` and `database/uploads/` on restricted persistent storage, inject the database key from a secret
  manager, and keep encrypted backups and backup keys separately. Existing plaintext
  data must be migrated before this release starts; the runtime rejects an unencrypted database.
- **Production blocker:** although AES-GCM at-rest encryption is enforced, the JSON store remains
  single-process without transactional multi-writer guarantees. Do not accept real financial traffic
  until storage is migrated to a reviewed transactional design and concurrency behavior is validated.
- Production deployment is not complete for local-only installations: HTTPS domain, Google OAuth
  credentials, Twilio Verify credentials, live SMTP, TLS certificates, and a transactional database
  are required. Validate SMS delivery, Google callback, account linking, OTP lockout/expiry, backups,
  and restore behavior in a separate staging environment before opening member access.
- The live security audit, socket checks, staging restore rehearsal, and staging checks with real
  `pdfsig` and ClamAV binaries remain outstanding. Run them with dedicated test accounts and staging
  data; the lockout audit mutates its test account and must never target a live member account.
- Set `TEAMS_WEBHOOK_URL` to enable Teams security alerts. No AI provider is configured; the built-in
  security monitor uses deterministic rules.
# Donald
