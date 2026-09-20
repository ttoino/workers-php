<?php

namespace WorkersPhp\Laravel\Queue;

use Illuminate\Contracts\Queue\Queue as QueueContract;
use Illuminate\Queue\Queue;
use WorkersPhp\Queue\QueueHttpClient;

/**
 * Produce-only queue driver over a Cloudflare Queue endpoint. Laravel
 * payloads ride as JSON messages; consuming runs through the internal
 * consume endpoint (see QueueConsumer), so pop() always throws.
 */
class CfQueue extends Queue implements QueueContract
{
    public function __construct(private readonly QueueHttpClient $client) {}

    public function size($queue = null)
    {
        return 0;
    }

    public function pendingSize($queue = null)
    {
        return 0;
    }

    public function delayedSize($queue = null)
    {
        return 0;
    }

    public function reservedSize($queue = null)
    {
        return 0;
    }

    public function creationTimeOfOldestPendingJob($queue = null)
    {
        return null;
    }

    public function push($job, $data = '', $queue = null)
    {
        return $this->pushRaw($this->createPayload($job, $queue, $data), $queue);
    }

    public function later($delay, $job, $data = '', $queue = null)
    {
        return $this->pushRaw(
            $this->createPayload($job, $queue, $data),
            $queue,
            ['delay' => $this->secondsUntil($delay)],
        );
    }

    /** @param array<int, mixed> $jobs */
    public function bulk($jobs, $data = '', $queue = null)
    {
        $messages = [];
        foreach ((array) $jobs as $job) {
            $messages[] = [
                'body' => $this->createPayload($job, $queue, $data),
                'contentType' => 'json',
            ];
        }
        $this->client->sendBatch($messages);
    }

    public function pop($queue = null)
    {
        throw new \LogicException(
            'The cfqueue driver is produce-only; consuming runs through the container consume endpoint.',
        );
    }

    /** @param array<string, mixed> $options */
    public function pushRaw($payload, $queue = null, array $options = [])
    {
        $this->client->send($payload, $options['delay'] ?? null, 'json');

        return null;
    }
}
