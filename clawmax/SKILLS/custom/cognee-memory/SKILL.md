---
name: cognee-memory
description: Recall where the user's everyday objects were last seen (spatial memory stored in Cognee) through RecallLens's tool API.
tags: [memory, cognee, recalllens]
metadata: {"openclaw":{"requires":{"bins":["curl"]}}}
---

# cognee-memory

Every message from RecallLens starts with a header like:

`[RecallLens tools: https://<host>/tools · turn token: <TOKEN> (valid for this reply only) · user language: en-US]`

Use that URL and token for every call in this reply. Each tool is a JSON POST; replies are JSON. The token expires when
your reply ends: never store it, repeat it to the user, or put it in memory.

```bash
curl -s -X POST "<URL>/recall_object" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"object":"charger"}'
```

| Tool | Body | Returns |
|---|---|---|
| `recall_object` | `{"object":"charger"}` | `{found, last_seen:{zone_name, timestamp, age_seconds, state, damage_description, confidence, confidence_band}, history[]}` |
| `recall_recent_events` | `{"limit":8}` | newest memory events |
| `current_view` | `{}` | what the camera sees right now (live, not memory) |
| `remember_observation` | `{"object":"house keys","zone":"desk"}` | stores something the user told you |
| `forget_memory` | `{"data_id":"<id>"}` | deletes one stored observation |

Answer location questions only from `last_seen`. If `found` is false, say you have no reliable memory of it; never guess.
A `401` means the token expired: say so instead of retrying with anything else.
