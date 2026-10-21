<?php
declare(strict_types=1);

namespace VonDonald\System;

/** Reads and writes the existing Node-compatible VDB1 AES-256-GCM envelope. */
final class EncryptedJsonStore
{
    private const MAGIC = 'VDB1';

    /** @return array<string,mixed> */
    public static function load(): array
    {
        if (getenv('DATABASE_URL')) return PostgresJsonStore::load();
        $path = Config::dataFile();
        if (!is_file($path)) throw new \RuntimeException("Database file does not exist: {$path}");
        $handle = fopen($path, 'rb');
        if ($handle === false) throw new \RuntimeException('Unable to open encrypted database.');
        try {
            if (!flock($handle, LOCK_SH)) throw new \RuntimeException('Unable to lock encrypted database for reading.');
            $bytes = stream_get_contents($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
        if (!is_string($bytes) || strlen($bytes) < 32 || substr($bytes, 0, 4) !== self::MAGIC) {
            throw new \RuntimeException('Database is not a valid encrypted VDB1 envelope.');
        }
        $plain = openssl_decrypt(substr($bytes, 32), 'aes-256-gcm', Config::encryptionKey(), OPENSSL_RAW_DATA, substr($bytes, 4, 12), substr($bytes, 16, 16));
        if ($plain === false) throw new \RuntimeException('Database authentication failed; check the encryption key and file integrity.');
        try { $data = json_decode($plain, true, 512, JSON_THROW_ON_ERROR); }
        catch (\JsonException $e) { throw new \RuntimeException('Decrypted database is invalid JSON.', 0, $e); }
        if (!is_array($data) || !isset($data['users']) || !is_array($data['users'])) throw new \RuntimeException('Decrypted database has an invalid structure.');
        return $data;
    }

    /** @param array<string,mixed> $data */
    public static function save(array $data): void
    {
        if (!isset($data['users']) || !is_array($data['users'])) throw new \InvalidArgumentException('Refusing to save invalid database data.');
        if (getenv('DATABASE_URL')) { PostgresJsonStore::save($data); return; }
        $path = Config::dataFile();
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new \RuntimeException('Unable to create the data directory.');
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($json, 'aes-256-gcm', Config::encryptionKey(), OPENSSL_RAW_DATA, $iv, $tag);
        if ($cipher === false || strlen($tag) !== 16) throw new \RuntimeException('Unable to encrypt database data.');
        $envelope = self::MAGIC . $iv . $tag . $cipher;
        $lock = fopen($path . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) throw new \RuntimeException('Unable to lock encrypted database for writing.');
        $temp = tempnam($dir, '.db-');
        try {
            if ($temp === false) throw new \RuntimeException('Unable to create a temporary database file.');
            chmod($temp, 0600);
            if (file_put_contents($temp, $envelope, LOCK_EX) !== strlen($envelope)) throw new \RuntimeException('Unable to write the encrypted database.');
            if (!rename($temp, $path)) throw new \RuntimeException('Unable to atomically replace the encrypted database.');
            chmod($path, 0600);
        } finally {
            if (isset($temp) && is_string($temp) && is_file($temp)) unlink($temp);
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
