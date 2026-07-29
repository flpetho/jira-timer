'use client';

import { useState } from 'react';
import { activeSeconds, formatDurationShort } from '@/lib/time';
import { CRED_VARS, type CredVar, type MyselfResult } from '@/lib/conn';
import type { TimerState } from '@/lib/types';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Phrased as something you'd actually type at Claude Code, not as a command. */
const CLAUDE_RESTART_PROMPT = 'restart the JIRA timer so it picks up my new credentials';

/** What to show for each var in the copy block. Matches .env.example. */
const SAMPLE: Record<CredVar, string> = {
  JIRA_BASE_URL: 'https://your-org.atlassian.net',
  JIRA_EMAIL: 'you@example.com',
  JIRA_API_TOKEN: 'paste-your-token-here',
};

function envBlock(vars: readonly CredVar[]): string {
  return vars.map((v) => `${v}=${SAMPLE[v]}`).join('\n');
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — the text is on screen to copy by hand */
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <span className="faint">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function EnvBlock({ vars }: { vars: readonly CredVar[] }) {
  return <CopyBlock label=".env.local" text={envBlock(vars)} />;
}

/** How to make the server pick up new credentials. Differs by how it's running. */
function ApplyStep({ devMode }: { devMode: boolean }) {
  if (devMode) {
    return (
      <li>
        <b>Save the file.</b>{' '}
        <span className="muted">
          The dev server reloads it automatically — this screen will connect on its own within a
          few seconds.
        </span>
      </li>
    );
  }
  // The always-on build reads credentials at startup, so it needs a restart.
  // Most people meeting this screen have Claude Code open already, so asking it
  // beats switching to a terminal — but the command stays for when it isn't.
  return (
    <li>
      <b>Ask Claude Code to apply it.</b>{' '}
      <span className="muted">This build reads credentials at startup, so it needs a restart.</span>
      <CopyBlock label="ask Claude" text={CLAUDE_RESTART_PROMPT} />
      <div className="hint faint">
        Rather do it yourself? <code>sh scripts/service.sh update</code>
      </div>
    </li>
  );
}

function RawError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <details className="raw-error">
      <summary>What JIRA sent back</summary>
      <pre>{error}</pre>
    </details>
  );
}

/**
 * Reassurance strip. The timer persists to ~/.jira-timer/state.json and runs
 * without JIRA, so a mid-session disconnect must not look like lost time.
 * Pausing is a local write and needs no JIRA call.
 */
function LocalWork({
  timer,
  now,
  onPause,
  pausing,
}: {
  timer: TimerState | null;
  now: number;
  onPause: () => void;
  pausing: boolean;
}) {
  const stories = Object.values(timer?.stories ?? {});
  const unlogged = stories.filter((s) => s.doneAt == null);
  const total = unlogged.reduce((sum, s) => sum + activeSeconds(s.segments, now), 0);
  const activeKey = timer?.activeKey ?? null;
  const running = activeKey ? timer?.stories[activeKey] ?? null : null;

  // Only worth saying when there is actually time at stake. Durations are shown
  // to the minute, so anything under one would render as a meaningless "0m".
  if (total < 60 && !running) return null;

  return (
    <div className="reassure">
      {running && (
        <div className="reassure-run">
          <span className="key">{running.key}</span> is still running ·{' '}
          <b>{formatDurationShort(activeSeconds(running.segments, now))}</b>
        </div>
      )}
      <div className="muted">
        <b>{formatDurationShort(total)}</b> tracked across {unlogged.length}{' '}
        {unlogged.length === 1 ? 'story' : 'stories'}, saved on this machine. Nothing is lost —
        it will log to JIRA once you reconnect.
      </div>
      {running && (
        <button className="small" onClick={onPause} disabled={pausing}>
          {pausing ? 'Pausing…' : 'Pause timer'}
        </button>
      )}
    </div>
  );
}

export default function SetupScreen({
  me,
  timer,
  now,
  onRetry,
  onPause,
  pausing,
}: {
  me: MyselfResult | null;
  timer: TimerState | null;
  now: number;
  onRetry: () => void;
  onPause: () => void;
  pausing: boolean;
}) {
  if (!me) {
    // Avoids a flash of setup UI on every page load.
    return (
      <div className="card">
        <div className="spin">Checking connection…</div>
      </div>
    );
  }

  const devMode = me.devMode !== false;
  const missing = me.missing ?? [];
  const present = CRED_VARS.filter((v) => !missing.includes(v));
  const host = me.baseUrl ?? 'your JIRA site';

  return (
    <>
      {me.reason === 'unconfigured' && (
        <div className="card setup">
          <h2>Let&apos;s connect JIRA Timer</h2>
          <p className="muted intro">
            The timer runs entirely on your machine and talks to JIRA using your own API token.
            Nothing is shared with anyone else.
          </p>

          <div className="banner warn">
            {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not set.
            {present.length > 0 && (
              <>
                {' '}
                {present.join(' and ')} look{present.length === 1 ? 's' : ''} good.
              </>
            )}
          </div>

          <ol className="setup-steps">
            <li>
              <b>Create a JIRA API token.</b>{' '}
              <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
                Open the Atlassian token page ↗
              </a>
            </li>
            <li>
              <b>
                Add {missing.length === 1 ? 'it' : 'them'} to <code>.env.local</code>
              </b>{' '}
              in the project folder.
              <div className="hint faint">
                No <code>.env.local</code> yet? Run <code>cp .env.example .env.local</code> first.
              </div>
              <EnvBlock vars={missing} />
              {missing.includes('JIRA_BASE_URL') && (
                <div className="hint faint">
                  Your site URL is the address you see when JIRA is open in the browser — e.g.{' '}
                  <code>https://acme.atlassian.net</code>.
                </div>
              )}
            </li>
            <ApplyStep devMode={devMode} />
          </ol>
        </div>
      )}

      {me.reason === 'rejected' && (
        <div className="card setup">
          <h2>JIRA rejected your credentials</h2>
          <div className="banner bad">
            {host} returned HTTP {me.status}, so the token was refused.
          </div>
          <p className="muted">Usually one of:</p>
          <ul className="causes">
            <li>the token was revoked or has expired</li>
            <li>
              <code>JIRA_EMAIL</code> isn&apos;t the account that created the token
            </li>
            <li>the token was pasted with a missing or extra character</li>
          </ul>
          <ol className="setup-steps">
            <li>
              <b>Generate a fresh token.</b>{' '}
              <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
                Open the Atlassian token page ↗
              </a>
            </li>
            <li>
              <b>
                Replace the value in <code>.env.local</code>
              </b>
              <EnvBlock vars={['JIRA_API_TOKEN']} />
            </li>
            <ApplyStep devMode={devMode} />
          </ol>
          <RawError error={me.error} />
        </div>
      )}

      {me.reason === 'unreachable' && (
        <div className="card setup">
          <h2>Couldn&apos;t reach {host}</h2>
          <div className="banner bad">
            The credentials look complete, but the request didn&apos;t get through.
          </div>
          <ul className="causes">
            <li>
              Check <code>JIRA_BASE_URL</code> — it should be the address you see when JIRA is open
              in the browser, e.g. <code>https://acme.atlassian.net</code>, with no trailing path.
            </li>
            <li>If your JIRA sits behind a VPN, connect to it first.</li>
            <li>Confirm you&apos;re online, then retry.</li>
          </ul>
          <RawError error={me.error} />
        </div>
      )}

      <LocalWork timer={timer} now={now} onPause={onPause} pausing={pausing} />

      <div className="setup-actions">
        <button className="primary" onClick={onRetry}>
          Retry now
        </button>
        <span className="faint">Checking again automatically every few seconds…</span>
      </div>
    </>
  );
}
