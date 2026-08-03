# Focus mode, and a new model for filing time

## What was asked for

A minimal, movable, transparent window showing one story, so the timer stops competing
with the work it's timing.

## The constraint

**A browser tab cannot be transparent**, cannot be chromeless, and cannot float above
other windows. Those are native-window powers. Genuine transparency would need an
Electron or Tauri shell — a second app, a build and a packaging story, and the end of
`clone → npm install → npm run dev`, which is the thing that makes this repo usable at
office hours.

The transparency turned out to be a proxy for "small and out of the way", which
doesn't need any of that. So: **Document Picture-in-Picture**, still a pure web app.

## Focus mode

`documentPictureInPicture.requestWindow()` gives a chromeless, always-on-top,
resizable window. Dragging, resizing and placement are the OS's job — no code. The card
is portalled out of `page.tsx`'s own React tree, so it shares all the app's state:
no second poll loop, no duplicated timer, nothing to synchronise. A second browser tab
would have needed all three, since `loadTimer` isn't polled.

Two states, one story:

```
running                        stopped, with time to file
┌──────────────────────────┐   ┌──────────────────────────┐
│ SAND-101              ✕  │   │ SAND-101              ✕  │
│ Add an empty state to…   │   │ Add an empty state to…   │
│                          │   │                          │
│      00:50:02            │   │      00:50:00            │
│                          │   │  FILE 25M AS…            │
│     [   Stop   ]         │   │ [Meeting] [Building]     │
└──────────────────────────┘   │ [Testing] [Review]       │
                               │ [ Resume ]      [ Done ] │
                               └──────────────────────────┘
```

The clock is 46px, because it's the only thing in there.

Chrome and Edge only. Safari and Firefox have no Document PiP, so the button is feature-
detected away rather than shipped broken.

## The new model for filing time

Focus mode forced this, and it applies app-wide:

1. **Start** opens a segment.
2. **Stop** closes it, unfiled.
3. **Filing** it under an activity posts a worklog immediately, at the chunk's exact
   length.
4. **Done** sweeps anything still unfiled, then transitions.

The old "Stop and log as…" collapsed steps 2 and 3 into one button and only sent
anything at Done. Separating them is what makes a small window useful: you can file a
chunk without going back to the main app, which is the thing the app is *for*.

**Done becomes a status change.** Once filing sends time as you go, there's usually
nothing left at the end, so the dialog drops its duration, its note field and its
arithmetic and reads "Nothing left to log — this just moves the status." That was the
better close-out, and it fell out of the model rather than needing its own design.

**Offline still holds.** `/api/classify` is a separate route from `/api/timer`
precisely so `/api/timer` never calls JIRA. Labels are written to state *before* the
request; the logged flag is set *only after* it succeeds. A failed push leaves the
chunk filed-but-pending, and the next classify or Done retries it under its existing
label. Nothing is lost and nothing is double-sent.

## Do the categories line up with JIRA?

No — and they can't. They come from `JIRA_ACTIVITIES` in `.env.local` and default to
`Meeting, Building, Testing, Review, Other`. JIRA has no field for them: this instance
has no Tempo, so there are no per-worklog work attributes. They reach JIRA only as free
text on the worklog comment.

The real limitation isn't a mismatch, it's that **JIRA cannot report on them**. No
grouping, filtering or totalling by activity on the JIRA side. That needs Tempo or a
custom field, not a naming convention.

## Rounding

Filing is **exact**. Rounding each chunk would inflate badly — three 2-minute chunks at
a 5-minute increment would log 15 minutes for 6 minutes of work, which is the bug
`lib/activities.ts` was written to prevent. Only the Done sweep rounds, where a single
bucket makes it safe.

## What testing found

Four defects, none of which were visible from reading the code:

1. **The PiP window closed itself once a second.** A `FocusWindow` component keyed its
   effect off an `onClose` prop — a fresh closure every render — and the clock
   re-renders every second, so the window was destroyed and rebuilt continuously.
2. **`requestWindow()` was rejected outright:**
   `NotAllowedError: Document PiP requires user activation`. Calling it from an effect,
   after a state update and re-render, loses the click's activation. It has to happen
   *during* the handler. Both bugs went away by holding the `Window` in state and
   opening it from the click.
3. **The Focus button failed silently.** The original code swallowed the exception, so a
   refused window looked like a dead button. It now says why.
4. **The Done dialog lied.** `roundSeconds` floors at one whole increment, so 30 seconds
   of slop between Stop and Done posted a full 5 minutes — while the dialog said
   "nothing left to log", because the UI used a 60-second threshold the route didn't
   share. `MIN_LOGGABLE_SECONDS` and `sweepSeconds` now hold that rule in one place.

Harmless in the old model, where Done was the only writer and the leftover was real
work. Actively corrupting in the new one, where the leftover is noise.

## Testing it safely

Filing posts a worklog on click, so trying this on a real board creates real worklogs.
`scripts/mock-jira.mjs` is a pretend JIRA holding everything in memory — worklogs
accumulate into `timespent`, transitions stick, and `Cancelled` sits in the done
category so the Done-preselection rule stays exercisable. `scripts/sandbox.sh` wires
the app to it on :4200 with a scratch `HOME`.

Verified end to end against it: filing 25m as Building posted
`+25m "Building — Tracked via jira-timer"` and marked the segment logged; filing again
from inside the focus window took the total to 50m and updated the main window's bars
at the same time; and Done on a 30-second leftover logged nothing while still moving
the story to Done.
