import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = 3400 + Math.floor(Math.random() * 400)
const base = `http://127.0.0.1:${port}`
const scratch = mkdtempSync(join(tmpdir(), "huddle-test-"))
let child

const api = async (path, body, method = "POST") => {
	const res = await fetch(base + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const json = await res.json().catch(() => null)
	return { status: res.status, body: json }
}

const space = async () => (await api("/api/space", undefined, "GET")).body

const waitFor = async (read, ms = 10_000) => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		const value = await read()
		if (value) return value
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error("timed out waiting for the agents")
}

const waitCard = (predicate, ms) => waitFor(async () => (await space()).cards.find(predicate), ms)

before(async () => {
	const env = { ...process.env, PORT: String(port), DATA_FILE: join(scratch, "data.json"), NODE_ENV: "test" }
	for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"]) delete env[key]
	child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
	child.stderr.on("data", (d) => process.stderr.write(d))
	await waitFor(async () => {
		try {
			return (await api("/healthz", undefined, "GET")).status === 200
		} catch {
			return false
		}
	}, 20_000)
	await api("/api/reset", {})
}, { timeout: 30_000 })

after(() => {
	child?.kill()
	rmSync(scratch, { recursive: true, force: true })
})

test("serves a seeded space and a health check", async () => {
	const health = await api("/healthz", undefined, "GET")
	assert.equal(health.status, 200)
	assert.equal(health.body.ok, true)

	const s = await space()
	assert.equal(s.name, "The Crew")
	assert.deepEqual(s.members, ["Ada", "Tunde", "Kemi"])
	assert.equal(s.cards.length, 3)
	assert.deepEqual(s.balances, { Ada: 0, Tunde: 0, Kemi: 0 })
})

test("files a forwarded receipt, splits it, and emails the sender back", async () => {
	const res = await api("/api/inbox", {
		from: "Ada",
		subject: "Fwd: Your order from Sweet Crumbs Bakery",
		text: [
			"Order #4471 - Sweet Crumbs Bakery",
			"1 x Red velvet cake   $55.00",
			"1 x Candles            $8.00",
			"Total paid: $63.00",
			"Paid with Visa ending 4417",
		].join("\n"),
	})
	assert.equal(res.status, 200)

	const expense = await waitCard((c) => c.kind === "expense" && c.data.amount === 63)
	assert.equal(expense.data.payer, "Ada")
	assert.deepEqual(expense.data.splitAmong, ["Ada", "Tunde", "Kemi"])
	assert.equal(expense.by, "Clerk")

	const reply = await waitCard((c) => c.kind === "reply" && c.data.to === "Ada")
	assert.match(reply.data.body, /21/)
	assert.equal(reply.by, "Treasurer")

	const s = await space()
	assert.deepEqual(s.balances, { Ada: 42, Tunde: -21, Kemi: -21 })
})

test("handles two forwards at once without losing either one", async () => {
	await Promise.all([
		api("/api/inbox", { from: "Tunde", subject: "Fwd: ice and cups", text: "Paid $24.00 for ice and cups at the corner shop. Total: $24.00" }),
		api("/api/inbox", { from: "Kemi", subject: "Saturday plan", text: "Meet at Tunde's place at 6pm. Bring a jacket. No receipt here." }),
	])

	const expense = await waitCard((c) => c.kind === "expense" && c.data.amount === 24)
	assert.equal(expense.data.payer, "Tunde")

	const note = await waitCard((c) => c.kind === "note" && c.by === "Clerk" && c.data.title === "Saturday plan")
	assert.match(note.data.body, /6pm/)
})

test("turns a dropped link into a Scout card", async () => {
	const res = await api("/api/cards", {
		kind: "link",
		by: "Ada",
		x: 120,
		y: 120,
		data: { url: "https://huddle-test.invalid/page" },
	})
	assert.equal(res.status, 200)

	const card = await waitCard((c) => c.kind === "link" && c.by === "Scout")
	assert.equal(card.data.url, "https://huddle-test.invalid/page")
	assert.ok(card.data.summary)
	assert.equal(card.data.questions.length, 2)
})

test("de-duplicates votes and toggles claims", async () => {
	let s = await space()
	const poll = s.cards.find((c) => c.kind === "poll")
	const option = poll.data.options[1]

	for (let i = 0; i < 2; i++) {
		const res = await api(`/api/cards/${poll.id}/vote`, { optionId: option.id, by: "Kemi" })
		assert.equal(res.status, 200)
	}

	s = await space()
	const afterVote = s.cards.find((c) => c.id === poll.id)
	const voted = afterVote.data.options.find((o) => o.id === option.id)
	assert.equal(voted.votes.filter((v) => v === "Kemi").length, 1)

	const bring = s.cards.find((c) => c.kind === "bring")
	const item = bring.data.items.find((i) => !i.claimedBy)
	await api(`/api/cards/${bring.id}/claim`, { itemId: item.id, by: "Ada" })
	s = await space()
	assert.equal(s.cards.find((c) => c.id === bring.id).data.items.find((i) => i.id === item.id).claimedBy, "Ada")
	await api(`/api/cards/${bring.id}/claim`, { itemId: item.id, by: "Ada" })
	s = await space()
	assert.equal(s.cards.find((c) => c.id === bring.id).data.items.find((i) => i.id === item.id).claimedBy, null)
})

test("rejects malformed input", async () => {
	assert.equal((await api("/api/inbox", {})).status, 400)
	assert.equal((await api("/api/cards", { kind: "bogus" })).status, 400)
	assert.equal((await api("/api/cards", { kind: "link", data: { url: "javascript:alert(1)" } })).status, 400)

	const res = await fetch(`${base}/api/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" })
	assert.equal(res.status, 400)
	assert.deepEqual(await res.json(), { error: "Invalid JSON body" })
})

test("reset restores the demo space", async () => {
	await api("/api/reset", {})
	const s = await space()
	assert.equal(s.cards.length, 3)
	assert.deepEqual(s.balances, { Ada: 0, Tunde: 0, Kemi: 0 })
})
