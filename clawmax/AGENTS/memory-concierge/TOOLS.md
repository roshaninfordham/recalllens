# Tools

All tools are RecallLens HTTP endpoints, called with `curl` as described in the `cognee-memory` and
`personal-commerce` skills. The base URL and a one-reply bearer token arrive in the header of each message.

- Memory (Cognee): `recall_object`, `recall_recent_events`, `current_view`, `remember_observation`, `forget_memory`
- Commerce (demo cart, never purchases): `get_user_profile`, `search_products`, `add_to_cart`
