<?php

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    DB::table('page_hits')->insert(['path' => '/']);
    $hits = DB::table('page_hits')->count();

    return view('welcome', ['hits' => $hits]);
});
