<?php

namespace WorkersPhp\Mail;

use WorkersPhp\Http\CurlTransport;

/**
 * HTTP client for the worker's email endpoint, which takes a structured
 * message (no raw MIME):
 *
 *   POST {endpoint}/send  {"from": "...", "to": [...], "subject": "...", "html"?: "...", "text"?: "..."}
 */
final class MailHttpClient
{
    /** @var callable */
    private $transport;

    public function __construct(public readonly string $endpoint, ?callable $transport = null)
    {
        $this->transport = $transport ?? new CurlTransport;
    }

    /** @param string[] $to */
    public function send(string $from, array $to, string $subject, ?string $html = null, ?string $text = null): void
    {
        $payload = ['from' => $from, 'to' => array_values($to), 'subject' => $subject];
        if ($html !== null) {
            $payload['html'] = $html;
        }
        if ($text !== null) {
            $payload['text'] = $text;
        }

        [$status, , $raw] = ($this->transport)(
            'POST',
            $this->endpoint.'/send',
            ['Content-Type: application/json'],
            json_encode($payload),
        );

        if ($status >= 400) {
            throw new \RuntimeException("Email endpoint error (HTTP $status): ".substr($raw, 0, 500));
        }
    }
}
