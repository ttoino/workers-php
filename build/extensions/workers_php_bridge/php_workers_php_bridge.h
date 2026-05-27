/* workers_php_bridge — PHP↔JS bridge for workers-php. */

#ifndef PHP_WORKERS_PHP_BRIDGE_H
#define PHP_WORKERS_PHP_BRIDGE_H

extern zend_module_entry workers_php_bridge_module_entry;
#define phpext_workers_php_bridge_ptr &workers_php_bridge_module_entry

#define PHP_WORKERS_PHP_BRIDGE_VERSION "0.1.0"

#endif /* PHP_WORKERS_PHP_BRIDGE_H */
