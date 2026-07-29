import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JIRA Timer',
  description: 'Track active time against assigned JIRA stories.',
  icons: { icon: '/icon.svg' },
};

export const viewport = {
  themeColor: '#0b0e14',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
