# Configuration Reference

Gestalt reads `config.toml` from GestaltHome. The file uses flat TOML keys: nested tables, unknown keys, invalid types, and out-of-range values fail at startup. Secrets should be stored in environment variables and referenced by name.

## Connector and host

| Key | Description | Default |
| --- | --- | --- |
| `connector` | `mock`, `onebot-forward-ws`, or `onebot-reverse-ws`. | `mock` |
| `allowedgroups` | Optional array of group IDs. Events from other groups are ignored. | All groups |
| `onebot_ws_url` | OneBot WebSocket URL; required in forward mode. | — |
| `onebot_host` | Bind address for reverse mode. | `0.0.0.0` |
| `onebot_port` | Bind port; required in reverse mode. | — |
| `onebot_path` | WebSocket path for reverse mode. | `/onebot/v11/ws` |
| `onebot_access_token_env` | Environment variable containing the OneBot token. | — |
| `live_enabled` | Enable the live trace UI and API. | `false` |
| `live_host` | Live server bind address. Use `0.0.0.0` in Docker. | `127.0.0.1` |
| `live_port` | Live server port. | `3000` |

## Language models

`main_model_*` configures wakes, dreams, and inspect. `main_model_base_url` and `main_model_name` are required when the model is used. `sub_model_*` configures auxiliary work such as sticker understanding; every omitted sub-model field inherits its resolved main-model value.

Both prefixes support these suffixes:

| Suffix | Description | Main-model default |
| --- | --- | --- |
| `provider` | Provider adapter name. | `openai-compatible` |
| `base_url` | OpenAI-compatible API base URL. | Required |
| `name` | Provider model ID. | Required |
| `api_key_env` | Environment variable containing the API key. | `MODEL_API_KEY` |
| `api_key` | Direct API key. Mutually exclusive with `api_key_env`; environment variables are preferred. | — |
| `temperature` | Non-negative sampling temperature. | `1` |
| `max_steps` | Maximum tool-loop steps. | `1000` |
| `routing_order` | Comma-separated provider routing preference; an empty string clears inherited sub-model routing. | — |
| `routing_allow_fallbacks` | Allow providers outside `routing_order`. | Provider default |
| `routing_sort` | `price`, `throughput`, `latency`, or an empty string. | Provider default |
| `thinking` | Provider-specific thinking mode; an empty string disables the override. | Provider default |
| `tool_choice` | `required`, `auto`, `none`, or an empty string. Leave unset or use `auto` unless the provider accepts `required`; a wake that stops without `sleep` is nudged once either way. | Provider default |
| `prompt_cache_enabled` | Enable provider prompt caching. | Provider-dependent |
| `prompt_cache_ttl` | `5m`, `1h`, or an empty string. | Provider default |

## Embedding model

The embedding role is independent and does not inherit language-model settings.

| Key | Description | Default |
| --- | --- | --- |
| `embedding_model_provider` | Provider adapter name. | `openai-compatible` |
| `embedding_model_base_url` | Embedding API base URL. | Required when configured |
| `embedding_model_name` | Provider model ID. | Required when configured |
| `embedding_model_id` | Stable identity for vector-space compatibility. Change it when the model or dimensions change. | Required when configured |
| `embedding_model_api_key_env` | Environment variable containing the API key. | `EMBEDDING_MODEL_API_KEY` |
| `embedding_model_api_key` | Direct API key; mutually exclusive with `embedding_model_api_key_env`. | — |
| `embedding_model_dimensions` | Expected positive vector length. Responses with another length are rejected. | Unchecked |
| `embedding_model_routing_order` | Comma-separated provider routing preference. | — |
| `embedding_model_routing_allow_fallbacks` | Allow providers outside the routing order. | Provider default |

## Stickers

| Key | Description | Default |
| --- | --- | --- |
| `sticker_scraping_enabled` | Collect observed stickers for later retrieval. | `false` |
| `sticker_processing_concurrency` | Parallel sticker-analysis jobs (`1`–`32`). | `1` |
| `operator_user_ids` | Users allowed to change sticker scraping with runtime commands. | `[]` |

## Identity, context, and persistence

| Key | Description | Default |
| --- | --- | --- |
| `timezone` | IANA timezone used in model context. | System timezone, then UTC |
| `bot_user_id` | Bot ID stored for self-authored session messages. | Connector account ID, then `gestalt-bot` |
| `bot_display_name` | Bot name stored for self-authored session messages. | `Gestalt` |
| `session_recent_history_hours` | Journal history restored at startup. | `24` |
| `context_recent_message_count` | Earlier messages shown above the unread ones when entering a place (`0`–`500`). | `12` |
| `trace_binary_capture_enabled` | Persist binary trace blobs. Privacy-sensitive. | `false` |

## Life

Every value has a default. See [LIFE_LOOP.md](LIFE_LOOP.md) for what they govern.
There is deliberately nothing here about probabilities, triggers, or aggregation.

| Key | Description | Default |
| --- | --- | --- |
| `life_daily_token_budget` | Tokens per day. When spent it dreams, then sleeps until the day starts, and calls do not wake it. | `2000000` |
| `life_day_start_hour` | Local hour the budget and the diary day roll over. | `5` |
| `life_min_sleep_seconds` | Shortest sleep, also used when someone is still waiting. | `15` |
| `life_max_sleep_seconds` | Longest sleep. | `28800` |
| `life_default_sleep_seconds` | Sleep used when a wake ends without choosing one. | `600` |
| `life_bash_timeout_seconds` | How long one bash command may run. Wakes are serial, so a stuck command must not hold up the rest. | `120` |
| `life_dream_interval_hours` | Longest time between dreams before one is forced. | `24` |
| `life_typing_ms_per_char` | Time `say` takes per character. | `150` |
| `life_typing_min_ms` | Shortest typing time. | `800` |
| `life_typing_max_ms` | Longest typing time. | `8000` |
| `life_unread_limit` | Most unread messages shown when entering a place. | `40` |
| `life_wake_max_steps` | Model steps in one wake. | `16` |
| `life_dream_max_steps` | Model steps in one dream. | `64` |
| `life_me_max_bytes` | Size limit of `me/`. | `24576` |
| `life_place_max_bytes` | Size limit of one place, not counting its diary. | `24576` |
