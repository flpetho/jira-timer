/** @type {import('next').NextConfig} */

// `next dev` and `next start` would otherwise share ./.next, so starting a dev
// server in this checkout rewrites the build the always-on launchd agent is
// serving — it then 500s with MODULE_NOT_FOUND on chunks that no longer exist.
// Giving dev its own directory lets both run side by side.
// `next dev` sets NODE_ENV=development; `next build` and `next start` set production.
const isDev = process.env.NODE_ENV === 'development';

const nextConfig = {
  distDir: isDev ? '.next-dev' : '.next',
};

module.exports = nextConfig;
