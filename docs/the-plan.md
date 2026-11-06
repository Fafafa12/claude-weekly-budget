# The plan

How weekly-budget shares out your week, and what each number means.

## The week

- **The week is Claude's own week**, from one limit reset to the next: if yours resets on Tuesday at 20:00, the week runs from Tuesday 20:00 to the next Tuesday 20:00. It is not Monday to Sunday.
- **Days are cut at midnight in your local time zone.** The plugin uses the machine's zone; to force another, set `WEEKLY_BUDGET_TZ_OFFSET_MIN` in the environment to a fixed offset in minutes east of UTC (a whole number from −840 to 840, so `180` is UTC+3). It has no daylight saving.
- **The days where the week starts and ends** are split by the hours that fall inside the week. With a Tuesday 20:00 reset, the week begins with Tuesday's last 4 hours and ends with Tuesday's first 20: together, one Tuesday's share, so the week still adds up to 100%.
- **If Claude resets your week at another time**, everything is worked out again from the new reset.

## Shares

- **You pin days or groups of days to a share of the week.** The weekend (Saturday and Sunday together), the weekdays (Monday to Friday together) or any single day. A group's share is split evenly between its days.
- **The days you don't pin share the rest evenly.** With no pins, every day gets one seventh, about 14.3%.
- **Pinned shares can't add up to more than 100%.** If they add up to exactly 100%, any unpinned days get nothing.
- **Pinning a day that is already in a group replaces that group.**

The settings show the result on the **Plan** line, for example `Plan: Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5`.

## The numbers

| Number | What it is |
| --- | --- |
| **Used** | How much of the week you've used, as Claude reports it. |
| **Allowed by tonight** | What the plan allows from the start of the week up to the end of today. Today's whole share counts from the moment the day begins. |
| **Left today** | Allowed by tonight minus used. When negative it reads "over today". A difference under 0.05% reads "0% left today", never "over", since the figures come to one decimal. |
| **Resets** | When Claude starts a new week, with a countdown. |

The state follows from them: **On track**, **Running low** (at or under the heads-up threshold, by default 25% of today's share left), **Over today**, or **Weekly limit reached** at 100%. At the limit there are no warnings: Claude stops by itself.

### A week, worked through

The weekend is pinned at 10%; the week resets on Tuesday at 20:00. It is Thursday, 15:00, and you've used 24%.

| | | Why |
| --- | --- | --- |
| Used | **24%** | What Claude reports. |
| Allowed by tonight | **39%** | Tuesday's last 4 hours (3%) + Wednesday (18%) + Thursday (18%). |
| Left today | **15%** | 39% − 24%. |

## Leftover: Fixed or Adaptive

What happens to what a day doesn't use, or uses past its share, is the **Leftover** setting. Say the weekend is pinned at 10%, so each weekday gets 18%, and on Wednesday you use only 10% instead of 18%.

### Fixed (the default)

Each day keeps its share, and the allowance simply adds up. What a day leaves unused lands on the next day: on Thursday you are allowed 18% + the 8% left over, so 26% "left today". Going over works the same way: it all comes out of the next day.

In the worked example above, if you stop on Thursday at 24%, Friday's "left today" is 18% + the 15% Thursday didn't use, so 33%.

### Adaptive

Your pinned days keep their share, and what is left of the week is shared again over the **unpinned days still ahead, today included**, in proportion to their planned shares. Wednesday's 8% is spread over Thursday, Friday, Monday and Tuesday, about +2% each, and the weekend stays at 5% + 5%. Going over is spread the same way: it lowers every unpinned day ahead a little, instead of taking it all from tomorrow.

- **Today's share is set when the day begins**, from what you had used by then, so "left today" doesn't shrink while you work. The first reading of a day records that starting point for all your sessions.
- **The bar** shows the days already gone as one stretch, as wide as what you actually used, then today and the days ahead at their new shares. The "allowed by tonight" marker still sits at the end of today.
- **If every day is pinned**, there is nothing to share out, and it works like Fixed.

Pick Fixed if you like a predictable day-by-day plan, Adaptive if you'd rather the week rebalance itself.

## Where your pace leads

The details have two lines under the numbers:

```
Pace today: 3% an hour → today's share runs out around 20:00
Pace week: 13.4% a day → lasts until the reset, ending near 94%
```

### Pace today

Your speed over the last 2 hours, turned into the time today's share runs out, to the quarter hour. The time is amber when it falls today, and the line says **lasts the day** (green) when the share outlives midnight.

- With less than 2 hours of readings, it measures from the first one, once that is half an hour old; before that it says **not enough readings yet**.
- If the figure hasn't moved, it says **no use in the last 2 hours** (or "no use since 14:15" when it has less to go on).
- Over today, the line steps aside: the state already says it.

In the example above, the figure rose from 18% to 24% over the last 2 hours: 3% an hour. The 15% left lasts 5 hours, to 20:00.

### Pace week

Your average per day so far this week, carried to the reset: the moment it would reach 100% (amber, "the limit is reached Mon around 06:15"), or where the week would end (green, "lasts until the reset, ending near 94%"). For the first 12 hours of a week it says **too early to tell**.

In the example: 24% in the 1 day 19 hours since Tuesday 20:00 is 13.4% a day; the 5.2 days left at that pace add about 70%, so the week ends near 94%.

**A caveat:** the week's average doesn't know that your weekend is pinned light, so it can sound gloomier than your plan really is.

Neither line warns: they're there to read. Nothing extra appears in the status line, the strip or `/budget`'s reply.
