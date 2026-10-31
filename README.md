# huddle.

**One live page for your group, with its own inbox — and a crew of Mozaik agents that file everything that lands in it.**

Group chats scroll away. Twelve messages to pick a cake, and the receipt is gone by dinner. Huddle is one shared page: move cards, vote, claim what you're bringing — everyone sees it as it happens. And the space has an email address. Forward the cake receipt and the agents take it from there: the **Clerk** files it as an expense and writes why on the slip, the **Treasurer** wakes up, splits it and emails you back with what everyone owes, and if you drop a link the **Scout** reads it and pins a summary with two questions for the group to argue about.

## Why Mozaik

A group space is exactly what Mozaik's runtime models: **humans, agents and observers in one shared environment, reacting to events concurrently.** Nothing in Huddle is orchestrated — every behaviour is a situation handler reacting to a semantic event.

```
 browser users ──(createHuman, one per person)──┐
 Mailroom (human) ── inbox.received ────────────┤
                                                ▼
                                   ┌──── Mozaik runtime ────┐
                                   │   every event fans out │
                                   │   to every participant │
                                   └────────────────────────┘
   Clerk (agent)      on inbox.received            → file_expense / file_note / create_poll / add_to_bring_list
                                                     └─ emits expense.filed
   Treasurer (agent)  on expense.filed             → send_reply (emails the sender back)
   Scout (agent)      on inbox.received|link.dropped, if it has a URL → read_url → post_link_card
   Ticker (observer)  on every event               → live "agents in the room" panel + activity feed
```

- **Concurrency** — a forwarded email that contains both a receipt and a link wakes the Clerk and the Scout at the same time; the Treasurer starts the moment the Clerk emits `expense.filed`, while the Clerk's own loop is still finishing. Each `runLoop` gets a fresh context so concurrent loops never interleave.
- **Awareness** — the agents never call each other. The Treasurer doesn't know the Clerk exists; it only knows the situation "an expense was filed". Add a fourth agent and nothing else changes.
- **Observer pattern** — the Ticker is a participant that never thinks or speaks. It turns `inference.started`, `function_call.started`, `model.answer` into the status lights and feed you see on the page.
- **Humans are participants too** — every person who joins becomes a `createHuman` participant, and their votes, claims and dropped links are published into the runtime as events (`poll.voted`, `item.claimed`, `link.dropped`).
- **Mozaik cloud** — on `@mozaik-ai/core` 4.x every loop, inference and tool step streams to Mozaik cloud automatically once the machine is paired.

## Run it

```bash
npm install
cp .env.example .env          # add OPENAI_API_KEY
npm run pair                  # optional: connect Mozaik cloud to watch the agents run
npm start                     # → http://localhost:3000
```

Open it in two tabs (or two browsers), pick different names, and vote in one. Then hit **🧾 cake receipt → Send to space** and watch the right-hand panel.

Without an API key Huddle runs in **offline mode**: the same runtime, events and tools, with simple heuristics standing in for the model — so the demo never dies on bad Wi-Fi.

`POST /api/inbox` with `{ from, subject, text }` is the space's inbox, so any inbound-email webhook (AgentMail, Postmark, Mailgun) can be pointed straight at it.

## Stack

TypeScript · `@mozaik-ai/core` 4.2 · Express · Server-Sent Events for live sync · one vanilla HTML page, no build step.

## Inspiration

The shared-page-with-an-inbox idea was inspired by *OurSpaces* (Thomas Nguyen & Holly Tran, Convex All Gas Hackathon). Huddle is a separate implementation built from scratch at the JigJoy hackathon around Mozaik's multi-agent runtime.
