// ==UserScript==
// @name         Culture Capital 원클릭 부분 청산
// @namespace    rere
// @version      1.1.2
// @description  오픈 포지션에 25%·50%·75% 부분 청산과 본절(손절가 → 진입가) 버튼을 추가합니다. (PC: 표 오른쪽 칸, 모바일: 연필 버튼의 부분 청산 창과 포지션 상세 화면)
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culture-partial-close.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culture-partial-close.user.js
// ==/UserScript==

function ccpcMain() {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const FRACS = [0.25, 0.5, 0.75];

  const st = {
    token: null,     // 사이트가 trading-edge 요청에 붙이는 Auth-Trading-Api 값
    uuid: null,      // 거래 시스템 ID
    open: null,      // 오픈 포지션 목록 (서버에서 직접 받음)
    openAt: 0,
    openLoading: false,
    inst: null,      // 종목별 거래량 규칙 Map(symbol → { min, step, prec, pricePrec })
    instUuid: null,
    instLoading: false,
    busy: new Set(), // 요청 중인 포지션 id
  };
  let noConfirm = false;
  try { noConfirm = localStorage.getItem('ccpc-noconfirm') === '1'; } catch {}

  // ---------------------------------------------------------------- 인증 정보 가져오기
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

  // ---------------------------------------------------------------- 서버
  async function api(method, path, body) {
    const r = await nativeFetch(`/trading-edge/${st.uuid}/${path}`, {
      method,
      headers: { 'Auth-Trading-Api': st.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const msg = data && (data.errorMessage || data.message || data.errorCode || data.error);
      throw new Error(msg ? String(msg) : 'HTTP ' + r.status);
    }
    return data;
  }

  async function loadOpen(force) {
    if (!st.uuid || !st.token || st.openLoading) return;
    // 확인 창이 열려 있으면 예상 손익이 따라 움직이도록 1초마다, 아니면 2.5초마다
    if (!force && Date.now() - st.openAt < (pop ? 1000 : 2500)) return;
    st.openLoading = true;
    try { st.open = (await api('GET', 'open-positions')).positions || []; st.openAt = Date.now(); } catch {}
    st.openLoading = false;
    update();
  }

  async function loadInst() {
    if (!st.uuid || !st.token || st.instLoading || st.instUuid === st.uuid) return;
    st.instLoading = true;
    try {
      const d = await api('GET', 'effective-instruments');
      // { 심볼: 종목 정보 } 형태 (배열로 오는 경우도 받아 줌)
      const list = Array.isArray(d) ? d : Object.values(d || {});
      const map = new Map();
      for (const i of list) {
        if (!i || !i.symbol) continue;
        const step = +i.volumeStep || 0.01;
        map.set(i.symbol, {
          min: +i.volumeMin || step,
          step,
          prec: Number.isFinite(+i.volumePrecision) ? +i.volumePrecision : ((String(step).split('.')[1] || '').length),
          pricePrec: Number.isFinite(+i.pricePrecision) ? +i.pricePrecision : null,
        });
      }
      st.inst = map; st.instUuid = st.uuid;
    } catch {}
    st.instLoading = false;
    update();
  }

  // ---------------------------------------------------------------- 계산
  const isSell = p => p.side === 'SELL';
  const sideKo = p => isSell(p) ? '매도' : '매수';
  const name = p => p.alias || p.symbol;
  const rule = p => (st.inst && st.inst.get(p.symbol)) || null;

  // 사이트의 부분 청산 창과 같은 범위: 최소 거래량 이상, (보유량 − 최소 단위) 이하, 단위에 맞춰 내림
  function closeVol(p, f) {
    const r = rule(p);
    if (!r) return 0;
    const max = +(p.volume - r.step).toFixed(r.prec);
    let v = +(Math.floor(p.volume * f / r.step + 1e-9) * r.step).toFixed(r.prec);
    if (v > max) v = max;
    return v >= r.min - 1e-9 ? v : 0;
  }
  const fmtVol = (p, v) => (+v).toFixed(rule(p) ? rule(p).prec : 2);
  const fmtPrice = (p, v) => {
    const r = rule(p);
    return r && r.pricePrec != null ? (+v).toFixed(r.pricePrec) : String(+v);
  };
  const profitOf = p => {
    for (const k of ['profit', 'grossProfit', 'netProfit']) if (Number.isFinite(+p[k]) && p[k] !== null) return +p[k];
    return null;
  };
  const money = v => v == null ? '-' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 본절: 수익 중이고 손절이 아직 진입가가 아니며 트레일링 스탑을 안 쓸 때만
  function beState(p) {
    if (p.trailingDistance) return { ok: false, why: '트레일링 스탑을 쓰는 중이라 본절을 쓸 수 없어요' };
    if (p.stopLoss && Math.abs(p.stopLoss - p.openPrice) < 1e-9) return { ok: false, done: true, why: '이미 손절가가 진입가예요' };
    const pr = profitOf(p);
    if (pr == null || pr <= 0) return { ok: false, why: '수익 중일 때만 본절로 옮길 수 있어요' };
    return { ok: true };
  }

  const findPos = id => id && st.open && st.open.find(x => String(x.id) === id);

  // ---------------------------------------------------------------- 실행
  async function doPartial(p, vol) {
    if (st.busy.has(p.id)) return;
    st.busy.add(p.id); update();
    try {
      await api('POST', 'position/close-partially', { id: p.id, volume: +vol });
      toast(`${name(p)} ${fmtVol(p, vol)} lot 청산했어요`);
    } catch (e) {
      toast(`부분 청산 실패: ${e.message}`, true);
    }
    st.busy.delete(p.id);
    loadOpen(true);
  }

  async function doBreakEven(p) {
    if (st.busy.has(p.id)) return;
    st.busy.add(p.id); update();
    try {
      // 사이트의 포지션 수정과 같은 형식. 익절은 그대로 둠
      await api('POST', 'position/edit', {
        id: p.id, instrument: p.symbol, volume: p.volume, orderSide: p.side,
        tpPrice: p.takeProfit ?? 0, slPrice: p.openPrice, trailingDistance: 0,
      });
      toast(`${name(p)} 손절가를 진입가 ${fmtPrice(p, p.openPrice)}로 옮겼어요`);
    } catch (e) {
      toast(`본절 실패: ${e.message}`, true);
    }
    st.busy.delete(p.id);
    loadOpen(true);
  }

  // ---------------------------------------------------------------- 화면 줄 ↔ 포지션 찾기
  // 화면 줄에는 포지션 id가 없으므로 심볼·방향·거래량으로 고르고, 겹치면 진입 시간·진입가·이익으로 가린다
  const pad = n => String(n).padStart(2, '0');
  const utcTime = iso => { const d = new Date(iso); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
  const num = s => parseFloat(String(s).replace(/[\s,  ]/g, '').replace(/[−–]/g, '-'));

  function rowInfo(row) {
    const sym = row.querySelector('trade-instrument-symbol-name');
    const chip = row.querySelector('trade-instrument-symbol ui-chip');
    const vol = row.querySelector('[data-testid="open-position-volume"]');
    if (!sym || !chip || !vol) return null;
    const ct = chip.textContent.trim();
    const side = /매도|sell/i.test(ct) ? 'SELL' : /매수|buy/i.test(ct) ? 'BUY' : (chip.classList.contains('ui-chip--red') ? 'SELL' : 'BUY');
    const cells = [...row.querySelectorAll('ui-list-row-item')].map(c => c.textContent.replace(/\s+/g, ' ').trim());
    const profitEl = row.querySelector('[data-testid="open-position-profit-value"]');
    return {
      sym: sym.textContent.trim(), side, vol: num(vol.textContent),
      time: cells.find(t => /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(t)) || null,
      nums: cells.map(num).filter(Number.isFinite),
      profit: profitEl ? num(profitEl.textContent) : null,
    };
  }

  function matchRows(rows) {
    const out = new Map();
    if (!st.open) return out;
    const used = new Set();
    for (const row of rows) {
      const info = rowInfo(row);
      if (!info) continue;
      const cands = st.open.filter(p => !used.has(p.id) && name(p) === info.sym && p.side === info.side && Math.abs(+p.volume - info.vol) < 1e-9);
      let best = null, bestScore = -Infinity;
      for (const p of cands) {
        let s = 0;
        if (info.time && p.openTime && utcTime(p.openTime) === info.time) s += 10;
        if (info.nums.some(n => Math.abs(n - p.openPrice) < 1e-9)) s += 5;
        const pr = profitOf(p);
        if (info.profit != null && pr != null) s -= Math.abs(pr - info.profit) / 1000;
        if (s > bestScore) { bestScore = s; best = p; }
      }
      if (best) { used.add(best.id); out.set(row, best); }
    }
    return out;
  }

  // ---------------------------------------------------------------- 공통 화면 조각
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CSS = `
  trade-open-positions-desktop .trade-open-positions-desktop__action-row{width:auto!important;min-width:0!important}
  .ccpc{display:inline-flex;gap:3px;align-items:center;margin-right:6px;vertical-align:middle}
  .ccpc button,.ccpc-h button{font:inherit;font-size:11px;line-height:1;padding:5px 6px;border-radius:6px;cursor:pointer;
    border:1px solid var(--border-primary,rgba(128,128,128,.3));background:var(--surface-primary,transparent);color:var(--content-primary,inherit);font-variant-numeric:tabular-nums}
  .ccpc button:hover:not(:disabled){border-color:#0e9c8b;color:#0e9c8b}
  .ccpc button:disabled{opacity:.35;cursor:not-allowed}
  .ccpc button.be-done{background:rgba(14,156,139,.14);border-color:#0e9c8b;color:#0e9c8b;opacity:1}
  .ccpc button.on{background:var(--content-primary,#222);color:var(--surface-primary,#fff);border-color:transparent}
  .ccpc-h{display:flex;gap:6px;align-items:center;justify-content:flex-end;width:100%;font-size:12px;white-space:nowrap}
  .ccpc-h button{padding:3px 6px}
  .ccpc-h button.off{border-color:#e5374d;color:#e5374d}
  .ccpc-pop{position:fixed;z-index:100000;min-width:270px;max-width:340px;background:var(--surface-primary,#fff);color:var(--content-primary,#1b2430);
    border:1px solid var(--border-primary,rgba(128,128,128,.3));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);padding:12px 14px;font-size:13px;display:grid;gap:8px}
  .ccpc-pop b{font-weight:600}
  .ccpc-pop .ccpc-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-variant-numeric:tabular-nums}
  .ccpc-pop .ccpc-kv span:nth-child(odd){color:var(--content-secondary,#6b7684)}
  .ccpc-pop .ccpc-kv span:nth-child(even){text-align:right}
  .ccpc-pop .ccpc-row{display:flex;gap:8px;justify-content:flex-end;align-items:center}
  .ccpc-pop label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--content-secondary,#6b7684);cursor:pointer;margin-right:auto}
  .ccpc-go{background:#0e9c8b;color:#fff;border:0;border-radius:7px;padding:6px 16px;font:inherit;font-weight:600;cursor:pointer}
  .ccpc-no{background:none;border:1px solid var(--border-primary,rgba(128,128,128,.3));color:inherit;border-radius:7px;padding:5px 12px;font:inherit;cursor:pointer}
  .ccpc-up{color:#0e9c8b}.ccpc-down{color:#e5374d}
  .ccpc-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:100001;background:#1b2430;color:#fff;
    padding:9px 16px;border-radius:10px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:90vw;text-align:center}
  .ccpc-toast.err{background:#c62f42}
  .ccpc-m{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 10px}
  .ccpc-m button{font:inherit;font-size:15px;font-weight:600;padding:11px 0;border-radius:10px;cursor:pointer;font-variant-numeric:tabular-nums;
    border:1px solid var(--border-primary,rgba(128,128,128,.3));background:var(--surface-primary,transparent);color:var(--content-primary,inherit)}
  .ccpc-m button:disabled{opacity:.35}
  .ccpc-m button.be-done{background:rgba(14,156,139,.14);border-color:#0e9c8b;color:#0e9c8b;opacity:1}
  .ccpc-m-dialog{margin-top:12px}
  .ccpc-m-note{grid-column:1/-1;margin:-2px 0 0;font-size:12px;color:var(--content-secondary,#6b7684);text-align:center}
  .ccpc-pop.m{left:12px!important;right:12px;max-width:none;font-size:14px;padding:14px 16px}
  .ccpc-pop.m .ccpc-go,.ccpc-pop.m .ccpc-no{padding:9px 20px}`;

  let toastEl = null, toastTimer = 0;
  function toast(msg, err) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'ccpc-toast'; }
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!err);
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.remove(), err ? 5000 : 2600);
  }

  // ---------------------------------------------------------------- PC: 확인 창
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } popObs.disconnect(); popWatched = null; }
  // 확인 창이 열려 있는 동안 화면의 이익 숫자를 지켜보다가 사이트가 바꾸는 순간 예상 손익도 다시 계산
  // (원화 표시와 같은 속도. 화면에서 숫자를 못 찾으면 서버에서 받은 값으로 1초마다)
  const popObs = new MutationObserver(() => refreshPop());
  let popWatched = null;
  document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !e.target.closest('.ccpc, .ccpc-m')) closePop(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

  function showPop(anchor, p, kind, f, mobile, onDone) {
    closePop();
    const pr = profitOf(p);
    let head, rows, go;
    if (kind === 'pct') {
      const v = closeVol(p, f);
      const est = pr == null ? null : pr * v / p.volume;
      head = `<b>${esc(name(p))} ${sideKo(p)} ${fmtVol(p, v)} lot 청산</b> <span style="opacity:.7">(${Math.round(f * 100)}%)</span>`;
      rows = `<span>남는 수량</span><span>${fmtVol(p, p.volume - v)} lot</span>
        <span>진입가</span><span>${fmtPrice(p, p.openPrice)}</span>
        <span>예상 실현 손익</span><span class="ccpc-est"></span>`;
      go = '청산';
    } else {
      head = `<b>${esc(name(p))} ${sideKo(p)} 본절</b>`;
      rows = `<span>손절가</span><span>${p.stopLoss ? fmtPrice(p, p.stopLoss) : '없음'} → <b>${fmtPrice(p, p.openPrice)}</b></span>
        <span>익절가</span><span>${p.takeProfit ? fmtPrice(p, p.takeProfit) : '없음'} (그대로)</span>`;
      go = '옮기기';
    }
    pop = document.createElement('div');
    pop.className = 'ccpc-pop' + (mobile ? ' m' : '');
    pop.innerHTML = `<div>${head}</div><div class="ccpc-kv">${rows}</div>
      <div class="ccpc-row">${mobile ? '' : '<label><input type="checkbox" class="ccpc-skip"> 다음부터 바로 실행</label>'}
      <button class="ccpc-no">취소</button><button class="ccpc-go">${go}</button></div>`;
    // 이익 숫자를 읽을 화면 줄: PC 표의 줄, 모바일 부분 청산 창이면 연필을 누른 줄 (상세 화면은 refreshPop에서 찾음)
    const row = anchor.closest('ui-list-row') || (anchor.closest('.ccpc-m-dialog') ? pencilRow : null);
    pop.__state = { id: String(p.id), kind, f, row };
    document.body.appendChild(pop);
    refreshPop();
    const a = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let top = a.bottom + 6;
    if (top + h > innerHeight - 8) top = a.top - h - 6;
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, a.right - w)) + 'px';
    pop.querySelector('.ccpc-no').onclick = closePop;
    pop.querySelector('.ccpc-go').onclick = () => {
      const skip = pop.querySelector('.ccpc-skip');
      if (skip && skip.checked) setNoConfirm(true);
      const cur = findPos(pop.__state.id) || p;  // 창을 띄운 뒤 바뀐 최신 포지션 정보로 실행
      closePop();
      if (onDone) onDone();
      if (kind === 'pct') doPartial(cur, closeVol(cur, f)); else doBreakEven(cur);
    };
    pop.querySelector('.ccpc-go').focus();
  }

  // 열려 있는 확인 창의 예상 손익을 최신 포지션 이익으로 다시 계산 (포지션이 사라졌으면 닫음)
  function screenProfitEl(st8) {
    const r = st8.row;
    if (r && r.isConnected) {
      const m = matchRows([r]).get(r);  // 가상 스크롤로 줄이 다른 포지션에 재사용됐는지 확인
      if (m && String(m.id) === st8.id) return r.querySelector('[data-testid="open-position-profit-value"]');
    }
    if (detailId() === st8.id) return document.querySelector('[data-testid="open-position-mobile-profit"]');
    return null;
  }
  // 원화 표시 스크립트가 붙인 글자는 빼고 그 요소 자체의 숫자만 읽음
  const ownNum = el => { let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.data; return num(t); };

  function refreshPop() {
    if (!pop || !pop.__state) return;
    const { id, kind, f } = pop.__state;
    const p = findPos(id);
    if (!p) { closePop(); return; }
    const el = pop.querySelector('.ccpc-est');
    if (!el || kind !== 'pct') return;
    const live = screenProfitEl(pop.__state);
    if (live !== popWatched) {
      popObs.disconnect(); popWatched = live;
      if (live) popObs.observe(live, { characterData: true, childList: true, subtree: true });
    }
    const shown = live ? ownNum(live) : NaN;
    const v = closeVol(p, f), pr = Number.isFinite(shown) ? shown : profitOf(p);
    const est = pr == null || !v ? null : pr * v / p.volume;
    const text = '약 ' + money(est);
    if (el.textContent !== text) el.textContent = text;
    el.className = 'ccpc-est' + (est > 0 ? ' ccpc-up' : est < 0 ? ' ccpc-down' : '');
  }

  function setNoConfirm(v) {
    noConfirm = v;
    try { localStorage.setItem('ccpc-noconfirm', v ? '1' : '0'); } catch {}
    update();
  }

  // ---------------------------------------------------------------- PC: 표에 버튼 칸 넣기
  const EXTRA = '10.5rem';  // 마지막(동작) 칸에 더할 폭

  // 브라우저가 calc(6.625rem + 10.5rem)을 calc(17.125rem)으로 바꿔 저장하므로,
  // 넓힌 뒤 실제로 저장된 값을 기억해 두고 그와 다를 때(= 사이트가 새로 쓴 값)만 다시 넓힌다
  function widen(el) {
    const cur = el.style.gridTemplateColumns;
    if (!cur || cur === el.__ccpcApplied) return;
    const parts = cur.trim().split(/\s+(?![^(]*\))/);
    parts[parts.length - 1] = `calc(${parts[parts.length - 1]} + ${EXTRA})`;
    el.style.gridTemplateColumns = parts.join(' ');
    el.__ccpcApplied = el.style.gridTemplateColumns;
  }

  function pcButtons(p) {
    const busy = st.busy.has(p.id);
    const be = beState(p);
    return FRACS.map(f => {
      const v = closeVol(p, f);
      return `<button data-ccpc="pct" data-f="${f}" ${!v || busy ? 'disabled' : ''} title="${v ? `${fmtVol(p, v)} lot 청산` : '거래량이 너무 작아 이 비율로는 나눌 수 없어요'}">${Math.round(f * 100)}%</button>`;
    }).join('') + `<button data-ccpc="be" class="${be.done ? 'be-done' : ''}" ${!be.ok || busy ? 'disabled' : ''} title="${be.ok ? '손절가를 진입가로 옮기기' : esc(be.why)}">${be.done ? '본절✓' : '본절'}</button>`;
  }

  function updatePC() {
    const host = document.querySelector('trade-open-positions-desktop');
    if (!host) return;
    const header = host.querySelector('.ui-list-header__content');
    if (header) {
      widen(header);
      const last = header.querySelector(':scope > ui-list-header-item:last-child');
      if (last) {
        let h = last.querySelector('.ccpc-h');
        if (!h) {
          h = document.createElement('div');
          h.className = 'ccpc-h';
          h.innerHTML = '부분 청산 <button type="button"></button>';
          h.querySelector('button').addEventListener('click', e => { e.stopPropagation(); setNoConfirm(!noConfirm); });
          last.prepend(h);
        }
        const b = h.querySelector('button');
        const t = noConfirm ? '바로 실행' : '확인 후 실행';
        if (b.textContent !== t) b.textContent = t;
        b.classList.toggle('off', noConfirm);
        b.title = noConfirm ? '누르면 실행 전에 확인 창을 띄워요' : '누르면 확인 창 없이 바로 실행해요';
      }
    }
    const rows = [...host.querySelectorAll('ui-list-row[data-testid="open-positions-desktop-list-row"]')];
    const map = matchRows(rows);
    for (const row of rows) {
      const content = row.querySelector('.ui-list-row__content');
      if (content) widen(content);
      const cell = row.querySelector('.trade-open-positions-desktop__action-row');
      if (!cell) continue;
      let box = cell.querySelector(':scope > .ccpc');
      const p = map.get(row);
      if (!p || !rule(p)) { if (box) box.remove(); continue; }
      if (!box) {
        box = document.createElement('div');
        box.className = 'ccpc';
        box.addEventListener('click', onPcClick);
        cell.prepend(box);
      }
      const html = pcButtons(p);
      if (box.__html !== html) { box.innerHTML = html; box.__html = html; }
      box.dataset.id = p.id;
    }
  }

  function onPcClick(e) {
    const b = e.target.closest('button[data-ccpc]');
    e.stopPropagation();
    if (!b || b.disabled) return;
    const id = e.currentTarget.dataset.id;
    const p = st.open && st.open.find(x => String(x.id) === id);
    if (!p) return;
    const kind = b.dataset.ccpc, f = +b.dataset.f;
    if (noConfirm) { if (kind === 'pct') doPartial(p, closeVol(p, f)); else doBreakEven(p); return; }
    showPop(b, p, kind, f);
  }

  // ---------------------------------------------------------------- 모바일: 버튼 줄 두 곳
  // 1) 포지션을 눌러 들어간 상세 화면(/app/portfolio/open/<포지션 id>/info)의 "부분 청산" 버튼 위
  // 2) 연필(부분 청산) 버튼을 누르면 올라오는 사이트 "부분 청산" 창의 수량 입력 칸 위
  // 사이트의 연필 버튼과 창은 그대로 동작하고, 우리 버튼은 확인 창을 거쳐 실행한다
  const detailId = () => (location.pathname.match(/\/portfolio\/open\/([^/]+)/) || [])[1] || null;
  let pencilPosId = null, pencilRow = null;  // 마지막으로 누른 연필 버튼의 포지션과 줄 (사이트 창에는 포지션 정보가 없음)
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-testid="open-positions-mobile-partial-close-button"]');
    const row = btn && btn.closest('ui-list-row');
    if (!row) return;
    const p = matchRows([row]).get(row);
    pencilPosId = p ? String(p.id) : null;
    pencilRow = row;
  }, true);

  function mobileBox(cls, anchor, padFrom, p, onDone) {
    let box = document.querySelector('.' + cls);
    if (!anchor || !p || !rule(p)) { if (box) box.remove(); return; }
    if (!box || box.nextElementSibling !== anchor) {
      if (box) box.remove();
      box = document.createElement('div');
      box.className = 'ccpc-m ' + cls;
      box.addEventListener('click', e => {
        const b = e.target.closest('button[data-ccpc]');
        if (!b || b.disabled) return;
        const cur = st.open && st.open.find(x => String(x.id) === box.dataset.id);
        if (cur) showPop(b, cur, b.dataset.ccpc, +b.dataset.f, true, onDone);
      });
      anchor.before(box);
    }
    // 옆의 사이트 버튼 줄과 같은 좌우 여백
    const cs = getComputedStyle(padFrom);
    box.style.paddingLeft = cs.paddingLeft; box.style.paddingRight = cs.paddingRight;
    const busy = st.busy.has(p.id), be = beState(p);
    const html = FRACS.map(f => {
      const v = closeVol(p, f);
      return `<button data-ccpc="pct" data-f="${f}" ${!v || busy ? 'disabled' : ''}>${Math.round(f * 100)}%</button>`;
    }).join('') + `<button data-ccpc="be" class="${be.done ? 'be-done' : ''}" ${!be.ok || busy ? 'disabled' : ''}>${be.done ? '본절✓' : '본절'}</button>`
      + (be.ok || be.done ? '' : `<p class="ccpc-m-note">본절: ${esc(be.why)}</p>`);
    if (box.__html !== html) { box.innerHTML = html; box.__html = html; }
    box.dataset.id = p.id;
  }

  function updateMobile() {
    const detail = document.querySelector('mtr-position-details .mtr-open-position-details__buttons');
    mobileBox('ccpc-m-detail', detail, detail, detail && findPos(detailId()));
    // 사이트 부분 청산 창: PC는 표에 버튼이 있으므로 모바일 화면(<mtr-mobile>)에서만
    const dlg = document.querySelector('trade-open-position-partial-close');
    const mobile = !!document.querySelector('mtr-mobile');
    const stepper = mobile && dlg && dlg.querySelector(':scope > .trade-open-position-partial-close__stepper-container');
    const btns = stepper && dlg.querySelector(':scope > .trade-open-position-partial-close__buttons-container');
    // 우리 버튼으로 청산하면 사이트 창은 필요 없으므로 닫음
    const closeDlg = () => { const c = document.querySelector('[data-testid="open-position-partial-close-cancel-button"]'); if (c) c.click(); };
    mobileBox('ccpc-m-dialog', stepper, btns || stepper, stepper && findPos(pencilPosId), closeDlg);
  }

  // ---------------------------------------------------------------- 갱신
  function update() {
    if (!document.body) return;
    if (pop || document.querySelector('trade-open-positions-desktop, trade-open-positions-mobile, mtr-position-details')) { loadInst(); loadOpen(); }
    updatePC();
    updateMobile();
    refreshPop();
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    setInterval(update, 1000);
    let pending = false;
    // 사이트가 표의 칸 폭(style)을 다시 쓰면 바로 넓혀야 하므로 그 두 곳의 style 변경도 지켜봄
    const ours = '.ccpc, .ccpc-h, .ccpc-m, .ccpc-pop, .ccpc-toast';
    const relevant = m => m.type === 'attributes'
      ? m.target.matches('.ui-list-row__content, .ui-list-header__content')
      : !(m.target.closest && m.target.closest(ours));
    new MutationObserver(muts => {
      if (pending || !muts.some(relevant)) return;
      pending = true;
      setTimeout(() => { pending = false; update(); }, 60);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }
  if (document.head) boot(); else document.addEventListener('DOMContentLoaded', boot);
}

// 파이어폭스 탬퍼몽키, 아이폰 사파리 Userscripts 등은 스크립트를 페이지와 분리된 샌드박스에서 실행해서
// 사이트의 XHR을 엿볼 수 없으므로 항상 코드를 페이지에 직접 넣어 실행한다.
// (이 사이트는 CSP가 없어 인라인 스크립트가 막히지 않고, 크롬처럼 원래 페이지에서 실행되는 경우에도 똑같이 동작한다)
(function inject() {
  if (window.top !== window.self) return;  // 차트 프레임에서는 실행하지 않음
  const root = document.head || document.documentElement;
  if (!root) {  // 아주 이른 시점이라 <html>도 아직 없으면 생길 때까지 기다림
    new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); inject(); } })
      .observe(document, { childList: true });
    return;
  }
  const s = document.createElement('script');
  s.textContent = '(' + ccpcMain.toString() + ')();';
  root.appendChild(s);
  s.remove();
})();
