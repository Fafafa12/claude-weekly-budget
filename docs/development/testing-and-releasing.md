# Testing and releasing

## Run it from a clone

```
git clone git@github.com:Fafafa12/claude-weekly-budget.git
cd claude-weekly-budget
claude --plugin-dir ./weekly-budget
```

`--plugin-dir` loads the plugin from the folder and reloads it as you edit. Don't also keep it installed from the marketplace in the same session: two copies with one name clash ("the name is already taken"), and each install source gets its own store, so their settings differ.

## Tests

```
claude plugin test weekly-budget
```

Run from the repository root. About 400 tests, a minute or so. They need no Claude login: the test kit (`claude-code/testing`) runs the hooks against a faked engine.

- **`lib/` tests** call the pure functions directly with a fixed `now` and a fixed time zone (`fixedOffsetTz(180)`).
- **`ui/` tests** mount a pane (`$.ui.mount`), then `find`, `findAll` and `press` its elements, for each surface.
- **`controller.test.ts`** drives whole sessions: an `engine()` helper fakes the clock, the environment, the store, the surfaces, `/usage` (`process.run`) and Anthropic's answers (`session.authorize`, `http.fetch`), and records what was drawn, toasted, opened and fetched.
- **Reading the store from a test:** the kit only lets the plugin's own hooks touch `$.store`, so tests register a small `store-probe` plugin whose `/probe <key>` command returns the stored value.

Write the failing test first, watch it fail for the right reason, then make it pass. A test that has never failed proves nothing.

## Checks

```
claude plugin validate .                 # the marketplace
claude plugin validate weekly-budget     # the plugin: manifest, hooks, $.state keys
tsc -p weekly-budget                     # types
```

The type check needs `weekly-budget/.claude-plugin/types/`, which Claude Code writes when a session loads the plugin (it's gitignored): on a fresh clone, run `claude --plugin-dir ./weekly-budget` once.

**On GitHub,** `.github/workflows/test.yml` installs a pinned Claude Code (raise `CLAUDE_CODE_VERSION` on purpose), validates both and runs the tests on every push and pull request. It skips the type check, since the types only exist after a session. The workflow is paused for now (`gh workflow disable Tests`) while GitHub lifts a lock on the account; `gh workflow enable Tests` turns it back on.

## Debugging

- **The engine refuses a tree the kit accepted.** The kit doesn't enforce every prop rule the apps do (a `Box` width must be a number or a whole percentage, for example). In VS Code a refused tree draws nothing; the Claude Code extension's log says why: search it for "hook skipped".
- **`claude --debug`** logs every hook failure and refused result as `weekly-budget: …`.
- **The desktop app** runs its own bundled Claude Code, which can be older than the CLI's; its logs are under the app's config folder (`~/.config/Claude/logs/` on Linux).

## The README pictures

```
npx tsx scripts/screens.ts
```

Redraws `assets/screens/*.svg` from the plugin's own `lib/` (the bar, the status line, the reply and the pace wording) on a made-up week, with the fictional account "Acme (you@acme.dev)". Run it after changing anything they show, and commit the result. Never use real screenshots: they show real accounts.

## Versions

`weekly-budget/.claude-plugin/plugin.json`'s `version` is what Claude Code compares to offer an update, so every change people should get needs a bump:

- **minor** (0.7.0 → 0.8.0) for something new
- **patch** (0.7.0 → 0.7.1) for a fix

## Releasing

1. **Bump** the version in `weekly-budget/.claude-plugin/plugin.json`.
2. **Write it up:** a new section at the top of `CHANGELOG.md` (`## 0.8.0 · YYYY-MM-DD`, then Added / Changed / Fixed), the README's version badge, and its "What's been built" table.
3. **Check:** tests, both validations and the type check pass.
4. **Commit and push** to `main`.
5. **Tag** the release commit and push the tag:

   ```
   git tag -a v0.8.0 -m "weekly-budget 0.8.0"
   git push origin v0.8.0
   ```

   A version's tag goes on the last commit before the next version begins.
6. **Publish the release** with the changelog section as its notes, plus a link to what changed since the previous tag:

   ```
   gh release create v0.8.0 --verify-tag --latest \
     --title "weekly-budget 0.8.0" --notes-file notes.md
   ```

7. **Update your own installs:** `claude plugin marketplace update weekly-budget`, `claude plugin update weekly-budget@weekly-budget`, and restart every Claude app (the desktop app keeps its own marketplace copy).
