import type { MetadataRoute } from 'next';
import { ICON_URL } from './icon-version';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'JIRA Timer',
    short_name: 'JIRA Timer',
    description: 'Track active time against assigned JIRA stories.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    icons: [
      { src: ICON_URL, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: ICON_URL, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
