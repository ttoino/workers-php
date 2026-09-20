<?php

namespace WorkersPhp\Laravel\Queue;

use Illuminate\Container\Container;
use Illuminate\Contracts\Queue\Job as JobContract;
use Illuminate\Queue\Jobs\Job;

/**
 * A Cloudflare Queue message dressed as a Laravel job so
 * Illuminate\Queue\Worker can process it: the payload is a standard
 * Laravel queue payload, ids and attempts come from the Queue message,
 * and the released delay is captured so the consume endpoint can hand
 * it back to the queue.
 */
class CfQueueJob extends Job implements JobContract
{
    private int $releaseDelay = 0;

    public function __construct(
        Container $container,
        private readonly string $rawBody,
        private readonly string $messageId,
        private readonly int $attemptCount,
    ) {
        $this->container = $container;
    }

    public function getJobId()
    {
        return $this->messageId;
    }

    public function getRawBody()
    {
        return $this->rawBody;
    }

    public function attempts(): int
    {
        return $this->attemptCount;
    }

    public function release($delay = 0)
    {
        parent::release($delay);
        $this->releaseDelay = (int) $delay;
    }

    public function releaseDelay(): int
    {
        return $this->releaseDelay;
    }
}
