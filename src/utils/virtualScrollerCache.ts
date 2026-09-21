interface ScrollerCache {
  vscrollData?: { sizes: Record<string, number> };
  $_undefinedMap?: Record<string, boolean | undefined>;
  $_undefinedSizes?: number;
}

/** vue-virtual-scroller 2 的条目淘汰不会回收按 ID 保存的高度表。 */
export function pruneVirtualScrollerCache(scroller: ScrollerCache | null | undefined, retainedIds: string[]): void {
  if (!scroller) return;
  const retained = new Set(retainedIds);
  const sizes = scroller.vscrollData?.sizes;
  if (sizes) {
    for (const id of Object.keys(sizes)) {
      if (!retained.has(id)) delete sizes[id];
    }
  }
  const pending = scroller.$_undefinedMap;
  if (pending) {
    let removedPending = 0;
    for (const id of Object.keys(pending)) {
      if (retained.has(id)) continue;
      if (pending[id]) removedPending++;
      delete pending[id];
    }
    scroller.$_undefinedSizes = Math.max(0, (scroller.$_undefinedSizes || 0) - removedPending);
  }
}

/** 隐藏窗口的 rAF 可能停发，输入队列本身也必须有界。 */
export function appendRecentItems<T>(queue: T[], incoming: T[], limit: number): void {
  const start = Math.max(0, incoming.length - limit);
  const overflow = Math.max(0, queue.length + incoming.length - start - limit);
  if (overflow) queue.splice(0, overflow);
  for (let index = start; index < incoming.length; index++) queue.push(incoming[index]);
}
