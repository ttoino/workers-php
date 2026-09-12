<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>workers-php · laravel</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <main>
        <h1>Laravel on Cloudflare Workers</h1>
        <p>
            Stock Laravel {{ Illuminate\Foundation\Application::VERSION }} on PHP
            {{ PHP_VERSION }}, compiled to WebAssembly and running inside a
            Cloudflare Worker.
        </p>
        <p>
            Page hits served from a D1 database over Laravel's query builder:
            <strong>{{ $hits }}</strong>
        </p>
    </main>
</body>
</html>
