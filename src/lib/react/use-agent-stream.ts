import { useSyncExternalStore } from 'react'
import type { AgentStreamStore } from '../core/store'
import type { ConversationSnapshot } from '../types'

/**
 * 订阅会话快照。
 *
 * `useSyncExternalStore` 在这里不是炫技：它保证并发渲染下不会读到撕裂的状态
 * （tearing）——流式更新是典型的高频外部源，用 useState + useEffect 很容易
 * 读到半新半旧的快照。
 */
export function useAgentStream(store: AgentStreamStore): ConversationSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
