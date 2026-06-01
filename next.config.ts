import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ['kokoro-js'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.js', '.ts', '.tsx'],
    }

    return config
  },
}

export default nextConfig
