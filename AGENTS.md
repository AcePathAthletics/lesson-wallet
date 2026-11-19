## Agent skills

### Issue tracker

Issues tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Verification

`npm run verify` is the definition of done: it runs core tests without
`node_modules`, DB tests against the real migrations, a count guard, the
golden-path scenario, decision checks and a seeded-fault run, and writes
evidence to `verify-out/<timestamp>/`. Use `npm run verify:fast` in the
inner loop; CI runs the full command.

- Do not edit a test assertion to make it pass without sign-off. A red test is
  a real bug, a pglite/Supabase gap or a wrong test, and a human decides which.
- Adding or removing tests? Update `expectedTests` in `scripts/verify.config.json`.
- Closing a known gap? Remove it from `knownGaps` in the same change.
- Never apply migrations to the hosted Supabase project without sign-off.
