# Memory Model

## Document Status

This document records how Gestalt remembers. [LIFE_LOOP.md](LIFE_LOOP.md) holds the
runtime contract for wakes, and this file holds what memory is and how it changes.
Implementation lives in `packages/app/src/life/`: `store.ts` owns the home,
`bash.ts` owns the mounts, and `wake.ts` owns what a wake can read.

## What Memory Is

Memory is the part of its life the bot still carries. It is plain Markdown in a git
repository at `GestaltHome/life/`, and nothing else holds it: no vector search, no
database, no numeric relationship scores, no memory patch language.

```text
life/
  constitution.md        the floor; the bot cannot change it
  me/                    who it is; loaded into every wake
  places/<id>/           what it knows about this place
  places/<id>/diary/     dated notes from wakes there
  places/web/            what it found online
  places/archive/        memory from before the life loop; dreams only
```

The runtime does not prescribe files inside `me/` or a place. The first version of
`me/` is the persona, and the bot rearranges it however it likes.

## Three Speeds

| Layer | Written | Read |
| --- | --- | --- |
| The journal | Every message, by the runtime | `look`, in the wake's one place |
| Diaries | The note passed to `sleep` | That place, recent days; dreams, everything |
| `me/` and place memory | Only in dreams | `me/` always; place memory when in that place |

A diary is what happened. Place memory is what it still knows about there. `me/` is
who that made it. Each layer is smaller and slower than the one before it, and
moving something up a layer is a judgment the bot makes in a dream.

## Places Are The Privacy Boundary

Old memory was keyed by user and loaded by participant, so what someone said in one
group could surface in another. Memory is now keyed by place, and a wake holds one
place. Only dreams see every place, and they cannot speak.

The constitution says what may cross: nothing private may be written into `me/`,
because `me/` loads everywhere. Group-level knowledge of a person stays in that
group's place, even when the same person is in two places. Production data shows
that is rare: only 1 of 14 active senders spans groups.

The cost is real and accepted: in group B it does not know what just happened in
group A until a dream has passed.

## What Goes Into A Wake

A wake's system prompt carries the constitution and `me/`. Entering a chat place
adds that place's memory, its recent diary, and the unread messages. `/me`, `/web`,
and `/here` are mounted read-only in `bash` for anything else it wants to check.

Sizes are bounded by `life_me_max_bytes` and `life_place_max_bytes` so a long life
does not cost more to carry each year. Diaries and the archive do not count: a diary
is read by the day and the archive is waiting to be sorted.

## Dreaming

A dream is an ordinary wake with different mounts: `/me` and `/places` are
writable, there is no browser, and `say` and `react` have nowhere to go. It starts
when the bot chooses `look({ place: "dream" })`, when `life_dream_interval_hours`
pass, or when the budget runs out.

The dream reads the diaries since the last dream and asks what stayed with it, not
what is useful. Admission is "is this worth bringing up again", so trivia, jokes,
and someone's exact words can belong here. What made the bot feel like a group
member was remembering small things people said weeks earlier. Corrections replace
what was wrong rather than layering on top of it, stale material is deleted, and
unverified guesses are labeled.

A dream that fails, or that ends with something over its limit, is reverted with
`git reset --hard` and `git clean`. Refusing to sleep over the limit gives it the
chance to shorten first. Every wake that changed the home becomes one commit, so
`git log me/` is its growth history and each change traces back to diaries.

## Why Identity Only Changes In Dreams

The day has no write access to `me/`, by mount and not by instruction. A group member
therefore cannot talk their way into its identity. The words have to survive a
night in which it decides whether they mattered. The sleep note is the only daytime
write, and the runtime performs it.

## What It Does Not Remember

Nothing it did not look at. The journal records everything, but it does not read the
journal; it reads places, and only the places it went to. Not having seen something
is part of being finite, and `look` with `search` can still find it later.

## Harness Evidence

Scripted fixtures in `harness/fixtures/scenarios/` prove mechanics:
`life-dream-changes-me`, `life-oversized-dream-reverts`, `life-day-cannot-write-me`,
and `verify:migrate` for older homes. `life-model-dream` and the soul evals in
`harness/src/soul.eval.ts` judge whether real dreams keep what mattered.

Artifacts carry the home before and after, and `life-log` carries the commits. Read
them yourself; a passing check does not show that a dream was any good.
