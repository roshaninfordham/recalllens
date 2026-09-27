---
id: remember-and-assist
name: Remember and Assist
description: Recall where an object was last seen and, if it is damaged and the user wants, add a compatible replacement to the cart.
schedule: manual
enabled: true
executionMode: managed
owner: memory-concierge
targeting:
  agents: [memory-concierge]
---

# Remember and Assist

1. **Receive** the user's request (any language).
2. **Recall**: call `recall_object` (cognee-memory) for the object mentioned; check `current_view` if the user may be holding it now.
3. **Reason**: state the last reliable observation with time and confidence-appropriate wording. Note if its state is `damaged`.
4. **Act** (only if asked): `get_user_profile` → `search_products` with the phone as compatibility → pick a compatible full charger → `add_to_cart`.
5. **Report**: one or two sentences. Say what was added and that nothing was purchased.
