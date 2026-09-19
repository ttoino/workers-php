<?php

namespace WorkersPhp\Symfony\Mailer;

use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\TransportInterface;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;
use Symfony\Component\Mime\RawMessage;
use WorkersPhp\Mail\MailHttpClient;

// Symfony Mailer transport over the worker's email endpoint, which takes
// a structured message (no raw MIME). Only the first From address is
// used and Bcc is dropped (Cloudflare rejects it).
class HttpMailTransport implements TransportInterface
{
    private MailHttpClient $client;

    public function __construct(string|MailHttpClient $endpoint)
    {
        $this->client = is_string($endpoint) ? new MailHttpClient($endpoint) : $endpoint;
    }

    public function send(RawMessage $message, ?Envelope $envelope = null): ?SentMessage
    {
        if (!$message instanceof Email) {
            throw new \LogicException('http-mail only supports Symfony Email messages.');
        }

        $html = $message->getHtmlBody();
        if (is_resource($html)) $html = stream_get_contents($html);

        try {
            $this->client->send(
                $message->getFrom()[0]->getAddress(),
                array_map(fn (Address $a) => $a->getAddress(), $message->getTo()),
                (string) $message->getSubject(),
                $html === false ? null : $html,
                $message->getTextBody(),
            );
        } catch (\Throwable $e) {
            throw new TransportException($e->getMessage(), 0, $e);
        }

        return null;
    }

    public function __toString(): string
    {
        return 'http-mail';
    }
}
