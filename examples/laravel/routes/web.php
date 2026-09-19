<?php

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    $database = null;
    try {
        $database = DB::connection()->selectOne('SELECT 1 AS ok') !== null ? 'd1' : 'unreachable';
    } catch (Throwable $e) {
        $database = 'error: '.$e->getMessage();
    }

    return response()->json([
        'app' => config('app.name'),
        'database' => $database,
        'ready' => true,
    ]);
});
