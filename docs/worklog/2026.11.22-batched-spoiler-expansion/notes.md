# Batched spoiler expansion

- Expand collapsed spoilers in small batches and yield between batches so Arena can render updates without blocking the popup.
- Report cumulative click progress against the batch total.
- Added a regression test covering 25 spoilers and three event-loop yields.
- Bumped the extension version to 0.2.7.
