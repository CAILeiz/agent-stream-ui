/**
 * 首屏指标测量：FCP / DCL / load，多次取中位数。无依赖，用 Chrome DevTools Protocol。
 *
 *   node scripts/measure-fcp.mjs http://127.0.0.1:4173/ 5
 *   node scripts/measure-fcp.mjs https://caileiz.github.io/agent-stream-ui/ 5 slow
 *
 * `slow` 会启用 Fast 3G 节流（150ms RTT / 1.6Mbps）并禁用缓存，
 * 这样本地跑出来的数字和线上弱网下的体感才对得上。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const url = process.argv[2]
const runs = Number(process.argv[3] ?? 5)
const slow = process.argv[4] === 'slow'
const port = 9230

if (!url) {
  console.error('usage: node scripts/measure-fcp.mjs <url> [runs] [slow]')
  process.exit(1)
}

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))

if (!chromePath) {
  console.error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.')
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'asu-chrome-'))

const chrome = spawn(
  chromePath,
  [
    '--headless=old',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function newTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (res.ok) return await res.json()
    } catch {
      /* not ready */
    }
    await sleep(200)
  }
  throw new Error('devtools not ready')
}

const target = await newTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    id += 1
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

if (slow) {
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  })
}

const results = []

for (let run = 0; run < runs; run += 1) {
  await send('Page.navigate', { url })
  await sleep(4500)

  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const paint = performance.getEntriesByType('paint')
      const fcp = paint.find((entry) => entry.name === 'first-contentful-paint')
      const nav = performance.getEntriesByType('navigation')[0] || {}
      const resources = performance.getEntriesByType('resource')
      const bytes = (suffix) => resources
        .filter((entry) => entry.name.endsWith(suffix))
        .reduce((total, entry) => total + (entry.encodedBodySize || 0), 0)
      return JSON.stringify({
        fcp: fcp ? fcp.startTime : null,
        dcl: nav.domContentLoadedEventEnd ?? null,
        load: nav.loadEventEnd ?? null,
        js: bytes('.js'),
        css: bytes('.css'),
      })
    })()`,
    returnByValue: true,
  })

  results.push(JSON.parse(result.value))
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)]
}

console.log(`${url}  (${runs} runs, cache disabled${slow ? ', Fast 3G' : ''})`)
for (const key of ['fcp', 'dcl', 'load']) {
  const values = results.map((result) => result[key])
  console.log(`  ${key.padEnd(4)} median ${String(median(values)?.toFixed(0)).padStart(4)}ms   [${values.map((value) => value?.toFixed?.(0)).join(', ')}]`)
}
console.log(
  `  transfer js ${(median(results.map((result) => result.js)) / 1024).toFixed(0)}KB · css ${(median(results.map((result) => result.css)) / 1024).toFixed(0)}KB`,
)

ws.close()
chrome.kill('SIGKILL')
