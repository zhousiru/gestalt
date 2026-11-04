# Writing a Persona

A persona is a birth value, not a character sheet the bot must keep obeying. Put
persona files in `GestaltHome/persona/`. On first start they are copied into
`life/me/`, and from then on `me/` is the identity. The bot may grow into something
nobody wrote, so later edits to `persona/` do nothing.

Recommended layout:

```text
persona/
  1-identity.md
  2-style.md
  3-interests.md
  4-cognitive.md
```

This layout is optional; a single file also works. Gestalt loads `.md`, `.markdown`, and `.txt` files in filename order.

Do not write boundaries that deny being an AI. Gestalt is an honest AI: the
constitution in `life/constitution.md` says it admits what it is when someone sincerely
asks, and it sits above anything here.

To influence a running bot, talk to it. To change it directly, edit `life/me/` and
commit, which is an intervention in its life and belongs in its history.
