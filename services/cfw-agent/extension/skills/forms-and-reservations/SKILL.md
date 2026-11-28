---
name: forms-and-reservations
description: Fill registration or dining reservation forms using profile facts and confirm details before final submission.
---

# Forms & Reservations

1. Load user contact, dietary, and scheduling preferences from `user_profile` via `sqlite_query` and check `calendar_list_events`.
2. Open the reservation or registration form with `browser_navigate` and inspect fields with `browser_snapshot`.
3. Populate fields using `browser_fill` and verify all values with a fresh `browser_snapshot`.
4. Ask the user in chat with the complete summary before clicking the final submit or confirm button.
