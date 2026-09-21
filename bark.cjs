const { readResponseText } = require('./response-body.cjs');
const { normalizeAllowedRemoteImageUrl } = require('./remote-image-url.cjs');

function normalizeBarkUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 Bark 推送地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname === '/' || url.href.length > 2048) {
    throw new Error('Bark 地址应为 https://服务器/设备Key，不含查询参数');
  }
  return url.href.replace(/\/+$/, '');
}

function buildWinnerNotification(winner, remaining) {
  let icon;
  try {
    const avatar = normalizeAllowedRemoteImageUrl(winner.avatar);
    if (Buffer.byteLength(avatar) <= 1024) icon = avatar;
  } catch { /* Missing/untrusted avatars must never prevent the text notification. */ }
  const text = (value, length) => Array.from(String(value || '')).slice(0, length).join('');
  const number = value => Math.max(0, Math.floor(Number(value) || 0));
  const nickname = text(winner.nickname || '匿名观众', 80);
  const userId = winner.userIdVerified && winner.userIdSource === 'displayId' && /^\d+$/.test(winner.userId || '')
    ? text(winner.userId, 32) : '未获取';
  const timestamp = Number(winner.wonAt);
  const time = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '未记录';
  return {
    title: `第 ${number(winner.drawNo)} 轮中奖 · ${text(nickname, 32)}`,
    body: `昵称：${nickname}\n抖音号：${userId}\n弹幕：${text(winner.content || '未留下弹幕', icon ? 300 : 500)}\n本轮：第 ${number(winner.batchPosition) || 1}/${number(winner.batchSize) || 1} 位\n中奖时间：${time}\n剩余名额：${number(remaining)}`,
    ...(icon ? { icon } : {}),
    group: 'DyCast 中奖',
    isArchive: 1
  };
}

/** 地址只以系统加密文本保存；网络失败不暴露设备 Key，也不影响中奖结算。 */
function createBarkService({ getStore, safeStorage, fetchImpl, timeoutMs = 10000 }) {
  const recentIds = new Set();
  let inFlight = 0;
  let lastResult = null;
  const read = () => getStore().read().sections.bark || {};
  function getState() {
    const config = read();
    return { enabled: config.enabled === true, configured: Boolean(config.encryptedUrl), lastResult };
  }
  function save(config) {
    const previous = read();
    const patch = {};
    if (typeof config?.enabled === 'boolean') patch.enabled = config.enabled;
    if (typeof config?.pushUrl === 'string') {
      if (config.pushUrl.trim()) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持安全保存推送地址');
        patch.encryptedUrl = safeStorage.encryptString(normalizeBarkUrl(config.pushUrl)).toString('base64');
      } else {
        patch.encryptedUrl = '';
        patch.enabled = false;
      }
    }
    if (patch.enabled && !(patch.encryptedUrl ?? previous.encryptedUrl)) throw new Error('请先保存 Bark 推送地址');
    getStore().updateSection('bark', patch);
    return getState();
  }
  async function send(payload) {
    const config = read();
    if (!config.encryptedUrl) throw new Error('请先保存 Bark 推送地址');
    if (inFlight >= 32) throw new Error('推送请求过多，请稍后再试');
    let url;
    try {
      url = normalizeBarkUrl(safeStorage.decryptString(Buffer.from(config.encryptedUrl, 'base64')));
    } catch { throw new Error('无法读取 Bark 地址，请在当前电脑重新保存'); }
    inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let failure = '推送失败，请检查网络和 Bark 地址';
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const body = await readResponseText(response, 16 * 1024, 'Bark 响应');
      if (!response.ok) {
        failure = `Bark 服务返回 HTTP ${response.status}，请检查推送地址`;
        throw new Error();
      }
      if (JSON.parse(body).code !== 200) {
        failure = 'Bark 未接受推送，请检查设备 Key';
        throw new Error();
      }
      lastResult = { success: true, message: 'Bark 已接受推送', at: Date.now() };
      return lastResult;
    } catch {
      if (controller.signal.aborted) failure = 'Bark 推送超时，请检查网络';
      lastResult = { success: false, message: failure, at: Date.now() };
      throw new Error(failure);
    } finally {
      clearTimeout(timer);
      inFlight--;
    }
  }
  return {
    getState, save,
    test: () => send({ title: 'DyCast 推送测试', body: 'Bark 已连接，中奖揭晓后会推送中奖信息。', group: 'DyCast 中奖' }),
    async notifyWinner(winner, remaining) {
      if (!read().enabled) return { skipped: true };
      const id = String(winner?.winRecordId || '').slice(0, 256);
      if (!id || recentIds.has(id)) return { skipped: true };
      // 先占位，阻止并发和重复揭晓；失败不盲目重试，避免超时后重复推送。
      recentIds.add(id);
      if (recentIds.size > 2000) recentIds.delete(recentIds.values().next().value);
      try { return await send(buildWinnerNotification(winner, remaining)); }
      catch (error) {
        lastResult = { success: false, message: error.message, at: Date.now() };
        return lastResult;
      }
    }
  };
}

module.exports = { normalizeBarkUrl, buildWinnerNotification, createBarkService };
