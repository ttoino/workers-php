<?php

namespace WorkersPhp\Tests;

use Illuminate\Contracts\Queue\ShouldQueue;
use Orchestra\Testbench\TestCase;
use WorkersPhp\Laravel\Queue\QueueConsumer;

class RecordingJob implements ShouldQueue
{
    public static bool $ran = false;

    public function handle(): void
    {
        static::$ran = true;
    }
}

class FailingJob implements ShouldQueue
{
    public static bool $ran = false;

    public function handle(): void
    {
        static::$ran = true;
        throw new \RuntimeException('boom');
    }
}

class QueueConsumerTest extends TestCase
{
    protected function getEnvironmentSetUp($app): void
    {
        $app['config']->set('queue.failed.driver', null);
        $app['config']->set('queue.connections.cfqueue', [
            'driver' => 'cfqueue',
            'endpoint' => 'http://q.app',
            'max_tries' => 2,
            'retry_after' => 30,
        ]);
    }

    private function payload(object $job): string
    {
        return (string) json_encode([
            'uuid' => 'test-uuid',
            'displayName' => $job::class,
            'job' => 'Illuminate\\Queue\\CallQueuedHandler@call',
            'maxTries' => null,
            'maxExceptions' => null,
            'failOnTimeout' => false,
            'backoff' => null,
            'timeout' => null,
            'retryUntil' => null,
            'data' => ['commandName' => $job::class, 'command' => serialize($job)],
        ]);
    }

    public function test_a_successful_job_acks(): void
    {
        RecordingJob::$ran = false;

        $result = $this->app->make(QueueConsumer::class)->consume($this->payload(new RecordingJob), 'msg-1', 1);

        $this->assertTrue(RecordingJob::$ran);
        $this->assertSame(['status' => 200, 'delay' => null], $result);
    }

    public function test_a_failing_job_retries_with_the_configured_backoff(): void
    {
        FailingJob::$ran = false;

        $result = $this->app->make(QueueConsumer::class)->consume($this->payload(new FailingJob), 'msg-1', 1);

        $this->assertTrue(FailingJob::$ran);
        $this->assertSame(['status' => 500, 'delay' => 30], $result);
    }

    public function test_a_failing_job_on_its_last_try_acks_after_failing(): void
    {
        $result = $this->app->make(QueueConsumer::class)->consume($this->payload(new FailingJob), 'msg-1', 2);

        $this->assertSame(['status' => 200, 'delay' => null], $result);
    }
}
