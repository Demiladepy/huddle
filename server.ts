import "dotenv/config"
import express from "express"
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { lookup } from "node:dns/promises"
import { homedir } from "node:os"
import {
	defineRuntime,
	RuntimeState,
	createAgent,
	createHuman,
	SituationSpecification,
	SemanticEvent,
	ModelContext,
	DeveloperMessageItem,
	Agent,
	type Participant,
	type SituationContext,
	type SituationHandler,
	type Tool,
} from "@mozaik-ai/core"

// ───────────────────────────── config ─────────────────────────────
const PORT = Number(process.env.PORT ?? 3000)
const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY)
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY)
const HAS_GEMINI = Boolean(process.env.GEMINI_API_KEY)
const LIVE_AI = HAS_OPENAI || HAS_ANTHROPIC || HAS_GEMINI
// Pick a default model that matches whichever provider key is present.
const MODEL =
	process.env.MODEL ?? (HAS_OPENAI ? "gpt-5.4-mini" : HAS_ANTHROPIC ? "claude-sonnet-4-6" : HAS_GEMINI ? "gemini-3.5-flash" : "gpt-5.4-mini")
const SPACE_EMAIL = process.env.SPACE_EMAIL ?? "crew@huddle.space"
const DATA_FILE = process.env.DATA_FILE ?? "./data.json"
const CLOUD_PAIRED = Boolean(process.env.MOZAIK_API_KEY || process.env.MOZAIK_PROJECT_KEY || existsSync(`${homedir()}/.mozaik/credentials.json`))

// ───────────────────────────── space store ─────────────────────────────
type Kind = "note" | "poll" | "bring" | "expense" | "link" | "reply" | "mail"
type Card = { id: string; kind: Kind; x: number; y: number; by: string; createdAt: number; data: any }
type Activity = { id: string; at: number; who: string; role: "human" | "agent" | "system"; kind: string; text: string }
type Space = { name: string; email: string; members: string[]; cards: Card[]; activity: Activity[] }
type Mail = { from: string; subject: string; text: string }
// Each agent loop carries the mail it is working on, so two forwards landing at
// once can't overwrite each other's context between think() and a tool call.
const mailContext = new AsyncLocalStorage<Mail>()

function seed(): Space {
	return {
		name: "The Crew",
		email: SPACE_EMAIL,
		members: ["Ada", "Tunde", "Kemi"],
		cards: [
			{ id: randomUUID(), kind: "note", x: 40, y: 40, by: "Ada", createdAt: Date.now(), data: { title: "Kemi's birthday — Sat", body: "Surprise at Tunde's place. Don't tell her. Forward anything you buy to the space email.", color: "yellow" } },
			{ id: randomUUID(), kind: "poll", x: 320, y: 40, by: "Tunde", createdAt: Date.now(), data: { question: "Which cake?", options: [{ id: randomUUID(), label: "Red velvet", votes: ["Tunde"] }, { id: randomUUID(), label: "Chocolate", votes: [] }, { id: randomUUID(), label: "Ice-cream cake", votes: [] }] } },
			{ id: randomUUID(), kind: "bring", x: 40, y: 300, by: "Ada", createdAt: Date.now(), data: { title: "Who's bringing what", items: [{ id: randomUUID(), label: "Drinks", claimedBy: null }, { id: randomUUID(), label: "Speaker", claimedBy: "Tunde" }, { id: randomUUID(), label: "Balloons", claimedBy: null }] } },
		],
		activity: [],
	}
}

let space: Space = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf8")) : seed()
let saveTimer: NodeJS.Timeout | undefined
function persist() {
	clearTimeout(saveTimer)
	saveTimer = setTimeout(() => {
		// Write-then-rename so a crash mid-write cannot truncate the space.
		const tmp = `${DATA_FILE}.tmp`
		writeFileSync(tmp, JSON.stringify(space, null, 2))
		renameSync(tmp, DATA_FILE)
	}, 300)
}

// ───────────────────────────── live sync (SSE) ─────────────────────────────
const clients = new Set<express.Response>()
function broadcast(type: string, data: unknown) {
	const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
	for (const c of clients) {
		try {
			c.write(line)
		} catch {
			clients.delete(c)
		}
	}
}
function upsertCard(card: Card) {
	const i = space.cards.findIndex((c) => c.id === card.id)
	if (i >= 0) space.cards[i] = card
	else space.cards.push(card)
	persist()
	broadcast("card", card)
}
function removeCard(id: string) {
	space.cards = space.cards.filter((c) => c.id !== id)
	persist()
	broadcast("card.removed", { id })
}
function log(who: string, role: Activity["role"], kind: string, text: string) {
	const a: Activity = { id: randomUUID(), at: Date.now(), who, role, kind, text }
	space.activity.push(a)
	if (space.activity.length > 200) space.activity = space.activity.slice(-200)
	persist()
	broadcast("activity", a)
}
const agentStatus: Record<string, { state: string; detail: string; at: number }> = {}
function setStatus(name: string, state: string, detail = "") {
	agentStatus[name] = { state, detail, at: Date.now() }
	broadcast("status", { name, ...agentStatus[name] })
}

// place new agent-made cards in a free-ish spot on the right of the board
// two lanes: mail that lands on the left, what the agents made of it on the right
const LANE_HEIGHT: Record<Kind, number> = { note: 160, poll: 210, bring: 210, expense: 245, reply: 285, link: 345, mail: 275 }
const LANE_GAP = 14
let lanes = { mail: 40, out: 40 }
for (const c of space.cards) {
	const lane = c.x === 560 ? "mail" : c.x === 820 ? "out" : null
	if (lane) lanes[lane] = Math.max(lanes[lane], c.y + (LANE_HEIGHT[c.kind] ?? 260) + LANE_GAP)
}
function nextSpot(lane: "mail" | "out" = "out", kind: Kind = "note") {
	const y = lanes[lane]
	lanes[lane] = y + (LANE_HEIGHT[kind] ?? 260) + LANE_GAP
	if (lanes[lane] > 2000) lanes[lane] = 40
	return { x: lane === "mail" ? 560 : 820, y }
}

// ───────────────────────────── ledger ─────────────────────────────
function balances() {
	const net: Record<string, number> = {}
	for (const m of space.members) net[m] = 0
	for (const c of space.cards.filter((c) => c.kind === "expense")) {
		const { amount, payer, splitAmong } = c.data
		const among: string[] = splitAmong?.length ? splitAmong : space.members
		const share = amount / among.length
		net[payer] = (net[payer] ?? 0) + amount
		for (const m of among) net[m] = (net[m] ?? 0) - share
	}
	for (const k of Object.keys(net)) net[k] = Math.round(net[k] * 100) / 100
	return net
}

// ───────────────────────────── Mozaik runtime ─────────────────────────────
class SpaceState extends RuntimeState {
	inboxCount = 0
}
const { initializeRuntime, join, sendEvent, runLoop, resolveRuntime } = defineRuntime<SpaceState>()
initializeRuntime({ state: new SpaceState() })

// Specifications — "when" halves of situation handlers
class OnType extends SituationSpecification {
	constructor(private readonly type: string) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext) {
		return event.type === this.type
	}
}
class FromOthers extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext) {
		return event.producerId !== participant.getId()
	}
}
class HasLink extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext) {
		const p = event.payload as any
		return /https?:\/\/\S+/.test(`${p?.text ?? ""} ${p?.url ?? ""}`)
	}
}
class AnyEvent extends SituationSpecification {
	isSatisfiedBy() {
		return true
	}
}

// Fresh context per loop so concurrent loops on the same agent never interleave.
function contextFor(agent: Agent) {
	return ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
}
function think(agent: Agent, message: string) {
	runLoop(agent.getId(), message, { model: MODEL, context: contextFor(agent), tools: agent.getTools() })
}
const tool = (name: string, description: string, properties: Record<string, any>, required: string[], invoke: (a: any) => Promise<any>): Tool => ({
	type: "function",
	name,
	description,
	parameters: { type: "object", properties, required, additionalProperties: false },
	strict: false,
	invoke,
})
const str = (description: string) => ({ type: "string", description })

// ── The Clerk: reads everything that lands in the space inbox and files it.
const clerkTools: Tool[] = [
	tool(
		"file_expense",
		"File a purchase/receipt as an expense card. Use when the mail is a receipt, invoice, or someone says they paid for something.",
		{
			description: str("What was bought, short"),
			amount: { type: "number", description: "Total amount paid" },
			currency: str("Currency symbol or code, e.g. $, ₦, €"),
			payer: str("Member who paid (must be one of the members)"),
			split_among: { type: "array", items: { type: "string" }, description: "Members who share the cost. Default: all members." },
			reason: str("One short sentence explaining why this was filed as an expense, written on the slip"),
		},
		["description", "amount", "currency", "payer", "reason"],
		async (a) => {
			const payer = matchMember(a.payer) ?? a.payer
			if (!space.members.includes(payer)) space.members.push(payer)
			const splitAmong = (a.split_among?.length ? a.split_among : space.members).map((m: string) => matchMember(m) ?? m)
			const source = mailContext.getStore()
			const card: Card = { id: randomUUID(), kind: "expense", ...nextSpot("out", "expense"), by: "Clerk", createdAt: Date.now(), data: { description: a.description, amount: Number(a.amount), currency: a.currency || "$", payer, splitAmong, reason: a.reason, from: source?.from } }
			upsertCard(card)
			broadcast("members", space.members)
			sendEvent(SemanticEvent.create("expense.filed", clerk.getId(), { card, replyTo: source?.from, subject: source?.subject }), clerk.getId())
			return { ok: true, cardId: card.id }
		},
	),
	tool(
		"file_note",
		"Pin a note to the space. Use for plans, addresses, times, info people need to see.",
		{ title: str("Short title"), body: str("Note body, concise"), reason: str("Why it was pinned") },
		["title", "body", "reason"],
		async (a) => {
			upsertCard({ id: randomUUID(), kind: "note", ...nextSpot("out", "note"), by: "Clerk", createdAt: Date.now(), data: { title: a.title, body: a.body, color: "blue", reason: a.reason } })
			return { ok: true }
		},
	),
	tool(
		"create_poll",
		"Start a poll when the mail asks the group to choose between options.",
		{ question: str("The question"), options: { type: "array", items: { type: "string" }, description: "2-5 options" } },
		["question", "options"],
		async (a) => {
			upsertCard({ id: randomUUID(), kind: "poll", ...nextSpot("out", "poll"), by: "Clerk", createdAt: Date.now(), data: { question: a.question, options: a.options.slice(0, 5).map((label: string) => ({ id: randomUUID(), label, votes: [] })) } })
			return { ok: true }
		},
	),
	tool(
		"add_to_bring_list",
		"Add items to the 'who's bringing what' list when the mail mentions things someone needs to bring.",
		{ items: { type: "array", items: { type: "string" } } },
		["items"],
		async (a) => {
			let list = space.cards.find((c) => c.kind === "bring")
			if (!list) list = { id: randomUUID(), kind: "bring", ...nextSpot("out", "bring"), by: "Clerk", createdAt: Date.now(), data: { title: "Who's bringing what", items: [] } }
			for (const label of a.items) list.data.items.push({ id: randomUUID(), label, claimedBy: null })
			upsertCard(list)
			return { ok: true }
		},
	),
]
const clerk = createAgent({
	name: "Clerk",
	capabilities: ["inference", "filing"],
	instruction:
		"You are the Clerk of a shared group space (a friend group's page). Mail and forwards sent to the space land with you. " +
		"Decide what each one is and FILE it using your tools — never just answer in text. A receipt → file_expense. Plans/info → file_note. " +
		"A choice to make → create_poll. Things to bring → add_to_bring_list. You may use more than one tool. Links are handled by the Scout; ignore them unless there is also something to file. " +
		"After filing, reply with one short line saying what you did.",
	tools: clerkTools,
	handlers: [
		{
			specification: new OnType("inbox.received").and(new FromOthers()),
			processor: {
				apply({ event, participant }) {
					const mail = event.payload as Mail
					// A bare link belongs to the Scout. Don't double-file it as a Clerk note.
					if (/^https?:\/\/\S+$/i.test(mail.text.trim())) return
					mailContext.run(mail, () => {
						if (!LIVE_AI) return fallbackClerk(mail)
						think(participant as Agent, `Members: ${space.members.join(", ")}.\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text}`)
					})
				},
			},
		},
	],
})

// ── The Treasurer: wakes up whenever an expense is filed, settles up, emails the sender back.
const treasurer = createAgent({
	name: "Treasurer",
	capabilities: ["inference", "ledger", "email"],
	instruction:
		"You are the Treasurer of a friend group's shared space. When an expense is filed you get the expense and the running balances. " +
		"Call send_reply exactly once with a short, warm email back to whoever sent the receipt: confirm what was filed, the per-person share, and who owes whom overall. " +
		"Max 4 sentences and under 260 characters. No bullet points. Use the currency given.",
	tools: [
		tool(
			"send_reply",
			"Email a reply from the space back to a person.",
			{ to: str("Recipient name or email"), subject: str("Subject line"), body: str("Plain text body") },
			["to", "subject", "body"],
			async (a) => {
				upsertCard({ id: randomUUID(), kind: "reply", ...nextSpot("out", "reply"), by: "Treasurer", createdAt: Date.now(), data: { to: a.to, subject: a.subject, body: a.body, from: SPACE_EMAIL } })
				return { sent: true }
			},
		),
	],
	handlers: [
		{
			specification: new OnType("expense.filed"),
			processor: {
				apply({ event, participant }) {
					const { card, replyTo, subject } = event.payload as any
					const d = card.data
					const share = Math.round((d.amount / d.splitAmong.length) * 100) / 100
					const msg = `Expense filed: ${d.description}, ${d.currency}${d.amount} paid by ${d.payer}, split among ${d.splitAmong.join(", ")} (${d.currency}${share} each).\nRunning balances (positive = is owed): ${JSON.stringify(balances())}.\nReply to: ${replyTo ?? d.payer}. Original subject: ${subject ?? d.description}`
					broadcast("ledger", balances())
					if (!LIVE_AI) return fallbackTreasurer(participant as Agent, card, replyTo, share)
					think(participant as Agent, msg)
				},
			},
		},
	],
})

// ── The Scout: reads any link that lands in the space and turns it into a card worth arguing about.
const MAX_PAGE_BYTES = 200_000

function isPrivateAddress(host: string) {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "")
	if (h.includes(":")) {
		return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:127.")
	}
	const parts = h.split(".").map(Number)
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
	const [a, b] = parts
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 198 && (b === 18 || b === 19))
	)
}

// The inbox is open to the internet, so the Scout must not be usable as a
// proxy into localhost, private networks, or cloud metadata endpoints.
async function assertPublicUrl(raw: string) {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error("That does not look like a URL")
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) links can be read")
	if (url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") || isPrivateAddress(url.hostname)) {
		throw new Error("That link points inside a private network")
	}
	const addresses = await lookup(url.hostname, { all: true }).catch(() => [])
	if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("That link resolves to a private address")
	return url
}

async function readCapped(res: Response) {
	if (!res.body) return ""
	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let out = ""
	let size = 0
	while (size < MAX_PAGE_BYTES) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		out += decoder.decode(value, { stream: true })
	}
	reader.cancel().catch(() => {})
	return out
}

async function readUrl(raw: string) {
	try {
		let url = await assertPublicUrl(raw)
		let res: Response | undefined
		// Follow a few redirects ourselves so every hop is validated.
		for (let hop = 0; hop < 3; hop++) {
			const ctrl = new AbortController()
			const t = setTimeout(() => ctrl.abort(), 8000)
			res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { "user-agent": "Mozilla/5.0 HuddleScout" } })
			clearTimeout(t)
			const location = res.headers.get("location")
			if (res.status >= 300 && res.status < 400 && location) {
				url = await assertPublicUrl(new URL(location, url).toString())
				continue
			}
			break
		}
		if (!res) throw new Error("No response")
		if (!res.ok) throw new Error(`The page answered ${res.status}`)
		const html = await readCapped(res)
		const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? url.toString()
		const text = html
			.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;|&amp;|&#39;|&quot;/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 6000)
		return { title, text }
	} catch (e) {
		return { title: raw, text: `Could not read the page (${String(e)}). Work from the URL alone.` }
	}
}
const scout = createAgent({
	name: "Scout",
	capabilities: ["inference", "web"],
	instruction:
		"You are the Scout of a friend group's shared space. When a link lands in the space, call read_url, then call post_link_card with a 2-sentence plain summary " +
		"and exactly two short, fun questions the group could argue about. Then reply with one line.",
	tools: [
		tool("read_url", "Fetch a web page and return its title and text.", { url: str("The URL") }, ["url"], async (a) => readUrl(a.url)),
		tool(
			"post_link_card",
			"Put a link card on the space.",
			{ url: str("URL"), title: str("Page title"), summary: str("2 sentence summary"), questions: { type: "array", items: { type: "string" }, description: "Exactly two questions" } },
			["url", "title", "summary", "questions"],
			async (a) => {
				upsertCard({ id: randomUUID(), kind: "link", ...nextSpot("out", "link"), by: "Scout", createdAt: Date.now(), data: { url: a.url, title: a.title, summary: a.summary, questions: a.questions.slice(0, 2) } })
				return { ok: true }
			},
		),
	],
	handlers: [
		{
			specification: new OnType("inbox.received").or(new OnType("link.dropped")).and(new HasLink()).and(new FromOthers()),
			processor: {
				apply({ event, participant }) {
					const p = event.payload as any
					const url = (`${p.url ?? ""} ${p.text ?? ""}`.match(/https?:\/\/\S+/) ?? [""])[0].replace(/[).,]+$/, "")
					if (!LIVE_AI) return fallbackScout(participant as Agent, url)
					think(participant as Agent, `A link landed in the space from ${p.from ?? p.by}: ${url}`)
				},
			},
		},
	],
})

// ── The Ticker: an observer. Never thinks, never speaks — turns every runtime event into the live activity panel.
function nameOf(id: string) {
	const p: Participant | undefined = resolveRuntime().state.participants.get(id)
	return p?.getManifest().name ?? "someone"
}
const ticker = createHuman({
	name: "Ticker",
	capabilities: ["observe"],
	handlers: [
		{
			specification: new AnyEvent(),
			processor: {
				apply({ event }) {
					const who = nameOf(event.producerId)
					const p = event.payload as any
					switch (event.type) {
						case "participant.joined":
							if (["Ticker", "Mailroom"].includes(p?.name)) return
							return log(p?.name ?? who, p?.role === "agent" ? "agent" : "human", "joined", `${p?.name ?? who} joined the space`)
						case "inbox.received":
							return log(p.from, "human", "mail", `📨 Mail in: “${p.subject}”`)
						case "message_received.started":
							return setStatus(who, "reading", "")
						case "inference.started":
							return setStatus(who, "thinking", "")
						case "function_call.started":
							setStatus(who, "using tool", p?.call?.name)
							return log(who, "agent", "tool", `${p?.call?.name}(${shorten(p?.call?.args)})`)
						case "function_call.completed":
							return setStatus(who, "thinking", "")
						case "model.answer": {
							setStatus(who, "idle", "")
							const text = p?.answer?.content?.text ?? ""
							return text && log(who, "agent", "answer", text)
						}
						case "expense.filed":
							return log("Clerk", "agent", "event", `emitted expense.filed → Treasurer wakes up`)
					}
				},
			},
		},
	],
})
function shorten(s?: string) {
	if (!s) return ""
	return s.length > 140 ? s.slice(0, 140) + "…" : s
}

// Mailroom: the human-side door. Mail and dropped links enter the runtime through it.
const mailroom = createHuman({ name: "Mailroom", capabilities: ["email"], handlers: [] })
const humans = new Map<string, Participant>()
function humanFor(name: string) {
	let h = humans.get(name)
	if (!h) {
		h = createHuman({ name, capabilities: ["edit"], handlers: [] })
		humans.set(name, h)
		join(h)
		if (!space.members.includes(name) && name !== "Guest") {
			space.members.push(name)
			persist()
			broadcast("members", space.members)
		}
	}
	return h
}

join(ticker)
join(mailroom)
join(clerk)
join(treasurer)
join(scout)
for (const a of [clerk, treasurer, scout]) setStatus(nameOf(a.getId()), "idle")

function matchMember(name?: string) {
	if (!name) return undefined
	const n = name.toLowerCase().split(/[\s@<]/)[0]
	return space.members.find((m) => m.toLowerCase() === n || m.toLowerCase().startsWith(n) || n.startsWith(m.toLowerCase()))
}

// ───────────────────────────── no-key fallback (keeps the demo alive) ─────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function fallbackClerk(mail: Mail) {
	setStatus("Clerk", "thinking", "(offline mode)")
	await sleep(700)
	const m = mail.text.match(/total[^\d$₦€£]*([$₦€£])\s?(\d+(?:\.\d{2})?)/i) ?? mail.text.match(/([$₦€£])\s?(\d+(?:\.\d{2})?)/)
	const amount = Number(m?.[2] ?? 0)
	const cur = (mail.text.match(/[$₦€£]/) ?? ["$"])[0]
	const t = clerkTools.find((t) => t.name === (amount ? "file_expense" : "file_note"))!
	const args = amount
		? { description: mail.subject.replace(/^(fwd?|re):\s*/i, ""), amount, currency: cur, payer: matchMember(mail.from) ?? mail.from, reason: "Looks like a receipt, so it went to expenses." }
		: { title: mail.subject, body: mail.text.slice(0, 280), reason: "Info the group should see." }
	if (!amount && /https?:\/\//.test(mail.text)) {
		// A link-only forward belongs to the Scout. Don't pretend the Clerk filed it.
		setStatus("Clerk", "idle")
		return
	}
	setStatus("Clerk", "using tool", t.name)
	log("Clerk", "agent", "tool", `${t.name}(${shorten(JSON.stringify(args))})`)
	await t.invoke(args)
	setStatus("Clerk", "idle")
}
async function fallbackTreasurer(agent: Agent, card: Card, replyTo: string | undefined, share: number) {
	setStatus("Treasurer", "thinking", "(offline mode)")
	await sleep(900)
	const d = card.data
	const t = agent.getTools()[0]
	setStatus("Treasurer", "using tool", "send_reply")
	await t.invoke({ to: replyTo ?? d.payer, subject: `Re: ${d.description}`, body: `Filed ${d.description} (${d.currency}${d.amount}) under expenses. Split ${d.splitAmong.length} ways that's ${d.currency}${share} each — I've added it to the ledger.` })
	log("Treasurer", "agent", "tool", `send_reply(to: ${replyTo ?? d.payer})`)
	setStatus("Treasurer", "idle")
}
async function fallbackScout(agent: Agent, url: string) {
	setStatus("Scout", "using tool", "read_url")
	const page = await readUrl(url)
	setStatus("Scout", "using tool", "post_link_card")
	await agent.getTools()[1].invoke({ url, title: page.title, summary: page.text.slice(0, 200) + "…", questions: ["Worth it?", "Who's in?"] })
	log("Scout", "agent", "tool", `post_link_card(${url})`)
	setStatus("Scout", "idle")
}

process.on("unhandledRejection", (err) => {
	console.error("[agent loop failed]", err)
	log("System", "system", "error", `An agent loop failed: ${String((err as any)?.message ?? err).slice(0, 160)}`)
	for (const n of Object.keys(agentStatus)) if (agentStatus[n].state !== "idle") setStatus(n, "idle")
})

// ───────────────────────────── HTTP ─────────────────────────────
const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "256kb" }))
app.use(express.static("public", { maxAge: "1h" }))
// One-link demo: auto-joins as Ada and fires the receipt+link race.
app.get("/demo", (_req, res) => res.sendFile(`${process.cwd()}/public/index.html`))

const CARD_KINDS = new Set<Kind>(["note", "poll", "bring", "link"])
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max)

app.get("/healthz", (_req, res) =>
	res.json({ ok: true, uptime: Math.round(process.uptime()), cards: space.cards.length, clients: clients.size, liveAI: LIVE_AI, model: MODEL, cloud: CLOUD_PAIRED }),
)

app.get("/api/space", (_req, res) => res.json({ ...space, balances: balances(), status: agentStatus, liveAI: LIVE_AI, model: MODEL, cloud: CLOUD_PAIRED }))

app.get("/api/events", (req, res) => {
	res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
	res.flushHeaders()
	res.write(`event: hello\ndata: {}\n\n`)
	clients.add(res)
	const ping = setInterval(() => res.write(`: ping\n\n`), 20000)
	req.on("close", () => {
		clearInterval(ping)
		clients.delete(res)
	})
})

app.post("/api/join", (req, res) => {
	const name = clean(req.body?.name, 24) || "Guest"
	humanFor(name)
	res.json({ ok: true, members: space.members })
})

// Human edits: every one is also published into the Mozaik runtime as a semantic event.
function humanEvent(by: string, type: string, payload: any) {
	const h = humanFor(by)
	sendEvent(SemanticEvent.create(type, h.getId(), { by, ...payload }), h.getId())
}

app.post("/api/cards", (req, res) => {
	const { kind, x, y, data } = req.body ?? {}
	const by = clean(req.body?.by, 24) || "Guest"
	if (!CARD_KINDS.has(kind)) return res.status(400).json({ error: "Unknown card kind" })
	if (!data || typeof data !== "object") return res.status(400).json({ error: "Missing card data" })
	const card: Card = {
		id: randomUUID(),
		kind,
		x: Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : 60,
		y: Number.isFinite(Number(y)) ? Math.max(0, Math.round(Number(y))) : 60,
		by,
		createdAt: Date.now(),
		data,
	}
	if (kind === "poll") card.data.options = (data.options ?? []).filter(Boolean).slice(0, 6).map((label: string) => ({ id: randomUUID(), label: clean(label, 80), votes: [] }))
	if (kind === "bring") card.data.items = (data.items ?? []).filter(Boolean).slice(0, 20).map((label: string) => ({ id: randomUUID(), label: clean(label, 80), claimedBy: null }))
	if (kind === "link") {
		const url = clean(data.url, 2048)
		if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Only http(s) links" })
		// the Scout turns a dropped link into the real card
		log(by, "human", "card", `${by} dropped a link`)
		humanEvent(by, "link.dropped", { url })
		return res.json({ ok: true })
	}
	upsertCard(card)
	log(by, "human", "card", `${by} added a ${kind}`)
	humanEvent(by, "card.added", { kind })
	res.json(card)
})

app.post("/api/cards/:id/move", (req, res) => {
	const c = space.cards.find((c) => c.id === req.params.id)
	if (!c) return res.sendStatus(404)
	if (!Number.isFinite(Number(req.body?.x)) || !Number.isFinite(Number(req.body?.y))) return res.status(400).json({ error: "x and y must be numbers" })
	c.x = Math.max(0, Math.round(Number(req.body.x)))
	c.y = Math.max(0, Math.round(Number(req.body.y)))
	persist()
	broadcast("move", { id: c.id, x: c.x, y: c.y, by: clean(req.body?.by, 24) })
	res.json({ ok: true })
})

app.post("/api/cards/:id/vote", (req, res) => {
	const c = space.cards.find((c) => c.id === req.params.id && c.kind === "poll")
	if (!c) return res.sendStatus(404)
	const { optionId } = req.body ?? {}
	const by = clean(req.body?.by, 24) || "Guest"
	for (const o of c.data.options) o.votes = o.votes.filter((v: string) => v !== by)
	const opt = c.data.options.find((o: any) => o.id === optionId)
	if (opt) opt.votes.push(by)
	upsertCard(c)
	log(by, "human", "vote", `${by} voted “${opt?.label}”`)
	humanEvent(by, "poll.voted", { question: c.data.question, option: opt?.label })
	res.json(c)
})

app.post("/api/cards/:id/claim", (req, res) => {
	const c = space.cards.find((c) => c.id === req.params.id && c.kind === "bring")
	if (!c) return res.sendStatus(404)
	const { itemId } = req.body ?? {}
	const by = clean(req.body?.by, 24) || "Guest"
	const it = c.data.items.find((i: any) => i.id === itemId)
	if (it) it.claimedBy = it.claimedBy === by ? null : by
	upsertCard(c)
	log(by, "human", "claim", it?.claimedBy ? `${by} is bringing ${it.label}` : `${by} un-claimed ${it?.label}`)
	humanEvent(by, "item.claimed", { item: it?.label })
	res.json(c)
})

app.delete("/api/cards/:id", (req, res) => {
	removeCard(req.params.id)
	res.json({ ok: true })
})

// The space's inbox. Point a real inbound-email webhook here, or use the "Forward to the space" box.
app.post("/api/inbox", (req, res) => {
	const mail: Mail = {
		from: clean(req.body?.from, 120) || "someone",
		subject: clean(req.body?.subject, 200) || "(no subject)",
		text: clean(req.body?.text, 20_000),
	}
	if (!mail.text) return res.status(400).json({ error: "Mail needs some text" })
	resolveRuntime().state.inboxCount++
	upsertCard({ id: randomUUID(), kind: "mail", ...nextSpot("mail", "mail"), by: mail.from, createdAt: Date.now(), data: mail })
	sendEvent(SemanticEvent.create("inbox.received", mailroom.getId(), mail), mailroom.getId())
	res.json({ ok: true })
})

app.post("/api/reset", (_req, res) => {
	space = seed()
	lanes = { mail: 40, out: 40 }
	persist()
	broadcast("reset", {})
	res.json({ ok: true })
})

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
	if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body" })
	if (err?.type === "entity.too.large") return res.status(413).json({ error: "Body too large" })
	console.error("[http]", err)
	res.status(500).json({ error: "Something went wrong" })
})

const server = app.listen(PORT, () => {
	console.log(`\n  Huddle running → http://localhost:${PORT}`)
	console.log(`  Agents: Clerk, Treasurer, Scout + Ticker observer on one Mozaik runtime`)
	console.log(`  AI: ${LIVE_AI ? `live (${MODEL})` : "OFFLINE fallback — set OPENAI_API_KEY in .env for real agents"}`)
	console.log(`  Cloud: ${CLOUD_PAIRED ? "paired — loops stream to app.jigjoy.ai" : "not paired — run npm run pair to watch agents live"}\n`)
})

let closing = false
function shutdown() {
	if (closing) return
	closing = true
	clearTimeout(saveTimer)
	try {
		writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(space, null, 2))
		renameSync(`${DATA_FILE}.tmp`, DATA_FILE)
	} catch {}
	for (const c of clients) c.end()
	server.close(() => process.exit(0))
	setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
