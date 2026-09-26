// HSTS only for production builds: a browser that saw it on http://localhost
// would refuse plain HTTP to every local port for the max-age.
const hsts =
  process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : [];

// React's development build evaluates code for its debugging tools; production never needs eval.
const scriptSrc = process.env.NODE_ENV === "development" ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["@seo/core", "@seo/db", "@seo/connectors", "@seo/pipeline", "@seo/seo-data", "@seo/social"],
  poweredByHeader: false,
  // Loaded from node_modules at runtime instead of bundled: native bindings,
  // worker threads (pino) and undici's own dynamic requires do not survive webpack.
  serverExternalPackages: ["pg", "bullmq", "ioredis", "pino", "undici"],
  // Workspace packages use NodeNext-style ".js" specifiers that point at ".ts"
  // sources; teach webpack the same mapping TypeScript already understands.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...hsts,
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};
export default nextConfig;
