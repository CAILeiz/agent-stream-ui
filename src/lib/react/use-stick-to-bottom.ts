import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const STICK_THRESHOLD_PX = 48

/**
 * 贴底滚动。
 *
 * 规则：只有用户本来就在底部时才自动滚；一旦上滑就"锁住"，新内容只提示不打扰。
 * 这是 AI 对话界面里最容易做错、也最影响体感的一个细节。
 *
 * @param signal 内容变化信号（一般是消息长度），变化后若处于贴底状态则滚到底。
 */
export function useStickToBottom<T extends HTMLElement>(signal: unknown) {
  const ref = useRef<T | null>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
  }, [signal])

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const onScroll = () => {
      const gap = element.scrollHeight - element.scrollTop - element.clientHeight
      const next = gap < STICK_THRESHOLD_PX
      pinnedRef.current = next
      setPinned(next)
    }

    element.addEventListener('scroll', onScroll, { passive: true })

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (pinnedRef.current) element.scrollTop = element.scrollHeight
          })
        : null
    observer?.observe(element)

    return () => {
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }, [])

  return { ref, pinned, scrollToBottom }
}
