![Banner](./assets/banner.webp)

# Gestalt

A chatbot that has a life rather than a queue. It wakes, chooses one place, acts or does not, and goes back to sleep. Who it becomes comes from what it lived through. See [the life loop](docs/LIFE_LOOP.md).

## Features

- One life across every chat: a single wake at a time, a daily token budget, and sleep it chooses itself.
- Group replies, DM replies, reactions, images, stickers, and silence as the default.
- Its own corner of the internet through just-bash and agent-browser.
- Identity and memory in a git repository, changed only by dreaming.
- Background sticker collection, vision analysis, embedding search, and model-selected sending.

## Docker

Create `gestalt-home/config.toml` from the example below, set `MODEL_API_KEY`
and `ONEBOT_ACCESS_TOKEN` in your environment, then run:

```sh
docker run --rm --name gestalt \
  -p 3000:3000 \
  -e MODEL_API_KEY \
  -e ONEBOT_ACCESS_TOKEN \
  -v "$PWD/gestalt-home:/var/lib/gestalt" \
  ghcr.io/zhousiru/gestalt
```

The mounted directory stores all runtime data and must be writable. The live UI is available at `http://localhost:3000` when enabled.
The published image targets `linux/amd64` because it includes the pinned
Fortress stable browser bundle. Fortress CDP runs only on random loopback ports
inside the container; port 9222 is not exposed.

## Configuration

Gestalt reads strict, flat TOML from `GestaltHome/config.toml`. See the [configuration reference](docs/CONFIGURATION.md) for every available setting.

Example:

```toml
allowedgroups = ["123456789"]

connector = "onebot-forward-ws"
onebot_ws_url = "ws://onebot:3001"
onebot_access_token_env = "ONEBOT_ACCESS_TOKEN"

live_enabled = true
live_host = "0.0.0.0"
live_port = 3000

main_model_provider = "openai-compatible"
main_model_base_url = "https://your-model-provider.example/v1"
main_model_name = "your-model"
main_model_api_key_env = "MODEL_API_KEY"

# Optional vision model for sticker understanding. Other fields inherit above.
sub_model_name = "your-vision-model"

embedding_model_provider = "openai-compatible"
embedding_model_base_url = "https://your-model-provider.example/v1"
embedding_model_name = "your-embedding-model"
embedding_model_id = "your-embedding-model:1024"
embedding_model_api_key_env = "MODEL_API_KEY"
embedding_model_dimensions = 1024

sticker_scraping_enabled = true
```

## Persona

Put one or more persona files in `gestalt-home/persona/`. A single `persona.md` is enough. It is a birth value: after first start the identity lives in `life/me/`. See [writing a persona](docs/PERSONA.md). A home from an older version needs [migrating](docs/LIFE_LOOP.md#migrating-an-older-home).

> [!NOTE]
> Currently tested only on QQ through OneBot v11.
