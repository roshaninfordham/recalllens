---
name: personal-commerce
description: Find a compatible replacement for the user's device accessories and add it to the RecallLens demo cart. Never purchases.
tags: [commerce, recalllens]
metadata: {"openclaw":{"requires":{"bins":["curl"]}}}
---

# personal-commerce

Use the tools URL and turn token from the `[RecallLens tools: … · turn token: … ]` header of the current message
(same rules as cognee-memory: this reply only, never store or repeat the token).

```bash
curl -s -X POST "<URL>/search_products" -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"query":"USB-C charger","compatibility":"Demo Phone"}'
```

| Tool | Body |
|---|---|
| `get_user_profile` | `{}` → `{phone_model}` |
| `search_products` | `{"query":"USB-C charger","compatibility":"<phone_model>"}` |
| `add_to_cart` | `{"product_id":"charger-usbc-20w"}` |

Flow: `get_user_profile` → `search_products` with the phone model as compatibility → choose a full charger (not a
cable-only item) and say why in one sentence → `add_to_cart`, only after the user asked for a replacement.
Report success only when the response has `"success": true`. Nothing is ever purchased; the cart is for the user to review.
