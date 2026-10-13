/*
 * engine.js — 《生化危机7》DLC「21」玩法引擎（UMD）
 * 同时供 Node 服务端 与 浏览器客户端 使用。
 *
 * 核心玩法（提取自 RE7 Banned Footage Vol.2 的「21」）：
 *  - 双方共用一副 1~11 的牌（无重复）。
 *  - 每人一张暗牌（仅自己可见）+ 若干明牌。
 *  - 轮流出牌：要牌(hit) 或 停牌(stay)。
 *  - 目标：点数凑到最接近 21 且不爆；双方都爆则较小者胜；平局双方均受罚。
 *  - 王牌卡(Trump)：在不消耗回合的情况下改变局势。
 *  - 每输一局扣 1 根手指（默认 5 根），先用完者输。
 */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else global.RE21 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- 王牌卡定义 ----
  // key: 内部名, name: 中文名, desc: 说明, target: 'self' | 'opp' | 'both'
  const TRUMPS = {
    peek:      { name: "窥探",   desc: "查看对手的暗牌",                       target: "self" },
    ret:       { name: "退还",   desc: "把你自己最后一张明牌退回牌堆",         target: "self" },
    drawBest:  { name: "抽高",   desc: "从牌堆抽走当前最大的一张牌",           target: "self" },
    addTwo:    { name: "加二",   desc: "对手本局结算点数 +2（更易爆牌）",      target: "opp"  },
    go24:      { name: "冲24",   desc: "本局目标点数变为 24",                  target: "both" },
    love:      { name: "爱敌",   desc: "逼对手从牌堆抽走最大的一张牌",         target: "opp"  },
    swap:      { name: "交换",   desc: "与对手互换暗牌",                       target: "both" },
    dbl:       { name: "加倍",   desc: "若对手本局落败，额外多扣 1 根手指",    target: "opp"  },
  };
  const TRUMP_KEYS = Object.keys(TRUMPS);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function randInt(n) { return Math.floor(Math.random() * n); }

  function makePlayer(name) {
    return { name, hidden: null, cards: [], stay: false, fingers: 5, trumps: [], connected: true };
  }

  function createGame(opts) {
    opts = opts || {};
    const names = opts.names || ["你", "Lucas"];
    const state = {
      players: [makePlayer(names[0]), makePlayer(names[1])],
      pool: [],
      current: 0,
      target: 21,
      round: 0,
      phase: "idle", // idle | playing | roundEnd | gameOver
      pendingAdd: [0, 0],   // 对手因「加二」而追加的点数
      pendingDbl: [false, false], // 对手是否因「加倍」额外扣手指
      revealed: [false, false],   // seat 是否已窥探对手暗牌
      lastResult: null,
      winner: null,
      log: [],
      fx: null,      // 最近一次王牌特效信号 {trump, seat, id}
      fxId: 0,
    };
    state.players.forEach((p) => refillTrumps(p));
    return state;
  }

  function refillTrumps(p) {
    // 每局开始把手牌补满到 3 张（随机）
    while (p.trumps.length < 3) {
      p.trumps.push(TRUMP_KEYS[randInt(TRUMP_KEYS.length)]);
    }
  }

  function dealRound(state) {
    const full = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    state.players[0].hidden = full[0];
    state.players[1].hidden = full[1];
    state.pool = full.slice(2);
    state.players.forEach((p) => {
      p.cards = [];
      p.stay = false;
      refillTrumps(p);
    });
    // 每人先发一张明牌
    state.players[0].cards.push(state.pool.pop());
    state.players[1].cards.push(state.pool.pop());
    state.current = 0;
    state.target = 21;
    state.pendingAdd = [0, 0];
    state.pendingDbl = [false, false];
    state.revealed = [false, false];
    state.lastResult = null;
    state.fx = null;
    state.round += 1;
    state.phase = "playing";
    state.log.push(`—— 第 ${state.round} 手开始 ——`);
    return state;
  }

  function faceTotal(p) { return p.cards.reduce((a, b) => a + b, 0); }
  function totalOf(p, state) { return p.hidden + faceTotal(p) + state.pendingAdd[p._idx || 0]; }

  function nextTurn(state) {
    if (state.players.every((p) => p.stay)) {
      resolveRound(state);
      return;
    }
    let n = state.current;
    for (let i = 0; i < 2; i++) {
      n = (n + 1) % 2;
      if (!state.players[n].stay) { state.current = n; return; }
    }
  }

  function resolveRound(state) {
    const a = state.players[0], b = state.players[1];
    const ta = a.hidden + faceTotal(a) + state.pendingAdd[0];
    const tb = b.hidden + faceTotal(b) + state.pendingAdd[1];
    const ba = ta > state.target, bb = tb > state.target;
    let losers = [];
    if (ba && bb) {
      if (ta > tb) losers = [0]; else if (tb > ta) losers = [1]; else losers = [0, 1];
    } else if (ba) losers = [0];
    else if (bb) losers = [1];
    else {
      if (ta < tb) losers = [0]; else if (tb < ta) losers = [1]; else losers = [0, 1];
    }
    losers.forEach((i) => {
      const pen = 1 + (state.pendingDbl[i] ? 1 : 0);
      state.players[i].fingers -= pen;
      state.log.push(`${state.players[i].name} 本手落败，失去 ${pen} 根手指（剩 ${Math.max(0, state.players[i].fingers)}）`);
    });
    state.lastResult = { ta, tb, ba, bb, losers, target: state.target };
    const f0 = state.players[0].fingers, f1 = state.players[1].fingers;
    if (f0 <= 0 || f1 <= 0) {
      if (f0 <= 0 && f1 <= 0) state.winner = "draw";
      else state.winner = f0 <= 0 ? 1 : 0;
      state.phase = "gameOver";
      state.log.push(state.winner === "draw" ? "双方同归于尽，平局！" : `${state.players[state.winner].name} 获胜！`);
    } else {
      state.phase = "roundEnd";
    }
    return state;
  }

  // 校验并执行动作。返回 {ok, error}
  function applyAction(state, seat, action) {
    if (state.phase !== "playing") return { ok: false, error: "当前不是出牌阶段" };
    if (state.current !== seat) return { ok: false, error: "还没轮到你" };
    const me = state.players[seat];
    const opp = state.players[1 - seat];

    if (action.type === "hit") {
      if (state.pool.length === 0) return { ok: false, error: "牌堆已空" };
      const c = state.pool.pop();
      me.cards.push(c);
      state.log.push(`${me.name} 要牌：${c}`);
      nextTurn(state);
      return { ok: true };
    }

    if (action.type === "stay") {
      me.stay = true;
      state.log.push(`${me.name} 停牌`);
      nextTurn(state);
      return { ok: true };
    }

    if (action.type === "trump") {
      const key = action.trump;
      const idx = me.trumps.indexOf(key);
      if (idx === -1) return { ok: false, error: "你没有这张王牌" };
      const res = playTrump(state, seat, key);
      if (!res.ok) return res;
      me.trumps.splice(idx, 1); // 消耗王牌
      state.log.push(`${me.name} 使用王牌「${TRUMPS[key].name}」`);
      state.fx = { trump: key, seat, id: ++state.fxId }; // 触发前端特效
      return { ok: true };
    }
    return { ok: false, error: "未知动作" };
  }

  function playTrump(state, seat, key) {
    const me = state.players[seat];
    const opp = state.players[1 - seat];
    switch (key) {
      case "peek":
        state.revealed[seat] = true;
        return { ok: true };
      case "ret":
        if (me.cards.length === 0) return { ok: false, error: "没有可退还的明牌" };
        state.pool.push(me.cards.pop());
        return { ok: true };
      case "drawBest": {
        if (state.pool.length === 0) return { ok: false, error: "牌堆已空" };
        const max = Math.max(...state.pool);
        const i = state.pool.indexOf(max);
        state.pool.splice(i, 1);
        me.cards.push(max);
        return { ok: true };
      }
      case "addTwo":
        state.pendingAdd[1 - seat] += 2;
        return { ok: true };
      case "go24":
        state.target = 24;
        return { ok: true };
      case "love": {
        if (state.pool.length === 0) return { ok: false, error: "牌堆已空" };
        const max = Math.max(...state.pool);
        const i = state.pool.indexOf(max);
        state.pool.splice(i, 1);
        opp.cards.push(max);
        return { ok: true };
      }
      case "swap":
        [me.hidden, opp.hidden] = [opp.hidden, me.hidden];
        return { ok: true };
      case "dbl":
        state.pendingDbl[1 - seat] = true;
        return { ok: true };
      default:
        return { ok: false, error: "未知王牌" };
    }
  }

  // 给指定座位生成“可查看”的状态视图（隐藏对手暗牌与王牌细节）
  function getView(state, seat) {
    const oppSeat = 1 - seat;
    const me = state.players[seat];
    const opp = state.players[oppSeat];
    const myTotal = me.hidden + faceTotal(me) + state.pendingAdd[seat];
    // 本手结束 / 整局结束 时自动亮牌（让玩家看清双方暗牌与点数）；游戏中仅“窥探”王牌可提前看
    const oppTotalKnown = state.revealed[seat] || state.phase === "roundEnd" || state.phase === "gameOver";
    const oppTotal = oppTotalKnown ? (opp.hidden + faceTotal(opp) + state.pendingAdd[oppSeat]) : null;
    return {
      phase: state.phase,
      round: state.round,
      target: state.target,
      current: state.current,
      pool: state.pool.slice(),
      poolCount: state.pool.length,
      winner: state.winner,
      lastResult: state.lastResult,
      fx: state.fx,
      log: state.log.slice(-12),
      me: {
        name: me.name,
        hidden: me.hidden,
        cards: me.cards.slice(),
        stay: me.stay,
        fingers: me.fingers,
        trumps: me.trumps.slice(),
        total: myTotal,
      },
      opp: {
        name: opp.name,
        hidden: oppTotalKnown ? opp.hidden : null,
        cards: opp.cards.slice(),
        stay: opp.stay,
        fingers: opp.fingers,
        trumpCount: opp.trumps.length,
        total: oppTotal,
        revealed: oppTotalKnown,
      },
    };
  }

  // ---- 简易 AI ----
  // 返回 {type:'hit'|'stay'} 或 {type:'trump', trump:'key'}（王牌不消耗回合，调用方循环处理）
  function aiAction(state, seat) {
    const me = state.players[seat];
    const opp = state.players[1 - seat];
    const myT = me.hidden + faceTotal(me) + state.pendingAdd[seat];
    const oppFace = faceTotal(opp);
    const oppKnown = state.revealed[seat];
    const oppEst = oppKnown ? (opp.hidden + oppFace + state.pendingAdd[1 - seat]) : (oppFace + 7);
    const has = (k) => me.trumps.includes(k);

    // 1) 已经爆了且能退还 → 退还自救
    if (myT > state.target && has("ret")) return { type: "trump", trump: "ret" };
    // 2) 自己点数很低且有「抽高」→ 抽到接近 21
    if (myT <= 17 && state.pool.length > 0 && has("drawBest")) return { type: "trump", trump: "drawBest" };
    // 3) 对手已接近爆牌，用「加二」推一把（需已知对手点数或估计很高）
    if ((oppKnown ? (opp.hidden + oppFace) >= 20 : oppEst >= 22) && has("addTwo")) return { type: "trump", trump: "addTwo" };
    // 4) 自己落后且对手未停牌 → 用「爱敌」赌博让对手爆
    if (!opp.stay && myT < oppEst && myT <= 20 && state.pool.length > 0 && has("love")) return { type: "trump", trump: "love" };
    // 5) 自己暗牌很差且对手可能领先 → 交换暗牌
    if (me.hidden <= 3 && oppEst > myT && has("swap")) return { type: "trump", trump: "swap" };
    // 6) 早期且未窥探 → 窥探
    if (!oppKnown && has("peek")) return { type: "trump", trump: "peek" };
    // 7) 自己稳赢（已停牌对手点数低）→ 加倍惩罚
    if (opp.stay && myT <= state.target && myT > oppEst && has("dbl")) return { type: "trump", trump: "dbl" };

    // 8) 基础要牌/停牌策略
    if (myT === 21) return { type: "stay" };
    if (myT >= 22) return { type: "stay" }; // 已爆，只能希望对手更糟
    if (myT <= 16) {
      if (state.pool.length === 0) return { type: "stay" };
      return { type: "hit" };
    }
    // 17~21 区间
    const safeMin = Math.min(...state.pool, 99);
    if (myT < oppEst && state.pool.length > 0 && myT + safeMin <= state.target) {
      return { type: "hit" };
    }
    return { type: "stay" };
  }

  return {
    TRUMPS, TRUMP_KEYS,
    createGame, dealRound, applyAction, getView, aiAction,
    faceTotal, totalOf,
  };
});
