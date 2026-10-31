#!/usr/bin/env node
// Regenerate the README screenshot from a running Huddle, using the Chrome
// already installed on the machine and the DevTools protocol (no deps).
//
//   npm start
//   npm run shot                     # http://127.0.0.1:3000/demo -> docs/huddle.png
//   npm run shot -- http://localhost:3000/demo docs/board.png
//
// SHOT_DELAY=8000  how long to let the agents work before capturing
// SHOT_RESET=0     don't reset the space first

import { spawn } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const targetUrl = process.argv[2] ?? "http://127.0.0.1:3000/demo"
const outFile = process.argv[3] ?? "docs/huddle.png"
const delay = Number(process.env.SHOT_DELAY ?? 8000)
const chromeCandidates = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean)
const chrome = chromeCandidates.find((p) => existsSync(p))
if (!chrome) throw new Error("Chrome/Edge not found. Set CHROME_PATH=/path/to/chrome")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (read, ms = 15_000) => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (await read()) return
		await sleep(200)
	}
	throw new Error("Chrome did not start in time")
}

if (process.env.SHOT_RESET !== "0") {
	await fetch(new URL("/api/reset", targetUrl).origin + "/api/reset", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	}).catch(() => {})
}

const port = 9333 + Math.floor(Math.random() * 300)
const profile = join(tmpdir(), `huddle-shot-${Date.now()}`)
const browser = spawn(
	chrome,
	[
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--window-size=1440,1000",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"about:blank",
	],
	{ stdio: "ignore" },
)

try {
	const base = `http://127.0.0.1:${port}`
	await waitFor(async () => {
		try {
			return (await fetch(`${base}/json/version`)).ok
		} catch {
			return false
		}
	})

	const target = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json()
	const ws = new WebSocket(target.webSocketDebuggerUrl)
	await new Promise((resolve, reject) => {
		ws.onopen = resolve
		ws.onerror = reject
	})

	let nextId = 0
	const pending = new Map()
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data)
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)(message)
			pending.delete(message.id)
		}
	}
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = ++nextId
			pending.set(id, resolve)
			ws.send(JSON.stringify({ id, method, params }))
		})

	await send("Page.enable")
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
	await send("Page.navigate", { url: targetUrl })
	await sleep(delay)

	const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false })
	if (!shot.result?.data) throw new Error(`Screenshot failed: ${JSON.stringify(shot.error ?? shot)}`)
	writeFileSync(outFile, Buffer.from(shot.result.data, "base64"))
	console.log(`saved ${outFile}`)
	ws.close()
} finally {
	browser.kill()
	await sleep(800)
	try {
		rmSync(profile, { recursive: true, force: true })
	} catch {
		// Chrome may still hold a crashpad file; the temp dir can wait.
	}
}
