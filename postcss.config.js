// Pass optimize explicitly. Tailwind caches compiled CSS per file and per the
// optimize option it receives, not per NODE_ENV. With the default, a dev server
// and a production build in one process (as in the browser tests) share one
// cache entry, and the dev server can get empty CSS.
export default ({ env }) => ({
  plugins: {
    "@tailwindcss/postcss": { optimize: env === "production" },
  },
});
