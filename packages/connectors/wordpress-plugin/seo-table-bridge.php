<?php
/**
 * Plugin Name: SEO Table Bridge
 * Description: Exposes the SEO fields WordPress core keeps out of the REST API (SEO title, meta description, canonical, robots) plus a redirect table, so SEO Table can apply approved fixes. When neither Yoast nor Rank Math is active it also prints those fields on the front end.
 * Version:     0.5.0
 * Requires PHP: 8.0
 * License:     MIT
 *
 * Install as a must-use plugin:
 *   wp-content/mu-plugins/seo-table-bridge.php
 *
 * Permissions: post fields need `edit_post` on that very post; redirects need
 * `manage_options`, because a redirect changes where any visitor of any URL ends
 * up. Redirect targets must stay on this site unless a host is allowed through
 * the `seo_table_redirect_allowed_hosts` filter. Nothing here is public.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

const SEO_TABLE_VERSION = '0.5.0';
const SEO_TABLE_NS = 'seo-table/v1';
const SEO_TABLE_REDIRECT_OPTION = 'seo_table_redirects';
const SEO_TABLE_FIELDS = ['title', 'meta_description', 'canonical', 'meta_robots'];
const SEO_TABLE_REDIRECT_CODES = [301, 302, 307, 308];
/** Directives accepted for meta_robots; anything else is refused rather than stored. */
const SEO_TABLE_ROBOTS = ['index', 'noindex', 'follow', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex', 'notranslate', 'none', 'all'];

// ---------------------------------------------------------------- storage

function seo_table_store(): string
{
    if (defined('WPSEO_VERSION')) {
        return 'yoast';
    }
    if (class_exists('RankMath')) {
        return 'rankmath';
    }
    return 'own';
}

/** The meta key holding a scalar field in the active store. meta_robots is structured and handled apart. */
function seo_table_meta_key(string $field): ?string
{
    $keys = [
        'yoast'    => ['title' => '_yoast_wpseo_title', 'meta_description' => '_yoast_wpseo_metadesc', 'canonical' => '_yoast_wpseo_canonical'],
        'rankmath' => ['title' => 'rank_math_title', 'meta_description' => 'rank_math_description', 'canonical' => 'rank_math_canonical_url'],
        'own'      => ['title' => '_seo_table_title', 'meta_description' => '_seo_table_description', 'canonical' => '_seo_table_canonical', 'meta_robots' => '_seo_table_robots'],
    ];
    return $keys[seo_table_store()][$field] ?? null;
}

/** "noindex, follow" -> ['noindex', 'follow'] with unknown directives rejected. */
function seo_table_parse_robots(string $value): ?array
{
    $out = [];
    foreach (explode(',', strtolower($value)) as $directive) {
        $directive = trim($directive);
        if ($directive === '') {
            continue;
        }
        if (!in_array($directive, SEO_TABLE_ROBOTS, true)) {
            return null;
        }
        $out[] = $directive;
    }
    return array_values(array_unique($out));
}

function seo_table_get(int $postId, string $field): ?string
{
    if ($field === 'meta_robots') {
        $store = seo_table_store();
        if ($store === 'rankmath') {
            $robots = get_post_meta($postId, 'rank_math_robots', true);
            return is_array($robots) && $robots !== [] ? implode(', ', $robots) : null;
        }
        if ($store === 'yoast') {
            $parts = [];
            $noindex = (string) get_post_meta($postId, '_yoast_wpseo_meta-robots-noindex', true);
            if ($noindex === '1') {
                $parts[] = 'noindex';
            } elseif ($noindex === '2') {
                $parts[] = 'index';
            }
            $nofollow = (string) get_post_meta($postId, '_yoast_wpseo_meta-robots-nofollow', true);
            if ($nofollow === '1') {
                $parts[] = 'nofollow';
            }
            $adv = (string) get_post_meta($postId, '_yoast_wpseo_meta-robots-adv', true);
            foreach (array_filter(array_map('trim', explode(',', $adv))) as $directive) {
                if ($directive !== 'none' && $directive !== '-') {
                    $parts[] = $directive;
                }
            }
            return $parts === [] ? null : implode(', ', $parts);
        }
    }
    $key = seo_table_meta_key($field);
    if ($key === null) {
        return null;
    }
    $value = get_post_meta($postId, $key, true);
    return is_string($value) && $value !== '' ? $value : null;
}

/** Store a value, or with null remove it, in whichever SEO plugin owns the field. */
function seo_table_set(int $postId, string $field, ?string $value): void
{
    if ($field === 'meta_robots' && seo_table_store() !== 'own') {
        $directives = $value === null ? [] : (seo_table_parse_robots($value) ?? []);
        if (seo_table_store() === 'rankmath') {
            if ($directives === []) {
                delete_post_meta($postId, 'rank_math_robots');
            } else {
                update_post_meta($postId, 'rank_math_robots', wp_slash($directives));
            }
            return;
        }
        $noindex = in_array('noindex', $directives, true) ? '1' : (in_array('index', $directives, true) ? '2' : '');
        $nofollow = in_array('nofollow', $directives, true) ? '1' : '';
        $adv = array_values(array_intersect($directives, ['noimageindex', 'noarchive', 'nosnippet']));
        foreach ([
            '_yoast_wpseo_meta-robots-noindex'  => $noindex,
            '_yoast_wpseo_meta-robots-nofollow' => $nofollow,
            '_yoast_wpseo_meta-robots-adv'      => implode(',', $adv),
        ] as $key => $stored) {
            if ($stored === '') {
                delete_post_meta($postId, $key);
            } else {
                update_post_meta($postId, $key, wp_slash($stored));
            }
        }
        return;
    }

    $key = seo_table_meta_key($field);
    if ($key === null) {
        return;
    }
    if ($value === null) {
        delete_post_meta($postId, $key);
        return;
    }
    update_post_meta($postId, $key, wp_slash($value));
}

/** Clean a submitted value for its field; WP_Error when it cannot be stored. */
function seo_table_clean(string $field, string $value)
{
    switch ($field) {
        case 'title':
        case 'meta_description':
            return sanitize_text_field($value);
        case 'canonical':
            $url = esc_url_raw($value, ['http', 'https']);
            return $url === '' ? new WP_Error('invalid_value', 'canonical must be an http(s) URL', ['status' => 400]) : $url;
        case 'meta_robots':
            $directives = seo_table_parse_robots($value);
            if ($directives === null || $directives === []) {
                return new WP_Error('invalid_value', 'meta_robots must be a comma-separated list of known robots directives', ['status' => 400]);
            }
            return implode(', ', $directives);
    }
    return new WP_Error('unsupported_field', 'Unknown field', ['status' => 400]);
}

// ---------------------------------------------------------------- paths & redirects

/**
 * The key a URL is stored and matched under: percent-decoded path (so %C3%A9,
 * %c3%a9 and a raw é are one key), no trailing slash, plus the query string with
 * its parameters sorted when there is one.
 */
function seo_table_path(string $url): string
{
    $path = rawurldecode((string) parse_url($url, PHP_URL_PATH));
    $path = '/' . trim($path, '/');
    $query = (string) parse_url($url, PHP_URL_QUERY);
    if ($query === '') {
        return $path;
    }
    parse_str($query, $params);
    ksort($params);
    return $path . '?' . http_build_query($params);
}

function seo_table_redirects(): array
{
    $redirects = get_option(SEO_TABLE_REDIRECT_OPTION, []);
    return is_array($redirects) ? $redirects : [];
}

function seo_table_host(string $host): string
{
    return preg_replace('/^www\./', '', strtolower($host)) ?? '';
}

/** Absolute redirect target on this site (or an allowed host), or WP_Error. */
function seo_table_redirect_target(string $to)
{
    $to = trim($to);
    if (str_starts_with($to, '/') && !str_starts_with($to, '//')) {
        $to = home_url($to);
    }
    $to = esc_url_raw($to, ['http', 'https']);
    $host = (string) parse_url($to, PHP_URL_HOST);
    if ($to === '' || $host === '') {
        return new WP_Error('invalid_target', 'The redirect target must be an http(s) URL', ['status' => 400]);
    }
    $allowed = array_map(static fn ($h) => seo_table_host((string) $h), (array) apply_filters(
        'seo_table_redirect_allowed_hosts',
        [(string) parse_url(home_url(), PHP_URL_HOST)]
    ));
    if (!in_array(seo_table_host($host), $allowed, true)) {
        return new WP_Error('external_target', 'Redirects may only point to this site', ['status' => 400]);
    }
    return $to;
}

/** True when sending $from to $to would come back to $from through the stored redirects. */
function seo_table_would_loop(string $fromKey, string $to, array $redirects): bool
{
    $key = seo_table_path($to);
    for ($hops = 0; $hops < 20; $hops++) {
        if ($key === $fromKey) {
            return true;
        }
        $next = $redirects[$key]['to'] ?? ($redirects[explode('?', $key, 2)[0]]['to'] ?? null);
        if (!is_string($next)) {
            return false;
        }
        $key = seo_table_path($next);
    }
    return true;
}

function seo_table_allowed_redirect_hosts(array $hosts): array
{
    return array_merge($hosts, (array) apply_filters('seo_table_redirect_allowed_hosts', []));
}

// ---------------------------------------------------------------- REST

/**
 * URLs keep their percent-encoding: sanitize_text_field would strip %xx octets
 * and turn every non-Latin path into a different one.
 */
function seo_table_trim($value): string
{
    return trim(wp_strip_all_tags((string) $value));
}

function seo_table_can_edit_post(WP_REST_Request $req): bool
{
    $postId = (int) $req->get_param('post');
    return $postId > 0 && current_user_can('edit_post', $postId);
}

function seo_table_can_manage(): bool
{
    return current_user_can('manage_options');
}

function seo_table_field_arg(bool $required): array
{
    return [
        'required'          => $required,
        'type'              => 'string',
        'enum'              => SEO_TABLE_FIELDS,
        'sanitize_callback' => 'sanitize_key',
    ];
}

function seo_table_post_arg(): array
{
    return [
        'required'          => true,
        'type'              => 'integer',
        'minimum'           => 1,
        'sanitize_callback' => 'absint',
        'validate_callback' => static fn ($v) => is_numeric($v) && get_post((int) $v) !== null,
    ];
}

function seo_table_url_arg(): array
{
    return [
        'required'          => true,
        'type'              => 'string',
        'sanitize_callback' => static fn ($v) => esc_url_raw((string) $v, ['http', 'https']),
        'validate_callback' => static fn ($v) => is_string($v) && parse_url($v, PHP_URL_HOST) !== null && parse_url($v, PHP_URL_HOST) !== false,
    ];
}

add_action('rest_api_init', static function (): void {
    register_rest_route(SEO_TABLE_NS, '/info', [
        'methods'             => 'GET',
        'permission_callback' => static fn () => current_user_can('edit_posts'),
        'callback'            => static fn () => rest_ensure_response([
            'version' => SEO_TABLE_VERSION,
            'store'   => seo_table_store(),
        ]),
    ]);

    register_rest_route(SEO_TABLE_NS, '/resolve', [
        'methods'             => 'GET',
        'permission_callback' => static fn () => current_user_can('edit_posts'),
        'args'                => ['url' => seo_table_url_arg()],
        'callback'            => 'seo_table_resolve',
    ]);

    register_rest_route(SEO_TABLE_NS, '/seo', [
        [
            'methods'             => 'GET',
            'permission_callback' => 'seo_table_can_edit_post',
            'args'                => ['post' => seo_table_post_arg()],
            'callback'            => static function (WP_REST_Request $req) {
                $postId = (int) $req->get_param('post');
                $out = ['post' => $postId, 'store' => seo_table_store()];
                foreach (SEO_TABLE_FIELDS as $field) {
                    $out[$field] = seo_table_get($postId, $field);
                }
                return rest_ensure_response($out);
            },
        ],
        [
            'methods'             => 'POST',
            'permission_callback' => 'seo_table_can_edit_post',
            'args'                => [
                'post'  => seo_table_post_arg(),
                'field' => seo_table_field_arg(true),
                // Must be present (checked in seo_table_write, since WordPress treats a
                // required null as missing); null deletes, exactly like DELETE.
                'value' => ['type' => ['string', 'null']],
            ],
            'callback'            => 'seo_table_write',
        ],
        [
            'methods'             => 'DELETE',
            'permission_callback' => 'seo_table_can_edit_post',
            'args'                => ['post' => seo_table_post_arg(), 'field' => seo_table_field_arg(true)],
            'callback'            => 'seo_table_write',
        ],
    ]);

    register_rest_route(SEO_TABLE_NS, '/redirects', [
        [
            'methods'             => 'GET',
            'permission_callback' => 'seo_table_can_manage',
            'args'                => ['from' => ['type' => 'string', 'sanitize_callback' => 'seo_table_trim']],
            'callback'            => static function (WP_REST_Request $req) {
                $redirects = seo_table_redirects();
                $from = (string) $req->get_param('from');
                if ($from === '') {
                    return rest_ensure_response($redirects);
                }
                $key = seo_table_path($from);
                return rest_ensure_response([
                    'from'   => $key,
                    'to'     => $redirects[$key]['to'] ?? null,
                    'status' => $redirects[$key]['status'] ?? null,
                ]);
            },
        ],
        [
            'methods'             => 'POST',
            'permission_callback' => 'seo_table_can_manage',
            'args'                => [
                'from'   => ['required' => true, 'type' => 'string', 'sanitize_callback' => 'seo_table_trim'],
                // Validated and esc_url_raw'd in seo_table_redirect_target.
                'to'     => ['required' => true, 'type' => 'string', 'sanitize_callback' => 'seo_table_trim'],
                'status' => ['type' => 'integer', 'default' => 301, 'enum' => SEO_TABLE_REDIRECT_CODES],
            ],
            'callback'            => 'seo_table_redirect_write',
        ],
        [
            'methods'             => 'DELETE',
            'permission_callback' => 'seo_table_can_manage',
            'args'                => ['from' => ['required' => true, 'type' => 'string', 'sanitize_callback' => 'seo_table_trim']],
            'callback'            => 'seo_table_redirect_write',
        ],
    ]);
});

/** The post behind a public URL, including the front page, which url_to_postid does not know. */
function seo_table_resolve(WP_REST_Request $req)
{
    $url = (string) $req->get_param('url');
    $postId = url_to_postid($url);
    if ($postId === 0 && seo_table_path($url) === seo_table_path(home_url('/'))) {
        $postId = get_option('show_on_front') === 'page' ? (int) get_option('page_on_front') : 0;
    }
    $post = $postId > 0 ? get_post($postId) : null;
    if (!$post) {
        return new WP_Error('not_found', 'No post has this address', ['status' => 404]);
    }
    if (!current_user_can('edit_post', $post->ID)) {
        return new WP_Error('rest_forbidden', 'You cannot edit this post', ['status' => 403]);
    }
    $type = get_post_type_object($post->post_type);
    return rest_ensure_response([
        'id'             => $post->ID,
        'type'           => $post->post_type,
        'rest_base'      => $type && $type->rest_base ? $type->rest_base : $post->post_type,
        'rest_namespace' => $type && !empty($type->rest_namespace) ? $type->rest_namespace : 'wp/v2',
        'link'           => get_permalink($post),
    ]);
}

function seo_table_write(WP_REST_Request $req)
{
    $postId = (int) $req->get_param('post');
    $field = (string) $req->get_param('field');
    if ($req->get_method() !== 'DELETE' && !$req->has_param('value')) {
        return new WP_Error('rest_missing_callback_param', 'Missing parameter(s): value', ['status' => 400]);
    }
    $raw = $req->get_method() === 'DELETE' ? null : $req->get_param('value');

    $value = null;
    if ($raw !== null) {
        $value = seo_table_clean($field, (string) $raw);
        if (is_wp_error($value)) {
            return $value;
        }
    }

    $previous = seo_table_get($postId, $field);
    seo_table_set($postId, $field, $value);
    return rest_ensure_response([
        'ok'       => true,
        'field'    => $field,
        'value'    => seo_table_get($postId, $field),
        'previous' => $previous,
        'store'    => seo_table_store(),
    ]);
}

function seo_table_redirect_write(WP_REST_Request $req)
{
    $from = (string) $req->get_param('from');
    $key = seo_table_path($from);
    if ($key === '/' && $req->get_method() !== 'DELETE') {
        return new WP_Error('invalid_source', 'The home page cannot be redirected', ['status' => 400]);
    }
    $redirects = seo_table_redirects();
    $previous = $redirects[$key]['to'] ?? null;

    if ($req->get_method() === 'DELETE') {
        unset($redirects[$key]);
        update_option(SEO_TABLE_REDIRECT_OPTION, $redirects, false);
        return rest_ensure_response(['ok' => true, 'value' => null, 'previous' => $previous]);
    }

    $to = seo_table_redirect_target((string) $req->get_param('to'));
    if (is_wp_error($to)) {
        return $to;
    }
    if (seo_table_would_loop($key, $to, $redirects)) {
        return new WP_Error('redirect_loop', 'This redirect would create a loop', ['status' => 400]);
    }
    $redirects[$key] = ['to' => $to, 'status' => (int) $req->get_param('status'), 'updated' => gmdate('c')];
    update_option(SEO_TABLE_REDIRECT_OPTION, $redirects, false);
    return rest_ensure_response(['ok' => true, 'value' => $to, 'previous' => $previous]);
}

// ---------------------------------------------------------------- front end

/** Serve the stored redirects. Runs before WordPress resolves a 404. */
add_action('template_redirect', static function (): void {
    if (is_admin()) {
        return;
    }
    $redirects = seo_table_redirects();
    if ($redirects === []) {
        return;
    }
    $key = seo_table_path((string) ($_SERVER['REQUEST_URI'] ?? '/'));
    // An exact query-string entry wins; a path-only entry matches any query.
    $entry = $redirects[$key] ?? $redirects[explode('?', $key, 2)[0]] ?? null;
    if (!is_array($entry) || !isset($entry['to'])) {
        return;
    }
    $target = (string) $entry['to'];
    if (seo_table_path($target) === $key) {
        return;
    }
    $status = (int) ($entry['status'] ?? 301);
    add_filter('allowed_redirect_hosts', 'seo_table_allowed_redirect_hosts');
    // wp_safe_redirect would send a disallowed target to wp-admin instead; a
    // target that is no longer allowed is simply not served.
    if (wp_validate_redirect($target, '') === '') {
        return;
    }
    if (wp_safe_redirect($target, in_array($status, SEO_TABLE_REDIRECT_CODES, true) ? $status : 301, 'SEO Table')) {
        exit;
    }
}, 1);

/*
 * With Yoast or Rank Math active they print these fields from the keys written
 * above. Without them nothing would, so the bridge prints its own.
 */
if (!defined('WPSEO_VERSION') && !class_exists('RankMath')) {
    add_filter('pre_get_document_title', static function (string $title): string {
        if (!is_singular()) {
            return $title;
        }
        $own = seo_table_get((int) get_queried_object_id(), 'title');
        return $own ?? $title;
    }, 20);

    add_action('wp_head', static function (): void {
        if (!is_singular()) {
            return;
        }
        $description = seo_table_get((int) get_queried_object_id(), 'meta_description');
        if ($description !== null) {
            echo '<meta name="description" content="' . esc_attr($description) . '" />' . "\n";
        }
    }, 1);

    add_filter('get_canonical_url', static function ($url, $post) {
        $own = $post ? seo_table_get((int) $post->ID, 'canonical') : null;
        return $own ?? $url;
    }, 20, 2);

    add_filter('wp_robots', static function (array $robots): array {
        if (!is_singular()) {
            return $robots;
        }
        $value = seo_table_get((int) get_queried_object_id(), 'meta_robots');
        foreach (seo_table_parse_robots((string) $value) ?? [] as $directive) {
            $opposite = ['index' => 'noindex', 'noindex' => 'index', 'follow' => 'nofollow', 'nofollow' => 'follow'][$directive] ?? null;
            if ($opposite !== null) {
                unset($robots[$opposite]);
            }
            $robots[$directive] = true;
        }
        return $robots;
    }, 20);
}
