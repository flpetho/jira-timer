import { describe, it, expect } from 'vitest';
import { missingCreds, reasonForStatus, CRED_VARS } from './conn';

// Realistic filled-in values. Deliberately avoids the .env.example placeholders,
// which count as unset — see the placeholder tests below.
const full = {
  JIRA_BASE_URL: 'https://acme.atlassian.net',
  JIRA_EMAIL: 'dana@acme.com',
  JIRA_API_TOKEN: 'ATATTsomethingsecret',
};

describe('missingCreds', () => {
  it('returns nothing when all three are set', () => {
    expect(missingCreds(full)).toEqual([]);
  });

  it('names each var when it alone is absent', () => {
    for (const v of CRED_VARS) {
      const env = { ...full, [v]: undefined };
      expect(missingCreds(env)).toEqual([v]);
    }
  });

  it('names every absent var when nothing is set', () => {
    expect(missingCreds({})).toEqual([...CRED_VARS]);
  });

  it('reports in CRED_VARS order regardless of key order', () => {
    expect(missingCreds({ JIRA_EMAIL: 'dana@acme.com' })).toEqual([
      'JIRA_BASE_URL',
      'JIRA_API_TOKEN',
    ]);
  });

  it('treats blank and whitespace-only values as absent', () => {
    expect(missingCreds({ ...full, JIRA_API_TOKEN: '' })).toEqual(['JIRA_API_TOKEN']);
    expect(missingCreds({ ...full, JIRA_API_TOKEN: '   ' })).toEqual(['JIRA_API_TOKEN']);
  });

  // Copying .env.example and filling in only some fields is the most common
  // setup mistake. Each untouched placeholder must read as "not configured yet"
  // rather than producing a confusing 401 or DNS failure downstream.
  it.each([
    ['JIRA_API_TOKEN', 'paste-your-token-here'],
    ['JIRA_BASE_URL', 'https://your-org.atlassian.net'],
    ['JIRA_EMAIL', 'you@example.com'],
  ])('treats the shipped %s placeholder as absent', (key, placeholder) => {
    expect(missingCreds({ ...full, [key]: placeholder })).toEqual([key]);
  });

  it('flags every var when .env.example is copied but never edited', () => {
    expect(
      missingCreds({
        JIRA_BASE_URL: 'https://your-org.atlassian.net',
        JIRA_EMAIL: 'you@example.com',
        JIRA_API_TOKEN: 'paste-your-token-here',
      }),
    ).toEqual([...CRED_VARS]);
  });
});

describe('reasonForStatus', () => {
  it('treats 401 and 403 as rejected credentials', () => {
    expect(reasonForStatus(401)).toBe('rejected');
    expect(reasonForStatus(403)).toBe('rejected');
  });

  it('treats other failures as unreachable', () => {
    for (const s of [0, 404, 500, 502, 503]) {
      expect(reasonForStatus(s)).toBe('unreachable');
    }
  });

  it('treats 2xx as ok', () => {
    expect(reasonForStatus(200)).toBe('ok');
    expect(reasonForStatus(204)).toBe('ok');
  });
});
