/**
 * Browsers keep favicons in a store separate from the HTTP cache, and a hard
 * reload does not clear it — an edited icon can keep showing the old artwork
 * indefinitely. Changing the URL is the only reliable way to force a refetch.
 *
 * Bump this whenever public/icon.svg changes.
 */
export const ICON_VERSION = 2;

export const ICON_URL = `/icon.svg?v=${ICON_VERSION}`;
