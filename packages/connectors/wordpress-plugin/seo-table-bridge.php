<?php
/**
 * Plugin Name: SEO Table Bridge
 * Description: Exposes the SEO fields WordPress core keeps out of the REST API (SEO title, meta description, canonical, robots) plus a redirect table, so SEO Table can apply approved fixes. Reads and writes only; it renders nothing on the front end.
 * Version:     0.4.0
 * Requires PHP: 8.0
 * License:     MIT
 *
 * Install as a must-use plugin:
 *   wp-content/mu-plugins/seo-table-bridge.php
 *
 * Every endpoint requires an authenticated user with `edit_posts`, so the
 * Application Password SEO Table uses is the only key. Nothing here is public.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

const SEO_TABLE_NS = 'seo-table/v1';
const SEO_TABLE_REDIRECT_OPTION = 'seo_table_redirects';

/** Meta keys, in preference order, for each logical field. */
function seo_table_meta_keys(string $field): array
{
    return match ($field) {
        'title' => ['_yoast_wpseo_title', 'rank_math_title', '_seo_table_title'],
        'meta_description' => ['_yoast_wpseo_metadesc', 'rank_math_description', '_seo_table_description'],
        'canonical' => ['_yoast_wpseo_canonical', 'rank_math_canonical_url', '_seo_table_canonical'],
        'meta_robots' => ['_seo_table_robots'],
        default => [],
    };
}

function seo_table_active_key(string $field): ?string
{
    $keys = seo_table_meta_keys($field);
    if ($keys === []) {
        return null;
    }
    if (defined('WPSEO_VERSION')) {
        return $keys[0];
    }
    if (class_exists('RankMath')) {
        return $keys[1] ?? $keys[0];
    }
    return end($keys);
}

function seo_table_permission(): bool
{
    return current_user_can('edit_posts');
}

add_action('rest_api_init', static function (): void {
    register_rest_route(SEO_TABLE_NS, '/seo', [
        [
            'methods'             => 'GET',
            'permission_callback' => 'seo_table_permission',
            'args'                => ['post' => ['required' => true, 'type' => 'integer']],
            'callback'            => static function (WP_REST_Request $req) {
                $postId = (int) $req->get_param('post');
                if (!get_post($postId)) {
                    return new WP_Error('not_found', 'No such post', ['status' => 404]);
                }
                $out = ['post' => $postId];
                foreach (['title', 'meta_description', 'canonical', 'meta_robots'] as $field) {
                    $key = seo_table_active_key($field);
                    $out[$field] = $key ? (get_post_meta($postId, $key, true) ?: null) : null;
                }
                return rest_ensure_response($out);
            },
        ],
        [
            'methods'             => 'POST',
            'permission_callback' => 'seo_table_permission',
            'callback'            => 'seo_table_write',
        ],
    ]);

    register_rest_route(SEO_TABLE_NS, '/redirects', [
        'methods'             => 'GET',
        'permission_callback' => 'seo_table_permission',
        'callback'            => static fn () => rest_ensure_response(get_option(SEO_TABLE_REDIRECT_OPTION, [])),
    ]);
});

function seo_table_write(WP_REST_Request $req)
{
    $field = (string) $req->get_param('field');

    if ($field === 'redirect') {
        $from = (string) $req->get_param('from');
        $to   = (string) $req->get_param('to');
        $code = (int) ($req->get_param('status') ?: 301);
        if ($from === '' || $to === '') {
            return new WP_Error('bad_request', 'from and to are required', ['status' => 400]);
        }
        if (!in_array($code, [301, 302, 307, 308], true)) {
            return new WP_Error('bad_request', 'Unsupported redirect status', ['status' => 400]);
        }
        $fromPath = seo_table_path($from);
        $redirects = get_option(SEO_TABLE_REDIRECT_OPTION, []);
        $previous = $redirects[$fromPath]['to'] ?? null;
        $redirects[$fromPath] = ['to' => $to, 'status' => $code, 'updated' => gmdate('c')];
        update_option(SEO_TABLE_REDIRECT_OPTION, $redirects, false);
        return rest_ensure_response(['ok' => true, 'value' => $to, 'previous' => $previous]);
    }

    $postId = (int) $req->get_param('post');
    $value  = (string) $req->get_param('value');
    if (!get_post($postId)) {
        return new WP_Error('not_found', 'No such post', ['status' => 404]);
    }
    $key = seo_table_active_key($field);
    if ($key === null) {
        return new WP_Error('unsupported_field', "Cannot write {$field}", ['status' => 422]);
    }
    $previous = get_post_meta($postId, $key, true) ?: null;
    update_post_meta($postId, $key, wp_kses_post($value));
    return rest_ensure_response([
        'ok'       => true,
        'field'    => $field,
        'value'    => get_post_meta($postId, $key, true),
        'previous' => $previous,
        'store'    => $key,
    ]);
}

function seo_table_path(string $url): string
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    return '/' . trim($path, '/');
}

/** Serve the redirects this plugin stores. Runs before WordPress resolves a 404. */
add_action('template_redirect', static function (): void {
    if (is_admin()) {
        return;
    }
    $redirects = get_option(SEO_TABLE_REDIRECT_OPTION, []);
    if (!is_array($redirects) || $redirects === []) {
        return;
    }
    $current = seo_table_path($_SERVER['REQUEST_URI'] ?? '/');
    if (!isset($redirects[$current]['to'])) {
        return;
    }
    $target = (string) $redirects[$current]['to'];
    $status = (int) ($redirects[$current]['status'] ?? 301);
    wp_redirect($target, $status);
    exit;
}, 1);

/** Emit the robots directive SEO Table stored, when one is set for this post. */
add_filter('wp_robots', static function (array $robots): array {
    if (!is_singular()) {
        return $robots;
    }
    $value = get_post_meta(get_the_ID(), '_seo_table_robots', true);
    if (!is_string($value) || $value === '') {
        return $robots;
    }
    foreach (array_map('trim', explode(',', $value)) as $directive) {
        if ($directive === '') {
            continue;
        }
        if ($directive === 'index') {
            unset($robots['noindex']);
            $robots['index'] = true;
        } elseif ($directive === 'follow') {
            unset($robots['nofollow']);
            $robots['follow'] = true;
        } else {
            $robots[$directive] = true;
        }
    }
    return $robots;
}, 20);
