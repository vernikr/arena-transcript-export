# 2026.11.22 — spoiler-aware progress percentage

- Calculate scan percentage from completed message and spoiler work units rather than messages alone.
- Count visible collapsed spoilers up front; add nested spoilers as parent panels reveal them.
- Keep the progress estimate monotonic when lazy discovery increases the denominator.
- Show expanded/total spoiler counts and the percentage in the popup log and toolbar tooltip.
- Add regression tests for message-plus-spoiler work units and dynamic nested-spoiler discovery.
