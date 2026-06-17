/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [],
  },
  eslint: {
    // No ESLint config/deps are installed in this project; skip linting
    // during `next build` so the build never blocks on an interactive
    // "install eslint?" prompt in non-TTY environments.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
