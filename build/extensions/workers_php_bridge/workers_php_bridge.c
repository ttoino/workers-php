/*
 * workers_php_bridge — single-function PHP↔JS bridge for workers-php.
 *
 * Exposes one PHP function:
 *
 *     workers_php_call(string $method, array $args = []): mixed
 *
 * which serializes `$args` to JSON, suspends the PHP wasm stack via
 * Emscripten's Asyncify, awaits `Module.workersPhpBridge[$method](...$args)`,
 * and returns the JS result decoded as a PHP value. On failure the JS
 * side throws (or returns `{ ok: false, error }`) and this function
 * raises `\WorkersPHP\BridgeException`.
 *
 * Why a custom extension instead of vrzno: vrzno exposes arbitrary JS to
 * PHP, which is a huge surface. We only need one entry point with a
 * fixed JSON-encoded protocol. This file is ~150 LOC and we own it.
 */

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "php.h"
#include "ext/standard/info.h"
#include "ext/json/php_json.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "php_workers_php_bridge.h"

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

/* Class entry for \WorkersPHP\BridgeException. */
static zend_class_entry *bridge_exception_ce;

/*
 * EM_ASYNC_JS: call Module.workersPhpBridge[method](...args) and return
 * a malloc'd UTF-8 JSON string in the shape
 *   { "ok": true,  "result": <json> }
 *   { "ok": false, "error":  "<message>" }
 *
 * Asyncify suspends the wasm stack while awaiting the Promise. Caller
 * frees the returned pointer with free().
 */
EM_ASYNC_JS(char *, workers_php_bridge_invoke, (const char *method_utf8, const char *args_json), {
    const method = UTF8ToString(method_utf8);
    let args;
    try {
        args = JSON.parse(UTF8ToString(args_json));
    } catch (e) {
        const msg = JSON.stringify({ ok: false, error: 'workers_php_bridge: malformed args JSON: ' + String(e) });
        return stringToNewUTF8(msg);
    }
    if (!Array.isArray(args)) {
        return stringToNewUTF8(JSON.stringify({ ok: false, error: 'workers_php_bridge: args must be an array' }));
    }
    const bridge = Module.workersPhpBridge;
    if (!bridge || typeof bridge !== 'object') {
        return stringToNewUTF8(JSON.stringify({
            ok: false,
            error: 'workers_php_bridge: Module.workersPhpBridge not installed (call installBridge before invoking PHP)',
        }));
    }
    const fn = bridge[method];
    if (typeof fn !== 'function') {
        return stringToNewUTF8(JSON.stringify({ ok: false, error: 'workers_php_bridge: unknown method: ' + method }));
    }
    try {
        const result = await fn(...args);
        return stringToNewUTF8(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
    } catch (e) {
        const message = (e && (e.message || String(e))) || 'unknown error';
        return stringToNewUTF8(JSON.stringify({ ok: false, error: message }));
    }
});

/* Helper: decode a JSON string into a zval. Returns FAILURE on parse error. */
static int bridge_json_decode(const char *json, size_t len, zval *out)
{
    return php_json_decode_ex(out, json, len, PHP_JSON_OBJECT_AS_ARRAY, PHP_JSON_PARSER_DEFAULT_DEPTH);
}

/* {{{ proto mixed workers_php_call(string $method, array $args = [])
   Synchronous call from PHP into a Module.workersPhpBridge[$method](...$args). */
PHP_FUNCTION(workers_php_call)
{
    zend_string *method;
    zval *args_zv = NULL;

    ZEND_PARSE_PARAMETERS_START(1, 2)
        Z_PARAM_STR(method)
        Z_PARAM_OPTIONAL
        Z_PARAM_ARRAY(args_zv)
    ZEND_PARSE_PARAMETERS_END();

    /* Serialize the args array to JSON. If absent or empty, use "[]". */
    smart_str args_buf = {0};
    if (args_zv != NULL) {
        php_json_encode(&args_buf, args_zv, PHP_JSON_UNESCAPED_UNICODE | PHP_JSON_UNESCAPED_SLASHES);
        smart_str_0(&args_buf);
    } else {
        smart_str_appendl(&args_buf, "[]", 2);
        smart_str_0(&args_buf);
    }

    char *json_response = workers_php_bridge_invoke(
        ZSTR_VAL(method),
        ZSTR_VAL(args_buf.s)
    );
    smart_str_free(&args_buf);

    if (json_response == NULL) {
        zend_throw_exception(bridge_exception_ce, "workers_php_bridge: invoke returned null", 0);
        RETURN_THROWS();
    }

    /* Decode the response envelope: { ok, result?, error? } */
    zval response;
    size_t response_len = strlen(json_response);
    if (bridge_json_decode(json_response, response_len, &response) == FAILURE) {
        zend_throw_exception_ex(bridge_exception_ce, 0,
            "workers_php_bridge: failed to decode response JSON: %s",
            json_response);
        free(json_response);
        RETURN_THROWS();
    }
    free(json_response);

    if (Z_TYPE(response) != IS_ARRAY) {
        zval_ptr_dtor(&response);
        zend_throw_exception(bridge_exception_ce,
            "workers_php_bridge: response is not an object", 0);
        RETURN_THROWS();
    }

    zval *ok_zv = zend_hash_str_find(Z_ARRVAL(response), "ok", sizeof("ok") - 1);
    if (ok_zv == NULL || Z_TYPE_P(ok_zv) != IS_TRUE) {
        /* Error path: extract `error` if present, otherwise generic. */
        zval *err_zv = zend_hash_str_find(Z_ARRVAL(response), "error", sizeof("error") - 1);
        if (err_zv != NULL && Z_TYPE_P(err_zv) == IS_STRING) {
            zend_throw_exception(bridge_exception_ce, Z_STRVAL_P(err_zv), 0);
        } else {
            zend_throw_exception(bridge_exception_ce,
                "workers_php_bridge: call failed with no error message", 0);
        }
        zval_ptr_dtor(&response);
        RETURN_THROWS();
    }

    /* Success: return the `result` field (or null). */
    zval *result_zv = zend_hash_str_find(Z_ARRVAL(response), "result", sizeof("result") - 1);
    if (result_zv == NULL) {
        zval_ptr_dtor(&response);
        RETURN_NULL();
    }

    /* Copy out before freeing the envelope. */
    ZVAL_COPY(return_value, result_zv);
    zval_ptr_dtor(&response);
}
/* }}} */

/* Argument info for ZPP. */
ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_workers_php_call, 0, 1, IS_MIXED, 0)
    ZEND_ARG_TYPE_INFO(0, method, IS_STRING, 0)
    ZEND_ARG_TYPE_INFO_WITH_DEFAULT_VALUE(0, args, IS_ARRAY, 0, "[]")
ZEND_END_ARG_INFO()

static const zend_function_entry workers_php_bridge_functions[] = {
    PHP_FE(workers_php_call, arginfo_workers_php_call)
    PHP_FE_END
};

PHP_MINIT_FUNCTION(workers_php_bridge)
{
    zend_class_entry ce;
    INIT_NS_CLASS_ENTRY(ce, "WorkersPHP", "BridgeException", NULL);
    bridge_exception_ce = zend_register_internal_class_ex(&ce, zend_ce_exception);
    return SUCCESS;
}

PHP_MINFO_FUNCTION(workers_php_bridge)
{
    php_info_print_table_start();
    php_info_print_table_header(2, "workers-php-bridge support", "enabled");
    php_info_print_table_row(2, "version", PHP_WORKERS_PHP_BRIDGE_VERSION);
    php_info_print_table_end();
}

zend_module_entry workers_php_bridge_module_entry = {
    STANDARD_MODULE_HEADER,
    "workers_php_bridge",
    workers_php_bridge_functions,
    PHP_MINIT(workers_php_bridge),
    NULL, /* MSHUTDOWN */
    NULL, /* RINIT */
    NULL, /* RSHUTDOWN */
    PHP_MINFO(workers_php_bridge),
    PHP_WORKERS_PHP_BRIDGE_VERSION,
    STANDARD_MODULE_PROPERTIES
};

#ifdef COMPILE_DL_WORKERS_PHP_BRIDGE
ZEND_GET_MODULE(workers_php_bridge)
#endif
