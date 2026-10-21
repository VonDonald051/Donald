<?php
declare(strict_types=1);

namespace VonDonald\System;

final class Config
{
    private static bool $loaded = false;

    public static function root(): string
    {
        return dirname(__DIR__, 2);
    }

    public static function load(): void
    {
        if (self::$loaded) return;
        self::$loaded = true;
        $file = self::root() . '/.env';
        if (!is_file($file)) return;
        $stat = lstat($file);
        if ($stat === false || is_link($file) || (($stat['mode'] & 0077) !== 0)) {
            throw new \RuntimeException('Local .env must be a regular file restricted to its owner (chmod 600 .env).');
        }
        $allowed = [
            'DB_ENCRYPTION_KEY', 'DATABASE_URL', 'NODE_ENV', 'LOGIN_PHONE_OTP_ENABLED',
            'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID',
            'LEGACY_SCRYPT_BRIDGE_SECRET', 'LEGACY_SCRYPT_VERIFY_URL',
            'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
        ];
        $lines = file($file, FILE_IGNORE_NEW_LINES);
        if ($lines === false) throw new \RuntimeException('Unable to read private .env file.');
        foreach ($allowed as $name) {
            if (getenv($name) !== false) continue;
            $matches = [];
            foreach ($lines as $line) {
                if (preg_match('/^\s*(?:export\s+)?' . preg_quote($name, '/') . '\s*=/', $line)) $matches[] = $line;
            }
            if (count($matches) > 1) throw new \RuntimeException("Local .env contains multiple {$name} entries.");
            if (!$matches) continue;
            $value = preg_replace('/^\s*(?:export\s+)?' . preg_quote($name, '/') . '\s*=\s*/', '', $matches[0]);
            $value = trim((string)$value);
            if (preg_match('/^(?:"([^"]*)"|\'([^\']*)\')(?:\s+#.*)?$/', $value, $m)) $value = $m[1] !== '' ? $m[1] : ($m[2] ?? '');
            else $value = trim((string)preg_replace('/\s+#.*$/', '', $value));
            putenv($name . '=' . $value);
            $_ENV[$name] = $value;
        }
    }

    public static function encryptionKey(): string
    {
        self::load();
        $key = getenv('DB_ENCRYPTION_KEY');
        if (!is_string($key) || !preg_match('/^[a-f0-9]{64}$/i', $key)) {
            throw new \RuntimeException('DB_ENCRYPTION_KEY must be provided as 64 hexadecimal characters.');
        }
        $decoded = hex2bin($key);
        if ($decoded === false || strlen($decoded) !== 32) throw new \RuntimeException('Invalid DB_ENCRYPTION_KEY.');
        return $decoded;
    }

    public static function dataFile(): string
    {
        $configured = getenv('VONDONALD_DATA_DIR');
        $dir = $configured ? rtrim($configured, DIRECTORY_SEPARATOR) : self::root() . '/database/data';
        return $dir . '/db.json';
    }
}
