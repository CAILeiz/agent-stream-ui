/**
 * 一次渲染的调度器。
 *
 * 为什么要这个：模型每秒可能吐出 20–60 个 delta，每个都通知 React 重新渲染
 * 是纯浪费——浏览器一帧最多画一次。默认用 rAF 把「状态已变」和「通知订阅者」
 * 解耦，一帧只 flush 一次；测试里换成同步调度器，断言才是确定的。
 */

export interface FlushScheduler {
  schedule: (flush: () => void) => unknown
  cancel: (handle: unknown) => void
}

export const immediateScheduler: FlushScheduler = {
  schedule(flush) {
    flush()
    return null
  },
  cancel() {
    /* 同步调度没有可取消的句柄 */
  },
}

export const rafScheduler: FlushScheduler = {
  schedule(flush) {
    if (typeof requestAnimationFrame !== 'function') {
      return setTimeout(flush, 16)
    }
    return requestAnimationFrame(() => flush())
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle as number)
    }
  },
}

export function defaultScheduler(): FlushScheduler {
  return typeof requestAnimationFrame === 'function' ? rafScheduler : immediateScheduler
}
