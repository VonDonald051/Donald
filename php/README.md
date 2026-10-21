# PHP migration

This directory is the start of the PHP replacement. The existing Node application
remains the active application until the PHP implementation reaches feature parity.
Do not point production traffic at this directory yet.

The PHP runtime targets PHP 8.2+ with OpenSSL, cURL, and PDO PostgreSQL. It can
read and write the existing VDB1 AES-256-GCM encrypted JSON store locally. On
Vercel, set `DATABASE_URL` to a PostgreSQL database: the encrypted VDB1 envelope
is stored in a single locked row, and `.vercelignore` keeps local database and
upload files out of the deployment. Set `DB_ENCRYPTION_KEY` in the deployment
environment; do not deploy `.env`.

## Current status

The shared data/configuration and request/security primitives are being ported
first. API routes, notification delivery, agreement/PDF workflows, WebSocket
chat/call signaling, dashboards, and operational scripts still need PHP ports.
The PHP entrypoint is not yet configured as the production Vercel route. Keep
using the current deployment until those components are migrated and verified.

Existing `s2$...` password records are Node `crypto.scrypt` hashes using a
16-byte salt. The temporary compatibility bridge is a rate-limited Node endpoint
for local development and `api/legacy-scrypt-verify.js` on Vercel. PHP calls it
using the shared `LEGACY_SCRYPT_BRIDGE_SECRET`. On successful legacy login, PHP
rehashes the password with `password_hash()` and persists the new hash, so the
bridge can later be removed. The local `.env` points to the loopback Node server;
in Vercel, leave `LEGACY_SCRYPT_VERIFY_URL` blank to use `VERCEL_URL`. Never send
credentials to a bridge URL outside the same trusted HTTPS deployment.

Before deploying PHP, import the existing encrypted database from a trusted
local environment with `DATABASE_URL` and `ENABLE_DATABASE_IMPORT=1` set, then
remove `ENABLE_DATABASE_IMPORT`. The import command refuses to overwrite an
existing state row. Uploads still need migration to private object storage before
the PHP application can replace the Node server on Vercel.
