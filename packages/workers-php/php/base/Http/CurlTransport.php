<?php

namespace WorkersPhp\Http;

/**
 * Shared transport for the *.app outbound hosts. Clients accept any
 * callable with this shape so tests (and alternative HTTP stacks) can
 * substitute their own:
 *
 *     fn(string $method, string $url, array $headers, ?string $body): array{int, array<string, string>, string}
 *
 * returning [status, response headers, response body].
 */
final class CurlTransport
{
    /** @return array{0: int, 1: array<string, string>, 2: string} */
    public function __invoke(string $method, string $url, array $headers = [], ?string $body = null): array
    {
        $ch = curl_init($url);
        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_NOBODY => $method === 'HEAD',
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$responseHeaders) {
                if (str_contains($line, ':')) {
                    [$k, $v] = explode(':', $line, 2);
                    $responseHeaders[strtolower(trim($k))] = trim($v);
                }

                return strlen($line);
            },
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($raw === false) {
            throw new \RuntimeException("HTTP transport error: $method $url");
        }

        return [$status, $responseHeaders, (string) $raw];
    }
}
