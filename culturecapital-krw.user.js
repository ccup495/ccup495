// ==UserScript==
// @name         Culture Capital 잔고 원화 표시
// @namespace    https://mtr.culturecapitalllc.com/
// @version      1.6.5
// @description  상단 잔고(USD)와 오픈 포지션·청산 포지션·재무의 금액에 네이버 환율(하나은행 매매기준율) 기준 원화 금액을 표시합니다. 모바일은 포트폴리오(시가·청산됨), 거래 화면 종목 손익 칩, 더보기 > 재무(Finance History)도 표시합니다.
// @match        *://*.culturecapitalllc.com/*
// @match        *://culturecapitalllc.com/*
// @exclude      *://co.culturecapitalllc.com/*
// @exclude      *://comt5.culturecapitalllc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      api.stock.naver.com
// @connect      m.search.naver.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culturecapital-krw.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culturecapital-krw.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 차트(트레이딩뷰)는 같은 주소의 별도 프레임이라 거기서도 실행되면 차트 위에 상태 배지가 하나 더 뜸.
  // @noframes를 무시하는 확장(아이폰 Userscripts 등)도 있어서 직접 한 번 더 확인함
  if (window.top !== window.self) return;

  const RATE_REFRESH_MS = 5 * 60 * 1000; // 환율 갱신 주기: 5분
  const SCAN_MS = 1000;                  // 잔고 변화 확인 주기: 1초
  const TOP_AREA_PX = 200;               // 화면 위쪽 이 높이 안의 USD 금액만 변환

  let rate = null;     // 1 USD = rate KRW
  let rateInfo = '';   // 툴팁에 표시할 환율 정보
  let rateError = '';  // 환율 실패 사유
  let lastCount = 0;   // 마지막으로 변환한 금액 개수
  let usdTextCount = 0;

  // ---------- 상태 배지 (오른쪽 아래) ----------

  const status = document.createElement('div');
  status.dataset.krwBadge = '1';
  status.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:6px 10px;'
    + 'border-radius:8px;font:12px/1.4 "Malgun Gothic",sans-serif;color:#fff;background:#374151;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;max-width:360px;opacity:.92;';
  status.title = '클릭하면 진단 정보가 클립보드에 복사됩니다';
  status.addEventListener('click', copyDiagnostics);

  // 모바일 화면(사이트가 <mtr-mobile>로 그림)에서는 상태 배지가 매수/매도 버튼을 가리므로 표시하지 않음
  // 로그인 화면처럼 <mtr-mobile>이 없는 화면도 있으므로 휴대폰 브라우저인지도 함께 확인
  const isMobile = () => !!document.querySelector('mtr-mobile') || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  function setStatus(text, ok) {
    if (isMobile()) { if (status.isConnected) status.remove(); return; }
    if (!status.isConnected && document.body) document.body.appendChild(status);
    status.style.background = ok ? '#047857' : '#b45309';
    if (status.textContent !== text) status.textContent = text;
  }

  // ---------- 네이버 환율 ----------

  // 탬퍼몽키는 GM_xmlhttpRequest, 아이폰 Userscripts 등 일부는 GM.xmlHttpRequest 이름으로 제공
  const gmRequest = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest : null;

  function get(url) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) { reject(new Error('외부 요청 기능(GM_xmlhttpRequest)을 쓸 수 없음')); return; }
      gmRequest({
        method: 'GET',
        url,
        timeout: 10000,
        onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
        onerror: (e) => reject(new Error('접속 실패 ' + (e && e.error ? e.error : ''))),
        ontimeout: () => reject(new Error('시간 초과')),
      });
    });
  }

  const toNumber = (s) => parseFloat(String(s).replace(/,/g, ''));

  async function fetchRate() {
    let firstError;
    // 1순위: 네이버 증권 환율 (네이버 '환율' 검색과 같은 하나은행 매매기준율)
    try {
      const data = JSON.parse(await get('https://api.stock.naver.com/marketindex/exchange/FX_USDKRW'));
      const info = data.exchangeInfo;
      const value = toNumber(info.closePrice);
      if (value > 0) {
        const time = (info.localTradedAt || '').replace('T', ' ').slice(0, 16);
        return { value, info: `네이버 환율 (하나은행) ${info.closePrice}원 · ${time} 기준` };
      }
    } catch (e) { firstError = e; }

    // 2순위: 네이버 검색 환율 계산기
    try {
      const url = 'https://m.search.naver.com/p/csearch/content/qapirender.nhn?key=calculator&pkid=141'
        + '&q=%ED%99%98%EC%9C%A8&where=m&u1=keb&u6=standardUnit&u7=0&u3=USD&u4=KRW&u8=down&u2=1';
      const data = JSON.parse(await get(url));
      const value = toNumber(data.country[1].value);
      if (value > 0) return { value, info: `네이버 환율 ${data.country[1].value}원` };
    } catch (e) { firstError = firstError || e; }
    throw firstError || new Error('환율 값을 읽지 못했습니다');
  }

  async function refreshRate() {
    try {
      const r = await fetchRate();
      rate = r.value;
      rateInfo = r.info;
      rateError = '';
    } catch (e) {
      rateError = e && e.message ? e.message : String(e);
      console.warn('[원화표시] 환율을 가져오지 못했습니다', e);
    }
    scan();
  }

  // ---------- 잔고 찾기 ----------

  // "410.14 USD", "6 130 USD", "-12.50USD" 같은 텍스트
  // 모바일은 큰 금액을 "2.11k", "-1.5M"처럼 줄여 쓰므로 끝의 k/M/B도 받음
  const USD_RX = /^([-−+]?)\s*\$?\s*([\d][\d.,\s  ]*?)\s*([kKmMbB])?\s*USD$/;
  const NUM_RX = /^([-−+]?)\s*\$?\s*([\d][\d.,\s  ]*?)\s*([kKmMbB])?$/;
  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

  function parseWith(rx, text) {
    const m = text.replace(/\s+/g, ' ').trim().match(rx);
    if (!m) return null;
    let num = parseFloat(m[2].replace(/[,\s  ]/g, ''));
    if (isNaN(num)) return null;
    if (m[3]) num *= SUFFIX[m[3].toLowerCase()];
    return m[1] === '-' || m[1] === '−' ? -num : num;
  }

  const inTopArea = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.top < TOP_AREA_PX && rect.width > 0;
  };

  function usdTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/USD/i.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && !n.parentElement.closest('[data-krw-badge]')) nodes.push(n);
    }
    return nodes;
  }

  /** 금액 목록: { anchor: 원화를 붙일 요소, usd: 금액 } */
  function findAmounts() {
    const result = new Map();
    const nodes = usdTextNodes();
    usdTextCount = nodes.length;
    for (const node of nodes) {
      const start = node.parentElement;
      if (!inTopArea(start) || start.closest('mtr-portfolio-tabs')) continue;  // 탭 줄 합계는 scanLists에서 처리

      // (a) 숫자와 USD가 같은 요소(또는 4단계 안의 부모)에 함께 있는 경우: "410.14 USD"
      let found = false;
      for (let el = start, depth = 0; el && el !== document.body && depth < 4; depth++, el = el.parentElement) {
        const usd = parseWith(USD_RX, el.textContent);
        if (usd !== null) { result.set(el, usd); found = true; break; }
      }
      if (found) continue;

      // (b) 숫자와 USD가 나란히 있는 형제 요소인 경우: <span>410.14</span><span>USD</span>
      for (let el = start, depth = 0; el && depth < 3; depth++, el = el.parentElement) {
        const prev = el.previousElementSibling;
        const usd = prev ? parseWith(NUM_RX, prev.textContent) : null;
        if (usd !== null) { result.set(el, usd); break; }
      }
    }
    return result;
  }

  // ---------- 원화 표시 ----------

  const formatKrw = (krw) => (krw < 0 ? '-' : '') + Math.round(Math.abs(krw)).toLocaleString('ko-KR') + '원';
  const badges = new Map(); // 금액 요소 -> 원화 표시 요소

  // 상단 바가 높이 고정 + overflow:hidden 이라 안에 넣으면 잘리므로,
  // 원화 표시는 body에 position:fixed 로 띄워서 금액 바로 아래에 겹쳐 그린다.
  function placeBadge(el, badge) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { badge.style.display = 'none'; return; }
    badge.style.display = '';
    badge.style.left = Math.round(rect.left) + 'px';
    badge.style.top = Math.round(rect.bottom + 1) + 'px';
  }

  function placeAll() {
    for (const [el, badge] of badges) placeBadge(el, badge);
  }

  function scan() {
    if (!document.body) return;
    if (!rate) {
      setStatus(rateError ? `원화표시 ⚠ 환율을 못 가져옴: ${rateError}` : '원화표시: 환율 불러오는 중…', false);
      return;
    }

    const amounts = findAmounts();

    // 사라진 금액의 원화 표시 정리
    for (const [el, badge] of badges) {
      if (!el.isConnected || !amounts.has(el)) { badge.remove(); badges.delete(el); }
    }

    for (const [el, usd] of amounts) {
      let badge = badges.get(el);
      if (!badge || !badge.isConnected) {
        badge = document.createElement('div');
        badge.dataset.krwBadge = '1';
        badge.style.cssText = 'position:fixed;z-index:2147483646;padding:1px 6px;border-radius:4px;'
          + 'font:600 11px/14px "Malgun Gothic",sans-serif;color:#374151;background:rgba(255,255,255,.95);'
          + 'box-shadow:0 1px 3px rgba(0,0,0,.2);white-space:nowrap;';
        document.body.appendChild(badge);
        badges.set(el, badge);
      }
      const text = '≈ ' + formatKrw(usd * rate);
      if (badge.textContent !== text) badge.textContent = text;
      badge.title = `${usd.toLocaleString('en-US')} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
      placeBadge(el, badge);
    }
    lastCount = amounts.size;
    scanLists();
    if (isMobile()) scanMobile();

    if (lastCount > 0) {
      setStatus(`원화표시 ✓ 환율 ${rate.toLocaleString('ko-KR')}원 · 금액 ${lastCount}개`, true);
    } else {
      setStatus(`원화표시 ⚠ 잔고를 못 찾음 (USD 글자 ${usdTextCount}개) — 클릭해서 진단 정보 복사`, false);
    }
  }

  // ---------- 하단 표 (오픈 포지션 / 청산 포지션 / 재무 등) ----------

  // 머리글이 이 이름인 칸은 USD 금액으로 보고 아래에 원화를 붙인다
  const MONEY_HEADERS = new Set(['이익', '스왑', '커미션', '금액']);

  const listStyle = document.createElement('style');
  listStyle.textContent = `
    .krw-cell-host{flex-direction:column!important;justify-content:center!important;align-items:flex-end!important}
    .krw-cell{font-size:11px;line-height:13px;opacity:.7;white-space:nowrap;font-weight:400}
    .krw-inline{opacity:.75;white-space:nowrap}
    .krw-m{font-size:11px;font-weight:400;opacity:.75;white-space:nowrap;margin-left:4px}
    .krw-m-block{display:block;margin-left:0;line-height:13px}
    .krw-watch-line{display:flex!important;align-items:baseline;gap:5px;white-space:nowrap;overflow:hidden}
    .krw-watch-line > .krw-watch{margin-left:0;flex-shrink:0}`;

  // 셀 글자에서 우리가 붙인 원화 표시는 빼고 읽음
  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (!(n.classList && (n.classList.contains('krw-cell') || n.classList.contains('krw-inline') || n.classList.contains('krw-m')))) s += n.textContent;
    return s;
  }

  // 셀의 USD 금액 찾기
  // - 셀 글자 전체가 금액인 경우: " -5.00 "
  // - 금액 아래 다른 줄이 있는 경우(오픈 포지션 이익): <div> 38.40 </div><div> 47.87% </div>
  //   → 금액 요소(valueEl)를 돌려주고, 원화는 그 아래 줄 옆에 붙임
  function cellValue(cell) {
    const usd = parseWith(NUM_RX, ownText(cell));
    if (usd !== null) return { usd, valueEl: null };
    for (const el of cell.querySelectorAll('*')) {
      if (el.children.length || el.classList.contains('krw-cell') || el.classList.contains('krw-inline')) continue;
      const v = parseWith(NUM_RX, el.textContent);
      if (v !== null) return { usd: v, valueEl: el };
    }
    return null;
  }

  function putKrw(cell, found) {
    const text = '≈ ' + formatKrw(found.usd * rate);
    const title = `${found.usd} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
    const v = found.valueEl;
    let below = v && v.nextElementSibling;
    if (below && below.classList.contains('krw-cell')) below = below.nextElementSibling;
    const belowShown = below && below.getClientRects().length > 0;  // 수익률 줄은 설정에 따라 숨겨져 있음
    let tag;
    if (belowShown) {
      // 보이는 아래 줄(수익률) 뒤에 " · ≈ 53,012원" 형태로 붙임 (줄 수를 늘리지 않음)
      v.parentElement.querySelectorAll(':scope > .krw-cell').forEach(e => e.remove());
      tag = below.querySelector(':scope > .krw-inline');
      if (!tag) { tag = document.createElement('span'); tag.className = 'krw-inline'; below.appendChild(tag); }
      if (tag.textContent !== ' · ' + text) tag.textContent = ' · ' + text;
    } else if (v) {
      // 아래 줄이 없거나 숨겨져 있으면 금액 바로 아래에 한 줄로
      if (below) below.querySelectorAll(':scope > .krw-inline').forEach(e => e.remove());
      tag = v.nextElementSibling;
      if (!tag || !tag.classList.contains('krw-cell')) { tag = document.createElement('div'); tag.className = 'krw-cell'; v.after(tag); }
      if (tag.textContent !== text) tag.textContent = text;
    } else {
      tag = cell.querySelector(':scope > .krw-cell');
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'krw-cell';
        cell.appendChild(tag);
        cell.classList.add('krw-cell-host');
      }
      if (tag.textContent !== text) tag.textContent = text;
    }
    tag.title = title;
  }

  function scanLists() {
    if (!listStyle.isConnected) document.head.appendChild(listStyle);

    // 탭 줄 오른쪽의 "합계 -1 290.28 USD" 오른쪽에 같은 모양의 "원화" 칸을 하나 더 붙임
    // (줄이 가로로 놓여 있어서 원래 합계는 자연히 왼쪽으로 밀림)
    for (const f of document.querySelectorAll('.krw-fund')) {  // 사이트가 합계를 다시 그려서 짝을 잃은 원화 칸 정리
      const p = f.previousElementSibling;
      if (!p || p.tagName !== 'TRADE-FUND-ITEM' || p.classList.contains('krw-fund')) f.remove();
    }
    for (const item of document.querySelectorAll('mtr-portfolio-tabs trade-fund-item:not(.krw-fund)')) {
      const value = item.querySelector('.trade-fund-item__value .ui-suffix__value');
      const usd = value ? parseWith(USD_RX, value.textContent) : null;
      let fund = item.nextElementSibling;
      if (!fund || !fund.classList.contains('krw-fund')) fund = null;
      if (usd === null) { if (fund) fund.remove(); continue; }
      if (!fund) {
        fund = document.createElement('trade-fund-item');
        fund.className = 'trade-fund-item krw-fund';  // 합계 칸의 폭 제한 클래스는 빼고 기본 모양만 가져옴
        fund.innerHTML = '<span class="trade-fund-item__name">원화</span>'
          + '<span class="trade-fund-item__value ui-suffix"><span class="ui-suffix__value"></span></span>';
        fund.style.cssText = 'margin-left:16px;flex-shrink:0;white-space:nowrap;';
        item.after(fund);
      }
      const v = fund.querySelector('.ui-suffix__value');
      const text = '≈ ' + formatKrw(usd * rate);
      if (v.textContent !== text) v.textContent = text;
      fund.title = `${usd.toLocaleString('en-US')} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
    }

    for (const list of document.querySelectorAll('.mtr-trade__activity-wrapper ui-list')) {
      const heads = [...list.querySelectorAll('ui-list-header-item')].map(h => h.textContent.trim());
      const cols = heads.map((h, i) => (MONEY_HEADERS.has(h) ? i : -1)).filter(i => i >= 0);
      if (!cols.length) continue;
      for (const row of list.querySelectorAll('ui-list-row')) {
        const content = row.querySelector('.ui-list-row__content');
        const cells = content ? content.children : [];
        if (cells.length !== heads.length) continue;  // 칸 수가 머리글과 다르면 위치를 믿을 수 없음
        for (const i of cols) {
          const cell = cells[i];
          const found = cellValue(cell);
          if (found) putKrw(cell, found);
          else cell.querySelectorAll('.krw-cell, .krw-inline').forEach(e => e.remove());
        }
      }
    }
  }

  // ---------- 모바일 화면 ----------
  // 모바일은 PC 하단 표 대신 화면마다 다른 목록을 쓰므로 금액 요소를 직접 찾는다

  // 금액 요소 안 끝에 "≈ 1,234원"을 붙임 (block이면 금액 아래 줄로)
  function putInline(el, block) {
    const usd = parseWith(NUM_RX, ownText(el));
    let tag = el.querySelector(':scope > .krw-m');
    if (usd === null) { if (tag) tag.remove(); return; }
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'krw-m' + (block ? ' krw-m-block' : '');
      el.appendChild(tag);
    }
    const text = '≈ ' + formatKrw(usd * rate);
    if (tag.textContent !== text) tag.textContent = text;
    tag.title = `${usd} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
  }

  // 하단 바 합계(총 이익, 합계)는 값 줄 폭이 좁아 원화가 다음 줄로 넘어가 잘리므로,
  // 위쪽 이름 줄("총 이익") 끝에 붙임
  function putInLabel(valueEl) {
    const label = valueEl.previousElementSibling;
    if (!label) { putInline(valueEl); return; }
    const usd = parseWith(NUM_RX, ownText(valueEl));
    let tag = label.querySelector(':scope > .krw-m');
    if (usd === null) { if (tag) tag.remove(); return; }
    if (!tag) { tag = document.createElement('span'); tag.className = 'krw-m'; label.appendChild(tag); }
    const text = '≈ ' + formatKrw(usd * rate);
    if (tag.textContent !== text) tag.textContent = text;
    tag.style.color = usd < 0 ? 'var(--content-error)' : usd > 0 ? 'var(--content-success)' : '';
    tag.title = `${usd} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
  }

  // 칸이 좁을 때 쓰는 짧은 원화 표기: 3,326,001 → 333만원, 152,000,000 → 1.5억원
  function shortKrw(krw) {
    const a = Math.abs(krw), sign = krw < 0 ? '-' : '';
    if (a >= 1e8) return sign + (a / 1e8).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억원';
    if (a >= 1e4) return sign + Math.round(a / 1e4).toLocaleString('ko-KR') + '만원';
    return formatKrw(krw);
  }

  // 거래 화면 종목 손익 칩(-3.73)은 옆에 붙이면 가격 칸을 가리므로, 아래 "스프레드" 줄의 스프레드 바로 옆에 원화를 붙임
  // (스프레드가 한 줄을 다 차지하는 블록이라 줄을 가로 배치로 바꾸고, 칸을 넘치면 짧은 표기로 바꿈)
  function putChip(chip) {
    const usd = parseWith(NUM_RX, chip.textContent);
    const symbol = chip.closest('trade-instrument-symbol');
    const line = symbol && symbol.querySelector('[data-testid="additional-data"]');
    if (!line) return;
    let tag = line.querySelector(':scope > .krw-watch');
    if (usd === null) { if (tag) tag.remove(); line.classList.remove('krw-watch-line'); return; }
    if (!tag) { tag = document.createElement('span'); tag.className = 'krw-m krw-watch'; line.appendChild(tag); }
    line.classList.add('krw-watch-line');
    let text = '≈ ' + formatKrw(usd * rate);
    if (tag.textContent !== text) tag.textContent = text;
    if (line.scrollWidth > line.clientWidth + 1) text = '≈ ' + shortKrw(usd * rate);
    if (tag.textContent !== text) tag.textContent = text;
    tag.style.color = usd < 0 ? 'var(--content-error)' : usd > 0 ? 'var(--content-success)' : '';
    tag.title = `${usd} USD × ${rate.toLocaleString('ko-KR')}원\n${rateInfo}`;
  }

  function scanMobile() {
    if (!listStyle.isConnected) document.head.appendChild(listStyle);
    // 포트폴리오 > 시가: 포지션 이익 아래 줄
    for (const el of document.querySelectorAll('[data-testid="open-position-profit-value"]')) putInline(el, true);
    // 포트폴리오 > 청산됨: 각 포지션 이익 옆, 하단 "총 이익" 옆
    for (const el of document.querySelectorAll('.trade-closed-positions-mobile__profit-wrapper > div')) putInline(el);
    for (const el of document.querySelectorAll('[data-testid="closed-positions-actions-profit"]')) putInLabel(el);
    // 더보기 > 재무(Finance History): 각 금액 옆, 하단 "합계" 옆
    for (const el of document.querySelectorAll('[data-testid="finance-history-list-item-mobile-amount"]')) putInline(el);
    for (const el of document.querySelectorAll('[data-testid="finance-history-actions-mobile-profit"]')) putInLabel(el);
    // 거래: 포지션이 있는 종목의 손익 칩
    for (const chip of document.querySelectorAll('trade-market-watch [data-testid="profit-badge"]')) putChip(chip);
    for (const t of document.querySelectorAll('.krw-watch')) {  // 포지션을 닫아 칩이 사라지면 원화도 정리
      const symbol = t.closest('trade-instrument-symbol');
      if (!symbol || !symbol.querySelector('[data-testid="profit-badge"]')) { t.parentElement.classList.remove('krw-watch-line'); t.remove(); }
    }
  }

  // ---------- 진단 정보 ----------

  function copyDiagnostics() {
    const lines = [
      `url: ${location.href}`,
      `rate: ${rate} (${rateInfo || rateError})`,
      `converted: ${lastCount}, usdTextNodes: ${usdTextCount}`,
    ];
    for (const node of usdTextNodes().slice(0, 12)) {
      const el = node.parentElement;
      const rect = el.getBoundingClientRect();
      const box = el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement : el;
      lines.push(`--- top=${Math.round(rect.top)} text=${JSON.stringify(node.data)}`);
      lines.push(box.outerHTML.replace(/\s+/g, ' ').slice(0, 700));
    }
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(
      () => { status.textContent = '진단 정보를 복사했습니다. 채팅창에 붙여넣어 주세요.'; },
      () => { console.log(text); status.textContent = '복사 실패 — F12 콘솔에 출력했습니다.'; },
    );
  }

  setStatus('원화표시: 시작…', false);
  refreshRate();
  setInterval(refreshRate, RATE_REFRESH_MS);
  setInterval(scan, SCAN_MS);
  // 오픈 포지션 이익은 시세마다 바뀌므로, 하단 표가 바뀌면 1초를 기다리지 않고 바로(0.03초 안에) 원화를 다시 계산
  let listPending = false;
  new MutationObserver((muts) => {
    if (listPending || !rate) return;
    const ours = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return e && e.closest('.krw-cell, .krw-inline, .krw-m'); };
    const WATCH = '.mtr-trade__activity-wrapper, trade-open-positions-mobile, trade-closed-positions-mobile, '
      + 'trade-closed-positions-actions-mobile, payment-finance-history-mobile, payment-finance-history-actions-mobile, trade-market-watch';
    if (!muts.some((m) => !ours(m.target) && (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest(WATCH))) return;
    listPending = true;
    setTimeout(() => { listPending = false; scanLists(); if (isMobile()) scanMobile(); }, 30);
  }).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  window.addEventListener('scroll', placeAll, true);
  window.addEventListener('resize', placeAll);
})();
