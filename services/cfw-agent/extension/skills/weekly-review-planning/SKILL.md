---
name: weekly-review-planning
description: "Weekly reset: reconcile commitments, calendar capacity, stalled work, and next-week plan."
source: "Adapted from Hermes Agent (NousResearch/hermes-agent, skills/productivity/weekly-review-planning/SKILL.md)"
author: "Ben Barclay (benbarclay), Hermes Agent"
license: MIT
---

# Weekly Review and Planning

Run a bounded weekly reset across the user's calendar, inbox, and durable memory. Default to recommendations and drafts, not silent mutations.

## When to Use

- "Run my weekly review."
- "What did I commit to and what is slipping?"
- "Plan next week from my calendar, email, and notes."
- "Find stale projects and waiting items."

## Procedure

### 1. Set systems and window

Confirm timezone (`user_profile` via `sqlite_query`), review period, planning horizon, and allowed writes. Default to recommendations/drafts until approved.

### 2. Review calendar evidence

Call `calendar_list_events` for the completed week (meetings and commitments) and the next 1-2 weeks (deadlines, travel, preparation, and fixed load). Capture follow-ups implied by past events and conflicts ahead.

### 3. Clear capture inboxes

Inspect recent `memory_notes` via `sqlite_query` and flagged/unanswered email via `gmail_search` (use `skills/email-inbox-triage/SKILL.md` for deep thread triage). Classify each item into next action, project, waiting, scheduled, someday, or reference.

### 4. Reconcile active projects and commitments

For each active project or trip, identify desired outcome, next action, owner, deadline, and blocker. Flag items with no next action, missed dates, or silent waiting items — never infer that silence means completion.

### 5. Build a capacity-aware plan

Estimate fixed calendar load and choose a realistic set of next-week outcomes ranked by consequence, deadline, dependency, and effort. Do not fill every free hour; explicitly name what is deferred.

### 6. Apply approved updates

Save agreed plans/decisions to `memory_notes` via `sqlite_query` and create follow-up drafts via `gmail_create_draft` only after user confirmation.

## Output Shape

1. Wins and completed commitments
2. Overdue or at risk
3. Waiting/follow-ups
4. Stalled or ambiguous projects
5. Next week's outcomes and calendar constraints
6. Proposed updates awaiting approval
7. Coverage gaps

## Verification

- [ ] Both the completed week and the planning horizon were covered, or gaps are stated.
- [ ] Every stalled/waiting flag traces to a specific note, calendar event, or email thread.
- [ ] The plan fits actual calendar capacity and names what was deferred.
