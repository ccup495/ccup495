// ==UserScript==
// @name         Culture Capital 주문 내역
// @namespace    rere
// @version      1.1.1
// @description  포트폴리오 탭(PC: 오픈 포지션/대기 주문/청산 포지션/재무, 모바일: 시가/예약거래/청산됨) 옆에 "주문" 탭을 추가해 주문 내역을 표시합니다.
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culture-orders.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culture-orders.user.js
// ==/UserScript==

function ccordMain() {
  'use strict';

  const nativeFetch = window.fetch.bind(window);

  const st = {
    token: null,       // 사이트가 trading-edge 요청에 붙이는 Auth-Trading-Api 값
    uuid: null,        // 거래 시스템 ID
    active: false,     // 주문 탭이 열려 있는지
    range: '1d',
    status: 'ALL',
    orders: null,
    error: null,
    loading: false,
    unselected: [],    // 주문 탭을 여는 동안 선택 표시를 지운 사이트 탭
    wrap: null,        // 주문 표를 붙인 탭 내용 영역
  };
  try { st.range = localStorage.getItem('ccord-range') || '1d'; } catch {}

  // ---------------------------------------------------------------- 인증 정보 가져오기
  // 사이트가 보내는 XHR에서 시스템 ID와 Auth-Trading-Api 헤더를 기억해 둠
  const X = XMLHttpRequest.prototype, open = X.open, setHeader = X.setRequestHeader;
  X.open = function (m, u) {
    const mm = String(u).match(/trading-edge\/([0-9a-f-]{36})\//);
    if (mm) st.uuid = mm[1];
    return open.apply(this, arguments);
  };
  X.setRequestHeader = function (k, v) {
    if (/^auth-trading-api$/i.test(k) && v) st.token = v;
    return setHeader.apply(this, arguments);
  };

  // 모바일 화면(사이트가 <mtr-mobile>로 그림)은 포트폴리오가 별도 화면이고, 탭 아래 내용 영역이 따로 있음
  const isMobile = () => !!document.querySelector('mtr-mobile');
  const getWrap = () => document.querySelector(isMobile() ? 'mtr-portfolio .mtr-portfolio__content' : '.mtr-trade__activity-wrapper');

  // ---------------------------------------------------------------- 데이터
  const RANGES = { '1d': ['오늘', 1], '1w': ['1주', 7], '1m': ['1개월', 30], '3m': ['3개월', 90] };
  const STATUSES = { ALL: ['전체', ['FILLED', 'PARTIALLY_FILLED', 'CANCELLED']],
                     FILLED: ['체결', ['FILLED', 'PARTIALLY_FILLED']], CANCELLED: ['취소', ['CANCELLED']] };

  async function load() {
    if (!st.uuid || !st.token) { st.error = '계정 정보를 기다리는 중…'; render(); setTimeout(() => st.active && load(), 1500); return; }
    st.loading = true; st.error = null; render();
    const to = Date.now(), from = to - RANGES[st.range][1] * 864e5;
    const q = new URLSearchParams({ from, to });
    for (const s of STATUSES[st.status][1]) q.append('statuses', s);
    try {
      const r = await nativeFetch(`/trading-edge/${st.uuid}/orders?${q}`,
                                  { headers: { 'Auth-Trading-Api': st.token, Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      st.orders = (Array.isArray(d) ? d : []).sort((a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''));
    } catch (e) {
      st.error = '불러오기 실패 (' + e.message + ')';
    }
    st.loading = false;
    render();
  }

  // ---------------------------------------------------------------- 화면
  const CSS = `
  .ccord-hide{display:none!important}
  .ccord{height:calc(100% - var(--ccord-tabs-h,40px));display:flex;flex-direction:column;font-size:13px;font-variant-numeric:tabular-nums}
  .ccord-bar{display:flex;gap:6px;align-items:center;padding:6px 12px;flex-wrap:wrap}
  .ccord-bar button{border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px}
  .ccord-bar button.on{background:rgba(14,156,139,.14);border-color:#0e9c8b;color:#0e9c8b;font-weight:600}
  .ccord-bar .sep{width:1px;height:16px;background:rgba(128,128,128,.3);margin:0 4px}
  .ccord-bar .info{margin-left:auto;opacity:.6;font-size:12px}
  .ccord-scroll{flex:1;min-height:0;overflow:auto}
  .ccord table{width:100%;border-collapse:collapse}
  .ccord-scroll::-webkit-scrollbar{width:10px;height:10px}
  .ccord-scroll::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:5px;border:2px solid transparent;background-clip:padding-box}
  .ccord-scroll::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.7)}
  .ccord th{position:sticky;top:0;background:var(--ccord-bg,#f4f6fa);font-weight:500;font-size:12px;text-align:right;padding:6px 10px;white-space:nowrap;z-index:1}
  .ccord td{text-align:right;padding:7px 10px;border-top:1px solid rgba(128,128,128,.15);white-space:nowrap}
  .ccord th:first-child,.ccord td:first-child{text-align:left}
  .ccord .sym{font-weight:600}
  .ccord .chip{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:11px;font-weight:500}
  .ccord .buy{color:#0e9c8b;background:rgba(14,156,139,.12)} .ccord .sell{color:#e5374d;background:rgba(229,55,77,.12)}
  .ccord .t{line-height:1.25} .ccord .t small{display:block;opacity:.65}
  .ccord .cx{opacity:.55}
  .ccord-empty{padding:30px;text-align:center;opacity:.6}
  .ccord.m th,.ccord.m td{padding:7px 8px}
  .ccord.m .t2{font-size:11px;opacity:.6;margin-top:2px}
  .ccord.m .chip{margin-left:4px}`;

  const panel = document.createElement('div');
  panel.className = 'ccord';
  panel.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const [k, v] = b.dataset.k.split(':');
    if (k === 'range') { st.range = v; try { localStorage.setItem('ccord-range', v); } catch {} }
    if (k === 'status') st.status = v;
    load();
  });

  const SIDE = { BUY: '매수', SELL: '매도' };
  const TYPE = { MARKET: '시장가', LIMIT: '지정가', STOP: '스톱', STOP_LIMIT: '스톱 리밋', TPSL: '익절/손절',
                 TAKE_PROFIT: '익절', STOP_LOSS: '손절', TRAILING_STOP: '트레일링 스톱' };
  const TIF = { GOODTILLCANCEL: '취소시까지 유효', DAY: '당일', GOODTILLDATE: '지정일까지', IMMEDIATEORCANCEL: 'IOC', FILLORKILL: 'FOK' };
  const STAT = { FILLED: '체결됨', PARTIALLY_FILLED: '부분 체결', CANCELLED: '취소됨', NEW: '접수', REJECTED: '거부됨' };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  // 사이트와 같은 UTC 기준으로 표시
  const time = iso => {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}<small>${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}</small>`;
  };
  const num = (v, dp) => v == null ? '-' : (+v).toFixed(dp ?? 2);

  function render() {
    if (!st.active) return;
    const btn = (k, map, cur) => Object.entries(map).map(([v, [label]]) =>
      `<button data-k="${k}:${v}" class="${v === cur ? 'on' : ''}">${label}</button>`).join('');
    const o = st.orders;
    const info = st.loading ? '불러오는 중…' : st.error ? esc(st.error)
      : o ? `${o.length}건${o.length >= 250 ? ' (최대 250건까지 표시, 기간을 줄여 보세요)' : ''}` : '';
    let body;
    const mobile = isMobile();
    panel.classList.toggle('m', mobile);
    if (mobile && o && o.length) {
      // 화면이 좁으므로 심볼·시각 / 거래량 / 가격 / 상태 4칸으로 줄임
      body = `<table><thead><tr><th>심볼 · 체결 시각</th><th>거래량</th><th>가격</th><th>상태</th></tr></thead><tbody>${o.map(x => {
          const dp = x.decimalPlaces;
          const side = x.side === 'BUY' ? 'buy' : 'sell';
          const price = x.executionPrice != null ? x.executionPrice : (x.limit != null ? x.limit : x.stop);
          const t = x.updateTime ? new Date(x.updateTime) : null;
          const when = t ? `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}` : '-';
          return `<tr class="${x.orderStatus === 'CANCELLED' ? 'cx' : ''}">
            <td><span class="sym">${esc(x.alias || x.symbol)}</span><span class="chip ${side}">${SIDE[x.side] || esc(x.side)} ${TYPE[x.orderType] || esc(x.orderType)}</span><div class="t2">${when}</div></td>
            <td>${x.fillVolume ?? 0}/${x.volume}</td><td>${num(price, dp)}</td>
            <td>${STAT[x.orderStatus] || esc(x.orderStatus)}</td></tr>`;
        }).join('')}</tbody></table>`;
    } else if (!o || !o.length) {
      body = `<div class="ccord-empty">${st.loading ? '불러오는 중…' : st.error ? esc(st.error) : '주문 내역이 없습니다.'}</div>`;
    } else {
      body = `<table><thead><tr><th>심볼</th><th>거래량</th><th>체결된 거래량</th><th>체결 시각</th><th>주문 시각</th>
        <th>만료</th><th>리밋</th><th>발동</th><th>가격</th><th>상태</th></tr></thead><tbody>${o.map(x => {
          const dp = x.decimalPlaces;
          const side = x.side === 'BUY' ? 'buy' : 'sell';
          return `<tr class="${x.orderStatus === 'CANCELLED' ? 'cx' : ''}">
            <td><span class="sym">${esc(x.alias || x.symbol)}</span><span class="chip ${side}">${SIDE[x.side] || esc(x.side)} ${TYPE[x.orderType] || esc(x.orderType)}</span></td>
            <td>${x.volume}</td><td>${x.fillVolume ?? '-'}</td>
            <td class="t">${time(x.updateTime)}</td><td class="t">${time(x.openTime)}</td>
            <td>${TIF[x.orderTimeType] || esc(x.orderTimeType)}</td>
            <td>${num(x.limit, dp)}</td><td>${num(x.stop, dp)}</td><td>${num(x.executionPrice, dp)}</td>
            <td>${STAT[x.orderStatus] || esc(x.orderStatus)}</td></tr>`;
        }).join('')}</tbody></table>`;
    }
    panel.innerHTML = `<div class="ccord-bar">${btn('range', RANGES, st.range)}<span class="sep"></span>${btn('status', STATUSES, st.status)}
      <button data-k="reload:1" title="새로고침">↻</button><span class="info">${info}</span></div><div class="ccord-scroll">${body}</div>`;
  }

  // ---------------------------------------------------------------- 탭
  const tab = document.createElement('ui-tab');

  function buildTab(template) {
    // "재무" 탭을 복제해서 모양을 맞춤 (Angular 이벤트는 복제되지 않으므로 직접 처리)
    tab.className = template.className.replace(/ui-tab__\w+/, 'ui-tab__ccord').replace('ui-tab--selected', '');
    tab.innerHTML = template.innerHTML;
    tab.setAttribute('tabid', 'ccord');
    const label = tab.querySelector('.mtr-portfolio-tabs__tab');
    if (label) {
      label.classList.remove('mtr-portfolio-tabs__tab--selected');
      for (const n of label.childNodes) if (n.nodeType === 3 && n.textContent.trim()) n.textContent = ' 주문 ';
    }
    const use = tab.querySelector('use');
    if (use) use.setAttribute('xlink:href', 'assets/sprite.svg#orders');
    tab.dataset.built = '1';
  }

  function setSelected(on) {
    tab.classList.toggle('ui-tab--selected', on);
    const label = tab.querySelector('.mtr-portfolio-tabs__tab');
    if (label) label.classList.toggle('mtr-portfolio-tabs__tab--selected', on);
    const svg = tab.querySelector('svg');
    if (svg) {
      svg.classList.toggle('ui-icon__svg--color-brand', on);
      svg.classList.toggle('ui-icon__svg--color-secondary', !on);
    }
  }

  function activate() {
    const wrap = getWrap();
    if (!wrap) return;
    st.active = true;
    st.wrap = wrap;
    // 사이트 탭의 선택 표시를 잠시 지움 (닫을 때 되돌림)
    st.unselected = [...document.querySelectorAll('mtr-portfolio-tabs ui-tab.ui-tab--selected')].filter(t => t !== tab);
    for (const t of st.unselected) {
      t.classList.remove('ui-tab--selected');
      const l = t.querySelector('.mtr-portfolio-tabs__tab--selected');
      if (l) l.classList.remove('mtr-portfolio-tabs__tab--selected');
      t.dataset.ccordWasSelected = '1';
    }
    setSelected(true);
    mount();
    load();
  }

  function deactivate() {
    st.active = false;
    setSelected(false);
    for (const t of st.unselected) {
      t.classList.add('ui-tab--selected');
      const l = t.querySelector('.mtr-portfolio-tabs__tab');
      if (l) l.classList.add('mtr-portfolio-tabs__tab--selected');
      delete t.dataset.ccordWasSelected;
    }
    st.unselected = [];
    panel.remove();
    document.querySelectorAll('.ccord-hide').forEach(e => e.classList.remove('ccord-hide'));
  }

  tab.addEventListener('click', e => { e.stopPropagation(); if (!st.active) activate(); });

  // 사이트 탭을 누르면 주문 탭을 닫음
  document.addEventListener('click', e => {
    if (!st.active) return;
    const t = e.target.closest('mtr-portfolio-tabs ui-tab');
    if (t && t !== tab) deactivate();
  }, true);

  function mount() {
    const tabs = document.querySelector('mtr-portfolio-tabs .ui-tabs__content');
    const wrap = getWrap();
    // 모바일에서 다른 화면으로 갔다 오면 포트폴리오가 새로 그려지므로 주문 탭은 닫힌 상태로 시작
    if (st.active && st.wrap && st.wrap !== wrap) deactivate();
    if (!tabs || !wrap) return;
    const all = [...tabs.querySelectorAll(':scope > ui-tab')].filter(t => t !== tab);
    const finance = all.find(t => t.getAttribute('tabid') === 'finance') || all[all.length - 1];
    if (!finance) return;
    if (!tab.dataset.built) buildTab(finance);
    if (finance.nextElementSibling !== tab) finance.after(tab);

    if (!st.active) return;
    // 사이트의 탭 내용은 숨기고 주문 표를 대신 보여줌
    for (const c of wrap.children) if (c !== panel && c.tagName !== 'MTR-PORTFOLIO-TABS') c.classList.add('ccord-hide');
    // 하단 영역은 높이가 고정이고 넘치면 잘리므로, 탭 줄을 뺀 높이에 맞춰 표 안에서 스크롤되게 함
    const bar = wrap.querySelector('mtr-portfolio-tabs');
    panel.style.setProperty('--ccord-tabs-h', bar ? bar.offsetHeight + 'px' : '0px');
    // 고정 머리글 배경을 사이트 배경색과 같게 (다크 테마 대응)
    for (let el = wrap; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) { panel.style.setProperty('--ccord-bg', bg); break; }
    }
    if (panel.parentElement !== wrap) { wrap.appendChild(panel); render(); }
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    let pending = false;
    new MutationObserver(muts => {
      if (pending || muts.every(m => panel.contains(m.target) || tab.contains(m.target))) return;
      pending = true;
      setTimeout(() => { pending = false; mount(); }, 50);
    }).observe(document.body, { childList: true, subtree: true });
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
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
  s.textContent = '(' + ccordMain.toString() + ')();';
  root.appendChild(s);
  s.remove();
})();
