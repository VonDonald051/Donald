<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/Config.php';
require_once dirname(__DIR__) . '/src/EncryptedJsonStore.php';
require_once dirname(__DIR__) . '/src/Request.php';
require_once dirname(__DIR__) . '/src/Auth.php';
require_once dirname(__DIR__) . '/src/PostgresJsonStore.php';
require_once dirname(__DIR__) . '/src/LegacyPasswordVerifier.php';
require_once dirname(__DIR__) . '/src/AuthService.php';

use VonDonald\System\Auth;
use VonDonald\System\AuthService;
use VonDonald\System\Config;
use VonDonald\System\EncryptedJsonStore;
use VonDonald\System\HttpException;
use VonDonald\System\Request;

function sendFile(string $path, string $contentType, string $cache = 'public, max-age=3600'): never
{
    if (!is_file($path) || !is_readable($path)) respond(404, ['error' => 'Not found.']);
    header('Content-Type: ' . $contentType);
    header('Cache-Control: ' . $cache);
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
}

function respond(int $status, array $body): never
{
    \VonDonald\System\PostgresJsonStore::finishWriteRequest($status >= 200 && $status < 500);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

foreach ([
    'X-Content-Type-Options' => 'nosniff', 'X-Frame-Options' => 'DENY',
    'Referrer-Policy' => 'no-referrer', 'Permissions-Policy' => 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy' => 'same-origin', 'Cross-Origin-Resource-Policy' => 'same-origin',
    'Content-Security-Policy' => "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://images.unsplash.com; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
] as $name => $value) header($name . ': ' . $value);

try {
    $request = new Request();
    Auth::protectMutation($request);
    if (!in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true) && getenv('DATABASE_URL')) {
        \VonDonald\System\PostgresJsonStore::beginWriteRequest();
    }
    if ($request->path === '/api/health' && $request->method === 'GET') respond(200, ['ok' => true]);
    if ($request->path === '/api/auth/groups' && $request->method === 'GET') {
        $db = EncryptedJsonStore::load();
        $groups = array_values(array_map(static fn($group) => ['id' => $group['id'], 'name' => $group['name']], array_filter($db['groups'] ?? [], static fn($group) => empty($group['isStaffChama']) && empty($group['suspended']))));
        respond(200, ['groups' => $groups]);
    }
    if ($request->path === '/api/auth/branding' && $request->method === 'GET') {
        $db = EncryptedJsonStore::load();
        $active = array_values(array_filter($db['branding'] ?? [], static fn($brand) => empty($brand['rolledBack'])));
        $brand = $active ? end($active) : null;
        respond(200, ['branding' => $brand ? ['name' => $brand['name'] ?? 'VonDonald051 Savings', 'logo' => $brand['logo'] ?? null, 'colors' => $brand['colors'] ?? null] : ['name' => 'VonDonald051 Savings', 'logo' => null, 'colors' => null]]);
    }
    if ($request->path === '/api/auth/google/config' && $request->method === 'GET') respond(200, ['available' => false]);
    if ($request->path === '/api/auth/login' && $request->method === 'POST') {
        $db = EncryptedJsonStore::load();
        respond(200, AuthService::login($db, $request));
    }
    if ($request->path === '/api/auth/phone/verify' && $request->method === 'POST') {
        $db = EncryptedJsonStore::load();
        respond(200, AuthService::verifyPhone($db, $request));
    }
    if ($request->path === '/api/auth/logout' && $request->method === 'POST') {
        $db = EncryptedJsonStore::load();
        AuthService::logout($db);
        respond(200, ['ok' => true]);
    }
    if ($request->path === '/api/me' && $request->method === 'GET') {
        $db = EncryptedJsonStore::load();
        $user = Auth::requireUser($db);
        $group = null;
        foreach (($db['groups'] ?? []) as $entry) if ((int)($entry['id'] ?? 0) === (int)($user['groupId'] ?? -1)) { $group = ['id' => $entry['id'], 'name' => $entry['name'] ?? '', 'description' => $entry['description'] ?? '']; break; }
        $profile = null;
        foreach (($db['memberProfiles'] ?? []) as $entry) if ((int)($entry['userId'] ?? 0) === (int)$user['id']) { $profile = $entry; break; }
        $savings = 0;
        foreach (($db['savings'] ?? []) as $entry) if ((int)($entry['userId'] ?? 0) === (int)$user['id'] && empty($entry['reversed']) && (!isset($entry['status']) || $entry['status'] === 'verified')) $savings += (int)($entry['amountCents'] ?? 0);
        $unread = count(array_filter(($db['notifications'] ?? []), static fn($n) => is_array($n) && empty($n['readAt']) && empty($n['read']) && ((int)($n['recipientId'] ?? 0) === (int)$user['id'] || (($n['recipientId'] ?? null) === null && ($n['recipientRole'] ?? '') === ($user['role'] ?? '') && (($n['groupId'] ?? null) === null || (int)$n['groupId'] === (int)($user['groupId'] ?? -1))))));
        $safe = array_intersect_key($user, array_flip(['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'groupId', 'pic', 'locked', 'disabled', 'passwordChangeRequired', 'failed', 'createdAt', 'ecdhPub']));
        $safe['name'] = ($user['firstName'] ?? '') . ' ' . ($user['lastName'] ?? '');
        $safe['groupId'] = $user['groupId'] ?? null;
        $safe['pic'] = $user['pic'] ?? null;
        $safe['pub'] = $user['ecdhPub'] ?? null;
        unset($safe['ecdhPub']);
        $pendingFee = false;
        foreach (($db['registrationFees'] ?? []) as $fee) if ((int)($fee['userId'] ?? 0) === (int)$user['id'] && ($fee['status'] ?? '') === 'pending' && empty($fee['reversed'])) $pendingFee = true;
        respond(200, ['me' => $safe, 'group' => $group, 'unread' => $unread, 'memberProfile' => $profile, 'registrationFeePending' => $pendingFee, 'savingsTotalCents' => $savings]);
    }

    $publicPages = [
        '/login.html' => 'login.html', '/register.html' => 'register.html', '/request.html' => 'request.html',
        '/forgot.html' => 'forgot.html', '/reset.html' => 'reset.html', '/force-password.html' => 'force-password.html',
    ];
    if (isset($publicPages[$request->path]) && $request->method === 'GET') {
        sendFile(Config::root() . '/frontend/public/' . $publicPages[$request->path], 'text/html; charset=utf-8', 'no-store');
    }
    if ($request->path === '/' && $request->method === 'GET') {
        header('Location: /login.html', true, 302);
        exit;
    }
    if (preg_match('#^/(css|js)/([A-Za-z0-9._-]+)$#', $request->path, $asset) && $request->method === 'GET') {
        $base = realpath(Config::root() . '/frontend/public/' . $asset[1]);
        $file = $base ? realpath($base . '/' . $asset[2]) : false;
        if (!$base || !$file || !str_starts_with($file, $base . DIRECTORY_SEPARATOR)) respond(404, ['error' => 'Not found.']);
        $type = match (strtolower(pathinfo($file, PATHINFO_EXTENSION))) {
            'css' => 'text/css; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'svg' => 'image/svg+xml',
            'png' => 'image/png', 'jpg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'woff2' => 'font/woff2',
            default => 'application/octet-stream',
        };
        sendFile($file, $type);
    }

    $dashboards = [
        '/app/vsa' => ['vsa.html', ['v_super_admin']],
        '/app/sa' => ['sa.html', ['super_admin']],
        '/app/admin' => ['admin.html', ['admin']],
        '/app/ga' => ['ga.html', ['group_admin']],
        '/app/member' => ['member.html', ['member', 'admin', 'super_admin', 'group_admin']],
    ];
    if (isset($dashboards[$request->path]) && $request->method === 'GET') {
        $db = EncryptedJsonStore::load();
        try { $user = Auth::requireUser($db); }
        catch (HttpException $e) {
            if ($e->status === 401) { header('Location: /login.html', true, 302); exit; }
            throw $e;
        }
        Auth::requireRole($user, ...$dashboards[$request->path][1]);
        sendFile(Config::root() . '/frontend/private/' . $dashboards[$request->path][0], 'text/html; charset=utf-8', 'no-store');
    }
    respond(404, ['error' => 'PHP migration route is not implemented yet.']);
} catch (HttpException $e) {
    respond($e->status, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('[php-app] ' . $e->getMessage());
    respond(500, ['error' => 'Internal server error.']);
}
