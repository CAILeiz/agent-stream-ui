/**
 * SSE 分帧：纯函数，不碰 fetch、不碰 DOM。
 *
 * 为什么自己写：EventSource 不支持 POST、不能带自定义 header、断线重连策略
 * 由浏览器决定（你没法控制退避、也没法只对 5xx 重试）。真正的 Agent 流式
 * 接口几乎都是 `POST + text/event-stream`。
 */

export interface SseFrame {
  /** 事件游标（服务端 outbox 自增 id），用于断点续传与去重。 */
  id: string | null
  event: string
  data: string
  /** 服务端建议的重连间隔；本实现不采纳，退避策略由客户端掌握。 */
  retry: number | null
}

const FRAME_SEPARATOR = /\r?\n\r?\n/

/**
 * 解析单帧（不含结尾空行）。
 *
 * 规范细节：一行可以是 `field`（无冒号）、`field:`（空值）、`field:value`，
 * 值前的一个空格必须去掉；`:` 开头是注释（心跳），整帧没有 data 时不产生事件。
 */
export function parseSseFrame(raw: string): SseFrame | null {
  if (raw.length === 0) return null

  const lines = raw.split(/\r?\n/)
  let id: string | null = null
  let event = 'message'
  let retry: number | null = null
  const dataLines: string[] = []

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'id':
        id = value
        break
      case 'event':
        event = value === '' ? 'message' : value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'retry': {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > 0) retry = parsed
        break
      }
      default:
        // 未知字段按规范忽略，保证协议向前兼容
        break
    }
  }

  if (dataLines.length === 0) return null

  return { id, event, data: dataLines.join('\n'), retry }
}

/**
 * 从缓冲区里切出所有完整帧，返回剩余未闭合文本。
 * 调用方负责把 `rest` 与下一次读到的 chunk 拼起来再解析。
 */
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = []
  let rest = buffer

  for (;;) {
    const match = FRAME_SEPARATOR.exec(rest)
    if (!match) break

    const raw = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)

    const frame = parseSseFrame(raw)
    if (frame) frames.push(frame)
  }

  return { frames, rest }
}

/** 序列化一帧（mock server 与测试用，保证和服务端输出同形）。 */
export function formatSseFrame(frame: {
  id?: string | number | null
  event?: string
  data: string
}): string {
  let out = ''
  if (frame.id !== undefined && frame.id !== null) out += `id: ${frame.id}\n`
  if (frame.event && frame.event !== 'message') out += `event: ${frame.event}\n`
  for (const line of frame.data.split('\n')) out += `data: ${line}\n`
  return `${out}\n`
}

/**
 * 游标比较。服务端 id 是单调递增的整数游标，但协议本身不保证——
 * 非数字 id 退化为"只要不相等就认为新"。
 */
export function isNewerEventId(next: string, current: string | null): boolean {
  if (current === null) return true

  const a = Number(next)
  const b = Number(current)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b

  return next !== current
}
