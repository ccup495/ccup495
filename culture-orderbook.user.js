// ==UserScript==
// @name         Culture Capital 호가창
// @namespace    rere
// @version      1.0.4
// @description  왼쪽 종목 패널(고급 주문 아래)에 실시간 호가창을 표시합니다. (PC 전용, 휴대폰에서는 실행 안 함)
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culture-orderbook.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culture-orderbook.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 휴대폰 브라우저에서는 사이트가 모바일 화면을 쓰는데, 호가창을 둘 자리가 없으므로 실행하지 않음
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;

  const NativeWS = window.WebSocket;
  const nativeSend = NativeWS.prototype.send;
  const nativeFetch = window.fetch.bind(window);

  const st = {
    ws: null,          // 사이트의 market-data-api 웹소켓
    uuid: null,        // 거래 시스템 ID (URL에서 추출)
    lastReq: null,     // 사이트가 마지막으로 보낸 quotationRequestV3 본문
    symbol: null,      // 현재 호가를 보고 있는 종목
    book: null,        // { asks:[{p,v}], bids:[{p,v}] }
    prev: null,
    lastLive: 0,       // 웹소켓으로 마지막 호가를 받은 시각
    collapsed: false,
  };
  try { st.collapsed = localStorage.getItem('ccob-collapsed') === '1'; } catch {}

  // ---------------------------------------------------------------- 웹소켓 가로채기
  const isMda = url => /\/market-data-api\/[^/]+\/ws-composite/.test(String(url));

  class PatchedWebSocket extends NativeWS {
    constructor(url, protocols) {
      super(url, protocols);
      if (isMda(url)) attach(this, String(url));
    }
  }
  window.WebSocket = PatchedWebSocket;

  function attach(ws, url) {
    st.ws = ws;
    st.uuid = url.match(/market-data-api\/([^/]+)\//)[1];
    if (st.symbol && !st.book) loadSnapshot(st.symbol);
    ws.send = function (data) { return nativeSend.call(this, patchOutgoing(data)); };
    ws.addEventListener('message', e => onIncoming(e.data));
    ws.addEventListener('open', () => st.symbol && resubscribe());
    ws.addEventListener('close', () => { if (st.ws === ws) render(); });
  }

  // 사이트가 보내는 구독 요청에 호가 종목을 끼워 넣음 (Pro View 계정과 같은 요청)
  function patchOutgoing(data) {
    if (typeof data !== 'string' || !data.includes('quotationRequestV3')) return data;
    try {
      const msg = JSON.parse(data);
      const req = msg.quotationRequestV3;
      if (!req) return data;
      st.lastReq = req;
      if (st.symbol && !req.orderBookSymbol) {
        req.orderBookSymbol = st.symbol;
        req.orderBookType = 'JSON';
        return JSON.stringify(msg);
      }
    } catch {}
    return data;
  }

  function resubscribe() {
    const ws = st.ws;
    if (!ws || ws.readyState !== 1 || !st.lastReq) return;  // 아직이면 사이트의 다음 요청에서 patchOutgoing이 처리
    const req = { ...st.lastReq, orderBookSymbol: st.symbol, orderBookType: 'JSON' };
    nativeSend.call(ws, JSON.stringify({ id: Date.now().toString(), quotationRequestV3: req }));
  }

  function onIncoming(raw) {
    if (typeof raw !== 'string' || !raw.includes('"ob"')) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ob = (msg.q3 && msg.q3.ob) || msg.ob;
    if (!ob || ob.symbol !== st.symbol) return;
    st.lastLive = Date.now();
    setBook(ob.askPrices, ob.askVolumes, ob.bidPrices, ob.bidVolumes);
  }

  // ---------------------------------------------------------------- 현재 종목
  function selectSymbol(sym) {
    st.symbol = sym;
    st.book = st.prev = null;
    st.lastLive = 0;
    render();
    loadSnapshot(sym);
    resubscribe();
  }

  // 처음 한 번은 REST로 받아서 바로 표시 (사이트 원래 동작과 동일)
  async function loadSnapshot(sym) {
    if (!st.uuid) return;
    try {
      const r = await nativeFetch(`/market-data-api/${st.uuid}/api/order-book?symbol=${encodeURIComponent(sym)}`,
                                  { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      if (st.symbol !== sym || st.book) return;
      setBook(d.askSide.map(x => x.orderPrice), d.askSide.map(x => x.orderVolume),
              d.bidSide.map(x => x.orderPrice), d.bidSide.map(x => x.orderVolume));
    } catch {}
  }

  function setBook(ap, av, bp, bv) {
    const zip = (ps, vs) => ps.map((p, i) => ({ p: String(p), v: +vs[i] }));
    st.prev = st.book;
    st.book = { asks: zip(ap, av), bids: zip(bp, bv) };
    schedule();
  }

  // ---------------------------------------------------------------- 화면
  const CSS = `
  .ccob{margin:4px 0 8px;font-size:12px;font-variant-numeric:tabular-nums;color:inherit}
  .ccob-h{display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;user-select:none;font-weight:600}
  .ccob-h .sp{margin-left:auto;font-weight:400;opacity:.6}
  .ccob-dot{width:7px;height:7px;border-radius:50%;background:#b8bcc6;flex:none}
  .ccob-dot.live{background:#0e9c8b}
  .ccob-arrow{opacity:.5;transition:transform .2s}
  .ccob.col .ccob-arrow{transform:rotate(-90deg)}
  .ccob.col .ccob-body{display:none}
  .ccob-cols,.ccob-r{display:grid;grid-template-columns:1fr 1fr;padding:0 6px}
  .ccob-cols{opacity:.55;font-size:11px;padding-bottom:2px}
  .ccob-cols span:last-child,.ccob-r span:last-child{text-align:right}
  .ccob-r{position:relative;height:19px;align-items:center;border-radius:3px}
  .ccob-r span{position:relative}
  .ccob-r i{position:absolute;top:1px;bottom:1px;right:0;border-radius:3px}
  .ccob-a .p{color:#e5374d;font-weight:500} .ccob-a i{background:rgba(229,55,77,.13)}
  .ccob-b .p{color:#0e9c8b;font-weight:500} .ccob-b i{background:rgba(14,156,139,.14)}
  .ccob-mid{display:flex;justify-content:space-between;padding:3px 6px;margin:2px 0;opacity:.75;font-size:11px;
            border-top:1px dashed rgba(128,128,128,.3);border-bottom:1px dashed rgba(128,128,128,.3)}
  .ccob-r.up{animation:ccob-up .5s} .ccob-r.down{animation:ccob-dn .5s}
  @keyframes ccob-up{from{background:rgba(14,156,139,.28)}to{background:transparent}}
  @keyframes ccob-dn{from{background:rgba(229,55,77,.28)}to{background:transparent}}
  .ccob-empty{padding:8px 6px;opacity:.55}`;

  const panel = document.createElement('div');
  panel.className = 'ccob' + (st.collapsed ? ' col' : '');
  panel.addEventListener('click', e => {
    if (!e.target.closest('.ccob-h')) return;
    st.collapsed = !st.collapsed;
    panel.classList.toggle('col', st.collapsed);
    try { localStorage.setItem('ccob-collapsed', st.collapsed ? '1' : '0'); } catch {}
  });

  const fmtVol = v => v >= 1e6 ? +(v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? +(v / 1e3).toFixed(1) + 'K' : String(v);
  const decimals = s => (s.split('.')[1] || '').length;

  let rafPending = false;
  // rAF는 탭이 가려지면 멈추므로 setTimeout으로 묶어서 그림
  function schedule() { if (!rafPending) { rafPending = true; setTimeout(render, 30); } }

  function render() {
    rafPending = false;
    const live = st.ws && st.ws.readyState === 1 && Date.now() - st.lastLive < 15000;
    const b = st.book;
    let spread = '';
    if (b && b.asks.length && b.bids.length) {
      const d = decimals(b.asks[0].p);
      spread = `스프레드 ${(+b.asks[0].p - +b.bids[0].p).toFixed(d)}`;
    }
    const head = `<div class="ccob-h"><span class="ccob-arrow">▾</span><span class="ccob-dot${live ? ' live' : ''}"
      title="${live ? '실시간' : '대기 중'}"></span>호가 ${st.symbol || ''}<span class="sp">${spread}</span></div>`;

    if (!b) {
      panel.innerHTML = head + `<div class="ccob-body"><div class="ccob-empty">${st.symbol ? '불러오는 중…' : '종목을 선택하세요'}</div></div>`;
      return;
    }
    const max = Math.max(...b.asks.map(x => x.v), ...b.bids.map(x => x.v), 1);
    const flash = (side, i, p) => {
      const old = st.prev && st.prev[side][i];
      if (!old || old.p === p) return '';
      return +p > +old.p ? ' up' : ' down';
    };
    const row = (side, cls) => (x, i) =>
      `<div class="ccob-r ${cls}${flash(side, i, x.p)}"><i style="width:${Math.max(x.v / max * 100, 2)}%"></i>
        <span class="p">${x.p}</span><span>${fmtVol(x.v)}</span></div>`;

    const asks = b.asks.map(row('asks', 'ccob-a')).reverse().join('');
    const bids = b.bids.map(row('bids', 'ccob-b')).join('');
    const mid = b.asks.length && b.bids.length
      ? ((+b.asks[0].p + +b.bids[0].p) / 2).toFixed(decimals(b.asks[0].p) + 1) : '-';
    panel.innerHTML = head + `<div class="ccob-body">
      <div class="ccob-cols"><span>가격</span><span>수량</span></div>
      ${asks}<div class="ccob-mid"><span>중간가</span><span>${mid}</span></div>${bids}</div>`;
  }
  setInterval(() => st.symbol && schedule(), 5000);  // 실시간 표시등 갱신용

  // 종목 패널의 "고급 주문" 줄 바로 아래에 붙임 (Angular가 다시 그려도 계속 따라붙음)
  // 펼쳐진 종목 바로 위 줄에 id="all-symbols-EURUSD" 처럼 종목명이 들어 있음
  // 접힌 종목의 trade-market-watch-item이 DOM에 남아 있을 수 있으므로
  // 매수/매도 버튼이 실제로 보이는(펼쳐진) 항목을 찾는다
  function findOpenItem() {
    const anchors = [...document.querySelectorAll('trade-market-watch-item [data-testid="mw-action-buttons"]')];
    const visible = anchors.find(a => a.getBoundingClientRect().height > 0) || anchors[anchors.length - 1];
    return visible ? visible.closest('trade-market-watch-item') : null;
  }

  const ID_RE = /^[a-z]+(?:-[a-z]+)*-([A-Z0-9][A-Za-z0-9._#&]*)$/;
  const idSymbol = el => { const m = el && el.id && el.id.match(ID_RE); return m ? m[1] : null; };

  // 펼쳐진 항목의 종목명: 바로 위 줄의 종목명 표시 → (전체 종목 목록처럼) 바로 위 줄의 id 순서로 시도
  // Favorites 목록의 줄에는 id가 없음
  function symbolOf(item) {
    const row = item.previousElementSibling;
    const name = row && row.querySelector('[data-testid="instrument-symbol-name"]');
    const text = name && name.textContent.trim();
    if (text) return text;
    return idSymbol(row);
  }

  let warnedItem = null;
  function mount() {
    const item = findOpenItem();
    if (!item) return;
    const sym = symbolOf(item);
    if (!sym && warnedItem !== item) {  // 같은 항목은 한 번만 출력
      warnedItem = item;
      console.warn('[ccob] 종목명을 못 찾음', item.parentElement && item.parentElement.outerHTML.slice(0, 2000));
    }
    if (sym && sym !== st.symbol) selectSymbol(sym);
    const anchor = item.querySelector('[data-testid="mw-action-buttons"]');
    if (anchor) { if (anchor.nextElementSibling !== panel) anchor.after(panel); }
    else if (panel.parentElement !== item) item.appendChild(panel);
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    render();
    let pending = false;
    new MutationObserver(muts => {
      if (pending || muts.every(m => panel.contains(m.target))) return;
      pending = true;
      setTimeout(() => { pending = false; mount(); }, 50);
    }).observe(document.body, { childList: true, subtree: true });
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
