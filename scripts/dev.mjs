#!/usr/bin/env node
/**
 * 一条命令起两个进程：mock agent 服务 + vite。
 * 不用 concurrently，少一个依赖，也方便统一着色和退出。
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const procs = []
let shuttingDown = false

function run(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: process.platform === 'win32',
  })

  const prefix = `\u001b[${color}m[${name}]\u001b[0m `
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() === '') continue
      stream.write(prefix + line + '\n')
    }
  }

  child.stdout.on('data', write(process.stdout))
  child.stderr.on('data', write(process.stderr))
  child.on('exit', (code) => {
    if (shuttingDown) return
    console.log(`${prefix}exited with ${code}`)
    shutdown(code ?? 0)
  })

  procs.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of procs) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 120)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('agent', process.execPath, ['server/mock-agent.mjs'], '36')
run('web', process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173'], '35')
