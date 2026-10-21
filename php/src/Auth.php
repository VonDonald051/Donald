<?php
declare(strict_types=1);

namespace VonDonald\System;

final class Auth
{
    /** @return array<string,mixed> */
    public static function requireUser(array $db): array
    {
        $sid = $_COOKIE['sid'] ?? '';
        if (!is_string($sid) || !preg_match('/^[a-f0-9]{64}$/', $sid)) throw new HttpException(401, 'Authentication required.');
        $session = null;
        foreach (($db['sessions'] ?? []) as $row) {
            if (is_array($row) && isset($row['token']) && hash_equals((string)$row['token'], $sid)) { $session = $row; break; }
        }
        if (!$session || (float)($session['expires'] ?? 0) < floor(microtime(true) * 1000)) throw new HttpException(401, 'Authentication required.');
        foreach (($db['users'] ?? []) as $user) {
            if (!is_array($user) || (int)($user['id'] ?? 0) !== (int)($session['userId'] ?? -1) || !empty($user['deleted'])) continue;
            if (!empty($user['disabled'])) throw new HttpException(423, 'Account disabled by V Super Admin.');
            $groupId = $user['groupId'] ?? null;
            if ($groupId !== null && ($user['role'] ?? '') !== 'v_super_admin') {
                foreach (($db['groups'] ?? []) as $group) {
                    if ((int)($group['id'] ?? 0) === (int)$groupId && !empty($group['suspended'])) throw new HttpException(423, 'This group is suspended. Contact the system Owner.');
                }
            }
            return $user;
        }
        throw new HttpException(401, 'Authentication required.');
    }

    public static function requireRole(array $user, string ...$roles): void
    {
        if (!in_array($user['role'] ?? '', $roles, true)) throw new HttpException(403, 'Forbidden: insufficient role.');
    }

    public static function protectMutation(Request $request): void
    {
        if (in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true)) return;
        if (($request->headers['x-requested-with'] ?? '') !== 'XMLHttpRequest') throw new HttpException(403, 'Request rejected.',);
        $origin = $request->headers['origin'] ?? '';
        $referer = $request->headers['referer'] ?? '';
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        $candidate = $origin !== '' ? $origin : $referer;
        if ($candidate === '') throw new HttpException(403, 'Request origin is required.');
        $parts = parse_url($candidate);
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $expected = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' ? 'https' : 'http';
        if (!is_array($parts) || $scheme !== $expected) throw new HttpException(403, 'Request origin does not match this server.');
        $requestHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        $originHost = strtolower((string)($parts['host'] ?? ''));
        $requestPort = null;
        if (preg_match('/^(.+):(\d+)$/', $requestHost, $match) && !str_ends_with($match[1], ']')) {
            $requestHost = $match[1]; $requestPort = (int)$match[2];
        } elseif (preg_match('/^\[(.+)\]:(\d+)$/', $requestHost, $match)) {
            $requestHost = '[' . strtolower($match[1]) . ']'; $requestPort = (int)$match[2];
        }
        $originPort = isset($parts['port']) ? (int)$parts['port'] : ($scheme === 'https' ? 443 : 80);
        $effectiveRequestPort = $requestPort ?? ($expected === 'https' ? 443 : 80);
        if ($originHost !== $requestHost || $originPort !== $effectiveRequestPort) throw new HttpException(403, 'Request origin does not match this server.');
    }
}
