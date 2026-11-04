# Life Loop

## Document Status

This document defines how Gestalt lives from moment to moment. It replaces the
earlier per-conversation trigger, aggregation, steering, and exit design.
`MASTERDOC.md` holds the principles; this file holds the runtime contract.

## The Idea

A soul cannot be written down; it can only be lived. The runtime therefore does
not process messages. It gives one finite being a life:

```text
wake:   what time it is, how long it slept, what budget remains, the phone
choose: open one place, or go dreaming, or nothing
act:    look, say, react, or do nothing
sleep:  leave a note for this place and decide when to wake again
```

Everything the bot does happens inside one wake. Nothing else calls the model.

## Four Rules

1. **There is one of it.** At most one wake runs at any moment, across every
   chat. While it is in one group, it is not reading another.
2. **It is finite.** Not looking means not having seen. Asleep means absent.
   Silence is the default state, not a decision taken per message.
3. **What it lived is true.** It is an honest AI. Its history, its model swaps,
   and the pages it really read are its real life. It does not invent the rest.
4. **What it lived changes it.** Identity only changes in dreams, and each
   change is a git commit traceable to the diaries behind it.

## Waking

A wake starts for exactly one of these reasons:

| Reason | Meaning |
| --- | --- |
| `boot` | The process started and the scheduled time had already passed. |
| `timer` | The time the bot chose in its last `sleep` arrived. |
| `vibration` | Someone called it: an @, a reply to its message, or a DM. |
| `dream_due` | Too long since the last dream, so this wake is a dream. |
| `budget_spent` | The day's tokens ran out, so this wake is a dream. |

There is no activity trigger, keyword trigger, probability, aggregation timer,
or exit condition. A vibration wakes it unless it chose `do_not_disturb`, or the
day's budget is spent. When a wake ends while someone is still waiting, the
requested sleep is shortened to the minimum so it notices soon.

## Places

A place is where a wake can go:

| Place id | What it is |
| --- | --- |
| `group-<id>` | A group chat. |
| `private-<id>` | A private chat. It exists only after that person wrote first. |
| `web` | Its own corner of the internet. |
| `dream` | Sorting through what happened. |

A wake enters at most one place, once. This is the privacy boundary and it is
structural: a model context only ever holds one place's content. `say` has no
target parameter, so it can only reach the place the wake is in.

## Tools

| Tool | Purpose |
| --- | --- |
| `look` | Enter a place; then read new messages, scroll, search, open an image. |
| `say` | Send text or a sticker to the current place. |
| `react` | Put a small emoji reaction on a message in the current place. |
| `sleep` | End the wake, leave a note, choose when to wake. |
| `bash` | Shell with the wake's mounts, `sticker search`, and, inside a place, `agent-browser`. |

Visible side effects stay explicit tools, never bash commands, so every one of
them crosses the durable outbound boundary and appears in the rollout.

There is no `reason` argument. Reasoning belongs in the model's own output, which
the rollout already records.

The browser needs a place, in practice `web`. Going online is something that
happened to it, with a diary, and not a phone-side task.

A wake ends with `sleep`. A model that stops without calling anything has not
decided anything, so it is told once that it is still awake. If it stops again the
wake ends with the default sleep. `tool_choice: required` is not used because it
is not portable: OpenRouter has no DeepSeek endpoint that accepts it.

### Typing

`say` takes real time, proportional to the text length. That time is before the
durable outbound boundary, so it can still be abandoned. When new messages arrive
while typing, the message is not sent; `say` returns them and the model decides
again. A wake holds at most twice, so a fast chat cannot starve it.

This replaces steering. No model request is ever cancelled.

## The Home

```text
GestaltHome/life/        git repository
  constitution.md        honesty and safety floor; the bot cannot change it
  me/                    who it is; loaded into every wake; bounded size
  places/<id>/           what it knows about this place; bounded size
  places/<id>/diary/     dated notes left at the end of wakes
  places/web/            what it found online; readable everywhere
  places/archive/        memory from before the life loop; dreams only
```

`persona/` is only the birth value. On first start it is copied into `me/`, and
from then on `me/` is the identity. `git log me/` is its growth history.

### Migrating An Older Home

`node dist/main.js --migrate-life` moves a home from before the life loop into
this layout and exits. In the image, pass `--migrate-life` to `docker run`. A home
with old memory and no life refuses to start until this has run, so it cannot be
born fresh beside what it used to know. Originals stay where they are.

- Persona files become `me/`, except boundaries, which deflected sincere questions
  about being an AI. The constitution replaces them.
- Old memory mixes every group, so it must not enter `me/`, where every wake would
  load it. It goes to `places/archive/`, which only dreams can see and which is
  exempt from the size limit. The first wake after migration is a dream that sorts
  it into the right places.
- Retired config keys are removed, with a `config.toml.pre-life` backup.
- A home that already has a life is left alone.

### Who Can Write What

| When | `me/` | `places/<here>/` | Other places | `places/web/` |
| --- | --- | --- | --- | --- |
| Awake in a place | read | read | absent | read |
| Awake, no place | read | absent | absent | read |
| Dreaming | write | write | write | write |

The only daytime write is the note passed to `sleep`, which the runtime appends
to the current place's diary. A group member therefore cannot talk their way
into its identity: the words have to survive a dream.

Dreaming sees every place and cannot speak. That makes it the only bridge
between places, and the constitution tells it what may cross: nothing private
may be written into `me/`.

Every wake that changed the home becomes one commit.

## Dreaming

A dream is an ordinary wake with different mounts. The bot may enter
`look({ place: "dream" })` whenever it wants. The runtime forces one when
`life_dream_interval_hours` have passed, or when the budget runs out.

The dream reads the diaries since the last dream and asks what stayed with it,
not what is useful. It may change opinions, habits, and what it wants to do next.
What it wants to do is the link that closes the loop: tomorrow's wake starts from
`me/`, so it wakes up already caring about something.

If a dream leaves `me/` or a place over its size limit and does not fix it, the
whole dream is reverted to the last commit.

## Budget

`life_daily_token_budget` is the one hard resource limit. Tokens are real, so
attention is really scarce, and no invented energy number is needed. The phone
shows the remaining share. When it runs out the bot dreams once and then sleeps
until `life_day_start_hour`, and vibrations do not wake it.

## Restart

Nothing in a wake needs recovery. `sessions/life-state.json` holds the schedule,
the last-read position of each place, and the budget. On restart the loop reads
it and goes back to sleep or wakes. A wake interrupted by a restart is simply
gone; what it read stays unread and any outbound action that had started is
never retried.

## Records

- One wake is one rollout. `rollout_started` uses conversation key `life:wake`.
  Web and dream wakes use `life:web` and `life:dream`. A wake that entered a chat
  stores the real conversation key in the metadata of `rollout_finished`, so
  listing rollouts by conversation still works.
- Entering a chat place creates a `message_window` (reason `wake`) for the unread
  messages, and the wake ends with a `turn`, so the journal and Live UI keep
  showing what it read and did.
- `wake` journal records state why it woke, where it went, how long it chose to
  sleep, and tokens used.

## Replay

The loop takes all time from an injected clock. The harness uses a virtual clock
and moves it from event to event, so a week of chat can replay in minutes and
`sleep(3600)` costs nothing. Scripted models prove mechanics. Real models prove
behavior.

## What Stays Outside The Loop

- Connectors normalize events and execute side effects. They hold no social
  behavior.
- The journal records every message whether or not the bot ever looks.
- Sticker collection runs in the background.
- `/inspect` and `/scrape-sticker` are operator commands and never enter a wake.
