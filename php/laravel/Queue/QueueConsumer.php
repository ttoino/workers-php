<?php

namespace WorkersPhp\Laravel\Queue;

use Illuminate\Container\Container;
use Illuminate\Queue\Worker;
use Illuminate\Queue\WorkerOptions;

/**
 * Runs one Cloudflare Queue message through Laravel's queue Worker and
 * reports the outcome under the consume endpoint contract: 200 acks
 * (success, or permanently failed after exhausting tries), 500 retries
 * with the released delay, which the queue applies as delaySeconds.
 */
class QueueConsumer
{
    public function __construct(private readonly Container $app) {}

    /** @return array{status: int, delay: int|null} */
    public function consume(string $rawBody, string $messageId, int $attempts): array
    {
        $job = new CfQueueJob($this->app, $rawBody, $messageId, $attempts);

        /** @var array<string, mixed> $config */
        $config = $this->app['config']['queue.connections.cfqueue'] ?? [];

        /** @var Worker $worker */
        $worker = $this->app->make('queue.worker');
        $options = new WorkerOptions(
            'cfqueue',
            (int) ($config['retry_after'] ?? 0),
            128,
            60,
            0,
            (int) ($config['max_tries'] ?? 3),
        );

        try {
            $worker->process('cfqueue', $job, $options);

            return ['status' => 200, 'delay' => null];
        } catch (\Throwable) {
            if ($job->isDeleted()) {
                return ['status' => 200, 'delay' => null];
            }

            return ['status' => 500, 'delay' => $job->releaseDelay() > 0 ? $job->releaseDelay() : null];
        }
    }
}
