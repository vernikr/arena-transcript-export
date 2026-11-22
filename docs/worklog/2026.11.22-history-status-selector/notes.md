# History loader status detection

- Filtered `role="status"` to the actual “Loading earlier messages” indicator.
- Arena can render unrelated message notices with the same role; these previously kept the history loader waiting indefinitely.
- Added a regression test using the tool-call-limit notice found in the supplied archive.
- Bumped the extension version to 0.2.6.
