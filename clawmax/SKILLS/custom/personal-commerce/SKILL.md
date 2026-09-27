---
name: personal-commerce
description: Find compatible replacement products for the user's devices and add them to the RecallLens demo cart. Never purchases.
tags: [commerce, recalllens]
metadata: {"openclaw":{"requires":{"bins":["curl"]}}}
---

# personal-commerce

| Tool | Call |
|---|---|
| get_user_profile | `curl -s -X POST http://127.0.0.1:3000/api/tools/get_user_profile -d '{}'` |
| search_products | `curl -s -X POST http://127.0.0.1:3000/api/tools/search_products -H 'Content-Type: application/json' -d '{"query":"USB-C charger","compatibility":"Demo Phone"}'` |
| add_to_cart | `curl -s -X POST http://127.0.0.1:3000/api/tools/add_to_cart -H 'Content-Type: application/json' -d '{"product_id":"charger-usbc-20w"}'` |

Flow: get_user_profile → search_products(compatibility = phone_model) → choose a full charger (not a cable-only item) → add_to_cart only after the user asked for a replacement.
Report success only when the response has `"success": true`. Nothing is ever purchased; the cart is for the user to review.
