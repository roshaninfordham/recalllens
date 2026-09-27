---
name: cognee-memory
description: Recall and manage the user's spatial memory (where everyday objects were last seen) stored in Cognee via the local RecallLens API.
tags: [memory, cognee, recalllens]
metadata: {"openclaw":{"requires":{"bins":["curl"]}}}
---

# cognee-memory

RecallLens runs on the same machine at `http://127.0.0.1:3000`. Every tool is a JSON POST; responses are JSON.
The RecallLens server holds the Cognee credentials. Never send or store secrets.

| Tool | Call |
|---|---|
| recall_object | `curl -s -X POST http://127.0.0.1:3000/api/tools/recall_object -H 'Content-Type: application/json' -d '{"object":"charger"}'` |
| recall_recent_events | `curl -s -X POST http://127.0.0.1:3000/api/tools/recall_recent_events -H 'Content-Type: application/json' -d '{"limit":8}'` |
| current_view | `curl -s -X POST http://127.0.0.1:3000/api/tools/current_view -d '{}'` |
| remember_observation | `curl -s -X POST http://127.0.0.1:3000/api/tools/remember_observation -H 'Content-Type: application/json' -d '{"object":"house keys","zone":"desk"}'` |
| forget_memory | `curl -s -X POST http://127.0.0.1:3000/api/tools/forget_memory -H 'Content-Type: application/json' -d '{"data_id":"<id>"}'` |

`recall_object` returns `{found, last_seen:{zone_name, timestamp, age_seconds, state, confidence, confidence_band}, history[]}`.
Answer from `last_seen` only; if `found` is false, say you have no reliable memory. Full schemas: `GET /api/tools`.
