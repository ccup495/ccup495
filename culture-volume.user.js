// ==UserScript==
// @name         Culture Capital 총 거래량
// @namespace    rere
// @version      1.1.2
// @description  오픈 포지션·청산 포지션의 총 거래량(lot)과 건수를 표시합니다. (PC: 하단 탭 줄 오른쪽, 모바일: 포트폴리오 하단 바)
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culture-volume.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culture-volume.user.js
// ==/UserScript==

function ccvolMain() {
  'use strict';

  const nativeFetch = window.fetch.bind(window);

  const st = {
    token: null,    // 사이트가 trading-edge 요청에 붙이는 Auth-Trading-Api 값
    uuid: null,     // 거래 시스템 ID
    open: null,     // 오픈 포지션 목록 (서버에서 직접 받음)
    openAt: 0,
    openLoading: false,
    closed: null,   // 청산 포지션 목록 (사이트가 받아온 응답을 그대로 씀)
    closedReq: null,  // 사이트가 보낸 청산 포지션 요청 { url, body, at }
    closedLoading: false,
  };

  // ---------------------------------------------------------------- 사이트 요청 엿보기
  // 청산 포지션 표는 화면에 보이는 줄만 그리므로, 전체 목록은 사이트가 받은 응답에서 가져옴
  const X = XMLHttpRequest.prototype, open = X.open, setHeader = X.setRequestHeader, send = X.send;
  X.open = function (m, u) {
    this.__ccvolUrl = String(u);
    const mm = this.__ccvolUrl.match(/trading-edge\/([0-9a-f-]{36})\//);
    if (mm) st.uuid = mm[1];
    return open.apply(this, arguments);
  };
  X.setRequestHeader = function (k, v) {
    if (/^auth-trading-api$/i.test(k) && v) st.token = v;
    return setHeader.apply(this, arguments);
  };
  X.send = function (body) {
    if (/trading-edge\/[0-9a-f-]{36}\/closed-positions(\?|$)/.test(this.__ccvolUrl || '')) {
      const req = { url: this.__ccvolUrl, body: typeof body === 'string' ? body : null, at: Date.now() };
      st.closedReq = req;
      this.addEventListener('load', () => {
        if (st.closedReq !== req) return;  // 더 최근 요청(필터 변경 등)이 있으면 무시
        try { st.closed = JSON.parse(this.responseText).operations || []; } catch { return; }
        update();
      });
    }
    return send.apply(this, arguments);
  };

  // ---------------------------------------------------------------- 데이터
  async function loadOpen() {
    if (!st.uuid || !st.token || st.openLoading) return;
    st.openLoading = true;
    try {
      const r = await nativeFetch(`/trading-edge/${st.uuid}/open-positions`,
                                  { headers: { 'Auth-Trading-Api': st.token, Accept: 'application/json' } });
      if (r.ok) { st.open = (await r.json()).positions || []; st.openAt = Date.now(); }
    } catch {}
    st.openLoading = false;
    update();
  }

  // 새로 청산된 포지션이 실시간으로 표에 추가되면 사이트는 목록을 다시 받지 않으므로 우리가 다시 받음
  async function reloadClosed() {
    const req = st.closedReq;
    if (!req || !req.body || !st.token || st.closedLoading) return;
    st.closedLoading = true;
    try {
      const body = JSON.parse(req.body);
      // 기간 끝이 "요청한 그때"였다면(= 지금까지) 지금 시각으로 늘려서 다시 요청
      if (body.to && Math.abs(new Date(body.to) - req.at) < 120000) body.to = new Date().toISOString();
      const r = await nativeFetch('/' + req.url.replace(/^\//, ''), {
        method: 'POST',
        headers: { 'Auth-Trading-Api': st.token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok && st.closedReq === req) st.closed = (await r.json()).operations || [];
    } catch {}
    st.closedLoading = false;
    update();
  }

  function summarize(list) {
    let total = 0;
    const by = new Map();
    for (const p of list) {
      const v = Number(p.volume) || 0;
      total += v;
      const key = `${p.alias || p.symbol} ${p.side === 'SELL' ? '매도' : '매수'}`;
      const g = by.get(key) || { v: 0, n: 0 };
      g.v += v; g.n++;
      by.set(key, g);
    }
    const lines = [...by].sort((a, b) => b[1].v - a[1].v).map(([k, g]) => `${k}  ${fmt(g.v)} lot (${g.n}건)`);
    return { total, count: list.length, lines };
  }

  const fmt = (v) => (Math.round(v * 1e4) / 1e4).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

  // ---------------------------------------------------------------- 화면
  const CSS = `.ccvol{margin-right:16px;flex-shrink:0;white-space:nowrap;cursor:default}
  .ccvol .ccvol-n{opacity:.6;font-weight:400;margin-left:4px}
  .ccvol-m{flex-shrink:0;white-space:nowrap;margin-right:auto}
  .trade-closed-positions-actions-mobile > .ccvol-m{margin-left:16px}
  .ccvol-m .ccvol-n{opacity:.6;margin-left:4px}
  .ccvol-m .ccvol-l{font-weight:var(--font-weight-sm);font-size:var(--font-size-sm);line-height:var(--line-height-sm);color:var(--content-secondary)}
  .ccvol-m .ccvol-x{font-weight:600;font-size:var(--font-size-sm);line-height:var(--line-height-sm);color:var(--content-primary)}`;

  function makeItem() {
    const el = document.createElement('trade-fund-item');
    el.className = 'trade-fund-item ccvol';
    el.innerHTML = '<span class="trade-fund-item__name">총 거래량<span class="ccvol-n"></span></span>'
      + '<span class="trade-fund-item__value ui-suffix"><span class="ui-suffix__value"><span class="ccvol-v"></span> '
      + '<sup class="ui-suffix__suffix">lot</sup></span></span>';
    return el;
  }

  function makeMobileItem() {
    const el = document.createElement('div');
    el.className = 'ccvol ccvol-m';
    // 사이트의 "총 이익" 칸과 같은 글자 모양 (사이트 스타일은 청산됨 바 안에서만 적용되므로 직접 지정)
    el.innerHTML = '<div class="ccvol-l">총 거래량<span class="ccvol-n"></span></div>'
      + '<div class="ccvol-x"><span class="ccvol-v"></span> lot</div>';
    return el;
  }

  // after: 이 요소 바로 뒤에 붙임 (없으면 맨 앞)
  function show(host, list, note, mobile, after) {
    let el = host.querySelector(':scope > .ccvol');
    if (!list) { if (el) el.remove(); return; }
    if (!el) el = mobile ? makeMobileItem() : makeItem();
    if (after) { if (after.nextElementSibling !== el) after.after(el); }
    else if (host.firstElementChild !== el) host.prepend(el);
    const s = summarize(list);
    const v = el.querySelector('.ccvol-v'), n = el.querySelector('.ccvol-n');
    if (v.textContent !== fmt(s.total)) v.textContent = fmt(s.total);
    if (n.textContent !== `${s.count}건`) n.textContent = `${s.count}건`;
    el.title = (s.lines.length ? s.lines.join('\n') : '포지션 없음') + (note ? '\n\n' + note : '');
  }

  // 표의 전체 줄 수 (가상 스크롤이라 그려진 줄이 아니라 스크롤 높이로 셈)
  function listRowCount() {
    const vp = document.querySelector('.mtr-trade__activity-wrapper cdk-virtual-scroll-viewport');
    if (!vp) return null;
    const row = vp.querySelector('ui-list-row');
    const sp = vp.querySelector('.cdk-virtual-scroll-spacer');
    if (!row || !sp) return vp.querySelector('ui-list-row') ? null : 0;
    const h = row.getBoundingClientRect().height;
    return h > 0 ? Math.round(parseFloat(sp.style.height) / h) : null;
  }

  let lastBadge = null, lastReload = 0;
  function update() {
    if (!document.body) return;
    const ordersTab = document.querySelector('.mtr-trade__activity-wrapper > .ccord');  // "주문" 탭이 열려 있으면 숨김
    const openHost = document.querySelector('mtr-portfolio-tabs trade-open-positions-actions-desktop');
    const closedHost = document.querySelector('mtr-portfolio-tabs trade-closed-positions-actions-desktop');

    if (openHost) {
      // 포지션 수가 바뀌면 바로, 아니면 5초마다 다시 받음 (부분 청산은 수가 안 바뀜)
      const badge = document.querySelector('[data-testid="open-positions-badge"]');
      const b = badge ? badge.textContent.trim() : '0';
      if (b !== lastBadge || Date.now() - st.openAt > 5000) { lastBadge = b; loadOpen(); }
      show(openHost, ordersTab ? null : st.open);
    }
    if (closedHost) {
      const rows = listRowCount();
      if (st.closed && rows !== null && rows !== st.closed.length && Date.now() - lastReload > 3000) { lastReload = Date.now(); reloadClosed(); }
      const note = st.closed && st.closed.length >= 250 ? '서버가 한 번에 보내는 개수 제한에 걸렸을 수 있습니다' : '';
      show(closedHost, ordersTab ? null : st.closed, note);
    }

    // 모바일 포트폴리오: 하단 바(시가 탭은 Select·필터 줄, 청산됨 탭은 "총 이익" 줄)
    const mOrders = document.querySelector('mtr-portfolio .mtr-portfolio__content > .ccord');
    const mOpen = document.querySelector('trade-open-positions-actions-mobile');
    const mClosed = document.querySelector('trade-closed-positions-actions-mobile');
    if (mOpen) {
      const badge = document.querySelector('[data-testid="open-positions-badge"]');
      const b = badge ? badge.textContent.trim() : '0';
      if (b !== lastBadge || Date.now() - st.openAt > 5000) { lastBadge = b; loadOpen(); }
      show(mOpen, mOrders ? null : st.open, '', true);
    }
    if (mClosed) {
      // 모바일 목록은 줄 수를 셀 수 없으므로, 새로 청산된 포지션이 반영되도록 15초마다 다시 받음
      if (st.closed && Date.now() - lastReload > 15000) { lastReload = Date.now(); reloadClosed(); }
      const profit = mClosed.querySelector(':scope > div:not(.ccvol):not(.trade-closed-positions-actions-mobile__button-wrapper)');
      show(mClosed, mOrders ? null : st.closed, '', true, profit);
    }
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    setInterval(update, 1000);
    let pending = false;
    new MutationObserver((muts) => {
      if (pending || !muts.some(m => !(m.target.closest && m.target.closest('.ccvol')) && m.target.closest && m.target.closest('mtr-portfolio-tabs, mtr-portfolio'))) return;
      pending = true;
      setTimeout(() => { pending = false; update(); }, 50);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.head) boot(); else document.addEventListener('DOMContentLoaded', boot);
}

// 파이어폭스 탬퍼몽키, 아이폰 사파리 Userscripts 등은 스크립트를 페이지와 분리된 샌드박스에서 실행해서
// 사이트의 XHR을 엿볼 수 없으므로 항상 코드를 페이지에 직접 넣어 실행한다.
// (이 사이트는 CSP가 없어 인라인 스크립트가 막히지 않고, 크롬처럼 원래 페이지에서 실행되는 경우에도 똑같이 동작한다)
(function inject() {
  const root = document.head || document.documentElement;
  if (!root) {  // 아주 이른 시점이라 <html>도 아직 없으면 생길 때까지 기다림
    new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); inject(); } })
      .observe(document, { childList: true });
    return;
  }
  const s = document.createElement('script');
  s.textContent = '(' + ccvolMain.toString() + ')();';
  root.appendChild(s);
  s.remove();
})();
