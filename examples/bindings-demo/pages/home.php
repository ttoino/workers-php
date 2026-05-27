<?php
/** @var \WorkersPHP\Env $env */

// Fetch recent guestbook entries via the D1 binding.
$entries = $env->DB->prepare(
    'SELECT id, name, message, created FROM Guestbook ORDER BY id DESC LIMIT 10'
)->all();

// Bump and read a per-isolate visit counter via KV.
$count = (int) ($env->KV->get('visits') ?? '0');
$env->KV->put('visits', (string) ($count + 1));

// List uploaded images from R2 (used in the home gallery).
$listing = $env->IMAGES->list(['prefix' => 'uploads/', 'limit' => 20]);
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>workers-php bindings demo</title>
    <link rel="stylesheet" href="/style/main.css">
</head>
<body>
    <header>
        <h1>workers-php bindings demo</h1>
        <p class="env-info">
            <code>APP_ENV</code> = <strong><?= htmlspecialchars($env->APP_ENV ?? '(unset)') ?></strong>
            · visits this isolate: <strong><?= $count + 1 ?></strong>
        </p>
    </header>

    <section>
        <h2>Guestbook (D1)</h2>

        <form method="POST" action="/guestbook">
            <label>Name <input type="text" name="name" required maxlength="40"></label>
            <label>Message <input type="text" name="message" required maxlength="200"></label>
            <button type="submit">Sign</button>
        </form>

        <?php if (count($entries->results) === 0): ?>
            <p>No entries yet. Be the first!</p>
        <?php else: ?>
            <ul class="entries">
                <?php foreach ($entries->results as $entry): ?>
                    <li>
                        <strong><?= htmlspecialchars($entry['name']) ?></strong>:
                        <?= htmlspecialchars($entry['message']) ?>
                        <span class="when"><?= htmlspecialchars($entry['created']) ?></span>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>
    </section>

    <section>
        <h2>Image gallery (R2 + multipart upload)</h2>

        <form method="POST" action="/upload" enctype="multipart/form-data">
            <label>Pick an image <input type="file" name="image" accept="image/*" required></label>
            <button type="submit">Upload</button>
        </form>

        <?php if (count($listing['objects']) === 0): ?>
            <p>No images yet.</p>
        <?php else: ?>
            <div class="gallery">
                <?php foreach ($listing['objects'] as $obj): ?>
                    <figure>
                        <img src="/<?= htmlspecialchars($obj->key) ?>" alt="<?= htmlspecialchars($obj->key) ?>">
                        <figcaption><?= htmlspecialchars($obj->key) ?> (<?= $obj->size ?> B)</figcaption>
                    </figure>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </section>

    <section>
        <h2>KV counter</h2>
        <p>Visit <a href="/counter">/counter</a> to increment a per-key counter and see KV in action.</p>
    </section>
</body>
</html>
