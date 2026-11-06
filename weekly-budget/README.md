# weekly-budget

A Claude Code plugin for planning your weekly Claude usage limit. You decide how the week is shared out across the days, for example only 10% at the weekend, and it shows where you stand against that plan. It can warn you when you run ahead of it, or hold your next message back until you snooze. It works in the terminal, in the VS Code extension and in the Claude desktop app.

- `/budget` shows where you stand, and the details say where your pace leads: when today's share runs out, and whether the week lasts. `/budget snooze 1h` silences warnings.
- `/budget-config` sets the plan, the leftover (Fixed or Adaptive), the warnings and the display.

Install, in a Claude Code session:

```
/plugin install weekly-budget --marketplace Fafafa12/claude-weekly-budget
```

Full documentation: https://github.com/Fafafa12/claude-weekly-budget#readme
