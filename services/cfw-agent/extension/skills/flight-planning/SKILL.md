---
name: flight-planning
description: Recall travel preferences, inspect past trip receipts, research current fares, and confirm with the user before booking.
---

# Flight & Trip Planning

1. Read standing preferences from `user_profile` via `sqlite_query` (home airport, airline, seating, hotel preferences).
2. Search prior trip receipts or confirmations with `gmail_search` and `gmail_get_message`.
3. Check schedule conflicts using `calendar_list_events`.
4. Research current fares and itineraries via `browser_navigate` and `browser_snapshot`.
5. Present exact itinerary, carrier, dates, and total price, and ask the user in chat before any checkout or payment.
6. Save new travel preferences or trip notes to `user_profile` or `memory_notes` via `sqlite_query`.
