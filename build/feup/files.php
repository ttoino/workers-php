<?php
// workers-php overlay for feup-ltw-proj/lib/files.php.
//
// uploadImage() still resizes via GD, but the WebP bytes go to the R2
// bucket exposed as $env->IMAGES instead of the in-memory PHP filesystem.
// staticRoutes (src/feup-index.ts) serves /assets/pictures/* back from R2.

    /**
     * Saves an image coming from $_FILES into the R2 bucket.
     *
     * @param array     $file         The file (or an array of files) from $_FILES
     * @param string    $path         Subfolder: 'user', 'restaurant', 'dish', 'menu'
     * @param int       $id           Used as the filename
     * @param int       $size         Max longest-side dimension after resize
     * @param float|int $aspect_ratio Target aspect ratio (0 = keep source)
     * @param ?int      $index        Index into a name="x[]" multi-file array
     *
     * @return bool false if the upload was invalid or encoding/storage failed.
     */
    function uploadImage(?array $file, string $path, int $id, int $size, float|int $aspect_ratio = 0, ?int $index = null): bool {
        // $_FILES['error'] is int upstream but the prelude emits a string
        // of digits; coerce both shapes.
        $err = $index === null ? ($file['error'] ?? 1) : ($file['error'][$index] ?? 1);
        $type = $index === null ? ($file['type'] ?? '') : ($file['type'][$index] ?? '');
        if (!isset($file) || ((int) $err) !== 0 || !str_starts_with((string) $type, 'image/'))
            return false;

        global $env;
        if (!isset($env) || !isset($env->IMAGES)) {
            // Misconfigured runtime; the caller falls back to the
            // default placeholder.
            return false;
        }

        $tmp_name = $index === null ? $file['tmp_name'] : $file['tmp_name'][$index];
        $image_data = @file_get_contents($tmp_name);
        if ($image_data === false) return false;

        $image = @imagecreatefromstring($image_data);
        if ($image === false) return false;

        $original_width = imagesx($image);
        $original_height = imagesy($image);
        $original_aspect_ratio = $original_width / $original_height;

        if ($aspect_ratio <= 0)
            $aspect_ratio = $original_aspect_ratio;

        if ($aspect_ratio > 1) {
            $dest_width = min($size, $original_width);
            $dest_height = $dest_width / $aspect_ratio;
        } else {
            $dest_height = min($size, $original_height);
            $dest_width = $dest_height * $aspect_ratio;
        }

        if ($original_aspect_ratio > $aspect_ratio) {
            $src_width = $original_height * $aspect_ratio;
            $src_height = $original_height;
            $offset_x = ($original_width - $src_width) / 2;
            $offset_y = 0;
        } else {
            $src_width = $original_width;
            $src_height = $original_width / $aspect_ratio;
            $offset_x = 0;
            $offset_y = ($original_height - $src_height) / 2;
        }

        $resized = imagecreatetruecolor((int) $dest_width, (int) $dest_height);
        imagecopyresized(
            $resized, $image,
            0, 0, (int) $offset_x, (int) $offset_y,
            (int) $dest_width, (int) $dest_height,
            (int) $src_width, (int) $src_height
        );

        // imagewebp() echoes; capture the bytes via an output buffer.
        ob_start();
        $ok = imagewebp($resized);
        $bytes = ob_get_clean();
        imagedestroy($image);
        imagedestroy($resized);
        if (!$ok || $bytes === false || $bytes === '') return false;

        // The key matches the URL path HasImage::getImagePath() builds,
        // which staticRoutes serves from this bucket.
        $key = "assets/pictures/$path/$id.webp";
        try {
            $env->IMAGES->put($key, $bytes, ['contentType' => 'image/webp']);
            return true;
        } catch (\Throwable $_) {
            return false;
        }
    }
?>
