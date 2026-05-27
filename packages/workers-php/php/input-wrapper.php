<?php
// Userland php:// stream wrapper that makes php://input return the raw
// request body. The library writes the body to /tmp/workers-php-input
// before each request; this wrapper exposes it.
//
// Why: PHP's stock php://input reads via the SAPI's read_post() hook,
// but php-wasm's embed SAPI is the stock embed SAPI which doesn't
// implement read_post for non-CLI input. So `file_get_contents('php://input')`
// returns empty by default. We replace the `php` stream wrapper entirely
// with this one; non-input php:// URIs are delegated back to the built-in
// wrapper via stream_wrapper_restore() inside the open call.

namespace WorkersPHP;

final class InputStreamWrapper {
    /** @var resource|null */
    public $context;

    private string $data = '';
    private int $pos = 0;

    /** Hold a stream resource opened against the built-in php:// wrapper. */
    private $delegate = null;

    public function stream_open(string $path, string $mode, int $options, ?string &$opened_path): bool {
        if ($path === 'php://input') {
            $body_file = '/tmp/workers-php-input';
            $this->data = is_file($body_file) ? (file_get_contents($body_file) ?: '') : '';
            return true;
        }

        // Delegate every other php:// URI to the built-in wrapper.
        // Trick: unregister ourselves, open with the original wrapper,
        // then re-register. Single-threaded request handling makes this
        // safe.
        \stream_wrapper_restore('php');
        try {
            $this->delegate = @\fopen($path, $mode, ($options & STREAM_USE_PATH) !== 0);
        } finally {
            \stream_wrapper_unregister('php');
            \stream_wrapper_register('php', self::class);
        }
        if ($this->delegate === false) {
            $this->delegate = null;
            return false;
        }
        return true;
    }

    public function stream_read(int $count): string {
        if ($this->delegate) {
            return (string) \fread($this->delegate, $count);
        }
        $chunk = substr($this->data, $this->pos, $count);
        $this->pos += strlen($chunk);
        return $chunk;
    }

    public function stream_write(string $data): int {
        if ($this->delegate) {
            return (int) \fwrite($this->delegate, $data);
        }
        // php://input is read-only.
        return 0;
    }

    public function stream_eof(): bool {
        if ($this->delegate) return \feof($this->delegate);
        return $this->pos >= strlen($this->data);
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool {
        if ($this->delegate) return \fseek($this->delegate, $offset, $whence) === 0;
        if ($whence === SEEK_SET)      $this->pos = $offset;
        elseif ($whence === SEEK_CUR)  $this->pos += $offset;
        elseif ($whence === SEEK_END)  $this->pos = strlen($this->data) + $offset;
        else return false;
        if ($this->pos < 0) { $this->pos = 0; return false; }
        return true;
    }

    public function stream_tell(): int {
        if ($this->delegate) return (int) \ftell($this->delegate);
        return $this->pos;
    }

    public function stream_stat() {
        if ($this->delegate) return @\fstat($this->delegate);
        return [
            'dev'   => 0, 'ino' => 0, 'mode' => 0100444, 'nlink' => 1,
            'uid'   => 0, 'gid' => 0, 'rdev' => 0,
            'size'  => strlen($this->data),
            'atime' => 0, 'mtime' => 0, 'ctime' => 0,
            'blksize' => -1, 'blocks' => -1,
        ];
    }

    public function url_stat(string $path, int $flags) {
        if ($path === 'php://input') {
            $body_file = '/tmp/workers-php-input';
            $size = is_file($body_file) ? (int) filesize($body_file) : 0;
            return [
                'dev'   => 0, 'ino' => 0, 'mode' => 0100444, 'nlink' => 1,
                'uid'   => 0, 'gid' => 0, 'rdev' => 0,
                'size'  => $size,
                'atime' => 0, 'mtime' => 0, 'ctime' => 0,
                'blksize' => -1, 'blocks' => -1,
            ];
        }
        \stream_wrapper_restore('php');
        try {
            return ($flags & STREAM_URL_STAT_QUIET) ? @\stat($path) : \stat($path);
        } finally {
            \stream_wrapper_unregister('php');
            \stream_wrapper_register('php', self::class);
        }
    }

    public function stream_close(): void {
        if ($this->delegate) {
            \fclose($this->delegate);
            $this->delegate = null;
        }
    }

    public function stream_set_option(int $option, int $arg1, int $arg2): bool {
        return false;
    }
}

\stream_wrapper_unregister('php');
\stream_wrapper_register('php', InputStreamWrapper::class);
