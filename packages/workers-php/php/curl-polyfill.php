<?php
// Userland curl_* polyfill backed by the JS fetch() bridge.
//
// The bundled wasm has no curl extension (upstream php-wasm has no build
// recipe for it), so apps that call curl_* — Guzzle, WordPress's WP_Http
// curl transport, most payment SDKs — fatal with "Call to undefined
// function". This file defines the common curl API in terms of
// workers_php_call('http_fetch', ...), which dispatches to the Worker's
// global fetch() via the workers_php_bridge extension. The bridge is
// EM_ASYNC_JS, so the request truly blocks PHP until fetch() resolves.
//
// Loaded only when extension_loaded('curl') is false (i.e. always, for
// the bundled wasm — but harmless if a future build adds real curl,
// which then takes precedence).
//
// Scope: single requests, full body buffered (no streaming), redirects
// optionally followed by fetch(), timeouts via AbortSignal. NOT
// supported: multi handles, shares, custom TLS client certs, CURLOPT_*
// outside the set below (they're accepted and ignored, matching the
// "best effort" spirit of a polyfill).

namespace WorkersPHP {
    /** Per-handle state for the curl polyfill. */
    final class CurlPolyfillHandle {
        public string $url = '';
        /** @var array<int, mixed> */
        public array $options = [];
        public int $errno = 0;          // CURLE_OK
        public string $error = '';
        /** @var array<string, mixed>|null Meta from the last exec. */
        public ?array $lastInfo = null;
    }

    /** Registry: maps object ids → handle state (kept off the object so
     *  userland comparisons against \CurlHandle-ish objects stay cheap). */
    final class CurlPolyfill {
        /** @var \WeakMap<object, CurlPolyfillHandle>|null */
        public static ?\WeakMap $map = null;

        public static function of(object $ch): CurlPolyfillHandle {
            self::$map ??= new \WeakMap();
            if (!isset(self::$map[$ch])) {
                self::$map[$ch] = new CurlPolyfillHandle();
            }
            return self::$map[$ch];
        }
    }
}

namespace {
    if (!\extension_loaded('curl')) {

        // --- Constants (subset; real values from ext/curl) ---

        \define('CURLE_OK', 0);
        \define('CURLE_COULDNT_CONNECT', 7);
        \define('CURLE_OPERATION_TIMEOUTED', 28);

        \define('CURLOPT_URL', 10002);
        \define('CURLOPT_RETURNTRANSFER', 19913);
        \define('CURLOPT_HEADER', 42);
        \define('CURLOPT_NOBODY', 44);
        \define('CURLOPT_POST', 47);
        \define('CURLOPT_FOLLOWLOCATION', 52);
        \define('CURLOPT_POSTFIELDS', 10015);
        \define('CURLOPT_CUSTOMREQUEST', 10036);
        \define('CURLOPT_HTTPHEADER', 10023);
        \define('CURLOPT_USERAGENT', 10018);
        \define('CURLOPT_TIMEOUT', 13);
        \define('CURLOPT_CONNECTTIMEOUT', 78);

        \define('CURLINFO_HTTP_CODE', 2097154);
        \define('CURLINFO_CONTENT_TYPE', 1048594);
        \define('CURLINFO_REDIRECT_URL', 1048607);
        \define('CURLINFO_EFFECTIVE_URL', 1048577);
        \define('CURLINFO_TOTAL_TIME', 6291462);

        if (!\class_exists('CurlHandle')) {
            // Real curl returns opaque CurlHandle objects; userland code
            // only passes them back to curl_* functions, so an empty
            // marker class is enough.
            class CurlHandle {}
        }

        function curl_init(?string $url = null): \CurlHandle|false {
            $ch = new \CurlHandle();
            $state = \WorkersPHP\CurlPolyfill::of($ch);
            if ($url !== null) $state->url = $url;
            return $ch;
        }

        function curl_setopt(\CurlHandle $ch, int $option, mixed $value): bool {
            \WorkersPHP\CurlPolyfill::of($ch)->options[$option] = $value;
            if ($option === CURLOPT_URL) \WorkersPHP\CurlPolyfill::of($ch)->url = (string) $value;
            return true;
        }

        function curl_setopt_array(\CurlHandle $ch, array $options): bool {
            foreach ($options as $option => $value) {
                \curl_setopt($ch, $option, $value);
            }
            return true;
        }

        function curl_exec(\CurlHandle $ch): string|bool {
            $state = \WorkersPHP\CurlPolyfill::of($ch);
            $opt = $state->options;
            $state->errno = CURLE_OK;
            $state->error = '';

            if ($state->url === '') {
                $state->errno = CURLE_COULDNT_CONNECT;
                $state->error = 'No URL set';
                return false;
            }

            $method = 'GET';
            if (!empty($opt[CURLOPT_CUSTOMREQUEST]))  $method = (string) $opt[CURLOPT_CUSTOMREQUEST];
            elseif (!empty($opt[CURLOPT_NOBODY]))     $method = 'HEAD';
            elseif (!empty($opt[CURLOPT_POST]))       $method = 'POST';

            $headers = [];
            foreach ((array) ($opt[CURLOPT_HTTPHEADER] ?? []) as $line) {
                $line = (string) $line;
                $i = \strpos($line, ':');
                if ($i !== false) $headers[\trim(\substr($line, 0, $i))] = \trim(\substr($line, $i + 1));
            }
            if (isset($opt[CURLOPT_USERAGENT])) $headers['User-Agent'] = (string) $opt[CURLOPT_USERAGENT];

            $bodyB64 = null;
            if (isset($opt[CURLOPT_POSTFIELDS])) {
                $fields = $opt[CURLOPT_POSTFIELDS];
                if (\is_array($fields)) $fields = \http_build_query($fields);
                $bodyB64 = \base64_encode((string) $fields);
            }

            $t0 = \microtime(true);
            try {
                $res = \workers_php_call('http_fetch', [
                    $state->url,
                    [
                        'method'         => $method,
                        'headers'        => $headers,
                        'bodyB64'        => $bodyB64,
                        'redirect'       => !empty($opt[CURLOPT_FOLLOWLOCATION]) ? 'follow' : 'manual',
                        'timeoutSeconds' => (int) ($opt[CURLOPT_TIMEOUT] ?? 0),
                    ],
                ]);
            } catch (\WorkersPHP\BridgeException $e) {
                $state->errno = \str_contains($e->getMessage(), 'timed out') || \str_contains($e->getMessage(), 'TimeoutError')
                    ? CURLE_OPERATION_TIMEOUTED
                    : CURLE_COULDNT_CONNECT;
                $state->error = $e->getMessage();
                return false;
            }

            $body = \base64_decode((string) ($res['bodyB64'] ?? ''), true);
            if ($body === false) $body = '';

            $state->lastInfo = [
                'url'           => (string) ($res['url'] ?? $state->url),
                'http_code'     => (int) ($res['status'] ?? 0),
                'content_type'  => $res['headers']['content-type'] ?? null,
                'redirect_url'  => ($res['status'] ?? 0) >= 300 && ($res['status'] ?? 0) < 400
                                    ? ($res['headers']['location'] ?? null) : null,
                'total_time'    => \microtime(true) - $t0,
            ];

            $out = $body;
            if (!empty($opt[CURLOPT_HEADER])) {
                $headerText = 'HTTP/1.1 ' . ($res['status'] ?? 0) . "\r\n";
                foreach ((array) ($res['headers'] ?? []) as $k => $v) $headerText .= "$k: $v\r\n";
                $out = $headerText . "\r\n" . $body;
            }

            if (!empty($opt[CURLOPT_RETURNTRANSFER])) return $out;
            echo $out;
            return true;
        }

        function curl_getinfo(\CurlHandle $ch, ?int $option = null): mixed {
            $info = \WorkersPHP\CurlPolyfill::of($ch)->lastInfo ?? [];
            if ($option === null) {
                return $info + [
                    'url' => null, 'http_code' => 0, 'content_type' => null,
                    'redirect_url' => null, 'total_time' => 0.0,
                ];
            }
            return match ($option) {
                CURLINFO_HTTP_CODE     => $info['http_code'] ?? 0,
                CURLINFO_CONTENT_TYPE  => $info['content_type'] ?? null,
                CURLINFO_REDIRECT_URL  => $info['redirect_url'] ?? null,
                CURLINFO_EFFECTIVE_URL => $info['url'] ?? null,
                CURLINFO_TOTAL_TIME    => $info['total_time'] ?? 0.0,
                default                => null,
            };
        }

        function curl_errno(\CurlHandle $ch): int {
            return \WorkersPHP\CurlPolyfill::of($ch)->errno;
        }

        function curl_error(\CurlHandle $ch): string {
            return \WorkersPHP\CurlPolyfill::of($ch)->error;
        }

        function curl_close(\CurlHandle $ch): void {
            // WeakMap entry drops when the handle is GC'd; nothing to do.
        }
    }
}
