<?php
declare(strict_types=1);

namespace VonDonald\System;

final class AuthService
{
    private static function now(): string { return gmdate('Y-m-d\\TH:i:s.v\\Z'); }

    private static function clientIp(Request $request): string
    {
        $forwarded = getenv('VERCEL') === '1' ? (string)($request->headers['x-forwarded-for'] ?? '') : '';
        $ip = trim(explode(',', $forwarded)[0] ?? '');
        if ($ip === '') $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
        return substr($ip, 0, 80);
    }

    private static function audit(array &$db, ?array $actor, string $action, string $target, Request $request): void
    {
        $db['audit'] ??= [];
        $db['counters'] ??= [];
        $id = (int)($db['counters']['audit'] ?? 0) + 1;
        $db['counters']['audit'] = $id;
        $previous = $db['audit'] ? end($db['audit']) : null;
        $entry = [
            'id' => $id, 'actor' => $actor['id'] ?? null, 'actorRole' => $actor['role'] ?? null,
            'action' => substr($action, 0, 80), 'target' => substr($target, 0, 160),
            'ip' => self::clientIp($request), 'at' => self::now(),
            'prevHash' => is_array($previous) ? hash('sha256', json_encode($previous, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)) : null,
            'hash' => null,
        ];
        $entry['hash'] = hash('sha256', json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
        $db['audit'][] = $entry;
        if (count($db['audit']) > 5000) $db['audit'] = array_slice($db['audit'], -5000);
        EncryptedJsonStore::save($db);
    }

    private static function rateLimit(array &$db, Request $request): void
    {
        $db['phpLoginRates'] ??= [];
        $now = time();
        foreach ($db['phpLoginRates'] as $key => $entry) if (($entry['until'] ?? 0) <= $now) unset($db['phpLoginRates'][$key]);
        $key = hash('sha256', self::clientIp($request));
        $entry = $db['phpLoginRates'][$key] ?? ['count' => 0, 'until' => $now + 60];
        if ($entry['until'] <= $now) $entry = ['count' => 0, 'until' => $now + 60];
        if ($entry['count'] >= 20) throw new HttpException(429, 'Too many sign-in attempts. Try again in a minute.');
        $entry['count']++;
        $db['phpLoginRates'][$key] = $entry;
    }

    private static function cookie(string $name, string $value, int $maxAge, bool $httpOnly = true): void
    {
        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
        setcookie($name, $value, ['expires' => time() + $maxAge, 'path' => '/', 'secure' => $secure, 'httponly' => $httpOnly, 'samesite' => 'Lax']);
    }

    private static function maskPhone(string $phone): string
    {
        $digits = preg_replace('/\D/', '', $phone) ?? '';
        return '+' . str_repeat('*', max(0, strlen($digits) - 4)) . substr($digits, -4);
    }

    private static function twilio(array $fields, string $operation): array
    {
        $sid = trim((string)getenv('TWILIO_ACCOUNT_SID'));
        $token = trim((string)getenv('TWILIO_AUTH_TOKEN'));
        $service = trim((string)getenv('TWILIO_VERIFY_SERVICE_SID'));
        if (!preg_match('/^AC[a-f0-9]{32}$/i', $sid) || $token === '' || !preg_match('/^VA[a-f0-9]{32}$/i', $service)) throw new \RuntimeException('Phone verification is not configured.');
        $url = 'https://verify.twilio.com/v2/Services/' . rawurlencode($service) . '/' . $operation;
        $curl = curl_init($url);
        if ($curl === false) throw new \RuntimeException('Phone verification service is unavailable.');
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($fields, '', '&', PHP_QUERY_RFC3986),
            CURLOPT_USERPWD => $sid . ':' . $token,
            CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        ]);
        try {
            $raw = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            if (!is_string($raw) || $status < 200 || $status >= 300) throw new \RuntimeException('Phone verification service is unavailable.');
            $decoded = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
            return is_array($decoded) ? $decoded : [];
        } catch (\JsonException $error) {
            throw new \RuntimeException('Phone verification service returned an invalid response.', 0, $error);
        } finally { curl_close($curl); }
    }

    private static function roleHome(string $role): string
    {
        return match ($role) {
            'v_super_admin' => '/app/vsa', 'super_admin' => '/app/sa', 'admin' => '/app/admin',
            'group_admin' => '/app/ga', 'member' => '/app/member', default => '/login.html',
        };
    }

    /** @return array<string,mixed> */
    public static function login(array &$db, Request $request): array
    {
        self::rateLimit($db, $request);
        $email = strtolower(trim(substr(preg_replace('/[\x00-\x1f\x7f]/', '', (string)($request->body['email'] ?? '')) ?? '', 0, 120)));
        $password = (string)($request->body['password'] ?? '');
        if (strlen($password) > 4096) throw new HttpException(401, 'Invalid email or password.');
        $userIndex = null;
        foreach (($db['users'] ?? []) as $index => $user) if (($user['email'] ?? '') === $email && empty($user['deleted'])) { $userIndex = $index; break; }
        if ($userIndex === null) {
            self::audit($db, null, 'login.failed.unknown', $email, $request);
            throw new HttpException(401, 'Invalid email or password.');
        }
        $user =& $db['users'][$userIndex];
        if (!empty($user['disabled'])) throw new HttpException(423, 'This account has been disabled. Contact the V Super Admin.');
        if (!empty($user['locked'])) throw new HttpException(423, 'Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it.');

        $stored = (string)($user['passHash'] ?? '');
        if (preg_match('/^\$2[aby]\$/', $stored)) $valid = password_verify($password, $stored);
        elseif (preg_match('/^s2\$[a-f0-9]{32}\$[a-f0-9]{128}$/i', $stored)) $valid = LegacyPasswordVerifier::verify($password, $stored);
        else $valid = false;
        if (!$valid) {
            $user['failed'] = (int)($user['failed'] ?? 0) + 1;
            $locked = $user['failed'] >= 4;
            if ($locked) $user['locked'] = true;
            self::audit($db, $user, $locked ? 'login.locked' : 'login.failed', $email, $request);
            if ($locked) throw new HttpException(423, 'Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it.');
            throw new HttpException(401, 'Invalid email or password (' . (4 - $user['failed']) . ' attempt(s) left before lockout).');
        }

        // Upgrade the legacy scrypt record at successful authentication.
        if (str_starts_with($stored, 's2$')) $user['passHash'] = password_hash($password, PASSWORD_DEFAULT);
        $remember = !empty($request->body['remember']);
        if (getenv('LOGIN_PHONE_OTP_ENABLED') === '1' || getenv('NODE_ENV') === 'production') {
            if (!preg_match('/^\+[1-9]\d{7,14}$/', (string)($user['phone'] ?? ''))) throw new HttpException(503, 'Your account needs an international phone number. Contact an administrator.');
            try { self::twilio(['To' => $user['phone'], 'Channel' => 'sms'], 'Verifications'); }
            catch (\Throwable) { throw new HttpException(503, 'Phone verification is unavailable. Contact the system administrator.'); }
            $id = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
            $db['phoneChallenges'] ??= [];
            $db['phoneChallenges'][] = ['id' => $id, 'userId' => (int)$user['id'], 'phone' => $user['phone'], 'remember' => $remember, 'ip' => self::clientIp($request), 'expires' => (int)(microtime(true) * 1000) + 600000, 'attempts' => 0];
            $db['phoneChallenges'] = array_values(array_filter($db['phoneChallenges'], static fn($c) => ($c['expires'] ?? 0) > (int)(microtime(true) * 1000)));
            self::cookie('phone_challenge', $id, 600);
            EncryptedJsonStore::save($db);
            return ['phoneVerification' => true, 'expires' => (int)(microtime(true) * 1000) + 600000, 'phone' => self::maskPhone((string)$user['phone'])];
        }
        return self::createSession($db, $user, $remember, 'password', $request);
    }

    /** @return array<string,mixed> */
    private static function createSession(array &$db, array &$user, bool $remember, string $method, Request $request): array
    {
        $user['failed'] = 0;
        $token = bin2hex(random_bytes(32));
        $ttl = $remember ? 30 * 86400000 : 8 * 3600000;
        $db['sessions'] ??= [];
        $db['sessions'][] = ['token' => $token, 'userId' => $user['id'], 'remember' => $remember, 'loginMethod' => $method, 'ua' => substr((string)($request->headers['user-agent'] ?? ''), 0, 150), 'ip' => self::clientIp($request), 'createdAt' => (int)(microtime(true) * 1000), 'expires' => (int)(microtime(true) * 1000) + $ttl];
        self::cookie('sid', $token, (int)ceil($ttl / 1000));
        EncryptedJsonStore::save($db);
        self::audit($db, $user, 'login.success.' . $method, (string)$user['email'], $request);
        return ['ok' => true, 'role' => $user['role'], 'home' => self::roleHome((string)$user['role']), 'passwordChangeRequired' => !empty($user['passwordChangeRequired'])];
    }

    /** @return array<string,mixed> */
    public static function verifyPhone(array &$db, Request $request): array
    {
        $id = (string)($_COOKIE['phone_challenge'] ?? '');
        $ip = self::clientIp($request);
        $index = null;
        foreach (($db['phoneChallenges'] ?? []) as $i => $challenge) if (isset($challenge['id']) && hash_equals((string)$challenge['id'], $id)) { $index = $i; break; }
        if ($index === null) throw new HttpException(401, 'That passcode is invalid or expired. Check it and try again.');
        $challenge =& $db['phoneChallenges'][$index];
        $remember = !empty($challenge['remember']);
        $now = (int)(microtime(true) * 1000);
        if (($challenge['expires'] ?? 0) <= $now || ($challenge['ip'] ?? '') !== $ip || ($challenge['attempts'] ?? 0) >= 5) {
            unset($db['phoneChallenges'][$index]); EncryptedJsonStore::save($db);
            throw new HttpException(401, 'That passcode is invalid or expired. Check it and try again.');
        }
        $code = trim((string)($request->body['code'] ?? ''));
        $challenge['attempts']++;
        if (!preg_match('/^\d{4,10}$/', $code)) { EncryptedJsonStore::save($db); throw new HttpException(401, 'That passcode is invalid or expired. Check it and try again.'); }
        try { $result = self::twilio(['Code' => $code, 'To' => $challenge['phone']], 'VerificationCheck'); }
        catch (\Throwable) { EncryptedJsonStore::save($db); throw new HttpException(503, 'Phone verification is temporarily unavailable. Please try again.'); }
        if (($result['status'] ?? '') !== 'approved') { EncryptedJsonStore::save($db); throw new HttpException(401, 'That passcode is invalid or expired. Check it and try again.'); }
        $userIndex = null;
        foreach (($db['users'] ?? []) as $i => $user) if ((int)($user['id'] ?? 0) === (int)$challenge['userId'] && empty($user['deleted'])) { $userIndex = $i; break; }
        unset($db['phoneChallenges'][$index]);
        $db['phoneChallenges'] = array_values($db['phoneChallenges']);
        self::cookie('phone_challenge', '', 0);
        if ($userIndex === null || !empty($db['users'][$userIndex]['disabled']) || !empty($db['users'][$userIndex]['locked'])) {
            EncryptedJsonStore::save($db);
            throw new HttpException(423, 'This account is unavailable. Contact the V Super Admin.');
        }
        $user =& $db['users'][$userIndex];
        return self::createSession($db, $user, $remember, 'password_phone', $request);
    }

    public static function logout(array &$db): void
    {
        $sid = (string)($_COOKIE['sid'] ?? '');
        $db['sessions'] = array_values(array_filter($db['sessions'] ?? [], static fn($session) => !hash_equals((string)($session['token'] ?? ''), $sid)));
        self::cookie('sid', '', 0);
        EncryptedJsonStore::save($db);
    }
}
