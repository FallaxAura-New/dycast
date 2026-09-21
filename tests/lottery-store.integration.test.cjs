const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); }
  };
}

class TestBroadcastChannel {
  onmessage = null;
  postMessage() {}
  close() {}
}

test('the tenth eligible comment auto-locks a batch and a previous winner can win a later round', async () => {
  const originalGlobals = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    indexedDB: globalThis.indexedDB,
    BroadcastChannel: globalThis.BroadcastChannel
  };
  const originalSetTimeout = globalThis.setTimeout;
  const testTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(() => { testTimers.delete(timer); callback(...args); }, delay);
    testTimers.add(timer);
    return timer;
  };
  const originalWarn = console.warn;
  const memoryStorage = createMemoryStorage();
  globalThis.localStorage = memoryStorage;
  globalThis.window = {
    electronAPI: undefined,
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout
  };
  globalThis.indexedDB = { open() { throw new Error('IndexedDB is disabled in this test'); } };
  globalThis.BroadcastChannel = TestBroadcastChannel;
  console.warn = (message, ...details) => {
    if (String(message).startsWith('[store] 完整') && String(message).includes('缓存加载失败')) return;
    originalWarn(message, ...details);
  };

  let server;
  let appSettings;
  try {
    const [{ createServer }, { default: vue }] = await Promise.all([
      import('vite'),
      import('@vitejs/plugin-vue')
    ]);
    server = await createServer({
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      plugins: [vue()],
      resolve: { alias: { '@': path.resolve(__dirname, '../src') } },
      server: { middlewareMode: true }
    });

    const store = await server.ssrLoadModule('/src/danmu/store.ts');
    appSettings = await server.ssrLoadModule('/src/utils/settingUtil.ts');
    appSettings.useSettings().value.remainingWinnerCount = 2;
    appSettings.useSettings().value.lotteryBadgeLevel = 0;
    store.updateSettings({
      lotteryThreshold: 10,
      lotteryWinnerCount: 1,
      lotteryKeyword: '',
      lotteryUserCooldownEnabled: false
    });

    const state = store.useDanmuState();
    store.beginLiveSession('room-a');
    store.startCollecting();
    for (let index = 1; index <= 5; index++) {
      store.pushDanmu({
        id: `room-a-${index}`,
        secUid: `room-a-user-${index}`,
        avatar: '',
        nickname: `旧房间观众${index}`,
        content: '参与旧房间抽奖',
        timestamp: index,
        liveSessionId: 'room-a',
        liveSessionCount: index
      });
    }
    assert.equal(state.totalDanmuCount, 5);
    assert.equal(state.energy, 5);
    assert.equal(state.lotteryPool.length, 5);

    let sessionResetSignals = 0;
    const stopSessionResetSubscription = store.subscribeDisplayDanmu(danmu => {
      if (danmu === null) sessionResetSignals += 1;
    });
    store.beginLiveSession('room-b');
    assert.equal(sessionResetSignals, 1, '切换会话须通知飘屏清除已飞出的旧弹幕');
    stopSessionResetSubscription();
    assert.equal(state.isCollecting, false, '切换直播间必须停止上一轮充能');
    assert.equal(state.totalDanmuCount, 0);
    assert.equal(state.energy, 0);
    assert.equal(state.lotteryPool.length, 0, '新房间不得继承旧房间奖池');
    assert.equal(state.activeDanmu.length, 0);
    assert.equal(state.displayDanmu.length, 0);

    store.startCollecting();
    store.pushDanmu({
      id: 'late-room-a-message',
      secUid: 'late-room-a-user',
      avatar: '',
      nickname: '旧连接迟到消息',
      content: '不应进入新房间',
      timestamp: 99,
      liveSessionId: 'room-a',
      liveSessionCount: 6
    });
    assert.equal(state.totalDanmuCount, 0, '旧会话迟到消息不得让状态切回旧房间');
    assert.equal(state.lotteryPool.length, 0);
    store.stopCollecting();

    store.updateSettings({ lotteryWinnerCount: 2 });
    let canonicalRemainingWinnerCount = 1;
    globalThis.window.electronAPI = {
      consumeRemainingWinnerCount(requested) {
        const consumed = Math.min(canonicalRemainingWinnerCount, requested);
        canonicalRemainingWinnerCount -= consumed;
        return {
          consumed,
          remainingWinnerCount: canonicalRemainingWinnerCount,
          settings: { remainingWinnerCount: canonicalRemainingWinnerCount }
        };
      },
      restoreRemainingWinnerCount(requested) {
        const restored = Math.min(9999 - canonicalRemainingWinnerCount, requested);
        canonicalRemainingWinnerCount += restored;
        return {
          restored,
          remainingWinnerCount: canonicalRemainingWinnerCount,
          settings: { remainingWinnerCount: canonicalRemainingWinnerCount }
        };
      }
    };
    store.startCollecting();
    for (let index = 1; index <= 10; index++) {
      store.pushDanmu({
        id: `cancelled-${index}`,
        secUid: `cancelled-user-${index}`,
        avatar: '',
        nickname: `待取消观众${index}`,
        content: '切房前待揭晓',
        timestamp: 50_000 + index
      });
    }
    const cancelledBatch = store.prepareLotteryBatch(1);
    assert.equal(cancelledBatch.length, 1);
    assert.equal(canonicalRemainingWinnerCount, 0, '批次人数必须服从主进程实际预留结果');

    store.beginLiveSession('room-c');
    assert.equal(state.isLotteryActive, false);
    assert.equal(canonicalRemainingWinnerCount, 1, '切房应返还尚未揭晓的名额');
    store.revealLotteryWinner(cancelledBatch[0]);
    assert.equal(state.lotteryHistory.length, 0, '旧动画迟到回调不得写回已取消的中奖者');
    globalThis.window.electronAPI = undefined;
    const barkWinners = [];
    globalThis.window.electronAPI = { notifyBarkWinner: async winner => { barkWinners.push(winner); return { success: true }; } };
    appSettings.useSettings().value.remainingWinnerCount = 2;
    store.updateSettings({ lotteryWinnerCount: 1 });

    const pushRound = (round) => {
      store.startCollecting();
      for (let index = 1; index <= 10; index++) {
        store.pushDanmu({
          id: `round-${round}-${index}`,
          secUid: 'repeat-viewer',
          avatar: '',
          nickname: '可重复中奖观众',
          content: '参与抽奖',
          timestamp: round * 100_000 + index
        });
        if (index === 9) assert.equal(state.isLotteryActive, false);
      }
      assert.equal(state.isLotteryActive, true);
      assert.equal(state.activeDanmu.length, 10, '开奖时不得清空已经在飘动的弹幕');
      store.pushDanmu({
        id: `round-${round}-during-lottery`,
        secUid: `during-lottery-user-${round}`,
        avatar: '',
        nickname: '开奖期间新观众',
        content: '中奖展示时也要继续飘动',
        timestamp: round * 100_000 + 11
      });
      assert.equal(state.activeDanmu.length, 11, '中奖展示期间的新弹幕仍应进入飘屏');
      const batch = store.prepareLotteryBatch(1);
      assert.equal(batch.length, 1);
      store.revealLotteryWinner(batch[0]);
      store.revealLotteryWinner(batch[0]);
      assert.equal(barkWinners.length, round, '重复揭晓不能再次发送 Bark 消息');
      store.closeLottery();
      assert.equal(state.activeDanmu.length, 11, '关闭中奖展示后不得清空仍在飞行的弹幕');
      store.stopCollecting();
    };

    pushRound(1);
    assert.equal(state.lotteryCount, 1);
    assert.equal(appSettings.useSettings().value.remainingWinnerCount, 1);

    store.beginLiveSession('room-d');
    assert.equal(state.lotteryHistory.length, 1, '切换直播间应保留已经揭晓的中奖历史');
    assert.equal(state.lotteryCount, 1);
    assert.equal(appSettings.useSettings().value.remainingWinnerCount, 1);

    pushRound(2);
    assert.equal(state.lotteryCount, 2);
    assert.equal(state.lotteryHistory.length, 2);
    assert.equal(appSettings.useSettings().value.remainingWinnerCount, 0);

    // Regression: ten raw comments with one badge-qualified viewer used to lock
    // a one-person batch, silently ignoring the configured ten winners.
    store.beginLiveSession('multi-winner-room');
    appSettings.useSettings().value.remainingWinnerCount = 20;
    appSettings.useSettings().value.lotteryBadgeLevel = 5;
    store.updateSettings({ lotteryWinnerCount: 10 });
    await Promise.resolve();
    store.startCollecting();
    let messageNumber = 0;
    const pushCandidate = (user, badgeLevel) => store.pushDanmu({
      id: `multi-message-${++messageNumber}`, secUid: `multi-user-${user}`,
      nickname: `观众${user}`, avatar: `https://p3.douyinpic.com/avatar-${user}.jpg`,
      content: '参与抽奖', timestamp: 900000 + messageNumber,
      targetAnchorId: 'anchor', fansClub: [{ anchorId: 'anchor', level: badgeLevel }]
    });
    pushCandidate(1, 5);
    for (let index = 2; index <= 10; index++) pushCandidate(index, 1);
    assert.equal(state.energy, 10);
    assert.equal(state.isLotteryActive, false, '10 条原始弹幕只有 1 位合格观众时不能缩水开奖');
    assert.equal(store.getLotteryStartBlockReason(), 'not-enough-eligible-participants');
    assert.deepEqual(store.prepareLotteryBatch(10), [], '直接锁定入口同样不得缩成单人');
    for (let index = 0; index < 20; index++) pushCandidate(1, 5);
    assert.equal(state.isLotteryActive, false, '同一观众刷屏不能补足多人名额');
    assert.equal(store.getDanmuRetentionStats().eligibleParticipants, 1);
    for (let index = 2; index <= 10; index++) {
      pushCandidate(index, 5);
      if (index < 10) assert.equal(state.isLotteryActive, false);
    }
    assert.equal(state.isLotteryActive, true, '第 10 位合格观众到来自动开启完整批次');
    const multiBatch = store.prepareLotteryBatch(10);
    assert.equal(multiBatch.length, 10);
    assert.equal(new Set(multiBatch.map(winner => winner.secUid)).size, 10);
    assert.ok(multiBatch.every(winner => winner.batchSize === 10));
    assert.equal(appSettings.useSettings().value.remainingWinnerCount, 10);
    assert.equal(store.prepareLotteryBatch(10).length, 10, '动画再次领取批次不能重复扣名额');
    assert.equal(appSettings.useSettings().value.remainingWinnerCount, 10);
    const notificationsBefore = barkWinners.length;
    for (const winner of multiBatch) {
      store.revealLotteryWinner(winner);
      store.revealLotteryWinner(winner);
    }
    assert.equal(state.lotteryHistory.length, 12);
    assert.equal(barkWinners.length - notificationsBefore, 10);
    assert.ok(barkWinners.slice(-10).every(winner => winner.avatar.startsWith('https://p3.douyinpic.com/')));
    store.closeLottery();
    store.stopCollecting();
    appSettings.useSettings().value.remainingWinnerCount = 0;
    appSettings.useSettings().value.lotteryBadgeLevel = 0;
    store.updateSettings({ lotteryUserCooldownEnabled: true });
    await Promise.resolve();
    store.startCollecting();
    for (let index = 0; index < 60000; index++) {
      store.pushDanmu({ id: `stress-${index}`, secUid: `stress-user-${index}`, nickname: '压力测试', avatar: '', content: '参与', timestamp: index + 1000000 });
    }
    const retained = store.getDanmuRetentionStats();
    assert.equal(retained.pool, 50000);
    assert.equal(retained.cooldownUsers, retained.pool, '被奖池淘汰的观众不得永久留在防刷 Map');
    assert.equal(retained.eligible, retained.pool);
    assert.equal(retained.eligibleParticipants, retained.pool, '去重人数索引随奖池淘汰，不得持续增长');
    assert.equal(retained.recentMessages, 10000);
    assert.equal(retained.displayed, 500);
    assert.equal(retained.active, 100);
    store.resetDanmuState();
    assert.equal(store.getDanmuRetentionStats().cooldownUsers, 0);
    assert.equal(store.getDanmuRetentionStats().eligibleParticipants, 0);
  } finally {
    await Promise.resolve();
    appSettings?.flushSettings();
    await server?.close();
    for (const timer of testTimers) clearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.window = originalGlobals.window;
    globalThis.localStorage = originalGlobals.localStorage;
    globalThis.indexedDB = originalGlobals.indexedDB;
    globalThis.BroadcastChannel = originalGlobals.BroadcastChannel;
    console.warn = originalWarn;
  }
});
