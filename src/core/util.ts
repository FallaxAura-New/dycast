import type { DyLiveInfo } from './dycast';

/** Decode the streamed JSON strings without evaluating page scripts. */
function livePageSources(html: string): string[] {
  const fragments: string[] = [];
  for (const match of html.matchAll(/self\.__pace_f\.push\(\s*\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)/g)) {
    try { fragments.push(JSON.parse(match[1])); } catch { /* Ignore a malformed fragment. */ }
  }
  return fragments.length ? [fragments.join(''), html] : [html];
}

/** Keep fields within their own object: never borrow a recommended room's ID/status. */
function* pageObjects(source: string, field: string): Generator<Record<string, any>> {
  const pattern = new RegExp(`"${field}"\\s*:\\s*\\{`, 'g');
  for (let match; (match = pattern.exec(source));) {
    const start = pattern.lastIndex - 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let complete = false;
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { yield JSON.parse(source.slice(start, end + 1)); } catch { /* Try the next state. */ }
        pattern.lastIndex = end + 1;
        complete = true;
        break;
      }
    }
    // A truncated object cannot yield data; don't repeatedly rescan its entire tail.
    if (!complete) return;
  }
}

function liveId(value: unknown): string {
  // Numeric 64-bit IDs cannot safely survive JSON.parse; require the string variant.
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : '';
}

function viewerFromSources(sources: string[]): string {
  for (const source of sources) {
    for (const store of pageObjects(source, 'userStore')) {
      const id = liveId(store.odin?.user_unique_id);
      if (id) return id;
    }
  }
  return '';
}

export function parseLiveViewerId(html: string): string {
  return viewerFromSources(livePageSources(html));
}

export function liveInfoFromRoom(roomInfo: Record<string, any>, uniqueId: string): DyLiveInfo | null {
  const room = roomInfo.room;
  const roomId = liveId(roomInfo.roomId) || liveId(roomInfo.room_id) || liveId(room?.id_str);
  if (!roomId || !liveId(uniqueId) || !room || typeof room !== 'object') return null;
  const anchor = roomInfo.anchor || room.owner || {};
  const text = (value: unknown) => typeof value === 'string'
    ? value.replace(/\\+u0026/g, '&').replace(/\\+\//g, '/') : '';
  return {
    roomId, uniqueId,
    avatar: text(anchor.avatar_thumb?.url_list?.[0]),
    cover: text(room.cover?.url_list?.[0]),
    nickname: text(anchor.nickname),
    title: text(room.title),
    status: Number(room.status ?? room.status_str) || 4,
    anchorId: liveId(anchor.id_str) || liveId(room.owner_user_id) || liveId(room.ownerUserId)
  };
}

export function parseLiveHtml(html: string, expectedRoomNumber?: string): DyLiveInfo | null {
  const sources = livePageSources(html);
  const uniqueId = viewerFromSources(sources);
  if (!uniqueId) return null;
  for (const source of sources) {
    for (const roomInfo of pageObjects(source, 'roomInfo')) {
      if (expectedRoomNumber && roomInfo.web_rid && roomInfo.web_rid !== expectedRoomNumber) continue;
      const info = liveInfoFromRoom(roomInfo, uniqueId);
      if (info) return info;
    }
  }
  return null;
}

/**
 * 将对象化成请求参数字符串
 *  - 如：item1=value1&item2=value2&...
 * @param params 请求参数对象
 * @returns
 */
export const makeUrlParams = function (params: any): string {
  return Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
};
