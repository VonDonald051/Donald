<?php
declare(strict_types=1);

namespace VonDonald\System;

/** Temporary bridge to the Node.js Vercel Function for legacy s2$ scrypt hashes. */
final class LegacyPasswordVerifier
{
    public static function verify(string $password, string $hash): bool
    {
        if (!preg_match('/^s2\$[a-f0-9]{32}\$[a-f0-9]{128}$/i', $hash) || strlen($password) > 4096) return false;
        if (!function_exists('curl_init')) throw new \RuntimeException('cURL is required for legacy password verification.');
        $secret = getenv('LEGACY_SCRYPT_BRIDGE_SECRET');
        if (!is_string($secret) || strlen($secret) < 32) throw new \RuntimeException('LEGACY_SCRYPT_BRIDGE_SECRET is not configured.');
        $url = getenv('LEGACY_SCRYPT_VERIFY_URL');
        if (!$url) {
            $host = getenv('VERCEL_URL') ?: getenv('VERCEL_PROJECT_PRODUCTION_URL');
            if (!$host) throw new \RuntimeException('LEGACY_SCRYPT_VERIFY_URL or VERCEL_URL must be configured.');
            $url = 'https://' . preg_replace('#^https?://#i', '', rtrim($host, '/')) . '/api/legacy-scrypt-verify';
        }
        $payload = json_encode(['password' => $password, 'hash' => $hash], JSON_THROW_ON_ERROR);
        $parts = parse_url($url);
        if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host'])) {
            throw new \RuntimeException('Legacy password verifier URL must be an absolute HTTP(S) URL.');
        }
        $origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        $ch = curl_init($url);
        if ($ch === false) throw new \RuntimeException('Unable to initialize legacy password verifier.');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Origin: ' . $origin, 'X-Legacy-Scrypt-Bridge: ' . $secret],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        try {
            $response = curl_exec($ch);
            $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            if (!is_string($response) || $status !== 200) throw new \RuntimeException('Legacy password verifier is unavailable.');
            $decoded = json_decode($response, true, 8, JSON_THROW_ON_ERROR);
            return is_array($decoded) && ($decoded['verified'] ?? false) === true;
        } catch (\JsonException $e) {
            throw new \RuntimeException('Legacy password verifier returned an invalid response.', 0, $e);
        } finally {
            curl_close($ch);
        }
    }
}
