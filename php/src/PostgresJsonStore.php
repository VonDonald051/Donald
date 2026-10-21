<?php
declare(strict_types=1);

namespace VonDonald\System;

/** External store for Vercel deployments; retains the encrypted VDB1 envelope. */
final class PostgresJsonStore
{
    private static ?\PDO $pdo = null;
    private static bool $requestTransaction = false;

    private static function connection(): \PDO
    {
        if (self::$pdo) return self::$pdo;
        $url = getenv('DATABASE_URL');
        if (!is_string($url) || $url === '') throw new \RuntimeException('DATABASE_URL is not configured.');
        $parts = parse_url($url);
        $scheme = is_array($parts) ? ($parts['scheme'] ?? '') : '';
        if (!is_array($parts) || !in_array($scheme, ['postgres', 'postgresql'], true)) throw new \RuntimeException('DATABASE_URL must be a PostgreSQL connection URL.');
        $host = (string)($parts['host'] ?? '');
        $port = (int)($parts['port'] ?? 5432);
        $database = ltrim((string)($parts['path'] ?? ''), '/');
        $user = rawurldecode((string)($parts['user'] ?? ''));
        $password = rawurldecode((string)($parts['pass'] ?? ''));
        if ($host === '' || $database === '' || $user === '') throw new \RuntimeException('DATABASE_URL is incomplete.');
        if (!extension_loaded('pdo_pgsql')) throw new \RuntimeException('The PHP pdo_pgsql extension is required for DATABASE_URL.');
        $dsn = 'pgsql:host=' . $host . ';port=' . $port . ';dbname=' . $database . ';sslmode=require';
        self::$pdo = new \PDO($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::ATTR_TIMEOUT => 5,
        ]);
        return self::$pdo;
    }

    /** @return array<string,mixed> */
    public static function load(): array
    {
        $row = self::connection()->query('SELECT payload FROM vondonald_state WHERE id = 1')->fetch();
        if (!$row || !isset($row['payload'])) throw new \RuntimeException('PostgreSQL state is empty; import the encrypted database before serving traffic.');
        $bytes = base64_decode((string)$row['payload'], true);
        if (!is_string($bytes)) throw new \RuntimeException('PostgreSQL encrypted state is invalid.');
        return self::decodeEnvelope($bytes);
    }

    public static function beginWriteRequest(): void
    {
        $pdo = self::connection();
        if ($pdo->inTransaction()) throw new \RuntimeException('Nested database write transaction.');
        $pdo->beginTransaction();
        self::$requestTransaction = true;
        try {
            if (!$pdo->query('SELECT id FROM vondonald_state WHERE id = 1 FOR UPDATE')->fetch()) {
                throw new \RuntimeException('PostgreSQL state row is missing.');
            }
        } catch (\Throwable $error) {
            self::finishWriteRequest(false);
            throw $error;
        }
    }

    public static function finishWriteRequest(bool $commit): void
    {
        if (!self::$requestTransaction || !self::$pdo) return;
        try {
            if (self::$pdo->inTransaction()) {
                if ($commit) self::$pdo->commit();
                else self::$pdo->rollBack();
            }
        } finally {
            self::$requestTransaction = false;
        }
    }

    /** @param array<string,mixed> $data */
    public static function save(array $data): void
    {
        if (!isset($data['users']) || !is_array($data['users'])) throw new \InvalidArgumentException('Refusing to save invalid database data.');
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($json, 'aes-256-gcm', Config::encryptionKey(), OPENSSL_RAW_DATA, $iv, $tag);
        if ($cipher === false || strlen($tag) !== 16) throw new \RuntimeException('Unable to encrypt database data.');
        $payload = base64_encode('VDB1' . $iv . $tag . $cipher);
        $pdo = self::connection();
        $ownTransaction = !$pdo->inTransaction();
        if ($ownTransaction) $pdo->beginTransaction();
        try {
            $statement = $pdo->prepare('UPDATE vondonald_state SET payload = :payload, updated_at = CURRENT_TIMESTAMP WHERE id = 1');
            $statement->execute(['payload' => $payload]);
            if ($statement->rowCount() !== 1) throw new \RuntimeException('PostgreSQL state row is missing.');
            if ($ownTransaction) $pdo->commit();
        } catch (\Throwable $error) {
            if ($ownTransaction && $pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
    }

    /** @return array<string,mixed> */
    private static function decodeEnvelope(string $bytes): array
    {
        if (strlen($bytes) < 32 || substr($bytes, 0, 4) !== 'VDB1') throw new \RuntimeException('Database is not a valid encrypted VDB1 envelope.');
        $plain = openssl_decrypt(substr($bytes, 32), 'aes-256-gcm', Config::encryptionKey(), OPENSSL_RAW_DATA, substr($bytes, 4, 12), substr($bytes, 16, 16));
        if ($plain === false) throw new \RuntimeException('Database authentication failed; check the encryption key and stored data integrity.');
        try { $data = json_decode($plain, true, 512, JSON_THROW_ON_ERROR); }
        catch (\JsonException $e) { throw new \RuntimeException('Decrypted database is invalid JSON.', 0, $e); }
        if (!is_array($data) || !isset($data['users']) || !is_array($data['users'])) throw new \RuntimeException('Decrypted database has an invalid structure.');
        return $data;
    }
}
