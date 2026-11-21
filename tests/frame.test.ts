import { describe, expect, it } from 'vitest'
import {
  formatSseFrame,
  isNewerEventId,
  parseSseChunk,
  parseSseFrame,
} from '../src/lib/sse/frame'

describe('parseSseFrame', () => {
  it('解析 id / event / data', () => {
    const frame = parseSseFrame('id: 7\nevent: message.delta\ndata: {"text":"hi"}')
    expect(frame).toEqual({
      id: '7',
      event: 'message.delta',
      data: '{"text":"hi"}',
      retry: null,
    })
  })

  it('默认 event 为 message', () => {
    expect(parseSseFrame('data: hello')?.event).toBe('message')
  })

  it('多行 data 用换行拼接', () => {
    expect(parseSseFrame('data: a\ndata: b')?.data).toBe('a\nb')
  })

  it('注释行（心跳）不产生事件', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull()
  })

  it('只有 retry 字段时不产生事件', () => {
    expect(parseSseFrame('retry: 3000')).toBeNull()
  })

  it('字段值前的单个空格被去掉，多余空格保留', () => {
    expect(parseSseFrame('data:   two spaces')?.data).toBe('  two spaces')
  })

  it('无冒号的字段按空值处理', () => {
    expect(parseSseFrame('data\ndata: x')?.data).toBe('\nx')
  })

  it('未知字段忽略', () => {
    const frame = parseSseFrame('data: x\nfoo: bar\nid: 1')
    expect(frame?.data).toBe('x')
    expect(frame?.id).toBe('1')
  })
})

describe('parseSseChunk', () => {
  it('切出完整帧并保留残余', () => {
    const { frames, rest } = parseSseChunk('data: a\n\ndata: b\n\ndata: c')
    expect(frames.map((frame) => frame.data)).toEqual(['a', 'b'])
    expect(rest).toBe('data: c')
  })

  it('兼容 CRLF', () => {
    const { frames } = parseSseChunk('id: 1\r\ndata: a\r\n\r\n')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.id).toBe('1')
  })

  it('跨 chunk 的半个帧不丢', () => {
    const first = parseSseChunk('id: 1\ndata: {"te')
    expect(first.frames).toHaveLength(0)
    const second = parseSseChunk(`${first.rest}xt":"ok"}\n\n`)
    expect(second.frames).toHaveLength(1)
    expect(JSON.parse(second.frames[0]!.data)).toEqual({ text: 'ok' })
  })
})

describe('formatSseFrame', () => {
  it('与解析器互逆', () => {
    const text = formatSseFrame({ id: 3, event: 'tool.call', data: '{"a":1}' })
    const frame = parseSseFrame(text.trimEnd())
    expect(frame?.id).toBe('3')
    expect(frame?.event).toBe('tool.call')
    expect(frame?.data).toBe('{"a":1}')
  })
})

describe('isNewerEventId', () => {
  it('数字游标按大小比较', () => {
    expect(isNewerEventId('10', '9')).toBe(true)
    expect(isNewerEventId('9', '10')).toBe(false)
    expect(isNewerEventId('9', '9')).toBe(false)
  })

  it('首次没有游标时总认为是新的', () => {
    expect(isNewerEventId('1', null)).toBe(true)
  })

  it('非数字 id 退化为不等判断', () => {
    expect(isNewerEventId('b', 'a')).toBe(true)
    expect(isNewerEventId('a', 'a')).toBe(false)
  })
})
