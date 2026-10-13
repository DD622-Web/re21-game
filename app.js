/* app.js — RE7 · 21 点 客户端 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const RE21 = window.RE21;

  // ---------------- 音效（Web Audio 实时合成，无需音频文件） ----------------
  const SFX = (function () {
    let ctx = null;
    function ensure() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
      if (ctx && ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function tone(freq, start, dur, type, peak) {
      const c = ensure(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      const t = c.currentTime + start;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak || 0.16, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
    }
    function noise(start, dur, peak, hp) {
      const c = ensure(); if (!c) return;
      const n = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, n, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp || 1500;
      const g = c.createGain(); g.gain.value = peak || 0.1;
      src.connect(f).connect(g).connect(c.destination); src.start(c.currentTime + start);
    }
    return {
      unlock() { ensure(); },
      deal() { noise(0, 0.07, 0.09, 2000); tone(520, 0, 0.06, "triangle", 0.1); },
      stay() { tone(330, 0, 0.18, "sine", 0.13); tone(247, 0.05, 0.2, "sine", 0.09); },
      trump() {
        [660, 880, 1100, 1320].forEach((f, i) => tone(f, i * 0.055, 0.2, "triangle", 0.13));
        noise(0, 0.22, 0.05, 3200);
      },
      lose() { tone(165, 0, 0.32, "sawtooth", 0.15); tone(110, 0.04, 0.36, "square", 0.09); },
      gain() { tone(523, 0, 0.12, "triangle", 0.14); tone(784, 0.06, 0.16, "triangle", 0.12); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.32, "triangle", 0.16)); },
    };
  })();
  // 首次交互解锁音频（浏览器策略）
  document.addEventListener("pointerdown", () => SFX.unlock(), { passive: true });

  // ---------------- 全局状态 ----------------
  let mode = null;            // 'solo' | 'online'
  let localState = null;      // 单人模式本地状态
  let ws = null;              // 联机 WebSocket
  let mySeat = 0;             // 联机座位
  let curView = null;         // 当前视图
  let aiTimer = null;
  let online = { code: "", you: "", opp: "" };
  let prev = { opp: 0, me: 0, round: 0, fOpp: 5, fMe: 5, phase: "playing", oppRevealed: false }; // 动画追踪
  let lastFxId = 0;        // 已播放过的王牌特效 id
  let introOpen = false;      // 开场弹窗是否打开

  // ---------------- 菜单交互 ----------------
  $("btnSolo").onclick = startSolo;
  $("btnOnline").onclick = () => $("onlinePanel").classList.toggle("hidden");
  $("btnCreate").onclick = onlineCreate;
  $("btnJoin").onclick = onlineJoin;
  $("btnQuit").onclick = quitToMenu;
  $("btnStartGame").onclick = hideIntro;
  $("btnSend").onclick = sendChat;
  $("chatText").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  function showScreen(id) {
    $("menu").classList.toggle("hidden", id !== "menu");
    $("game").classList.toggle("hidden", id !== "game");
  }

  function showIntro() {
    $("introModal").classList.remove("hidden");
  }
  function hideIntro() {
    $("introModal").classList.add("hidden");
    introOpen = false;
    if (mode === "solo") maybeRunAI(); // 关掉弹窗后让 AI 开始
  }

  // ---------------- 单人 vs AI ----------------
  function startSolo() {
    mode = "solo";
    $("modeLabel").textContent = "单人 · 对战 AI";
    $("roomInfo").classList.add("hidden");
    $("chat").classList.add("hidden");
    $("statusDot").className = "status-dot on";
    introOpen = true;
    resetSolo();
    showScreen("game");
    showIntro();
  }
  function resetSolo() {
    clearTimeout(aiTimer);
    prev = { opp: 0, me: 0, round: 0, fOpp: 5, fMe: 5, phase: "playing", oppRevealed: false };
    localState = RE21.createGame({ names: ["你", "Lucas"] });
    RE21.dealRound(localState);
    curView = RE21.getView(localState, 0);
    render(curView);
    maybeRunAI();
  }
  function maybeRunAI() {
    if (introOpen) return;
    if (mode !== "solo" || !localState) return;
    if (localState.phase !== "playing" || localState.current !== 1) return;
    aiTimer = setTimeout(() => {
      let a = RE21.aiAction(localState, 1);
      let guard = 0;
      while (a.type === "trump" && guard < 20) {
        RE21.applyAction(localState, 1, a);
        a = RE21.aiAction(localState, 1);
        guard++;
      }
      if (a.type !== "trump") RE21.applyAction(localState, 1, a);
      curView = RE21.getView(localState, 0);
      render(curView);
      maybeRunAI();
    }, 800);
  }

  // ---------------- 联机 ----------------
  function wsUrl() {
    const custom = ($("serverInput").value || "").trim();
    if (custom) {
      let u = custom.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
      const proto = (location.protocol === "https:" || /^wss?:\/\//.test(custom)) ? "wss" : "ws";
      return `${proto}://${u}`;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  function onlineCreate() {
    const name = ($("nameInput").value || "玩家").trim();
    ws = new WebSocket(wsUrl());
    ws.onopen = () => ws.send(JSON.stringify({ type: "create", name }));
    ws.onmessage = onWsMessage;
    ws.onclose = () => setStatus(false);
    ws.onerror = () => msg("连接失败，请确认服务器已启动");
  }
  function onlineJoin() {
    const name = ($("nameInput").value || "玩家").trim();
    const code = ($("codeInput").value || "").trim().toUpperCase();
    if (code.length !== 4) { msg("请输入 4 位房间码"); return; }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", name, code }));
    ws.onmessage = onWsMessage;
    ws.onclose = () => setStatus(false);
    ws.onerror = () => msg("连接失败，请确认服务器已启动");
  }
  function setStatus(on) {
    $("statusDot").className = "status-dot " + (on ? "on" : "off");
  }
  function msg(t) { $("onlineMsg").textContent = t; }

  function onWsMessage(ev) {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "created":
        online.code = m.code;
        setStatus(true);
        msg(`房间已创建：${m.code} — 把房间码发给好友，等 TA 加入…`);
        break;
      case "start":
        mode = "online";
        mySeat = m.seat;
        online = { code: m.code, you: m.you, opp: m.opp };
        $("modeLabel").textContent = "联机 · 对战好友";
        $("roomInfo").classList.remove("hidden");
        $("roomInfo").innerHTML = `房间 <b>${m.code}</b> · 对手 ${escapeHtml(m.opp)} ` +
          `<button class="mini-btn alt" id="copyCode" style="padding:4px 10px;font-size:12px">复制房间码</button>`;
        $("chat").classList.remove("hidden");
        $("chatLog").innerHTML = "";
        prev = { opp: 0, me: 0, round: 0, fOpp: 5, fMe: 5, phase: "playing", oppRevealed: false };
        showScreen("game");
        introOpen = true;
        showIntro();
        $("copyCode").onclick = () => navigator.clipboard && navigator.clipboard.writeText(m.code);
        break;
      case "state":
        curView = m.view;
        render(curView);
        break;
      case "chat":
        appendChat(m.from, m.text);
        break;
      case "opponentLeft":
        appendSys("对手已离开房间");
        break;
      case "error":
        if (mode !== "online") msg(m.message);
        else alert(m.message);
        break;
    }
  }
  function sendChat() {
    const t = $("chatText").value.trim();
    if (!t || !ws) return;
    ws.send(JSON.stringify({ type: "chat", text: t }));
    $("chatText").value = "";
  }
  function appendChat(from, text) {
    const d = document.createElement("div");
    d.innerHTML = `<span class="who">${escapeHtml(from)}：</span>${escapeHtml(text)}`;
    $("chatLog").appendChild(d);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }
  function appendSys(text) {
    const d = document.createElement("div");
    d.className = "sys";
    d.textContent = text;
    $("chatLog").appendChild(d);
  }

  // ---------------- 动作 ----------------
  function doAction(action) {
    if (action.type === "stay") SFX.stay();
    if (mode === "solo") {
      const r = RE21.applyAction(localState, 0, action);
      if (!r.ok) return;
      curView = RE21.getView(localState, 0);
      render(curView);
      maybeRunAI();
    } else if (mode === "online" && ws) {
      ws.send(JSON.stringify({ type: "action", action }));
    }
  }
  function doNext() {
    if (mode === "solo") {
      // 同一局内发「下一手」：手指保留，继续累计，直到有人掉光 5 根
      RE21.dealRound(localState);
      prev = { opp: 0, me: 0, round: localState.round, fOpp: localState.players[1].fingers, fMe: localState.players[0].fingers, phase: "playing", oppRevealed: false };
      curView = RE21.getView(localState, 0);
      render(curView);
      maybeRunAI();
    } else if (ws) ws.send(JSON.stringify({ type: "next" }));
  }
  function doRestart() {
    if (mode === "solo") resetSolo();
    else if (ws) ws.send(JSON.stringify({ type: "restart" }));
  }

  function quitToMenu() {
    clearTimeout(aiTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    mode = null; localState = null; curView = null;
    showScreen("menu");
  }

  // ---------------- 渲染 ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function rankOf(v) { return v === 1 ? "A" : v === 11 ? "J" : String(v); }
  function pickSuit(v, seed) {
    const suits = ["♠", "♥", "♦", "♣"];
    return suits[(v + (seed || 0)) % 4];
  }
  function cardHTML(val, opts) {
    opts = opts || {};
    if (opts.back) return `<div class="card back"></div>`;
    const suit = pickSuit(val, opts.seed);
    const rank = rankOf(val);
    const color = (suit === "♥" || suit === "♦") ? "red" : "black";
    const dim = opts.dim ? " dim" : "";
    const small = opts.small ? " small" : "";
    const nw = opts.new ? " new" : "";
    const reveal = opts.reveal ? " reveal" : "";
    const delay = opts.new ? ` style="animation-delay:${opts.delay || 0}s"` : "";
    return `<div class="card ${color}${small}${dim}${nw}${reveal}"${delay}>
      <span class="corner tl"><span>${rank}</span><span>${suit}</span></span>
      <span class="center-pip">${suit}</span>
      <span class="corner br"><span>${rank}</span><span>${suit}</span></span>
    </div>`;
  }
  // 真实手掌 SVG：5 根手指（小指/无名指/中指/食指/拇指），输掉的指会掉落并留下红色断口
  // 插槽顺序即手指顺序：n 根存活，n..4 为已失去
  const HAND_SLOTS = [
    { x: 46, top: 58, h: 42, w: 18, bx: 55, by: 100 },  // 小指
    { x: 68, top: 42, h: 58, w: 19, bx: 77, by: 100 },  // 无名指
    { x: 90, top: 34, h: 66, w: 19, bx: 99, by: 100 },  // 中指
    { x: 112, top: 46, h: 54, w: 18, bx: 121, by: 100 }, // 食指
    { x: 14, top: 64, h: 56, w: 18, rot: -34, bx: 33, by: 100 }, // 拇指
  ];
  function fingerSVG(s, extra) {
    const baseCx = s.x + s.w / 2;
    const inner = `<g class="finger ${extra || ""}">
      <rect x="${s.x}" y="${s.top}" width="${s.w}" height="${s.h}" rx="${s.w / 2}" ry="${s.w / 2}"
        fill="url(#skinG)" stroke="#c79a6f" stroke-width="1.5"/>
      <ellipse class="nail" cx="${baseCx}" cy="${s.top + 7}" rx="${s.w / 2 - 2}" ry="5"/>
    </g>`;
    return s.rot ? `<g transform="rotate(${s.rot} ${baseCx} 100)">${inner}</g>` : inner;
  }
  function handHTML(n, justLost) {
    let parts = "";
    HAND_SLOTS.forEach((s, i) => {
      if (i < n) {
        parts += fingerSVG(s, "");                       // 存活手指
      } else {
        parts += `<circle class="stump" cx="${s.bx}" cy="${s.by}" r="7"/>`; // 断口
        if (justLost && i === n) parts += fingerSVG(s, "dropping");          // 本回合刚掉落的那根
      }
    });
    const hurt = justLost ? " hurt" : "";
    return `<span class="hand-wrap"><svg class="hand-svg${hurt}" viewBox="0 0 150 190" overflow="visible">
      <defs><linearGradient id="skinG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#F1D4B5"/><stop offset="1" stop-color="#D9B086"/>
      </linearGradient></defs>
      <path class="palm" d="M44 100 L128 100 C134 130 130 162 112 170 L60 170 C42 162 38 130 44 100 Z"
        fill="url(#skinG)" stroke="#c79a6f" stroke-width="2"/>
      ${parts}
    </svg><span class="fcount"><b>${Math.max(0, n)}</b>/5</span></span>`;
  }

  function render(v) {
    if (!v) return;
    const nr = v.round !== prev.round;          // 是否新一局
    const fOpp = v.opp.fingers < prev.fOpp;     // 对手是否刚掉手指
    const fMe = v.me.fingers < prev.fMe;        // 自己是否刚掉手指
    const dealtMe = v.me.cards.length > prev.me;   // 自己刚发了一张牌
    const dealtOpp = v.opp.cards.length > prev.opp; // 对手刚发了一张牌
    const resolved = v.phase === "roundEnd" || v.phase === "gameOver"; // 本手/整局结束 → 亮牌
    const oppJustRevealed = v.opp.revealed && !prev.oppRevealed;        // 对手暗牌刚翻开的瞬间
    // 对手面板
    const oppHtml = `
      <div class="ph">
        <div class="avatar opp">🎩</div>
        <span class="pname">${escapeHtml(v.opp.name)}</span>
        ${v.phase === "playing" && v.current !== mySeatForView(v) ? '<span class="turn-badge">思考中</span>' : ""}
        ${handHTML(v.opp.fingers, fOpp)}
      </div>
      <div class="cards">
        ${v.opp.cards.map((c, i) => cardHTML(c, { new: nr || i >= prev.opp, seed: i, delay: Math.min(i, 8) * 0.07 })).join("")}
        ${v.opp.revealed ? cardHTML(v.opp.hidden, { seed: 99, reveal: oppJustRevealed }) : cardHTML(0, { back: true })}
      </div>
      <div class="total">明牌点数 <b>${v.opp.cards.reduce((a, b) => a + b, 0)}</b>
        ${v.opp.revealed ? `· 暗牌 <b>${v.opp.hidden}</b> · 合计 <b>${v.opp.total}</b>` : "· 暗牌未知"}
        · 王牌 <b>${v.opp.trumpCount}</b> 张</div>`;
    $("opp").innerHTML = oppHtml;

    // 中央区
    const poolCards = v.pool.map((c) => `<span class="pc">${c}</span>`).join("");
    let turnTxt;
    if (v.phase === "playing") {
      const myTurn = v.current === mySeatForView(v);
      turnTxt = myTurn ? "👉 轮到你出牌" : `${escapeHtml(v.opp.name)} 出牌中…`;
    } else if (v.phase === "roundEnd") {
      turnTxt = "本手结束 — 双方已亮牌，点击「下一手」继续";
    } else {
      turnTxt = "";
    }
    // 本手 / 整局结束的“亮牌结算说明”：看清双方点数与输在哪
    let roundResultHTML = "";
    if (resolved && v.lastResult) {
      const r = v.lastResult;
      const meSeat = mySeatForView();
      const meT = meSeat === 0 ? r.ta : r.tb;
      const oppT = meSeat === 0 ? r.tb : r.ta;
      const meLost = r.losers.includes(meSeat);
      let why;
      if (r.ba && r.bb) why = meT > oppT ? "你爆得更多（更惨）" : (oppT > meT ? "对手爆得更多，你赢这手" : "双方同点爆牌");
      else if (r.ba) why = `你爆牌了（${meT} > 目标 ${r.target}）`;
      else if (r.bb) why = `对手爆牌了（${oppT} > 目标 ${r.target}）`;
      else why = meT > oppT ? "你点数更高，赢这手" : (oppT > meT ? "你点数更低，输这手" : "双方点数相同");
      const tag = meLost
        ? '<span class="res-tag lose">本手你输了</span>'
        : (r.losers.length === 0 ? '<span class="res-tag draw">本手平局</span>' : '<span class="res-tag win">本手你赢了</span>');
      roundResultHTML = `<div class="round-result">
        ${tag}
        <div class="res-compare">你 <b class="${meLost ? "bad" : "good"}">${meT}</b> &nbsp;vs&nbsp; 对手 <b class="${meLost ? "good" : "bad"}">${oppT}</b>
          <span class="res-target">（目标 ${r.target}）</span></div>
        <div class="res-why">${why}</div>
      </div>`;
    }
    const logHtml = v.log.map((l) => {
      const cls = l.includes("——") || l.includes("获胜") || l.includes("平局") ? "sys" : (l.includes(v.me.name) ? "me" : "");
      return `<div class="${cls}">${escapeHtml(l)}</div>`;
    }).join("");
    $("center").innerHTML = `
      <div class="pool"><span class="deck"></span> 牌堆剩余 <b>${v.poolCount}</b> 张：${poolCards}</div>
      <div class="turn-info ${v.phase === "gameOver" ? "over" : ""}">
        目标 <b>${v.target}</b> 点 &nbsp;|&nbsp; ${turnTxt}
      </div>
      ${roundResultHTML}
      <div class="log">${logHtml}</div>`;

    // 我的面板
    const myTurn = v.phase === "playing" && v.current === mySeatForView(v);
    const meHtml = `
      <div class="ph">
        <div class="avatar me">🙂</div>
        <span class="pname">${escapeHtml(v.me.name)}（你）</span>
        ${myTurn ? '<span class="turn-badge">你的回合</span>' : ""}
        ${handHTML(v.me.fingers, fMe)}
      </div>
      <div class="cards">
        ${v.me.cards.map((c, i) => cardHTML(c, { new: nr || i >= prev.me, seed: i, delay: Math.min(i, 8) * 0.07 })).join("")}
        ${cardHTML(v.me.hidden, { seed: 50 })}
      </div>
      <div class="total">暗牌 <b>${v.me.hidden}</b> · 合计 <b>${v.me.total}</b>
        ${v.me.total > v.target ? '· <span style="color:var(--danger)">已爆牌</span>' : ""}</div>`;
    $("me").innerHTML = meHtml;

    // 更新动画追踪状态
    prev.opp = v.opp.cards.length;
    prev.me = v.me.cards.length;
    prev.round = v.round;
    prev.fOpp = v.opp.fingers;
    prev.fMe = v.me.fingers;
    prev.oppRevealed = v.opp.revealed;

    // 本手结束亮牌后，给输/赢双方面板加高亮
    const oppSeat = 1 - mySeatForView();
    const meLost = v.lastResult ? v.lastResult.losers.includes(mySeatForView()) : false;
    const oppLost = v.lastResult ? v.lastResult.losers.includes(oppSeat) : false;
    $("opp").classList.toggle("panel-lose", !!oppLost);
    $("opp").classList.toggle("panel-win", !oppLost && resolved);
    $("me").classList.toggle("panel-lose", !!meLost);
    $("me").classList.toggle("panel-win", !meLost && resolved);

    // 发牌音效（任一方刚发牌都播，覆盖本地与联机对手）
    if (dealtMe || dealtOpp) SFX.deal();

    // 王牌特效（fx 信号变化才触发，避免重复）
    if (v.fx && v.fx.id !== lastFxId) {
      lastFxId = v.fx.id;
      const byOpp = v.fx.seat !== mySeatForView();
      showTrumpFx(v.fx.trump, byOpp);
    }

    // 掉手指 / 终局 浮层提示 + 音效
    if (fMe) { showToast("💥 你被切掉了一根手指！", "lose"); SFX.lose(); }
    else if (fOpp) { showToast("🩸 对手掉了一根手指", "gain"); SFX.gain(); }
    else if (v.phase === "gameOver" && prev.phase !== "gameOver") {
      const iWon = (v.winner === 0 && mySeatForView() === 0) || (v.winner === 1 && mySeatForView() === 1);
      if (v.winner === "draw") { showToast("⚰️ 平局！同归于尽", "draw"); SFX.lose(); }
      else if (iWon) { showToast("🎉 你赢了！", "gain"); SFX.win(); }
      else { showToast("💀 你输了…", "lose"); SFX.lose(); }
    }
    prev.phase = v.phase;

    renderActions(v, myTurn);
  }

  // 视图里"我"的座位：单人固定 0；联机用 mySeat
  function mySeatForView() { return mode === "online" ? mySeat : 0; }

  function renderActions(v, myTurn) {
    const box = $("actions");
    box.innerHTML = "";

    if (v.phase === "gameOver") {
      const banner = document.createElement("div");
      banner.className = "win-banner";
      if (v.winner === "draw") banner.textContent = "平局！双方同归于尽";
      else if ((v.winner === 0 && mySeatForView() === 0) || (v.winner === 1 && mySeatForView() === 1))
        banner.textContent = "🎉 你赢了！";
      else banner.textContent = `💀 ${escapeHtml(mySeatForView() === 0 ? v.opp.name : v.me.name)} 获胜`;
      box.appendChild(banner);
      const b = mkBtn("再来一局", "restart", doRestart);
      box.appendChild(b);
      return;
    }

    if (v.phase === "roundEnd") {
      box.appendChild(mkBtn("下一手", "next", doNext));
      return;
    }

    // playing
    const hit = mkBtn("要牌", "hit", () => doAction({ type: "hit" }));
    const stay = mkBtn("停牌", "stay", () => doAction({ type: "stay" }));
    hit.disabled = !myTurn;
    stay.disabled = !myTurn;
    box.appendChild(hit);
    box.appendChild(stay);

    // 王牌卡
    const wrap = document.createElement("div");
    wrap.className = "trumps";
    const tt = document.createElement("div");
    tt.className = "tt";
    tt.textContent = "王牌卡（点击使用，不消耗回合）";
    wrap.appendChild(tt);
    const row = document.createElement("div");
    row.className = "trump-row";
    v.me.trumps.forEach((key) => {
      const t = RE21.TRUMPS[key];
      const btn = document.createElement("button");
      btn.className = "trump";
      btn.disabled = !myTurn;
      btn.innerHTML = `<div class="tn">${t.name}</div><div class="td">${t.desc}</div>`;
      btn.onclick = () => doAction({ type: "trump", trump: key });
      row.appendChild(btn);
    });
    wrap.appendChild(row);
    box.appendChild(wrap);
  }

  let toastTimer = null;
  function showToast(text, kind) {
    const t = $("toast");
    t.className = "toast " + kind;
    t.textContent = text;
    if (kind === "lose") $("game").classList.add("shake");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.className = "toast hidden";
      $("game").classList.remove("shake");
    }, 1500);
  }

  function showTrumpFx(key, byOpp) {
    const fx = $("trumpFx");
    const t = RE21.TRUMPS[key];
    fx.querySelector(".tl-who").textContent = byOpp ? "对手发动了王牌" : "你发动了王牌";
    fx.querySelector(".tl-name").textContent = t ? t.name : key;
    fx.querySelector(".tl-desc").textContent = t ? t.desc : "";
    fx.querySelectorAll(".spark").forEach((s) => s.remove());
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("span");
      s.className = "spark";
      const ang = Math.random() * Math.PI * 2;
      const dist = 90 + Math.random() * 100;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      s.style.background = i % 2 ? "var(--teal)" : "var(--gold)";
      fx.appendChild(s);
    }
    fx.classList.remove("show");
    void fx.offsetWidth; // 重置动画
    fx.classList.add("show");
    SFX.trump();
    clearTimeout(fx._t);
    // 对手发动时停留更久，让玩家看清说明；自己发动稍短
    const hold = byOpp ? 2800 : 1700;
    fx.querySelector(".trump-label").style.animationDuration = hold + "ms";
    fx._t = setTimeout(() => fx.classList.remove("show"), hold);
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement("button");
    b.className = "btn " + cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  // 初始显示菜单
  showScreen("menu");
})();
