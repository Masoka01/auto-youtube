/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['fluent-ffmpeg'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },
};

export default nextConfig;
