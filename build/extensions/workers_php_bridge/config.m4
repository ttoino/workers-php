dnl workers_php_bridge — single-function PHP↔JS bridge for workers-php.
dnl Provides one PHP function, workers_php_call(string $method, array $args),
dnl that dispatches to Module.workersPhpBridge[method](...args) in JS.

PHP_ARG_ENABLE([workers-php-bridge],
  [whether to enable workers-php-bridge support],
  [AS_HELP_STRING([--enable-workers-php-bridge],
    [Enable workers-php-bridge support])],
  [no])

if test "$PHP_WORKERS_PHP_BRIDGE" != "no"; then
  AC_DEFINE(HAVE_WORKERS_PHP_BRIDGE, 1, [whether workers-php-bridge is enabled])
  PHP_NEW_EXTENSION(workers_php_bridge, workers_php_bridge.c, $ext_shared)
fi
