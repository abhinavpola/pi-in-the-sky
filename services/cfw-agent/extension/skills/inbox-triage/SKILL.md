---
name: inbox-triage
description: Search Gmail threads, summarize urgent items, and prepare draft replies without sending unconfirmed emails.
---

# Inbox Triage

1. Query relevant messages with `gmail_search`.
2. Fetch full thread details with `gmail_get_message` for actionable items.
3. Group findings by urgent action required, waiting on others, and informational.
4. Use `gmail_create_draft` for replies; ask the user in chat before sending any external communication.
