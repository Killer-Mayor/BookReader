import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '../index.css'
import '../App.css'

export const metadata: Metadata = {
  title: 'Audio Reader',
  description: 'A local-first book reader with TTS and optional cloud sync.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
