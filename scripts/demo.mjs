#!/usr/bin/env node
// Fires the "both at once" demo at a running Huddle and narrates what the
// agents do. No dependencies: fetch + a polling loop.
//
//   npm start              # in one terminal
//   npm run demo           # in another
//
// HUDDLE_URL=http://localhost:3000 DEMO_USER=Ada npm run demo

const BASE = (process.env.HUDDLE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "")
const FROM = process.env.DEMO_USER ?? "Ada"

const RECEIPT = {
	subject: "Fwd: Your order from Sweet Crumbs Bakery",
	text: [
		'Order #4471 - Sweet Crumbs Bakery',
		'1 x Red velvet cake (8")   $55.00',
		"1 x Candles + topper       $8.00",
		"Total paid: $63.00",
		"Paid with Visa ending 4417",
		"Pickup Saturday 2pm",
		"",
		"(for kemi's thing - split it between the three of us)",
	].join("\n"),
}

const LINK = { subject: "we should go here after", text: "https://en.wikipedia.org/wiki/Karaoke" }

const api = async (path, body, method = "POST") => {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const json = await res.json().catch(() => null)
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
	return json
}

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = color("1")
const dim = color("2")
const green = color("32")
const orange = color("38;5;208")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
	console.log(`\n${bold("huddle demo")} ${dim(`-> ${BASE}`)}\n`)

	const health = await api("/healthz", undefined, "GET").catch(() => null)
	if (!health?.ok) {
		console.error(`No Huddle at ${BASE}. Start it first with ${bold("npm start")}.`)
		process.exit(1)
	}
	console.log(dim(`  mode: ${health.liveAI ? `live (${health.model})` : "offline fallback"}${health.cloud ? " + mozaik cloud" : ""}\n`))

	// A fresh board makes the demo legible.
	await api("/api/reset", {})

	console.log(dim(`  ${FROM} forwards a receipt and drops a link at the same instant...\n`))
	await Promise.all([
		api("/api/inbox", { from: FROM, ...RECEIPT }),
		api("/api/inbox", { from: FROM, ...LINK }),
	])

	const seen = new Set()
	const started = Date.now()
	let lastStatus = ""

	while (Date.now() - started < 45_000) {
		const space = await api("/api/space", undefined, "GET")
		for (const c of space.cards) {
			if (seen.has(c.id) || !["Clerk", "Treasurer", "Scout"].includes(c.by)) continue
			seen.add(c.id)
			const detail =
				c.kind === "expense"
					? `${c.data.currency}${c.data.amount} paid by ${c.data.payer} · split ${c.data.splitAmong.length} ways`
					: c.kind === "reply"
						? `email to ${c.data.to}: "${String(c.data.body).slice(0, 90)}${String(c.data.body).length > 90 ? "..." : ""}"`
						: c.kind === "link"
							? `${c.data.title} — ${c.data.questions?.length ?? 0} questions pinned`
							: c.data.title ?? c.data.amount ?? c.kind
			console.log(`  ${green("+")} ${bold(c.by.padEnd(9))} ${orange(c.kind.padEnd(7))} ${detail}`)
		}

		const status = Object.entries(space.status)
			.filter(([, s]) => s.state !== "idle")
			.map(([name, s]) => `${name}: ${s.state}${s.detail ? ` (${s.detail})` : ""}`)
			.join("  ")
		if (status && status !== lastStatus) {
			lastStatus = status
			console.log(dim(`    ${status}`))
		}

		const kinds = new Set([...seen].map((id) => space.cards.find((c) => c.id === id)?.kind))
		if (kinds.has("expense") && kinds.has("reply") && kinds.has("link")) break
		await sleep(400)
	}

	const { balances, activity } = await api("/api/space", undefined, "GET")
	console.log(`\n${bold("  ledger")}`)
	for (const [name, net] of Object.entries(balances)) {
		const label = net > 0 ? `is owed ${net.toFixed(2)}` : net < 0 ? `owes ${Math.abs(net).toFixed(2)}` : "all square"
		console.log(`    ${name.padEnd(8)} ${net > 0 ? green(label) : net < 0 ? orange(label) : dim(label)}`)
	}
	const toolCalls = activity.filter((a) => a.kind === "tool").length
	console.log(dim(`\n  ${seen.size} cards from ${toolCalls} tool calls in ${((Date.now() - started) / 1000).toFixed(1)}s — every step is an event on one Mozaik runtime.\n`))
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
