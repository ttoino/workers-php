<?php

namespace WorkersPhp\Laravel\Queue;

use Illuminate\Contracts\Queue\Queue;
use Illuminate\Queue\Connectors\ConnectorInterface;
use WorkersPhp\Queue\QueueHttpClient;

class CfQueueConnector implements ConnectorInterface
{
    /** @param array<string, mixed> $config */
    public function connect(array $config): Queue
    {
        return new CfQueue(new QueueHttpClient($config['endpoint'] ?? ''));
    }
}
