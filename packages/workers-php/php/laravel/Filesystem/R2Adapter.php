<?php

namespace WorkersPhp\Laravel\Filesystem;

use League\Flysystem\Config;
use League\Flysystem\DirectoryAttributes;
use League\Flysystem\FileAttributes;
use League\Flysystem\FilesystemAdapter;
use League\Flysystem\UnableToCheckExistence;
use League\Flysystem\UnableToReadFile;
use League\Flysystem\UnableToRetrieveMetadata;
use WorkersPhp\R2\R2HttpClient;

// Flysystem v3 adapter over an R2 HTTP endpoint (a Cloudflare worker with
// the bucket binding). R2 is flat: directories exist only as key prefixes.
class R2Adapter implements FilesystemAdapter
{
    private R2HttpClient $client;

    public function __construct(
        string|R2HttpClient $endpoint,
        private readonly string $urlPrefix = '/storage',
    ) {
        $this->client = is_string($endpoint) ? new R2HttpClient($endpoint) : $endpoint;
    }

    // Laravel's FilesystemAdapter::url() looks for getUrl on custom
    // adapters; objects are served by the worker under the URL prefix.
    public function getUrl(string $path): string
    {
        return $this->urlPrefix . '/' . $path;
    }

    public function fileExists(string $path): bool
    {
        try {
            return $this->client->head($path) !== null;
        } catch (\Throwable $e) {
            throw UnableToCheckExistence::forLocation($path, $e);
        }
    }

    public function directoryExists(string $path): bool
    {
        return $this->client->list(rtrim($path, '/') . '/', 1)['objects'] !== [];
    }

    public function write(string $path, string $contents, Config $config): void
    {
        $mime = $config->get('mimetype') ?? match (strtolower(pathinfo($path, PATHINFO_EXTENSION))) {
            'svg' => 'image/svg+xml',
            'webp' => 'image/webp',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            default => null,
        };
        $this->client->put($path, $contents, $mime);
    }

    public function writeStream(string $path, $contents, Config $config): void
    {
        $this->write($path, stream_get_contents($contents), $config);
        if (is_resource($contents)) fclose($contents);
    }

    public function read(string $path): string
    {
        $object = $this->client->get($path);
        if ($object === null) throw UnableToReadFile::fromLocation($path, 'not found');

        return $object['body'];
    }

    public function readStream(string $path)
    {
        $stream = fopen('php://temp', 'r+');
        fwrite($stream, $this->read($path));
        rewind($stream);

        return $stream;
    }

    public function delete(string $path): void
    {
        $this->client->delete($path);
    }

    public function deleteDirectory(string $path): void
    {
        $cursor = null;
        do {
            $page = $this->client->list(rtrim($path, '/') . '/', 1000, $cursor);
            $keys = array_column($page['objects'], 'key');
            if ($keys) {
                $this->client->delete(...$keys);
            }
            $cursor = $page['truncated'] ? $page['cursor'] : null;
        } while ($cursor);
    }

    public function createDirectory(string $path, Config $config): void
    {
        // R2 has no directories; prefixes appear as objects are written.
    }

    public function setVisibility(string $path, string $visibility): void
    {
        // Bucket-wide policy; per-object visibility does not exist.
    }

    public function visibility(string $path): FileAttributes
    {
        return new FileAttributes($path, null, 'public');
    }

    public function mimeType(string $path): FileAttributes
    {
        $headers = $this->head($path, 'mimeType');

        return new FileAttributes($path, null, null, null, $headers['content-type'] ?? null);
    }

    public function lastModified(string $path): FileAttributes
    {
        $headers = $this->head($path, 'lastModified');

        return new FileAttributes($path, null, null, isset($headers['last-modified']) ? strtotime($headers['last-modified']) : null);
    }

    public function fileSize(string $path): FileAttributes
    {
        $headers = $this->head($path, 'fileSize');

        return new FileAttributes($path, isset($headers['content-length']) ? (int) $headers['content-length'] : null);
    }

    public function listContents(string $path, bool $deep): iterable
    {
        $prefix = $path === '' ? '' : rtrim($path, '/') . '/';
        $cursor = null;
        do {
            $page = $this->client->list($prefix, 1000, $cursor);
            foreach ($page['objects'] as $obj) {
                if (!$deep && str_contains(substr($obj['key'], strlen($prefix)), '/')) {
                    yield new DirectoryAttributes($prefix . strstr(substr($obj['key'], strlen($prefix)), '/', true));
                    continue;
                }
                yield new FileAttributes($obj['key'], $obj['size']);
            }
            $cursor = $page['truncated'] ? $page['cursor'] : null;
        } while ($cursor);
    }

    public function move(string $source, string $destination, Config $config): void
    {
        $this->copy($source, $destination, $config);
        $this->delete($source);
    }

    public function copy(string $source, string $destination, Config $config): void
    {
        $this->write($destination, $this->read($source), $config);
    }

    private function head(string $path, string $metadata): array
    {
        $headers = $this->client->head($path);
        if ($headers === null) throw UnableToRetrieveMetadata::$metadata($path, 'not found');

        return $headers;
    }
}
