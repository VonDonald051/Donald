<?php
declare(strict_types=1);

namespace VonDonald\System;

final class Request
{
    public readonly string $method;
    public readonly string $path;
    public readonly array $query;
    public readonly array $headers;
    public readonly array $body;

    public function __construct()
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $rawPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
        $this->path = '/' . trim(is_string($rawPath) ? $rawPath : '/', '/');
        $this->query = $_GET;
        $this->headers = function_exists('getallheaders') ? array_change_key_case(getallheaders(), CASE_LOWER) : [];
        $contentType = strtolower((string)($this->headers['content-type'] ?? ''));
        $raw = file_get_contents('php://input', false, null, 0, 1048577);
        if (!is_string($raw) || strlen($raw) > 1048576) throw new HttpException(413, 'Request body is too large.');
        if (str_contains($contentType, 'application/json') && $raw !== '') {
            try { $decoded = json_decode($raw, true, 64, JSON_THROW_ON_ERROR); }
            catch (\JsonException) { throw new HttpException(400, 'Malformed JSON request.'); }
            if (!is_array($decoded)) throw new HttpException(400, 'JSON body must be an object.');
            $this->body = $decoded;
        } else {
            $this->body = $_POST;
        }
    }
}

final class HttpException extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
