# 2026.10.10 — themed UI, detailed progress, release artifact, icon

## Scope
System-theme (light/dark) popup styled after native Chrome; staged, granular progress; downloadable
zip artifact on GitHub; toolbar icon in Chrome's Material-outline (2px, gray) idiom.
Input: the user's first live export (679 KB markdown) — verified 0 unexpanded spoilers, 349
activity sections, no residue; exposed one defect.

## Done
- fix(util): topbar renders the branch title twice without a separator (button + tooltip) →
  dedupe repeated-unit titles (`X+X → X`, ≥3-char unit guard); fixes duplicated H1 and filename.
- feat(ui): popup rewritten — `prefers-color-scheme` palette mapped to native Chrome tokens
  (accent #1a73e8/#8ab4f8, surfaces, focus rings, accent-color checkboxes), staged scrollable
  progress log with per-stage spinner→✓ and a final ok/warn summary.
- feat(progress): loader now reports scan/page(+delta)/loading/settle/retry phases (was a single
  opaque line for the whole history stage); expander reports click vs settle phases; serialize
  reports assembled byte size.
- feat(icon): Material-outline document+download glyph, 2px stroke, #5f6368, 24px grid;
  PNG 16/32/48/128/512 rasterized from vector geometry; wired into manifest icons + action icon.
- chore(release): `arena-transcript-export-v0.2.0.zip` published on the v0.2.0 GitHub Release;
  tag-driven release workflow (zip → gh release upload --clobber) + test CI on every push.

## Verification
- 26/26 jsdom units green (incl. new title-dedupe cases).
- Release asset presence confirmed via API (browser_download_url).
