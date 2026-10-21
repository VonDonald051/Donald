<?php
declare(strict_types=1);

require_once __DIR__ . '/src/Config.php';
require_once __DIR__ . '/src/EncryptedJsonStore.php';

use VonDonald\System\Config;

if (PHP_SAPI !== 'cli') { http_response_code(404); exit(1); }
if (!getenv('DATABASE_URL')) { fwrite(STDERR, "DATABASE_URL must be set in the environment.\n"); exit(2); }
if (getenv('ENABLE_DATABASE_IMPORT') !== '1') { fwrite(STDERR, "Set ENABLE_DATABASE_IMPORT=1 for the planned migration window.\n"); exit(2); }

try {
    $bytes = file_get_contents(Config::dataFile());
    if (!is_string($bytes) || strlen($bytes) < 32 || substr($bytes, 0, 4) !== 'VDB1') throw new RuntimeException('Local database is not an encrypted VDB1 file.');
    $plain = openssl_decrypt(substr($bytes, 32), 'aes-256-gcm', Config::encryptionKey(), OPENSSL_RAW_DATA, substr($bytes, 4, 12), substr($bytes, 16, 16));
    if ($plain === false) throw new RuntimeException('Local database authentication failed.');
    $data = json_decode($plain, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data) || !isset($data['users']) || !is_array($data['users'])) throw new RuntimeException('Local database structure is invalid.');
    $url = parse_url((string)getenv('DATABASE_URL'));
    if (!is_array($url) || !in_array($url['scheme'] ?? '', ['postgres', 'postgresql'], true)) throw new RuntimeException('DATABASE_URL must be PostgreSQL.');
    if (!extension_loaded('pdo_pgsql')) throw new RuntimeException('pdo_pgsql is required.');
    $dsn = 'pgsql:host=' . ($url['host'] ?? '') . ';port=' . ($url['port'] ?? 5432) . ';dbname=' . ltrim((string)($url['path'] ?? ''), '/') . ';sslmode=require';
    $pdo = new PDO($dsn, rawurldecode((string)($url['user'] ?? '')), rawurldecode((string)($url['pass'] ?? '')), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('CREATE TABLE IF NOT EXISTS vondonald_state (id SMALLINT PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    if ($pdo->query('SELECT 1 FROM vondonald_state WHERE id = 1')->fetchColumn() !== false) throw new RuntimeException('PostgreSQL state already exists; refusing to overwrite it.');
    $insert = $pdo->prepare('INSERT INTO vondonald_state (id, payload) VALUES (1, :payload)');
    $insert->execute(['payload' => base64_encode($bytes)]);
    fwrite(STDOUT, 'Encrypted state imported; users=' . count($data['users']) . ', bytes=' . strlen($bytes) . PHP_EOL);
} catch (Throwable $error) {
    fwrite(STDERR, 'Import failed: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
