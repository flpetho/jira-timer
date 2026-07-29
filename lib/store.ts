import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { TimerState } from './types';
import { emptyState, normalizeState } from './timer-logic';

const DIR = path.join(os.homedir(), '.jira-timer');
export const STATE_FILE = path.join(DIR, 'state.json');

export async function readState(): Promise<TimerState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Backfills fields added after a state file was written.
    return normalizeState({ activeKey: parsed.activeKey ?? null, stories: parsed.stories ?? {} });
  } catch {
    return emptyState();
  }
}

export async function writeState(state: TimerState): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
