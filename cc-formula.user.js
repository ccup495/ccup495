// ==UserScript==
// @name         Culture Capital 수식관리자·조건검색
// @namespace    rere
// @version      1.1.0
// @description  키움 영웅문 스타일 수식관리자(기술적지표·신호검색·시스템트레이딩·강세약세·사용자함수)와 조건검색을 트레이딩뷰 차트에 추가합니다.
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/cc-formula.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/cc-formula.user.js
// ==/UserScript==

function ccfMain() {
  'use strict';
  if (window.__ccfLoaded) return;
  window.__ccfLoaded = true;
  // =============================================================================
  // 키움 수식관리자 호환 수식 엔진
  //  - 문법: A = avg(C, 단기); B = avg(C, 장기); CrossUp(A, B)
  //  - 과거값: C(1) = 1봉 전 종가, A(2) = 변수 A의 2봉 전 값
  //  - 주석: // 한 줄,  /* 여러 줄 */
  //  - 대소문자 구분 없음, 한글 이름 가능
  //  - 모든 값은 시계열(봉마다 하나의 값). 참=1, 거짓=0, 값 없음=NaN
  // =============================================================================
  function ccFormulaEngine() {
    'use strict';

    class FormulaError extends Error {
      constructor(msg, line, info) {
        super(line ? msg + ' (줄 ' + line + ')' : msg);
        this.line = line;
        this.info = info || null; // 자동수정용: { code, pos, ... }
      }
    }

    // ---------------------------------------------------------------------------
    // 1. 토큰 분리
    // ---------------------------------------------------------------------------
    const ID_START = /[A-Za-z_ㄱ-ㆎ가-힣]/;
    const ID_PART = /[A-Za-z0-9_ㄱ-ㆎ가-힣]/;
    const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    const OPS = ['==', '!=', '<>', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '^', '<', '>', '=', '!', '(', ')', ',', ';'];
    const WORD_OPS = { and: '&&', or: '||', not: '!', 그리고: '&&', 또는: '||' };

    function lex(src) {
      const toks = [];
      let i = 0, line = 1;
      const n = src.length;
      while (i < n) {
        const ch = src[i];
        if (ch === '\n') { toks.push({ t: 'nl', line: line, pos: i, end: i + 1 }); line++; i++; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ' ' || ch === '　') { i++; continue; }
        if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (ch === '/' && src[i + 1] === '*') {
          const e = src.indexOf('*/', i + 2);
          const end = e < 0 ? n : e + 2;
          for (let k = i; k < end; k++) if (src[k] === '\n') line++;
          i = end; continue;
        }
        if (/[0-9.]/.test(ch)) {
          NUM_RE.lastIndex = i;
          const m = NUM_RE.exec(src);
          if (m) { toks.push({ t: 'num', v: parseFloat(m[0]), line: line, pos: i, end: i + m[0].length }); i += m[0].length; continue; }
        }
        if (ch === '"' || ch === "'") {
          const e = src.indexOf(ch, i + 1);
          if (e < 0) throw new FormulaError('따옴표가 닫히지 않았습니다', line, { code: 'quote', pos: i });
          toks.push({ t: 'str', v: src.slice(i + 1, e), line: line, pos: i, end: e + 1 });
          i = e + 1; continue;
        }
        if (ID_START.test(ch)) {
          let j = i + 1;
          while (j < n && ID_PART.test(src[j])) j++;
          const word = src.slice(i, j);
          const low = word.toLowerCase();
          const tk = { line: line, pos: i, end: j };
          if (WORD_OPS[low]) { tk.t = 'op'; tk.v = WORD_OPS[low]; }
          else if (low === 'true' || low === '참') { tk.t = 'num'; tk.v = 1; }
          else if (low === 'false' || low === '거짓') { tk.t = 'num'; tk.v = 0; }
          else { tk.t = 'id'; tk.v = word; }
          toks.push(tk);
          i = j; continue;
        }
        let op = null;
        for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
        if (!op) throw new FormulaError('알 수 없는 문자: ' + ch, line, { code: 'char', pos: i, ch: ch });
        toks.push({ t: 'op', v: op === '<>' ? '!=' : op, line: line, pos: i, end: i + op.length });
        i += op.length;
      }
      toks.push({ t: 'eof', line: line, pos: n, end: n });
      return toks;
    }

    // ---------------------------------------------------------------------------
    // 2. 구문 분석 → AST
    //   우선순위(낮음→높음): or, and, not, == != =, < <= > >=, + -, * / %, 단항 -, ^
    // ---------------------------------------------------------------------------
    const BIN_CONT = new Set(['||', '&&', '==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '^', '=']);

    function parse(src) {
      const toks = lex(src);
      let p = 0, depth = 0, lastEnd = 0;
      const ctxStack = []; // 'call' | 'group'

      function peek() {
        // 괄호 안에서는 줄바꿈 무시
        if (depth > 0) while (toks[p].t === 'nl') p++;
        return toks[p];
      }
      function next() { const t = peek(); p++; lastEnd = t.end; return t; }
      function skipNl() { while (toks[p].t === 'nl') p++; }
      function isOp(t, v) { return t.t === 'op' && t.v === v; }
      function expectOp(v) {
        const t = next();
        if (!isOp(t, v)) throw new FormulaError("'" + v + "'가 필요합니다" + desc(t), t.line, { code: 'expect', want: v, pos: t.pos, after: lastPrev(t), ctx: ctxStack[ctxStack.length - 1] });
        return t;
      }
      function lastPrev(t) { let q = toks.indexOf(t) - 1; while (q >= 0 && toks[q].t === 'nl') q--; return q >= 0 ? toks[q].end : 0; }
      function desc(t) {
        if (t.t === 'eof') return ' (수식이 끝남)';
        if (t.t === 'nl') return ' (줄바꿈)';
        return " ('" + (t.v !== undefined ? t.v : t.t) + "' 앞)";
      }
      // 다음 줄이 이항 연산자로 시작하면 식이 이어지는 것으로 본다
      function peekBin() {
        let q = p;
        if (depth === 0) {
          while (toks[q].t === 'nl') q++;
          const t = toks[q];
          if (t.t === 'op' && BIN_CONT.has(t.v)) { p = q; return t; }
          return toks[p];
        }
        return peek();
      }

      function parseProgram() {
        const stmts = [];
        for (;;) {
          while (toks[p].t === 'nl' || isOp(toks[p], ';')) p++;
          if (toks[p].t === 'eof') break;
          stmts.push(parseStatement());
          const t = toks[p];
          if (t.t === 'eof') break;
          if (t.t === 'nl' || isOp(t, ';')) continue;
          throw new FormulaError("문장 사이에 ';' 또는 줄바꿈이 필요합니다" + desc(t), t.line, { code: 'sep', pos: t.pos });
        }
        if (!stmts.length) throw new FormulaError('수식이 비어 있습니다', 1, { code: 'empty', pos: 0 });
        return stmts;
      }
      function parseStatement() {
        const t = toks[p], t2 = toks[p + 1];
        if (t.t === 'id' && isOp(t2, '=')) {
          p += 2;
          skipNl();
          const ex = parseExpr();
          return { k: 'assign', name: t.v, expr: ex, line: t.line, s: t.pos, nameEnd: t.end, e: lastEnd };
        }
        const ex = parseExpr();
        return { k: 'expr', expr: ex, line: t.line, s: t.pos, e: lastEnd };
      }
      function parseExpr() { return parseOr(); }
      function bin(sub, ops) {
        return function () {
          let a = sub();
          for (;;) {
            const t = peekBin();
            if (t.t === 'op' && ops.indexOf(t.v) >= 0) {
              p++; lastEnd = t.end; skipNl();
              const b = sub();
              a = { k: 'bin', op: t.v === '=' ? '==' : t.v, a: a, b: b, line: t.line, s: a.s, e: lastEnd, opPos: t.pos, opEnd: t.end };
            } else return a;
          }
        };
      }
      function parseNot() {
        const t = peek();
        if (isOp(t, '!')) { p++; lastEnd = t.end; skipNl(); const a = parseNot(); return { k: 'un', op: '!', a: a, line: t.line, s: t.pos, e: lastEnd }; }
        return parseEq();
      }
      function parseUnary() {
        const t = peek();
        if (isOp(t, '-') || isOp(t, '+')) { p++; lastEnd = t.end; skipNl(); const a = parseUnary(); return t.v === '-' ? { k: 'un', op: '-', a: a, line: t.line, s: t.pos, e: lastEnd } : a; }
        if (isOp(t, '!')) { p++; lastEnd = t.end; skipNl(); const a = parseUnary(); return { k: 'un', op: '!', a: a, line: t.line, s: t.pos, e: lastEnd }; }
        return parsePow();
      }
      function parsePow() {
        const a = parsePrimary();
        const t = peekBin();
        if (isOp(t, '^')) { p++; lastEnd = t.end; skipNl(); const b = parseUnary(); return { k: 'bin', op: '^', a: a, b: b, line: t.line, s: a.s, e: lastEnd, opPos: t.pos, opEnd: t.end }; }
        return a;
      }
      function parsePrimary() {
        const t = next();
        if (t.t === 'num') return { k: 'num', v: t.v, line: t.line, s: t.pos, e: t.end };
        if (t.t === 'str') return { k: 'str', v: t.v, line: t.line, s: t.pos, e: t.end };
        if (t.t === 'id') {
          if (isOp(toks[p], '(')) {
            p++; lastEnd = toks[p - 1].end; depth++; ctxStack.push('call');
            const args = [];
            if (!isOp(peek(), ')')) {
              for (;;) {
                args.push(parseExpr());
                if (isOp(peek(), ',')) { p++; continue; }
                break;
              }
            }
            expectOp(')'); depth--; ctxStack.pop();
            return { k: 'call', name: t.v, args: args, line: t.line, s: t.pos, nameEnd: t.end, e: lastEnd };
          }
          return { k: 'id', name: t.v, line: t.line, s: t.pos, e: t.end };
        }
        if (isOp(t, '(')) {
          depth++; ctxStack.push('group');
          const e = parseExpr();
          expectOp(')'); depth--; ctxStack.pop();
          return Object.assign({}, e, { s: t.pos, e: lastEnd, paren: true });
        }
        throw new FormulaError('값이 필요합니다' + desc(t), t.line, { code: 'value', pos: t.pos });
      }
      const parseMul = bin(parseUnary, ['*', '/', '%']);
      const parseAdd = bin(parseMul, ['+', '-']);
      const parseRel = bin(parseAdd, ['<', '<=', '>', '>=']);
      const parseEq = bin(parseRel, ['==', '!=', '=']);
      const parseAnd = bin(parseNot, ['&&']);
      const parseOr = bin(parseAnd, ['||']);

      return parseProgram();
    }

    // ---------------------------------------------------------------------------
    // 3. 봉 데이터 컨텍스트
    // ---------------------------------------------------------------------------
    function makeCtx(opts) {
      const tz = opts && typeof opts.tzOffsetMin === 'number' ? opts.tzOffsetMin : null; // null = 브라우저 시간대
      const ctx = {
        o: [], h: [], l: [], c: [], v: [], t: [], date: [], time: [],
        dO: [], dH: [], dL: [], pO: [], pH: [], pL: [], pC: [],
        n: 0,
        set: function (i, bar) {
          ctx.o[i] = bar.open; ctx.h[i] = bar.high; ctx.l[i] = bar.low; ctx.c[i] = bar.close;
          ctx.v[i] = bar.volume === undefined ? NaN : bar.volume;
          ctx.t[i] = bar.time;
          let d;
          if (tz === null) {
            d = new Date(bar.time);
            ctx.date[i] = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
            ctx.time[i] = d.getHours() * 10000 + d.getMinutes() * 100 + d.getSeconds();
          } else {
            d = new Date(bar.time + tz * 60000);
            ctx.date[i] = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
            ctx.time[i] = d.getUTCHours() * 10000 + d.getUTCMinutes() * 100 + d.getUTCSeconds();
          }
          if (i > 0 && ctx.date[i - 1] === ctx.date[i]) {
            ctx.dO[i] = ctx.dO[i - 1];
            ctx.dH[i] = Math.max(ctx.dH[i - 1], bar.high);
            ctx.dL[i] = Math.min(ctx.dL[i - 1], bar.low);
            ctx.pO[i] = ctx.pO[i - 1]; ctx.pH[i] = ctx.pH[i - 1]; ctx.pL[i] = ctx.pL[i - 1]; ctx.pC[i] = ctx.pC[i - 1];
          } else {
            ctx.dO[i] = bar.open; ctx.dH[i] = bar.high; ctx.dL[i] = bar.low;
            if (i > 0) { ctx.pO[i] = ctx.dO[i - 1]; ctx.pH[i] = ctx.dH[i - 1]; ctx.pL[i] = ctx.dL[i - 1]; ctx.pC[i] = ctx.c[i - 1]; }
            else { ctx.pO[i] = NaN; ctx.pH[i] = NaN; ctx.pL[i] = NaN; ctx.pC[i] = NaN; }
          }
          ctx.n = i + 1;
        },
      };
      return ctx;
    }

    // ---------------------------------------------------------------------------
    // 4. 노드: 모든 식은 시계열 버퍼를 가진다.
    //   ev(i): i번째 봉 값을 계산해 버퍼에 넣고 반환
    //   get(i, k): k봉 전 값 (이미 계산된 버퍼에서 읽음)
    // ---------------------------------------------------------------------------
    function val(x) { return x === undefined ? NaN : x; }
    function truthy(x) { return x !== 0 && x === x; } // NaN은 거짓

    function exprNode(fn) {
      const buf = [];
      return {
        buf: buf,
        ev: function (i) { const v = fn(i); buf[i] = v; return v; },
        get: function (i, k) { const j = i - (k || 0); return j >= 0 ? val(buf[j]) : NaN; },
      };
    }
    function constNode(v) {
      return { buf: null, ev: function () { return v; }, get: function () { return v; }, isConst: true, value: v };
    }
    function arrNode(arr) {
      return {
        ev: function (i) { return val(arr[i]); },
        get: function (i, k) { const j = i - (k || 0); return j >= 0 ? val(arr[j]) : NaN; },
      };
    }
    // 이미 계산되는 노드를 가리키는 참조 (변수, 함수 인자)
    function refNode(target) {
      return {
        ev: function (i) { return target.get(i, 0); },
        get: function (i, k) { return target.get(i, k); },
      };
    }

    // ---------------------------------------------------------------------------
    // 5. 내장 함수 (JS 구현)
    //   fn(i, v, a, raw, st, ctx): v=인자 값(현재 봉), a=인자 노드, raw=자기 값 버퍼(이동 전)
    //   shift: 마지막 선택 인자 M → M봉 전 값
    // ---------------------------------------------------------------------------
    function per(x) { const n = Math.round(x); return n >= 1 ? n : 1; }
    function prevRaw(raw, i) { return i > 0 ? val(raw[i - 1]) : NaN; }

    function smaAt(a, i, n) {
      let s = 0;
      for (let k = 0; k < n; k++) { const x = a.get(i, k); if (x !== x) return NaN; s += x; }
      return s / n;
    }
    function emaStep(a, v0, i, n, raw, alpha) {
      const p = prevRaw(raw, i);
      if (p !== p) return smaAt(a, i, n); // 첫 값은 단순평균으로 시작
      if (v0 !== v0) return p;
      return alpha * v0 + (1 - alpha) * p;
    }
    function wmaAt(a, i, n) {
      let s = 0, w = 0;
      for (let k = 0; k < n; k++) { const x = a.get(i, k); if (x !== x) return NaN; s += x * (n - k); w += n - k; }
      return s / w;
    }
    const MA_TYPES = {
      '단순': 0, simple: 0, sma: 0, avg: 0, '0': 0,
      '지수': 1, exponential: 1, ema: 1, eavg: 1, '1': 1,
      '가중': 2, weighted: 2, wma: 2, wavg: 2, '2': 2,
      '윌더': 3, wilder: 3, rma: 3, smma: 3, '3': 3,
    };

    const B = {};
    function def(names, spec) { names.split(',').forEach(function (n) { B[n.trim().toLowerCase()] = spec; }); }

    def('avg,평균,sma', { min: 2, max: 3, shift: 2, fn: function (i, v, a) { return smaAt(a[0], i, per(v[1])); } });
    def('wavg,가중평균,wma', { min: 2, max: 3, shift: 2, fn: function (i, v, a) { return wmaAt(a[0], i, per(v[1])); } });
    def('eavg,지수평균,ema', { min: 2, max: 3, shift: 2, fn: function (i, v, a, raw) { const n = per(v[1]); return emaStep(a[0], v[0], i, n, raw, 2 / (n + 1)); } });
    def('rma,윌더평균,smma', { min: 2, max: 3, shift: 2, fn: function (i, v, a, raw) { const n = per(v[1]); return emaStep(a[0], v[0], i, n, raw, 1 / n); } });
    def('ma,이평', {
      min: 3, max: 4, shift: 3, raw: [2],
      fn: function (i, v, a, raw) {
        const n = per(v[1]);
        switch (v[2]) {
          case 1: return emaStep(a[0], v[0], i, n, raw, 2 / (n + 1));
          case 2: return wmaAt(a[0], i, n);
          case 3: return emaStep(a[0], v[0], i, n, raw, 1 / n);
          default: return smaAt(a[0], i, n);
        }
      },
    });
    def('stdev,표준편차', {
      min: 2, max: 3, shift: 2,
      fn: function (i, v, a) {
        const n = per(v[1]); const m = smaAt(a[0], i, n);
        if (m !== m) return NaN;
        let s = 0;
        for (let k = 0; k < n; k++) { const d = a[0].get(i, k) - m; s += d * d; }
        return Math.sqrt(s / n);
      },
    });
    def('meandev,평균편차', {
      min: 2, max: 3, shift: 2,
      fn: function (i, v, a) {
        const n = per(v[1]); const m = smaAt(a[0], i, n);
        if (m !== m) return NaN;
        let s = 0;
        for (let k = 0; k < n; k++) s += Math.abs(a[0].get(i, k) - m);
        return s / n;
      },
    });
    function extreme(isMax) {
      return {
        min: 2, max: 3, shift: 2,
        fn: function (i, v, a) {
          const n = per(v[1]); let r = NaN;
          for (let k = 0; k < n; k++) {
            const x = a[0].get(i, k);
            if (x === x && (r !== r || (isMax ? x > r : x < r))) r = x;
          }
          return r;
        },
      };
    }
    def('highest,최고값', extreme(true));
    def('lowest,최저값', extreme(false));
    // N봉 안에서 최고/최저값이 몇 봉 전에 있었는지 (0 = 현재 봉)
    function extremeBars(isMax) {
      return {
        min: 2, max: 2,
        fn: function (i, v, a) {
          const n = per(v[1]); let r = NaN, at = NaN;
          for (let k = 0; k < n; k++) {
            const x = a[0].get(i, k);
            if (x === x && (r !== r || (isMax ? x > r : x < r))) { r = x; at = k; }
          }
          return at;
        },
      };
    }
    def('highestbars', extremeBars(true));
    def('lowestbars', extremeBars(false));
    // 선형회귀: 현재 봉의 회귀값 / 기울기
    function linreg(slopeOnly) {
      return {
        min: 2, max: 2,
        fn: function (i, v, a) {
          const n = per(v[1]);
          if (n < 2) return NaN;
          let sx = 0, sy = 0, sxy = 0, sxx = 0;
          for (let k = 0; k < n; k++) {
            const y = a[0].get(i, n - 1 - k); if (y !== y) return NaN;
            sx += k; sy += y; sxy += k * y; sxx += k * k;
          }
          const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
          if (slopeOnly) return slope;
          return (sy - slope * sx) / n + slope * (n - 1);
        },
      };
    }
    def('linreg,선형회귀', linreg(false));
    def('linregslope,회귀기울기', linreg(true));
    def('sum,합계', {
      min: 1, max: 3, shift: 2,
      fn: function (i, v, a, raw) {
        if (a.length === 1) { // 누적 합계
          const p = prevRaw(raw, i); const x = v[0];
          if (x !== x) return p;
          return p === p ? p + x : x;
        }
        const n = per(v[1]); let s = 0;
        for (let k = 0; k < n; k++) { const x = a[0].get(i, k); if (x !== x) return NaN; s += x; }
        return s;
      },
    });
    def('max,최대값', { min: 1, max: 99, fn: function (i, v) { let r = NaN; for (const x of v) { if (x !== x) return NaN; if (r !== r || x > r) r = x; } return r; } });
    def('min,최소값', { min: 1, max: 99, fn: function (i, v) { let r = NaN; for (const x of v) { if (x !== x) return NaN; if (r !== r || x < r) r = x; } return r; } });
    def('abs,절대값', { min: 1, max: 1, fn: function (i, v) { return Math.abs(v[0]); } });
    def('log,자연로그', { min: 1, max: 1, fn: function (i, v) { return Math.log(v[0]); } });
    def('log10,상용로그', { min: 1, max: 1, fn: function (i, v) { return Math.log10(v[0]); } });
    def('exp', { min: 1, max: 1, fn: function (i, v) { return Math.exp(v[0]); } });
    def('sqrt,제곱근', { min: 1, max: 1, fn: function (i, v) { return Math.sqrt(v[0]); } });
    def('pow,누승', { min: 2, max: 2, fn: function (i, v) { return Math.pow(v[0], v[1]); } });
    def('sin,사인', { min: 1, max: 1, fn: function (i, v) { return Math.sin(v[0]); } });
    def('cos,코사인', { min: 1, max: 1, fn: function (i, v) { return Math.cos(v[0]); } });
    def('tan,탄젠트', { min: 1, max: 1, fn: function (i, v) { return Math.tan(v[0]); } });
    def('asin,아크사인', { min: 1, max: 1, fn: function (i, v) { return Math.asin(v[0]); } });
    def('acos,아크코사인', { min: 1, max: 1, fn: function (i, v) { return Math.acos(v[0]); } });
    def('atan,아크탄젠트', { min: 1, max: 1, fn: function (i, v) { return Math.atan(v[0]); } });
    def('round,반올림', { min: 1, max: 2, fn: function (i, v) { const m = Math.pow(10, v[1] || 0); return Math.round(v[0] * m) / m; } });
    def('floor,내림', { min: 1, max: 1, fn: function (i, v) { return Math.floor(v[0]); } });
    def('ceil,올림', { min: 1, max: 1, fn: function (i, v) { return Math.ceil(v[0]); } });
    def('nz', { min: 1, max: 2, fn: function (i, v) { return v[0] === v[0] ? v[0] : (v.length > 1 ? v[1] : 0); } });
    def('isnan,값없음', { min: 1, max: 1, fn: function (i, v) { return v[0] !== v[0] ? 1 : 0; } });
    def('if,iff,만일,만약', { min: 3, max: 3, fn: function (i, v) { return truthy(v[0]) ? v[1] : v[2]; } });
    def('between,사이', { min: 3, max: 3, fn: function (i, v) { return v[0] >= v[1] && v[0] <= v[2] ? 1 : 0; } });
    def('crossup,상향돌파', {
      min: 2, max: 2,
      fn: function (i, v, a) { const a1 = a[0].get(i, 1), b1 = a[1].get(i, 1); return v[0] > v[1] && a1 <= b1 ? 1 : 0; },
    });
    def('crossdown,하향돌파', {
      min: 2, max: 2,
      fn: function (i, v, a) { const a1 = a[0].get(i, 1), b1 = a[1].get(i, 1); return v[0] < v[1] && a1 >= b1 ? 1 : 0; },
    });
    def('shift,이동', { min: 2, max: 2, fn: function (i, v, a) { const k = Math.round(v[1]); return k >= 0 ? a[0].get(i, k) : NaN; } });
    def('barssince', {
      min: 1, max: 1,
      fn: function (i, v, a, raw) { if (truthy(v[0])) return 0; const p = prevRaw(raw, i); return p === p ? p + 1 : NaN; },
    });
    def('countsince', {
      min: 2, max: 2,
      fn: function (i, v, a, raw) {
        const d = truthy(v[1]) ? 1 : 0;
        if (truthy(v[0])) return d;
        const p = prevRaw(raw, i); return p === p ? p + d : NaN;
      },
    });
    // 조건 만족 시점 목록을 봉 번호로 보관 (마지막 봉 재계산 대비 같은 봉은 지우고 다시 넣음)
    function events(st, i, cond) {
      const ev = st.ev || (st.ev = []);
      while (ev.length && ev[ev.length - 1] >= i) ev.pop();
      if (truthy(cond)) ev.push(i);
      return ev;
    }
    function sinceExtreme(isMax) {
      return {
        min: 2, max: 3,
        fn: function (i, v, a, raw, st) {
          const three = a.length === 3;
          const nth = three ? Math.max(1, Math.round(v[0])) : 1;
          const cond = three ? v[1] : v[0];
          const dataNode = three ? a[2] : a[1];
          const ev = events(st, i, cond);
          const start = ev[ev.length - nth];
          if (start === undefined) return NaN;
          let r = NaN;
          for (let j = start; j <= i; j++) {
            const x = dataNode.get(i, i - j);
            if (x === x && (r !== r || (isMax ? x > r : x < r))) r = x;
          }
          return r;
        },
      };
    }
    def('highestsince', sinceExtreme(true));
    def('lowestsince', sinceExtreme(false));
    def('valuewhen', {
      min: 3, max: 3,
      fn: function (i, v, a, raw, st) {
        const nth = Math.max(1, Math.round(v[0]));
        const ev = events(st, i, v[1]);
        const j = ev[ev.length - nth];
        return j === undefined ? NaN : a[2].get(i, i - j);
      },
    });
    def('truerange,tr', {
      min: 0, max: 0,
      fn: function (i, v, a, raw, st, ctx) {
        const h = ctx.h[i], l = ctx.l[i], c1 = i > 0 ? ctx.c[i - 1] : NaN;
        return c1 !== c1 ? h - l : Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1));
      },
    });
    def('dayopen,당일시가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.dO[i]; } });
    def('dayhigh,당일고가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.dH[i]; } });
    def('daylow,당일저가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.dL[i]; } });
    def('predayopen,전일시가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.pO[i]; } });
    def('predayhigh,전일고가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.pH[i]; } });
    def('predaylow,전일저가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.pL[i]; } });
    def('predayclose,전일종가', { min: 0, max: 0, fn: function (i, v, a, r, s, ctx) { return ctx.pC[i]; } });
    // 파라볼릭 SAR (봉별 상태를 배열로 보관해 마지막 봉 재계산 가능)
    def('sar,파라볼릭', {
      min: 0, max: 2,
      fn: function (i, v, a, raw, st, ctx) {
        const step = v.length > 0 ? v[0] : 0.02, maxAf = v.length > 1 ? v[1] : 0.2;
        const T = st.trend || (st.trend = []), E = st.ep || (st.ep = []), F = st.af || (st.af = []);
        const h = ctx.h[i], l = ctx.l[i];
        if (i === 0) { T[0] = 1; E[0] = h; F[0] = step; return l; }
        const pT = T[i - 1], pE = E[i - 1], pF = F[i - 1], pS = val(raw[i - 1]);
        if (pT === undefined || pS !== pS) { T[i] = ctx.c[i] >= ctx.c[i - 1] ? 1 : -1; E[i] = T[i] > 0 ? h : l; F[i] = step; return T[i] > 0 ? Math.min(l, ctx.l[i - 1]) : Math.max(h, ctx.h[i - 1]); }
        let sar = pS + pF * (pE - pS), tr = pT, ep = pE, af = pF;
        if (tr > 0) {
          sar = Math.min(sar, ctx.l[i - 1], i > 1 ? ctx.l[i - 2] : ctx.l[i - 1]);
          if (l < sar) { tr = -1; sar = ep; ep = l; af = step; }
          else if (h > ep) { ep = h; af = Math.min(af + step, maxAf); }
        } else {
          sar = Math.max(sar, ctx.h[i - 1], i > 1 ? ctx.h[i - 2] : ctx.h[i - 1]);
          if (h > sar) { tr = 1; sar = ep; ep = h; af = step; }
          else if (l < ep) { ep = l; af = Math.min(af + step, maxAf); }
        }
        T[i] = tr; E[i] = ep; F[i] = af;
        return sar;
      },
    });

    // 데이터 변수
    const DATA = {};
    [['c,close,종가', 'c'], ['o,open,시가', 'o'], ['h,high,고가', 'h'], ['l,low,저가', 'l'],
      ['v,volume,거래량', 'v'], ['date,일자', 'date'], ['time,시간', 'time']].forEach(function (x) {
      x[0].split(',').forEach(function (n) { DATA[n] = x[1]; });
    });
    const SPECIAL_DATA = { account: 'account', 거래대금: 'account', oi: 'oi', 미결제약정: 'oi', barindex: 'index', 봉번호: 'index' };

    // ---------------------------------------------------------------------------
    // 6. 수식으로 정의한 내장 지표 함수 (이름/인자 수로 구분)
    // ---------------------------------------------------------------------------
    const LIB_SRC = [
      ['RSI', 'N', 'RSI(C, N)'],
      ['RSI', 'A,N', 'U = max(A - A(1), 0); D = max(A(1) - A, 0); RU = rma(U, N); RD = rma(D, N); if(RU + RD == 0, 50, 100 * RU / (RU + RD))'],
      ['MACD', '', 'MACD(12, 26)'],
      ['MACD', 'S,L', 'eavg(C, S) - eavg(C, L)'],
      ['MACDSignal', 'S,L,G', 'eavg(MACD(S, L), G)'],
      ['MACDOsc', 'S,L,G', 'M = MACD(S, L); M - eavg(M, G)'],
      ['StochasticsFast', 'N', 'HH = highest(H, N); LL = lowest(L, N); if(HH == LL, 50, (C - LL) / (HH - LL) * 100)'],
      ['StochasticsK', 'N,K', 'avg(StochasticsFast(N), K)'],
      ['StochasticsD', 'N,K,D', 'avg(StochasticsK(N, K), D)'],
      ['CCI', 'N', 'M = (H + L + C) / 3; MD = meandev(M, N); if(MD == 0, 0, (M - avg(M, N)) / (0.015 * MD))'],
      ['ATR', 'N', 'rma(TrueRange(), N)'],
      ['DiPlus', 'N', 'UP = H - H(1); DN = L(1) - L; PDM = if(UP > DN and UP > 0, UP, 0); TRA = rma(TrueRange(), N); if(TRA == 0, 0, 100 * rma(PDM, N) / TRA)'],
      ['DiMinus', 'N', 'UP = H - H(1); DN = L(1) - L; MDM = if(DN > UP and DN > 0, DN, 0); TRA = rma(TrueRange(), N); if(TRA == 0, 0, 100 * rma(MDM, N) / TRA)'],
      ['ADX', 'N', 'P = DiPlus(N); M = DiMinus(N); DX = if(P + M == 0, 0, abs(P - M) / (P + M) * 100); rma(DX, N)'],
      ['OBV', '', 'sum(if(C > C(1), V, if(C < C(1), -V, 0)))'],
      ['MFI', 'N', 'TP = (H + L + C) / 3; MF = TP * V; PF = sum(if(TP > TP(1), MF, 0), N); NF = sum(if(TP < TP(1), MF, 0), N); if(NF == 0, 100, 100 - 100 / (1 + PF / NF))'],
      ['Momentum', 'N', 'C / C(N) * 100'],
      ['ROC', 'N', '(C - C(N)) / C(N) * 100'],
      ['ROC', 'A,N', '(A - A(N)) / A(N) * 100'],
      ['Disparity', 'N', 'C / avg(C, N) * 100'],
      ['이격도', 'N', 'C / avg(C, N) * 100'],
      ['WilliamsR', 'N', 'HH = highest(H, N); LL = lowest(L, N); if(HH == LL, 0, (HH - C) / (HH - LL) * -100)'],
      ['BBandsUp', 'N,D', 'avg(C, N) + D * stdev(C, N)'],
      ['BBandsDown', 'N,D', 'avg(C, N) - D * stdev(C, N)'],
      ['BBandsWidth', 'N,D', '(BBandsUp(N, D) - BBandsDown(N, D)) / avg(C, N) * 100'],
      ['BBandsB', 'N,D', 'U = BBandsUp(N, D); W = BBandsDown(N, D); if(U == W, 50, (C - W) / (U - W) * 100)'],
      ['EnvelopeUp', 'N,P', 'avg(C, N) * (1 + P / 100)'],
      ['EnvelopeDown', 'N,P', 'avg(C, N) * (1 - P / 100)'],
      ['TRIX', 'N', 'E = eavg(eavg(eavg(C, N), N), N); (E - E(1)) / E(1) * 100'],
      ['VR', 'N', 'U = sum(if(C > C(1), V, 0), N); D = sum(if(C < C(1), V, 0), N); E = sum(if(C == C(1), V, 0), N); if(D + E / 2 == 0, 0, (U + E / 2) / (D + E / 2) * 100)'],
      ['Psychological', 'N', 'sum(if(C > C(1), 1, 0), N) / N * 100'],
      ['심리도', 'N', 'Psychological(N)'],
      ['전환선', 'N', '(highest(H, N) + lowest(L, N)) / 2'],
      ['기준선', 'N', '(highest(H, N) + lowest(L, N)) / 2'],
      ['선행스팬1', 'A,B,P', 'shift((전환선(A) + 기준선(B)) / 2, P - 1)'],
      ['선행스팬2', 'N,P', 'shift((highest(H, N) + lowest(L, N)) / 2, P - 1)'],
      ['SuperTrendDir', 'N,M', 'MID = (H + L) / 2; AT = ATR(N); UB = MID - M * AT; DB = MID + M * AT; ' +
        'UPL = if(C(1) > UPL(1), max(UB, UPL(1)), UB); DNL = if(C(1) < DNL(1), min(DB, DNL(1)), DB); ' +
        'TP = nz(T(1), 1); T = if(TP == -1 and C > DNL(1), 1, if(TP == 1 and C < UPL(1), -1, TP)); if(isnan(AT), NaN_, T)'],
      ['SuperTrend', 'N,M', 'MID = (H + L) / 2; AT = ATR(N); UB = MID - M * AT; DB = MID + M * AT; ' +
        'UPL = if(C(1) > UPL(1), max(UB, UPL(1)), UB); DNL = if(C(1) < DNL(1), min(DB, DNL(1)), DB); ' +
        'TP = nz(T(1), 1); T = if(TP == -1 and C > DNL(1), 1, if(TP == 1 and C < UPL(1), -1, TP)); if(T == 1, UPL, DNL)'],
      ['양봉', '', 'C > O'],
      ['음봉', '', 'C < O'],
      ['StochRSI', 'N,K', 'R = RSI(N); HH = highest(R, N); LL = lowest(R, N); avg(if(HH == LL, 50, (R - LL) / (HH - LL) * 100), K)'],
      ['CMO', 'N', 'U = sum(max(C - C(1), 0), N); D = sum(max(C(1) - C, 0), N); if(U + D == 0, 0, 100 * (U - D) / (U + D))'],
      ['UltimateOsc', 'A,B,D', 'BP = C - min(L, C(1)); TRA = max(H, C(1)) - min(L, C(1)); ' +
        'X1 = sum(BP, A) / sum(TRA, A); X2 = sum(BP, B) / sum(TRA, B); X3 = sum(BP, D) / sum(TRA, D); 100 * (4 * X1 + 2 * X2 + X3) / 7'],
      ['AroonUp', 'N', '(N - highestbars(H, N + 1)) / N * 100'],
      ['AroonDown', 'N', '(N - lowestbars(L, N + 1)) / N * 100'],
      ['AroonOsc', 'N', 'AroonUp(N) - AroonDown(N)'],
      ['DPO', 'N', 'C - avg(C, N, floor(N / 2) + 1)'],
      ['ForceIndex', 'N', 'eavg((C - C(1)) * V, N)'],
      ['EOM', 'N', 'avg(((H + L) / 2 - (H(1) + L(1)) / 2) * (H - L) / V * 10000, N)'],
      ['ElderBull', 'N', 'H - eavg(C, N)'],
      ['ElderBear', 'N', 'L - eavg(C, N)'],
      ['AD', '', 'sum(if(H == L, 0, ((C - L) - (H - C)) / (H - L) * V))'],
      ['ChaikinOsc', 'F,S', 'X = AD(); eavg(X, F) - eavg(X, S)'],
      ['KeltnerUp', 'N,M', 'eavg(C, N) + M * ATR(N)'],
      ['KeltnerDown', 'N,M', 'eavg(C, N) - M * ATR(N)'],
      ['DonchianUp', 'N', 'highest(H, N)'],
      ['DonchianDown', 'N', 'lowest(L, N)'],
      ['BBandsMid', 'N', 'avg(C, N)'],
      ['Pivot', '', '(PredayHigh() + PredayLow() + PredayClose()) / 3'],
      ['PivotR1', '', '2 * Pivot() - PredayLow()'],
      ['PivotS1', '', '2 * Pivot() - PredayHigh()'],
      ['PivotR2', '', 'Pivot() + PredayHigh() - PredayLow()'],
      ['PivotS2', '', 'Pivot() - (PredayHigh() - PredayLow())'],
      ['VolumeOsc', 'F,S', 'B = avg(V, S); if(B == 0, 0, (avg(V, F) - B) / B * 100)'],
    ];

    // ---------------------------------------------------------------------------
    // 7. 컴파일러: AST → 노드 그래프
    // ---------------------------------------------------------------------------
    function key(name) { return String(name).toLowerCase(); }

    function buildFuncTable(userFuncs) {
      const table = {}; // key(name) → { arity → {params, stmts, src, user} }
      function add(name, params, src, user) {
        const k = key(name);
        const ps = params ? params.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        (table[k] || (table[k] = {}))[ps.length] = { name: name, params: ps, src: src, stmts: null, user: !!user };
      }
      LIB_SRC.forEach(function (d) { add(d[0], d[1], d[2], false); });
      (userFuncs || []).forEach(function (f) {
        if (!f || !f.name || !f.body) return;
        add(f.name, Array.isArray(f.params) ? f.params.join(',') : (f.params || ''), f.body, true);
      });
      return table;
    }

    // NaN_ 같은 상수
    const CONSTS = { nan_: NaN, nan: NaN, na: NaN, pi: Math.PI };

    function compile(src, opts) {
      opts = opts || {};
      const ctx = opts.ctx || makeCtx();
      const funcs = opts.funcTable || buildFuncTable(opts.userFuncs);
      const vars = {};
      Object.keys(opts.vars || {}).forEach(function (k) { vars[key(k)] = +opts.vars[k]; });
      let depth = 0;
      const usedVars = new Set();

      const dataNodes = {};
      function dataNode(name) {
        if (dataNodes[name]) return dataNodes[name];
        let n;
        if (name === 'account') {
          n = { ev: function (i) { return ctx.c[i] * ctx.v[i]; }, get: function (i, k) { const j = i - (k || 0); return j >= 0 ? ctx.c[j] * ctx.v[j] : NaN; } };
        } else if (name === 'oi') {
          n = constNode(NaN);
        } else if (name === 'index') {
          n = { ev: function (i) { return i; }, get: function (i, k) { return i - (k || 0); } };
        } else n = arrNode(ctx[name]);
        return (dataNodes[name] = n);
      }

      // scope: key → { node } | { self: holder }
      function compileBlock(stmts, outer) {
        const order = [];
        let result = null;
        // 뒤에서 정의되는 변수도 T(1)처럼 과거 값으로는 먼저 쓸 수 있게 미리 자리를 만든다
        const scope = Object.create(outer);
        const fwd = {};
        for (const s of stmts) {
          if (s.k !== 'assign') continue;
          const k = key(s.name);
          if (!fwd[k]) { fwd[k] = { target: null, name: s.name }; if (!(k in outer)) scope[k] = { self: fwd[k] }; }
        }
        for (const s of stmts) {
          if (s.k === 'assign') {
            const k = key(s.name);
            if (DATA[k] || SPECIAL_DATA[k]) throw new FormulaError("'" + s.name + "'은(는) 가격 데이터 이름이라 변수로 쓸 수 없습니다", s.line, { code: 'datavar', pos: s.s, stmtEnd: s.e, name: s.name });
            const holder = fwd[k];
            const inner = Object.create(scope);
            const before = lookup(scope, s.name);
            inner[k] = { self: holder, prev: before && before.node ? before : undefined };
            const node = materialize(compileExpr(s.expr, inner));
            holder.target = node;
            scope[k] = { node: node };
            order.push(node);
            result = node;
          } else {
            const node = materialize(compileExpr(s.expr, scope));
            order.push(node);
            result = node;
          }
        }
        return { order: order, result: result };
      }
      // 상수·참조 노드는 버퍼가 없으므로 결과 노드로 쓸 때 버퍼를 붙인다
      function materialize(n) {
        if (n.buf) return n;
        return exprNode(function (i) { return n.ev(i); });
      }

      function lookup(scope, name) { const k = key(name); return k in scope ? scope[k] : undefined; }

      function compileExpr(e, scope) {
        switch (e.k) {
          case 'num': return constNode(e.v);
          case 'str': return constNode(NaN);
          case 'id': return compileId(e, scope, null);
          case 'un': {
            const a = compileExpr(e.a, scope);
            if (e.op === '-') return exprNode(function (i) { return -a.ev(i); });
            return exprNode(function (i) { return truthy(a.ev(i)) ? 0 : 1; });
          }
          case 'bin': {
            const a = compileExpr(e.a, scope), b = compileExpr(e.b, scope);
            const f = BIN[e.op];
            return exprNode(function (i) { return f(a.ev(i), b.ev(i)); });
          }
          case 'call': return compileCall(e, scope);
        }
        throw new FormulaError('알 수 없는 식', e.line);
      }

      function compileId(e, scope, lagNode) {
        const k = key(e.name);
        let b = lookup(scope, e.name);
        let base = null;
        // A = A * 2 처럼 앞에서 정의한 같은 이름을 현재 값으로 쓰면 이전 정의를 가리킨다
        while (b && b.self && b.prev && (!lagNode || (lagNode.isConst && lagNode.value < 1))) b = b.prev;
        if (b) {
          if (b.self) {
            // 자기 자신 참조: 과거 값만 가능
            if (!lagNode || (lagNode.isConst && lagNode.value < 1)) throw new FormulaError("변수 '" + e.name + "'은(는) 정의되기 전이나 자기 식 안에서는 " + e.name + '(1)처럼 과거 값으로만 쓸 수 있습니다', e.line, { code: 'selfref', pos: e.s, end: e.e, name: e.name });
            const holder = b.self;
            return exprNode(function (i) { const k2 = Math.round(lagNode.ev(i)); return k2 >= 1 ? holder.target.get(i, k2) : NaN; });
          }
          base = b.node;
        } else if (DATA[k]) base = dataNode(DATA[k]);
        else if (SPECIAL_DATA[k]) base = dataNode(SPECIAL_DATA[k]);
        else if (k in vars) { usedVars.add(k); base = constNode(vars[k]); }
        else if (k in CONSTS) base = constNode(CONSTS[k]);
        else if (!lagNode && (B[k] || funcs[k])) {
          // 인자 없는 함수를 괄호 없이 쓴 경우 (예: DayOpen, OBV)
          return compileCall({ k: 'call', name: e.name, args: [], line: e.line }, scope);
        } else throw new FormulaError("알 수 없는 이름: '" + e.name + "' (지표변수라면 변수 목록에 추가하세요)", e.line, { code: 'unkname', pos: e.s, end: e.s + e.name.length, name: e.name, lagged: !!lagNode });
        if (!lagNode) return refNode(base);
        if (lagNode.isConst) {
          const kk = Math.round(lagNode.value);
          return { ev: function (i) { return base.get(i, kk); }, get: function (i, k2) { return base.get(i, kk + (k2 || 0)); } };
        }
        return exprNode(function (i) { const kk = Math.round(lagNode.ev(i)); return kk >= 0 ? base.get(i, kk) : NaN; });
      }

      function compileCall(e, scope) {
        const k = key(e.name);
        // 과거값 참조: C(1), A(2) — 변수/데이터 이름 뒤 괄호 하나
        const b = lookup(scope, e.name);
        if (b || DATA[k] || SPECIAL_DATA[k] || (k in vars)) {
          if (e.args.length !== 1) throw new FormulaError("'" + e.name + "(N)'은 N봉 전 값입니다. 괄호 안에 숫자 하나만 넣으세요", e.line, { code: 'lagargs', pos: e.s, end: e.e, name: e.name, call: e });
          const lag = compileExpr(e.args[0], scope);
          return compileId({ k: 'id', name: e.name, line: e.line, s: e.s, e: e.e }, scope, lag);
        }
        const uf = funcs[k];
        if (uf && uf[e.args.length] && (uf[e.args.length].user || !B[k] || !arityOk(B[k], e.args.length))) {
          return inlineFunc(uf[e.args.length], e, scope);
        }
        const spec = B[k];
        if (spec) {
          if (!arityOk(spec, e.args.length)) throw new FormulaError(e.name + ' 함수의 인자 수가 맞지 않습니다 (' + (spec.min === spec.max ? spec.min : spec.min + '~' + spec.max) + '개 필요)', e.line, { code: 'arity', pos: e.s, end: e.e, name: e.name, call: e, min: spec.min, max: spec.max, alts: uf ? Object.keys(uf).map(Number) : [] });
          const args = e.args.map(function (ae, idx) {
            if (spec.raw && spec.raw.indexOf(idx) >= 0) {
              const name = ae.k === 'id' || ae.k === 'str' ? (ae.name || ae.v) : (ae.k === 'num' ? String(ae.v) : null);
              const t = name !== null ? MA_TYPES[key(name)] : undefined;
              if (t === undefined) throw new FormulaError('이평 종류는 단순/지수/가중/윌더 중 하나여야 합니다', ae.line, { code: 'matype', pos: ae.s, end: ae.e, word: name });
              return constNode(t);
            }
            return compileExpr(ae, scope);
          });
          return builtinNode(spec, args);
        }
        if (uf) {
          const ar = Object.keys(uf).join(' 또는 ');
          throw new FormulaError(e.name + ' 함수의 인자 수가 맞지 않습니다 (' + ar + '개 필요)', e.line, { code: 'arity', pos: e.s, end: e.e, name: e.name, call: e, alts: Object.keys(uf).map(Number) });
        }
        throw new FormulaError("알 수 없는 함수: '" + e.name + "'", e.line, { code: 'unkfunc', pos: e.s, end: e.nameEnd, name: e.name, call: e });
      }
      function arityOk(spec, n) { return n >= spec.min && n <= spec.max; }

      function builtinNode(spec, args) {
        const raw = [], st = {}, v = new Array(args.length);
        const hasShift = spec.shift !== undefined && args.length > spec.shift;
        const fargs = hasShift ? args.slice(0, spec.shift) : args;
        const fv = hasShift ? new Array(spec.shift) : v;
        const buf = [];
        const node = {
          buf: buf,
          ev: function (i) {
            for (let j = 0; j < args.length; j++) v[j] = args[j].ev(i);
            if (hasShift) for (let j = 0; j < fv.length; j++) fv[j] = v[j];
            const r = spec.fn(i, fv, fargs, raw, st, ctx);
            raw[i] = r;
            let out = r;
            if (hasShift) { const m = Math.round(v[spec.shift]); out = m > 0 ? (i - m >= 0 ? val(raw[i - m]) : NaN) : r; }
            buf[i] = out;
            return out;
          },
          get: function (i, k) { const j = i - (k || 0); return j >= 0 ? val(buf[j]) : NaN; },
        };
        return node;
      }

      function inlineFunc(fd, e, scope) {
        if (++depth > 30) throw new FormulaError('함수 호출이 너무 깊습니다 (재귀 호출 확인): ' + e.name, e.line, { code: 'inner', pos: e.s });
        try {
          if (!fd.stmts) {
            try { fd.stmts = parse(fd.src); } catch (err) { throw new FormulaError('함수 ' + fd.name + ' 수식 오류: ' + err.message, e.line, { code: 'inner', pos: e.s, func: fd.name, user: fd.user }); }
          }
          const args = e.args.map(function (ae) { return materialize(compileExpr(ae, scope)); });
          // 함수 본문은 호출한 쪽 변수를 보지 못하고, 인자와 지표변수만 본다
          const inner = Object.create(null);
          fd.params.forEach(function (pn, idx) { inner[key(pn)] = { node: args[idx] }; });
          let block;
          try { block = compileBlock(fd.stmts, inner); } catch (err) {
            // 함수 본문 안의 위치는 지금 수식의 위치가 아니므로 자동수정 정보는 바꿔 둔다
            if (fd.user) throw new FormulaError('사용자함수 ' + fd.name + ': ' + err.message, e.line, { code: 'inner', pos: e.s, func: fd.name, user: true });
            throw new FormulaError(err.message, e.line, { code: 'inner', pos: e.s, func: fd.name });
          }
          const order = block.order, result = block.result;
          const buf = [];
          return {
            buf: buf,
            ev: function (i) {
              for (let j = 0; j < args.length; j++) args[j].ev(i);
              for (let j = 0; j < order.length; j++) order[j].ev(i);
              const r = result.get(i, 0);
              buf[i] = r;
              return r;
            },
            get: function (i, k) { const j = i - (k || 0); return j >= 0 ? val(buf[j]) : NaN; },
          };
        } finally { depth--; }
      }

      const stmts = typeof src === 'string' ? parse(src) : src;
      const scope = Object.create(null);
      const block = compileBlock(stmts, scope);
      const order = block.order, result = block.result;
      return {
        ctx: ctx,
        usedVars: Array.from(usedVars),
        run: function (i) {
          for (let j = 0; j < order.length; j++) order[j].ev(i);
          return result.get(i, 0);
        },
        value: function (i, k) { return result.get(i, k || 0); },
      };
    }

    const BIN = {
      '+': function (a, b) { return a + b; },
      '-': function (a, b) { return a - b; },
      '*': function (a, b) { return a * b; },
      '/': function (a, b) { return b === 0 ? NaN : a / b; },
      '%': function (a, b) { return b === 0 ? NaN : a % b; },
      '^': function (a, b) { return Math.pow(a, b); },
      '==': function (a, b) { return a === b ? 1 : 0; },
      '!=': function (a, b) { return a !== a || b !== b ? 0 : (a !== b ? 1 : 0); },
      '<': function (a, b) { return a < b ? 1 : 0; },
      '<=': function (a, b) { return a <= b ? 1 : 0; },
      '>': function (a, b) { return a > b ? 1 : 0; },
      '>=': function (a, b) { return a >= b ? 1 : 0; },
      '&&': function (a, b) { return truthy(a) && truthy(b) ? 1 : 0; },
      '||': function (a, b) { return truthy(a) || truthy(b) ? 1 : 0; },
    };

    // ---------------------------------------------------------------------------
    // 8. 지표변수 문자열 "단기=5, 장기=20" ↔ 객체
    // ---------------------------------------------------------------------------
    function parseVars(s) {
      const out = {};
      if (!s) return out;
      if (typeof s === 'object') { Object.keys(s).forEach(function (k) { out[k] = +s[k]; }); return out; }
      String(s).split(/[,;\n]/).forEach(function (part) {
        const m = part.split('=');
        if (m.length !== 2) return;
        const k = m[0].trim(), v = parseFloat(m[1]);
        if (k && !isNaN(v)) out[k] = v;
      });
      return out;
    }
    function varsToString(o) { return Object.keys(o || {}).map(function (k) { return k + '=' + o[k]; }).join(', '); }

    // ---------------------------------------------------------------------------
    // 9. 조건 조합식: "A and (B or !C)"
    // ---------------------------------------------------------------------------
    function compileLogic(src, letters) {
      const stmts = parse(src);
      if (stmts.length !== 1 || stmts[0].k !== 'expr') throw new FormulaError('조합식은 식 하나여야 합니다 (예: A and B)');
      const allowed = new Set(letters.map(key));
      function walk(e) {
        if (e.k === 'id') {
          if (!allowed.has(key(e.name))) throw new FormulaError("조합식에 없는 조건: '" + e.name + "'");
          const k = key(e.name);
          return function (m) { return !!m[k]; };
        }
        if (e.k === 'num') return function () { return truthy(e.v); };
        if (e.k === 'un' && e.op === '!') { const a = walk(e.a); return function (m) { return !a(m); }; }
        if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
          const a = walk(e.a), b = walk(e.b);
          return e.op === '&&' ? function (m) { return a(m) && b(m); } : function (m) { return a(m) || b(m); };
        }
        throw new FormulaError('조합식에는 조건 이름과 and, or, !, 괄호만 쓸 수 있습니다');
      }
      const f = walk(stmts[0].expr);
      return function (map) {
        const m = {};
        Object.keys(map).forEach(function (k) { m[key(k)] = map[k]; });
        return f(m);
      };
    }

    // ---------------------------------------------------------------------------
    // 10. 배열 봉 데이터에 여러 수식을 한 번에 계산 (조건검색, 수식검증용)
    // ---------------------------------------------------------------------------
    function runOnBars(bars, sources, opts) {
      opts = opts || {};
      const ctx = makeCtx(opts);
      const table = buildFuncTable(opts.userFuncs);
      const progs = sources.map(function (s) { return compile(s, { ctx: ctx, funcTable: table, vars: opts.vars }); });
      const out = progs.map(function () { return new Array(bars.length); });
      for (let i = 0; i < bars.length; i++) {
        ctx.set(i, bars[i]);
        for (let j = 0; j < progs.length; j++) out[j][i] = progs[j].run(i);
      }
      return out;
    }

    // ---------------------------------------------------------------------------
    // 11. 자동수정
    //   1) 전각 기호, 다른 프로그램 문법(트레이딩뷰 ta.xxx, close[1], a ? b : c 등)을 먼저 바꾸고
    //   2) 컴파일 오류가 날 때마다 오류 위치를 보고 고칠 후보를 만들어 하나씩 시험한다.
    //      후보를 넣었을 때 오류가 없어지거나 더 뒤로 밀려나야 채택한다.
    //   3) 문법이 맞으면 흔한 실수(RSI(C)처럼 기간 자리에 가격 넣기 등)를 한 번 더 고친다.
    // ---------------------------------------------------------------------------
    const CANON = {};
    ['avg', 'eavg', 'wavg', 'rma', 'ma', 'stdev', 'meandev', 'highest', 'lowest', 'highestbars', 'lowestbars', 'LinReg', 'LinRegSlope', 'sum',
      'max', 'min', 'abs', 'log', 'log10', 'exp', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'round', 'floor', 'ceil', 'nz', 'isnan',
      'if', 'between', 'CrossUp', 'CrossDown', 'shift', 'BarsSince', 'CountSince', 'HighestSince', 'LowestSince', 'ValueWhen', 'TrueRange',
      'DayOpen', 'DayHigh', 'DayLow', 'PredayOpen', 'PredayHigh', 'PredayLow', 'PredayClose', 'SAR'].forEach(function (n) { CANON[n.toLowerCase()] = n; });
    // 첫 인자가 데이터(가격)인 통계 함수와 그 기본값
    const SERIES_FN = { avg: 20, 평균: 20, sma: 20, wavg: 20, 가중평균: 20, wma: 20, eavg: 20, 지수평균: 20, ema: 20, rma: 14, 윌더평균: 14, smma: 14,
      ma: 20, 이평: 20, stdev: 20, 표준편차: 20, meandev: 20, 평균편차: 20, highest: 20, 최고값: 20, lowest: 20, 최저값: 20, highestbars: 20, lowestbars: 20,
      linreg: 20, 선형회귀: 20, linregslope: 20, 회귀기울기: 20, sum: 20, 합계: 20 };
    const SERIES_DEFAULT_DATA = { highest: 'H', 최고값: 'H', highestbars: 'H', lowest: 'L', 최저값: 'L', lowestbars: 'L' };
    // 내장 지표 함수를 인자 없이/모자라게 썼을 때 채울 기본값
    const FN_DEFAULTS = {
      rsi: [14], macd: [12, 26], macdsignal: [12, 26, 9], macdosc: [12, 26, 9], stochasticsfast: [5], stochasticsk: [5, 3], stochasticsd: [5, 3, 3],
      cci: [20], atr: [14], diplus: [14], diminus: [14], adx: [14], mfi: [14], momentum: [10], roc: [12], disparity: [20], 이격도: [20], williamsr: [14],
      bbandsup: [20, 2], bbandsdown: [20, 2], bbandswidth: [20, 2], bbandsb: [20, 2], bbandsmid: [20], envelopeup: [20, 5], envelopedown: [20, 5],
      trix: [12], vr: [20], psychological: [10], 심리도: [10], 전환선: [9], 기준선: [26], 선행스팬1: [9, 26, 26], 선행스팬2: [52, 26],
      supertrend: [10, 3], supertrenddir: [10, 3], stochrsi: [14, 3], cmo: [14], ultimateosc: [7, 14, 28], aroonup: [25], aroondown: [25], aroonosc: [25],
      dpo: [20], forceindex: [13], eom: [14], elderbull: [13], elderbear: [13], chaikinosc: [3, 10], keltnerup: [20, 2], keltnerdown: [20, 2],
      donchianup: [20], donchiandown: [20], volumeosc: [5, 20], sar: [0.02, 0.2],
    };
    // 다른 프로그램(트레이딩뷰·에이미브로커·엑셀 등)에서 쓰는 함수 이름
    const FN_ALIAS = {
      crossover: 'CrossUp', crossunder: 'CrossDown', cross: 'CrossUp', 골든크로스: 'CrossUp', 데드크로스: 'CrossDown', 돌파: 'CrossUp', 상승돌파: 'CrossUp', 하락돌파: 'CrossDown',
      iif: 'if', ifelse: 'if', iff: 'if', average: 'avg', mean: 'avg', 이동평균: 'avg', 단순이평: 'avg', 지수이평: 'eavg', 지수이동평균: 'eavg', 가중이평: 'wavg',
      hhv: 'highest', llv: 'lowest', hhvbars: 'highestbars', llvbars: 'lowestbars', stddev: 'stdev', std: 'stdev', dev: 'meandev',
      stoch: 'StochasticsK', stochastic: 'StochasticsK', stochk: 'StochasticsK', stochd: 'StochasticsD', bbup: 'BBandsUp', bbupper: 'BBandsUp', bbdn: 'BBandsDown',
      bblower: 'BBandsDown', bbdown: 'BBandsDown', bbmid: 'BBandsMid', bbwidth: 'BBandsWidth', macdsig: 'MACDSignal', macdhist: 'MACDOsc', macdhistogram: 'MACDOsc',
      supertrendline: 'SuperTrend', psar: 'SAR', parabolicsar: 'SAR', willr: 'WilliamsR', wpr: 'WilliamsR', mom: 'Momentum', obvline: 'OBV', dmi: 'ADX',
      valuewhen: 'ValueWhen', barssince: 'BarsSince', absolute: 'abs', nan: 'isnan', isna: 'isnan', na: 'isnan', 반올림: 'round',
    };
    // 다른 프로그램에서 쓰는 데이터 이름 → 이 수식 문법
    const ID_ALIAS = {
      hl2: '(H + L) / 2', hlc3: '(H + L + C) / 3', ohlc4: '(O + H + L + C) / 4', hlcc4: '(H + L + C + C) / 4', bar_index: 'BarIndex', barnumber: 'BarIndex',
      price: 'C', 현재가: 'C', 가격: 'C', closeprice: 'C', vol: 'V', 체결량: 'V', 틱거래량: 'V', 저점: 'L', 고점: 'H', openprice: 'O', 시초가: 'O',
    };
    const MA_WORDS = [[/^(s|sma|simple|단|기본|산술|단순이평|단순평균)$/i, '단순'], [/^(e|ema|exp|expo|exponential|지|지수이평|지수평균)$/i, '지수'],
      [/^(w|wma|weight|weighted|가|가중이평|가중평균)$/i, '가중'], [/^(r|rma|smma|wilder|윌|수정|윌더평균)$/i, '윌더']];

    // 받침에 맞춰 을/를
    function eul(w) {
      w = String(w);
      const ch = w.charCodeAt(w.length - 1);
      let bat;
      if (ch >= 0xAC00 && ch <= 0xD7A3) bat = (ch - 0xAC00) % 28 !== 0;
      else bat = /[013678lmn]$/i.test(w);
      return "'" + w + "'" + (bat ? '을' : '를');
    }
    function lev(a, b) {
      if (a === b) return 0;
      const m = a.length, n = b.length;
      if (!m || !n) return m || n;
      let prev = new Array(n + 1), cur = new Array(n + 1);
      for (let j = 0; j <= n; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        const t = prev; prev = cur; cur = t;
      }
      return prev[n];
    }
    // 오타 고치기: 가장 가까운 이름 (너무 짧거나 멀면 null)
    function closest(word, names) {
      const w = word.toLowerCase();
      const L = w.length;
      const hangul = /[가-힣]/.test(w);
      const lim = hangul ? (L <= 3 ? 0 : 1) : L <= 2 ? 0 : L <= 4 ? 1 : L <= 8 ? 2 : 3;
      const strip = function (x) { return x.replace(/[0-9]/g, ''); };
      let best = null, bd = Infinity;
      names.forEach(function (n) {
        // 이평2 → 이평3 처럼 숫자만 다른 이름은 다른 변수로 본다
        if (strip(n.toLowerCase()) === strip(w)) return;
        const d = lev(w, n.toLowerCase());
        if (d < bd || (d === bd && best && Math.abs(n.length - L) < Math.abs(best.length - L))) { bd = d; best = n; }
      });
      return best && bd <= lim && bd > 0 ? best : null;
    }
    function lineOf(src, pos) { let n = 1; for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') n++; return n; }
    function lineText(src, line) { return (src.split('\n')[line - 1] || '').trim(); }
    function splice(src, a, b, txt) { return src.slice(0, a) + txt + src.slice(b); }
    function isValueStart(t) { return t && (t.t === 'num' || t.t === 'id' || t.t === 'str' || (t.t === 'op' && (t.v === '(' || t.v === '!'))); }
    const BIN_OPS = new Set(['||', '&&', '==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '^', '=']);
    function guessVarValue(name) {
      const n = name.toLowerCase();
      if (/단기|short|fast|빠른/.test(n)) return 5;
      if (/중기|mid/.test(n)) return 20;
      if (/장기|long|slow|느린/.test(n)) return 60;
      if (/시그널|signal|sig/.test(n)) return 9;
      if (/과열|과매수|overbought|상한|upper/.test(n)) return 70;
      if (/침체|과매도|oversold|하한|lower/.test(n)) return 30;
      if (/배수|승수|mult|factor|^k$|^d$/.test(n)) return 2;
      return 14;
    }
    // 수식 안에서 대입하는 변수 이름 (구문이 맞을 때만)
    function assignedNames(src) {
      try { return parse(src).filter(function (s) { return s.k === 'assign'; }).map(function (s) { return s.name; }); } catch (e) { return []; }
    }
    function wordsIn(src) {
      const out = new Set();
      try { lex(src).forEach(function (t) { if (t.t === 'id') out.add(t.v.toLowerCase()); }); } catch (e) { /* 무시 */ }
      return out;
    }

    // 1단계: 글자 단위로 확실한 것부터 바꾼다
    function normalizeSrc(src) {
      const notes = [];
      let s = src;
      function sub(re, to, why) {
        const before = s;
        s = s.replace(re, to);
        if (s !== before) notes.push(why);
      }
      sub(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }, '전각(넓은) 영문·숫자를 일반 글자로 바꿨어요');
      const SYM = { '（': '(', '）': ')', '，': ',', '、': ',', '；': ';', '＝': '=', '＜': '<', '＞': '>', '＋': '+', '－': '-', '−': '-', '–': '-', '—': '-',
        '＊': '*', '×': '*', '／': '/', '÷': '/', '≥': '>=', '≤': '<=', '≠': '!=', '“': '"', '”': '"', '‘': "'", '’': "'", '．': '.', '％': '%', '＾': '^', '！': '!', '｜': '|', '＆': '&' };
      sub(/[（），、；＝＜＞＋－−–—＊×／÷≥≤≠“”‘’．％＾！｜＆]/g, function (c) { return SYM[c]; }, '전각·특수 기호(（ ） × ÷ ≥ 등)를 일반 기호로 바꿨어요');
      sub(/=>/g, '>=', "'=>'를 '>='(크거나 같다)로 바꿨어요");
      sub(/=</g, '<=', "'=<'를 '<='(작거나 같다)로 바꿨어요");
      sub(/(^|[^&])&(?!&)/g, '$1&&', "'&'를 '&&'(그리고)로 바꿨어요");
      sub(/(^|[^|])\|(?!\|)/g, '$1||', "'|'를 '||'(또는)로 바꿨어요");
      sub(/(^|[^A-Za-z0-9_가-힣])(ta|math|request|strategy)\.(?=[A-Za-z_])/gi, '$1', "트레이딩뷰식 'ta.' 같은 앞글자를 뺐어요");
      sub(/([A-Za-z_가-힣][A-Za-z0-9_가-힣]*)\s*\[\s*([^\[\]\n]+?)\s*\]/g, '$1($2)', "'close[1]' 같은 과거값 표기를 'close(1)'로 바꿨어요");
      // 조건 ? 참 : 거짓  →  if(조건, 참, 거짓)   (한 문장에 하나만 있을 때)
      const parts = s.split(/(;|\n)/);
      let tern = false;
      for (let i = 0; i < parts.length; i += 2) {
        const m = /^(\s*(?:[A-Za-z_가-힣][A-Za-z0-9_가-힣]*\s*=(?!=)\s*)?)([^?:]+?)\s*\?\s*([^?:]+?)\s*:\s*([^?:]+?)(\s*)$/.exec(parts[i]);
        if (m && !/\/\//.test(parts[i])) { parts[i] = m[1] + 'if(' + m[2].trim() + ', ' + m[3].trim() + ', ' + m[4].trim() + ')' + m[5]; tern = true; }
      }
      if (tern) { s = parts.join(''); notes.push("'조건 ? 참 : 거짓' 문법을 if(조건, 참, 거짓)으로 바꿨어요"); }
      return { src: s, notes: notes };
    }

    // 2단계: 오류 하나에 대한 고칠 후보들
    function fixCandidates(src, err, env) {
      const info = err.info || {};
      const out = [];
      const add = function (s, why, extra) { out.push(Object.assign({ src: s, why: why, pos: info.pos || 0 }, extra || {})); };
      let toks = null;
      try { toks = lex(src); } catch (e) { toks = null; }
      const tokAt = function (pos) { return toks ? toks.findIndex(function (t) { return t.pos === pos; }) : -1; };
      const prevIdx = function (i) { let q = i - 1; while (q >= 0 && toks[q].t === 'nl') q--; return q; };
      const nextIdx = function (i) { let q = i + 1; while (q < toks.length && toks[q].t === 'nl') q++; return q; };
      const txt = function (node) { return src.slice(node.s, node.e); };
      const argList = function (call) { return call.args.map(txt); };

      switch (info.code) {
        case 'char': {
          const ch = info.ch;
          if (ch === '?' || ch === ':') break; // 삼항 연산자: 1단계에서 못 바꾼 복잡한 경우
          if (/[$#@`~\\{}\[\]]/.test(ch) || /[^\x00-\x7F가-힣ㄱ-ㆎ]/.test(ch)) add(splice(src, info.pos, info.pos + 1, ''), "쓸 수 없는 문자 '" + ch + "'를 지웠어요");
          break;
        }
        case 'quote':
          add(splice(src, info.pos, info.pos + 1, ''), '닫히지 않은 따옴표를 지웠어요');
          break;
        case 'expect': {
          if (!toks) break;
          const i = tokAt(info.pos), t = toks[i];
          // 줄이 바뀐 뒤에 막혔으면 앞 줄 끝에 ')'가 빠진 것으로 본다
          const newLine = src.slice(info.after, info.pos).indexOf(String.fromCharCode(10)) >= 0;
          const closeIt = function () { add(splice(src, info.after, info.after, ')'), "닫는 괄호 ')'가 모자라서 넣었어요", { pos: info.after }); };
          if (newLine) closeIt();
          if (info.ctx === 'call' && isValueStart(t) && !newLine) add(splice(src, info.after, info.after, ','), '함수 인자 사이에 빠진 쉼표(,)를 넣었어요', { pos: info.after });
          if (!newLine && !isValueStart(t) && !(t && t.t === 'op' && t.v === ',' && info.ctx === 'group')) closeIt();
          break;
        }
        case 'sep': {
          if (!toks) break;
          const i = tokAt(info.pos), t = toks[i], pi = prevIdx(i), pt = pi >= 0 ? toks[pi] : null;
          const nt = toks[nextIdx(i)];
          if (t.t === 'op' && t.v === ')') add(splice(src, t.pos, t.end, ''), "짝이 없는 닫는 괄호 ')'를 지웠어요");
          else if (t.t === 'id' && nt && nt.t === 'op' && nt.v === '=' && pt) add(splice(src, pt.end, pt.end, ';'), "문장 사이에 빠진 ';'를 넣었어요");
          else if (pt && pt.t === 'num' && (t.t === 'id' || (t.t === 'op' && t.v === '('))) add(splice(src, pt.end, t.pos, ' * '), "숫자 뒤에 빠진 곱하기 '*'를 넣었어요");
          else if (t.t === 'str') add(splice(src, t.pos, t.end, ''), '필요 없는 글자(따옴표 문자열)를 지웠어요');
          break;
        }
        case 'value': {
          if (!toks) break;
          const i = tokAt(info.pos), t = toks[i], pi = prevIdx(i), pt = pi >= 0 ? toks[pi] : null;
          const isBin = function (x) { return x && x.t === 'op' && BIN_OPS.has(x.v); };
          if (t.t === 'op' && t.v === ')' && pt && pt.t === 'op' && pt.v === ',') add(splice(src, pt.pos, pt.end, ''), "괄호 앞의 남는 쉼표(,)를 지웠어요");
          else if (t.t === 'op' && t.v === ',' && pt && pt.t === 'op' && (pt.v === ',' || pt.v === '(')) add(splice(src, t.pos, t.end, ''), '두 번 들어간 쉼표(,)를 지웠어요');
          else if (isBin(t) && isBin(pt)) {
            const between = src.slice(pt.end, t.pos);
            const merged = pt.v + t.v;
            // 앞이 대입 '=' 이면 (A = > 3 같은 경우) 뒤 기호만 지운다
            const ppi = prevIdx(pi), assignEq = pt.v === '=' && ppi >= 0 && toks[ppi].t === 'id' && (prevIdx(ppi) < 0 || toks[prevIdx(ppi)].t === 'nl' || (toks[prevIdx(ppi)].t === 'op' && toks[prevIdx(ppi)].v === ';'));
            if (!assignEq && /^\s+$/.test(between) && ['>=', '<=', '!=', '&&', '||'].indexOf(merged) >= 0) add(splice(src, pt.end, t.pos, ''), "띄어 쓴 '" + pt.v + ' ' + t.v + "'를 '" + merged + "'로 붙였어요");
            else add(splice(src, t.pos, t.end, ''), "연산자가 두 번 들어가서 '" + src.slice(t.pos, t.end) + "'를 지웠어요");
          } else if ((t.t === 'eof' || t.t === 'nl' || (t.t === 'op' && (t.v === ';' || t.v === ')'))) && pt && (isBin(pt) || (pt.t === 'op' && pt.v === ','))) {
            const ppi = prevIdx(pi);
            const danglingAssign = pt.v === '=' && ppi >= 0 && toks[ppi].t === 'id';
            if (!danglingAssign) add(splice(src, pt.pos, pt.end, ''), "식 끝에 남은 '" + src.slice(pt.pos, pt.end) + "'를 지웠어요");
          } else if (isBin(t) && (!pt || (pt.t === 'op' && (pt.v === '(' || pt.v === ',' || pt.v === ';')) || pt.t === 'nl')) add(splice(src, t.pos, t.end, ''), "앞에 값이 없는 '" + src.slice(t.pos, t.end) + "'를 지웠어요");
          break;
        }
        case 'datavar': {
          if (!toks) break;
          const used = wordsIn(src);
          let nn = /[가-힣]/.test(info.name) ? info.name + '값' : info.name + '1', k = 2;
          while (used.has(nn.toLowerCase()) || DATA[nn.toLowerCase()] || B[nn.toLowerCase()] || env.known.has(nn.toLowerCase())) nn = (/[가-힣]/.test(info.name) ? info.name + '값' : info.name) + (k++);
          const kk = info.name.toLowerCase();
          let s2 = src;
          toks.filter(function (t) { return t.t === 'id' && t.v.toLowerCase() === kk && (t.pos === info.pos || t.pos >= info.stmtEnd); })
            .sort(function (a, b) { return b.pos - a.pos; })
            .forEach(function (t) { s2 = splice(s2, t.pos, t.end, nn); });
          add(s2, "'" + info.name + "'은(는) 가격 데이터 이름이라 변수 이름을 '" + nn + "'(으)로 바꿨어요");
          break;
        }
        case 'selfref': {
          let stmts = null;
          try { stmts = parse(src); } catch (e) { break; }
          const ui = stmts.findIndex(function (s) { return info.pos >= s.s && info.pos < s.e; });
          const use = stmts[ui];
          const k = info.name.toLowerCase();
          const di = stmts.findIndex(function (s, j) { return j > ui && s.k === 'assign' && s.name.toLowerCase() === k; });
          if (use && use.k === 'assign' && use.name.toLowerCase() === k) {
            add(splice(src, info.pos, info.end, info.name + '(1)'), "자기 자신을 쓰는 '" + info.name + "'를 1봉 전 값 '" + info.name + "(1)'로 바꿨어요");
          } else if (use && di > ui) {
            const d = stmts[di];
            let a = d.s, b = d.e;
            while (b < src.length && /[ \t]/.test(src[b])) b++;
            if (src[b] === ';') b++;
            while (b < src.length && /[ \t]/.test(src[b])) b++;
            if (src[b] === '\n') b++;
            const defText = src.slice(d.s, d.e).trim();
            let s2 = splice(src, a, b, '');
            s2 = splice(s2, use.s, use.s, defText + ';\n');
            add(s2, eul(info.name) + " 쓰기 전에 정의하도록 '" + info.name + " = …' 문장을 앞으로 옮겼어요");
            add(splice(src, info.pos, info.end, info.name + '(1)'), eul(info.name) + " 1봉 전 값 '" + info.name + "(1)'로 바꿨어요");
          } else add(splice(src, info.pos, info.end, info.name + '(1)'), eul(info.name) + " 1봉 전 값 '" + info.name + "(1)'로 바꿨어요");
          break;
        }
        case 'lagargs': {
          const c = info.call, as = argList(c);
          if (!as.length) add(splice(src, info.pos, info.end, info.name), "'" + info.name + "()'의 빈 괄호를 지웠어요");
          else add(splice(src, info.pos, info.end, info.name + '(' + as[0] + ')'), "'" + info.name + "(N)'은 N봉 전 값이라 괄호 안에 첫 값만 남겼어요");
          break;
        }
        case 'matype': {
          const w = String(info.word === null || info.word === undefined ? src.slice(info.pos, info.end) : info.word).trim();
          let to = '단순';
          MA_WORDS.forEach(function (m) { if (m[0].test(w)) to = m[1]; });
          add(splice(src, info.pos, info.end, to), "이평 종류 '" + src.slice(info.pos, info.end) + "'를 '" + to + "'(으)로 바꿨어요");
          break;
        }
        case 'arity': {
          const c = info.call, k = c.name.toLowerCase(), as = argList(c), n = as.length;
          const allowed = new Set(info.alts || []);
          if (info.min !== undefined) for (let j = info.min; j <= Math.min(info.max, 12); j++) allowed.add(j);
          const list = Array.from(allowed).sort(function (a, b) { return a - b; });
          const rebuild = function (args) { return splice(src, c.s, c.e, c.name + '(' + args.join(', ') + ')'); };
          if ((k === 'truerange' || k === 'tr') && n === 1) { add(splice(src, c.s, c.e, 'ATR(' + as[0] + ')'), "TrueRange는 인자가 없어요. 기간을 넣으려면 ATR이라 ATR(" + as[0] + ")로 바꿨어요"); break; }
          const bigger = list.filter(function (x) { return x > n; });
          const smaller = list.filter(function (x) { return x < n; });
          if (!bigger.length || (smaller.length && n > list[list.length - 1])) {
            const kk = smaller[smaller.length - 1];
            add(rebuild(as.slice(0, kk)), c.name + ' 함수는 인자가 ' + kk + '개라 남는 인자를 뺐어요');
            break;
          }
          const want = bigger[0];
          if (SERIES_FN[k] !== undefined) {
            const dataName = SERIES_DEFAULT_DATA[k] || 'C';
            const firstIsData = n >= 1 && DATA[as[0].toLowerCase()] !== undefined;
            if (n === 0) { add(rebuild([dataName, String(SERIES_FN[k])]), c.name + '에 데이터와 기간이 없어서 ' + dataName + ', ' + SERIES_FN[k] + '를 넣었어요 (값은 바꿔도 돼요)'); break; }
            if (n === 1 && !firstIsData) { add(rebuild([dataName].concat(as)), c.name + '(데이터, 기간) 순서라 앞에 데이터 ' + dataName + '(' + (dataName === 'C' ? '종가' : dataName === 'H' ? '고가' : '저가') + ')를 넣었어요'); break; }
            if (n === 1) { add(rebuild(as.concat([String(SERIES_FN[k])])), c.name + '에 기간이 없어서 ' + SERIES_FN[k] + '를 넣었어요 (값은 바꿔도 돼요)'); break; }
          }
          if ((k === 'crossup' || k === 'crossdown' || k === '상향돌파' || k === '하향돌파') && n === 1) { add(rebuild(as.concat(['0'])), c.name + '은 두 값이 필요해서 기준값 0을 넣었어요 (0선 돌파)'); break; }
          if ((k === 'if' || k === 'iff' || k === '만일' || k === '만약') && n === 2) { add(rebuild(as.concat(['0'])), 'if(조건, 참값, 거짓값)에서 거짓값이 없어서 0을 넣었어요'); break; }
          if ((k === 'shift' || k === '이동') && n === 1) { add(rebuild(as.concat(['1'])), 'shift에 몇 봉 전인지가 없어서 1을 넣었어요'); break; }
          if ((k === 'barssince') && n === 0) break;
          const defs = FN_DEFAULTS[k];
          if (defs && defs.length >= want) {
            const fill = defs.slice(n, want).map(String);
            add(rebuild(as.concat(fill)), c.name + '에 모자란 값을 기본값 ' + fill.join(', ') + '(으)로 채웠어요');
          } else if (env.userFn && env.userFn[k]) {
            const fill = new Array(want - n).fill('14');
            add(rebuild(as.concat(fill)), '사용자함수 ' + c.name + '에 모자란 인자를 임시값 14로 채웠어요 (알맞은 값으로 바꾸세요)');
          }
          break;
        }
        case 'unkfunc': {
          const c = info.call, k = c.name.toLowerCase(), as = argList(c);
          if (k === 'ref' && as.length === 2) { add(splice(src, c.s, c.e, 'shift(' + as[0] + ', ' + as[1].replace(/^\s*-\s*/, '') + ')'), 'Ref(값, -N)을 이 수식의 shift(값, N)로 바꿨어요'); break; }
          if (k === 'change' || k === '변화') { add(splice(src, c.s, c.e, '(' + as[0] + ' - shift(' + as[0] + ', ' + (as[1] || '1') + '))'), 'change(값)을 (값 - N봉 전 값)으로 풀어 썼어요'); break; }
          if ((k === 'rising' || k === 'falling') && as.length >= 1) {
            const nn = as[1] || '1';
            add(splice(src, c.s, c.e, (k === 'rising' ? '(' + as[0] + ' > shift(' + as[0] + ', ' + nn + '))' : '(' + as[0] + ' < shift(' + as[0] + ', ' + nn + '))')), k + '(값, N)을 비교식으로 풀어 썼어요');
            break;
          }
          if ((k === 'stoch' || k === 'stochastic') && as.length === 4) { add(splice(src, c.s, c.e, 'StochasticsFast(' + as[3] + ')'), '트레이딩뷰 stoch(…)를 StochasticsFast(' + as[3] + ')로 바꿨어요'); break; }
          const lexAlias = FN_ALIAS[k];
          if (lexAlias) { add(splice(src, info.pos, info.end, lexAlias), "함수 이름 '" + c.name + "'를 이 수식에서 쓰는 '" + lexAlias + "'(으)로 바꿨어요"); break; }
          const m = closest(c.name, env.funcNames);
          if (m) add(splice(src, info.pos, info.end, m), "함수 이름 오타 '" + c.name + "'를 '" + m + "'(으)로 고쳤어요");
          if (DATA[k] === undefined && env.known.has(k)) break;
          break;
        }
        case 'unkname': {
          const k = info.name.toLowerCase();
          if (!info.lagged && ID_ALIAS[k]) { add(splice(src, info.pos, info.end, ID_ALIAS[k]), eul(info.name) + " 이 수식 문법 '" + ID_ALIAS[k] + "'(으)로 바꿨어요"); break; }
          if (ID_ALIAS[k] && /^[A-Za-z]+$/.test(ID_ALIAS[k])) { add(splice(src, info.pos, info.end, ID_ALIAS[k]), eul(info.name) + " '" + ID_ALIAS[k] + "'(으)로 바꿨어요"); break; }
          // MA20, EMA12, RSI14 처럼 이름에 기간을 붙여 쓴 경우
          const mm = /^([A-Za-z가-힣]+?)_?(\d+)$/.exec(info.name);
          if (mm && !info.lagged) {
            const fk = mm[1].toLowerCase();
            const fnName = FN_ALIAS[fk] || CANON[fk] || (env.funcTable[fk] && Object.values(env.funcTable[fk])[0].name) || (B[fk] ? fk : null);
            if (fnName) {
              const fl = fnName.toLowerCase();
              let rep = null;
              if (SERIES_FN[fl] !== undefined || fk === 'ma' || fk === 'mav') rep = (fk === 'ema' ? 'eavg' : fk === 'wma' ? 'wavg' : fk === 'ma' || fk === 'sma' || fk === 'mav' ? 'avg' : fnName) + '(' + (SERIES_DEFAULT_DATA[fl] || 'C') + ', ' + mm[2] + ')';
              else if (env.funcTable[fl] && env.funcTable[fl][1]) rep = fnName + '(' + mm[2] + ')';
              if (rep) { add(splice(src, info.pos, info.end, rep), eul(info.name) + " " + rep + '(으)로 풀어 썼어요'); break; }
            }
          }
          const m = closest(info.name, env.idNames.concat(assignedNames(src)));
          if (m) add(splice(src, info.pos, info.end, m), "이름 오타 '" + info.name + "'를 '" + m + "'(으)로 고쳤어요");
          if (env.allowNewVars) {
            const v = guessVarValue(info.name);
            add(src, eul(info.name) + " 지표변수로 추가했어요 (임시값 " + v + ', 지표변수 칸에서 바꾸세요)', { newVar: [info.name, v] });
          }
          break;
        }
      }
      return out;
    }

    // 3단계: 문법은 맞지만 결과가 이상해지는 흔한 실수
    function lintFixes(src, env) {
      let stmts;
      try { stmts = parse(src); } catch (e) { return []; }
      const edits = [];
      function walk(e) {
        if (!e || typeof e !== 'object') return;
        if (e.k === 'call') {
          const k = e.name.toLowerCase(), n = e.args.length;
          const isData = function (a) { return a.k === 'id' && DATA[a.name.toLowerCase()] !== undefined; };
          const fd = env.funcTable[k];
          const lib = fd && fd[n] && !fd[n].user ? fd[n] : null;
          if (lib && !env.assigned.has(k)) {
            lib.params.forEach(function (pn, idx) {
              const a = e.args[idx];
              if (pn === 'A' || !a || !isData(a)) return;
              if (n === 1 && fd[2] && fd[2].params[0] === 'A') {
                const dv = (FN_DEFAULTS[k] || [14])[0];
                edits.push({ s: e.s, e: e.e, txt: e.name + '(' + src.slice(a.s, a.e) + ', ' + dv + ')', why: e.name + '(' + a.name + ')는 ' + a.name + ' 값을 기간으로 써서 계산이 안 돼요. ' + e.name + '(' + a.name + ', ' + dv + ')로 바꿨어요' });
              } else {
                const dv = (FN_DEFAULTS[k] || [])[idx] || 14;
                edits.push({ s: a.s, e: a.e, txt: String(dv), why: e.name + '의 ' + (idx + 1) + '번째 자리는 기간인데 가격(' + a.name + ')이 들어가 있어서 ' + dv + '(으)로 바꿨어요' });
              }
            });
          } else if (SERIES_FN[k] !== undefined && n >= 2 && B[k]) {
            const a0 = e.args[0], a1 = e.args[1];
            if (a0.k === 'num' && isData(a1)) edits.push({ s: e.s, e: e.e, txt: e.name + '(' + [src.slice(a1.s, a1.e), src.slice(a0.s, a0.e)].concat(e.args.slice(2).map(function (x) { return src.slice(x.s, x.e); })).join(', ') + ')', why: e.name + '(데이터, 기간) 순서가 바뀌어 있어서 자리를 바꿨어요' });
            else if (isData(a1)) edits.push({ s: a1.s, e: a1.e, txt: String(SERIES_FN[k]), why: e.name + '의 기간 자리에 가격(' + a1.name + ')이 들어가 있어서 ' + SERIES_FN[k] + '(으)로 바꿨어요' });
            else if (a1.k === 'num' && a1.v < 1) edits.push({ s: a1.s, e: a1.e, txt: '1', why: e.name + '의 기간은 1 이상이어야 해서 1로 바꿨어요' });
          }
          e.args.forEach(walk);
          return;
        }
        if (e.k === 'bin') { walk(e.a); walk(e.b); return; }
        if (e.k === 'un') walk(e.a);
      }
      stmts.forEach(function (s) { walk(s.expr); });
      return edits.filter(function (x) { return x.s !== undefined; }).sort(function (a, b) { return b.s - a.s; });
    }

    // opts: { userFuncs, vars, params(함수 본문용 인자 이름), allowNewVars }
    function autoFix(src, opts) {
      opts = opts || {};
      const userFuncs = opts.userFuncs || [];
      const funcTable = buildFuncTable(userFuncs);
      const vars = Object.assign({}, opts.vars || {});
      (opts.params || []).forEach(function (p) { vars[p] = 1; });
      const newVars = {};
      const userFn = {};
      userFuncs.forEach(function (f) { if (f && f.name) userFn[f.name.toLowerCase()] = true; });
      const funcNames = Object.keys(B).map(function (k) { return CANON[k] || k; })
        .concat(Object.keys(funcTable).map(function (k) { const v = Object.values(funcTable[k])[0]; return v ? v.name : k; }));
      const idNames = ['C', 'O', 'H', 'L', 'V', 'Close', 'Open', 'High', 'Low', 'Volume', '종가', '시가', '고가', '저가', '거래량', 'date', 'time', '일자', '시간', 'BarIndex', '봉번호', '거래대금']
        .concat(Object.keys(vars)).concat(['DayOpen', 'DayHigh', 'DayLow', 'PredayOpen', 'PredayHigh', 'PredayLow', 'PredayClose', 'OBV', 'AD', '양봉', '음봉', 'TrueRange']);
      const known = new Set(funcNames.concat(idNames).map(function (x) { return x.toLowerCase(); }));
      const env = { funcNames: funcNames, idNames: idNames, known: known, funcTable: funcTable, userFn: userFn, allowNewVars: opts.allowNewVars !== false };
      const changes = [];
      function tryCompile(s, extra) {
        try { compile(s, { funcTable: buildFuncTable(userFuncs), vars: Object.assign({}, vars, newVars, extra || {}) }); return null; } catch (e) { return e; }
      }
      const norm = normalizeSrc(String(src || ''));
      let cur = norm.src;
      norm.notes.forEach(function (n) { changes.push({ why: n }); });
      const seen = new Set([cur]);
      let err = tryCompile(cur);
      for (let iter = 0; err && iter < 40; iter++) {
        if (!err.info) break;
        const cands = fixCandidates(cur, err, env);
        let picked = null, pickedErr = null;
        for (const c of cands) {
          const extra = {};
          if (c.newVar) extra[c.newVar[0]] = c.newVar[1];
          const ne = tryCompile(c.src, extra);
          if (!ne) { picked = c; pickedErr = null; break; }
          const progress = !seen.has(c.src) || c.newVar;
          if (progress && ne.info && !picked && (ne.info.pos > err.info.pos || ne.info.code !== err.info.code || ne.message !== err.message)) { picked = c; pickedErr = ne; }
        }
        if (!picked) break;
        if (picked.newVar) newVars[picked.newVar[0]] = picked.newVar[1];
        const line = lineOf(cur, picked.pos);
        changes.push({ why: picked.why, line: line, before: lineText(cur, line), after: lineText(picked.src, lineOf(picked.src, picked.pos)), newVar: picked.newVar ? picked.newVar[0] : undefined });
        cur = picked.src;
        seen.add(cur);
        err = pickedErr;
      }
      if (!err) {
        const lint = lintFixes(cur, { funcTable: funcTable, assigned: new Set(assignedNames(cur).map(function (x) { return x.toLowerCase(); })) });
        lint.forEach(function (ed) {
          const next = splice(cur, ed.s, ed.e, ed.txt);
          if (!tryCompile(next)) {
            const line = lineOf(cur, ed.s);
            changes.push({ why: ed.why, line: line, before: lineText(cur, line), after: lineText(next, line) });
            cur = next;
          }
        });
      }
      return { src: cur, changed: cur !== src || Object.keys(newVars).length > 0, changes: changes, newVars: newVars, ok: !err, error: err ? err.message : null };
    }

    // 신호가 매 봉 나오는 '상태' 조건을 '처음 참이 된 봉'에만 나오게 바꾼다
    //  A > B → CrossUp(A, B),  A < B → CrossDown(A, B),  그 밖 → X = 조건; X and !X(1)
    function toEventFormula(src) {
      const stmts = parse(src);
      const last = stmts[stmts.length - 1];
      const ex = last.expr;
      const t = function (n) { return src.slice(n.s, n.e); };
      if (last.k === 'expr' && ex.k === 'bin' && !ex.paren && ['>', '>=', '<', '<='].indexOf(ex.op) >= 0) {
        const fn = ex.op[0] === '>' ? 'CrossUp' : 'CrossDown';
        return { src: src.slice(0, ex.s) + fn + '(' + t(ex.a) + ', ' + t(ex.b) + ')' + src.slice(ex.e), how: eul(t(ex)) + " " + fn + '(' + t(ex.a) + ', ' + t(ex.b) + ')로 바꿔 돌파한 봉에만 신호가 나오게 했어요' };
      }
      if (last.k === 'assign') {
        return { src: src.slice(0, last.e) + ';\n' + last.name + ' and !' + last.name + '(1)' + src.slice(last.e), how: '조건이 처음 참이 된 봉에만 신호가 나오도록 마지막 줄에 "' + last.name + ' and !' + last.name + '(1)"을 붙였어요' };
      }
      const used = wordsIn(src);
      let nm = '신호조건', k = 2;
      while (used.has(nm)) nm = '신호조건' + (k++);
      return { src: src.slice(0, last.s) + nm + ' = ' + t(ex) + ';\n' + nm + ' and !' + nm + '(1)' + src.slice(last.e), how: '조건이 처음 참이 된 봉에만 신호가 나오도록 "' + nm + ' and !' + nm + '(1)" 형태로 바꿨어요' };
    }
    // 마지막 식이 'A and B and C'이면 각 부분을 따로 계산할 수 있게 나눈다 (어느 조건이 막는지 찾기용)
    function splitAnd(src) {
      const stmts = parse(src);
      const last = stmts[stmts.length - 1];
      if (last.k !== 'expr') return [];
      const parts = [];
      (function walk(e) { if (e.k === 'bin' && e.op === '&&' && !e.paren) { walk(e.a); walk(e.b); } else parts.push(e); })(last.expr);
      if (parts.length < 2) return [];
      const head = src.slice(0, last.s);
      return parts.map(function (p) { const t = src.slice(p.s, p.e); return { text: t, src: head + t }; });
    }

    // 함수 설명 (수식관리자 도움말)
    const DOCS = [
      ['데이터', [
        ['C / Close / 종가', '종가. C(1) = 1봉 전 종가'], ['O / Open / 시가', '시가'], ['H / High / 고가', '고가'], ['L / Low / 저가', '저가'],
        ['V / Volume / 거래량', '거래량 (CFD는 틱 거래량)'], ['account / 거래대금', '종가 × 거래량 (근사값)'],
        ['date / 일자', '봉 날짜 (예: 20261118)'], ['time / 시간', '봉 시작 시간 (예: 93000)'], ['BarIndex / 봉번호', '첫 봉부터 0, 1, 2 ...'],
      ]],
      ['연산자', [
        ['+ - * / % ^', '사칙연산, 나머지, 거듭제곱'], ['== != < <= > >=', '비교 (= 도 같음으로 처리)'],
        ['and && 그리고', '논리곱'], ['or || 또는', '논리합'], ['! not', '부정'], ['A = 식;', '변수 대입 (세미콜론 또는 줄바꿈으로 구분)'],
        ['// 주석', '한 줄 주석, /* */ 여러 줄 주석'],
      ]],
      ['통계 함수 (M: M봉 전 값, 생략 가능)', [
        ['avg(A, N[, M]) / 평균', '단순 이동평균'], ['eavg(A, N[, M]) / 지수평균', '지수 이동평균'],
        ['wavg(A, N[, M]) / 가중평균', '가중 이동평균'], ['rma(A, N) / 윌더평균', '윌더(수정) 이동평균'],
        ['ma(A, N, 단순|지수|가중|윌더[, M]) / 이평', '종류를 고르는 이동평균'],
        ['stdev(A, N) / 표준편차', '표준편차'], ['highest(A, N) / 최고값', 'N봉 최고값'], ['lowest(A, N) / 최저값', 'N봉 최저값'],
        ['sum(A) / sum(A, N) / 합계', '누적 합계 / N봉 합계'], ['meandev(A, N)', '평균 편차'],
      ]],
      ['수학 함수', [
        ['max(A, B, ...) / min', '최대값 / 최소값'], ['abs, sqrt, log, log10, exp, pow(a,b)', '절대값, 제곱근, 로그, 거듭제곱'],
        ['sin, cos, tan, asin, acos, atan', '삼각함수'], ['round(A[, 자리]), floor, ceil', '반올림 / 내림 / 올림'],
        ['nz(A[, 대체값])', '값이 없으면 0(또는 대체값)'], ['isnan(A)', '값이 없으면 참'],
      ]],
      ['기타 함수', [
        ['CrossUp(A, B) / 상향돌파', 'A가 B를 상향 돌파한 봉에서 참'], ['CrossDown(A, B) / 하향돌파', 'A가 B를 하향 돌파'],
        ['if(조건, 참값, 거짓값) / 만일 / iff', '조건 선택'], ['between(A, 하한, 상한)', '범위 안이면 참'],
        ['shift(A, N) / 이동', 'N봉 전 값 (A(N)과 같음)'], ['BarsSince(조건)', '조건이 마지막으로 참이었던 뒤 지난 봉 수'],
        ['CountSince(조건, 데이터)', '조건 이후 데이터가 참인 횟수'], ['HighestSince([n,] 조건, 데이터)', '조건(n번째) 이후 최고값'],
        ['LowestSince([n,] 조건, 데이터)', '조건 이후 최저값'], ['ValueWhen(n, 조건, 데이터)', 'n번째 최근 조건 시점의 데이터 값'],
        ['DayOpen() DayHigh() DayLow()', '당일 시가/고가/저가'], ['PredayOpen() PredayHigh() PredayLow() PredayClose()', '전일 시가/고가/저가/종가'],
        ['TrueRange()', 'True Range'], ['SAR(가속, 최대)', '파라볼릭 SAR (기본 0.02, 0.2)'],
      ]],
      ['지표 함수', [
        ['RSI(N) / RSI(A, N)', 'RSI'], ['MACD(단기, 장기)', 'MACD (MACD()는 12, 26)'], ['MACDSignal(단기, 장기, 시그널)', 'MACD 시그널'],
        ['MACDOsc(단기, 장기, 시그널)', 'MACD 오실레이터'], ['StochasticsFast(N)', '스토캐스틱 %K (Fast)'],
        ['StochasticsK(N, K)', '스토캐스틱 Slow %K'], ['StochasticsD(N, K, D)', '스토캐스틱 Slow %D'],
        ['CCI(N)', 'CCI'], ['ATR(N)', 'ATR'], ['DiPlus(N) / DiMinus(N) / ADX(N)', 'DMI, ADX'], ['OBV()', 'OBV'],
        ['MFI(N)', 'MFI'], ['Momentum(N)', '모멘텀 (C / C(N) × 100)'], ['ROC(N)', '변화율 %'], ['Disparity(N) / 이격도(N)', '이격도'],
        ['WilliamsR(N)', '윌리엄스 %R'], ['BBandsUp(N, D) / BBandsDown(N, D)', '볼린저 상단 / 하단'],
        ['BBandsWidth(N, D) / BBandsB(N, D)', '볼린저 밴드폭 % / %B'], ['EnvelopeUp(N, %) / EnvelopeDown(N, %)', '엔벨로프'],
        ['TRIX(N)', 'TRIX'], ['VR(N)', '볼륨 레이시오'], ['Psychological(N) / 심리도(N)', '심리도'],
        ['전환선(N) / 기준선(N)', '일목균형표 전환선 / 기준선'], ['선행스팬1(전환, 기준, 선행) / 선행스팬2(N, 선행)', '현재 봉의 구름 값'],
        ['SuperTrend(N, 배수) / SuperTrendDir(N, 배수)', '슈퍼트렌드 선 / 방향 (1 상승, -1 하락)'], ['양봉() / 음봉()', '양봉 / 음봉'],
        ['StochRSI(N, K)', '스토캐스틱 RSI'], ['CMO(N)', '샹드 모멘텀 오실레이터'], ['UltimateOsc(단기, 중기, 장기)', '얼티밋 오실레이터'],
        ['AroonUp(N) / AroonDown(N) / AroonOsc(N)', '아룬'], ['DPO(N)', '추세 제거 가격 오실레이터'], ['ForceIndex(N)', '포스 인덱스'],
        ['EOM(N)', 'Ease of Movement'], ['ElderBull(N) / ElderBear(N)', '엘더 불파워 / 베어파워'], ['AD() / ChaikinOsc(단기, 장기)', 'A/D 라인 / 차이킨 오실레이터'],
        ['KeltnerUp(N, 배수) / KeltnerDown(N, 배수)', '켈트너 채널'], ['DonchianUp(N) / DonchianDown(N)', '돈치안 채널'], ['BBandsMid(N)', '볼린저 중심선'],
        ['Pivot() / PivotR1() / PivotS1() / PivotR2() / PivotS2()', '전일 기준 피봇 포인트'], ['VolumeOsc(단기, 장기)', '거래량 오실레이터 %'],
        ['LinReg(A, N) / LinRegSlope(A, N)', '선형회귀 값 / 기울기'], ['highestbars(A, N) / lowestbars(A, N)', 'N봉 최고/최저값이 몇 봉 전인지'],
      ]],
    ];

    return {
      FormulaError: FormulaError,
      parse: parse,
      compile: compile,
      makeCtx: makeCtx,
      buildFuncTable: buildFuncTable,
      parseVars: parseVars,
      varsToString: varsToString,
      compileLogic: compileLogic,
      runOnBars: runOnBars,
      truthy: truthy,
      DOCS: DOCS,
      autoFix: autoFix,
      toEventFormula: toEventFormula,
      splitAnd: splitAnd,
    };
  }


  // =============================================================================
  // 조건검색 항목 (대분류 → 폴더 → 항목). 각 항목은 수식 템플릿이며 {키}가 값으로 바뀐다.
  // =============================================================================
  const MA_KINDS = ['단순', '지수', '가중', '윌더'];
  function P(k, label, def, step, options) { return { k: k, label: label, def: def, step: step, options: options }; }
  const PT = P('t', '이평 종류', '단순', null, MA_KINDS);

  const PRESET_TREE = [];
  const PRESET_MAP = {};
  function folder(cat, name, items) {
    let c = PRESET_TREE.find(function (x) { return x.name === cat; });
    if (!c) { c = { name: cat, folders: [] }; PRESET_TREE.push(c); }
    const f = { name: name, items: [] };
    items.forEach(function (it) {
      if (PRESET_MAP[it.id]) throw new Error('조건 항목 id 중복: ' + it.id);
      it.cat = cat; it.grp = name; it.params = it.params || [];
      PRESET_MAP[it.id] = it; f.items.push(it);
    });
    c.folders.push(f);
  }
  function I(id, name, params, f) { return { id: id, name: name, params: params, f: f }; }

  // -----------------------------------------------------------------------------
  // 기술적분석 > 이동평균
  // -----------------------------------------------------------------------------
  folder('기술적분석', '이동평균', [
    I('ma_golden', '이평 골든크로스', [P('s', '단기', 5), P('l', '장기', 20), PT], 'CrossUp(ma(C, {s}, {t}), ma(C, {l}, {t}))'),
    I('ma_dead', '이평 데드크로스', [P('s', '단기', 5), P('l', '장기', 20), PT], 'CrossDown(ma(C, {s}, {t}), ma(C, {l}, {t}))'),
    I('ma_golden3', '단기 이평이 중기·장기 이평 동시 상향돌파', [P('a', '단기', 5), P('b', '중기', 20), P('c', '장기', 60), PT],
      'A = ma(C, {a}, {t}); B = ma(C, {b}, {t}); D = ma(C, {c}, {t}); A > B and A > D and (A(1) <= B(1) or A(1) <= D(1))'),
    I('price_ma_up', '주가가 이평 상향돌파', [P('n', '이평 기간', 20), PT], 'CrossUp(C, ma(C, {n}, {t}))'),
    I('price_ma_dn', '주가가 이평 하향돌파', [P('n', '이평 기간', 20), PT], 'CrossDown(C, ma(C, {n}, {t}))'),
    I('price_above_ma', '주가가 이평 위', [P('n', '이평 기간', 20), PT], 'C > ma(C, {n}, {t})'),
    I('price_below_ma', '주가가 이평 아래', [P('n', '이평 기간', 20), PT], 'C < ma(C, {n}, {t})'),
    I('price_above_all', '주가가 이평 4개 모두 위', [P('a', '이평1', 5), P('b', '이평2', 20), P('c', '이평3', 60), P('d', '이평4', 120), PT],
      'C > ma(C, {a}, {t}) and C > ma(C, {b}, {t}) and C > ma(C, {c}, {t}) and C > ma(C, {d}, {t})'),
    I('price_below_all', '주가가 이평 4개 모두 아래', [P('a', '이평1', 5), P('b', '이평2', 20), P('c', '이평3', 60), P('d', '이평4', 120), PT],
      'C < ma(C, {a}, {t}) and C < ma(C, {b}, {t}) and C < ma(C, {c}, {t}) and C < ma(C, {d}, {t})'),
    I('ma_bull_array', '이평 정배열 (3개)', [P('a', '단기', 5), P('b', '중기', 20), P('c', '장기', 60), PT], 'ma(C, {a}, {t}) > ma(C, {b}, {t}) and ma(C, {b}, {t}) > ma(C, {c}, {t})'),
    I('ma_bear_array', '이평 역배열 (3개)', [P('a', '단기', 5), P('b', '중기', 20), P('c', '장기', 60), PT], 'ma(C, {a}, {t}) < ma(C, {b}, {t}) and ma(C, {b}, {t}) < ma(C, {c}, {t})'),
    I('ma_bull_array4', '이평 정배열 (4개)', [P('a', '이평1', 5), P('b', '이평2', 20), P('c', '이평3', 60), P('d', '이평4', 120), PT],
      'ma(C, {a}, {t}) > ma(C, {b}, {t}) and ma(C, {b}, {t}) > ma(C, {c}, {t}) and ma(C, {c}, {t}) > ma(C, {d}, {t})'),
    I('ma_bear_array4', '이평 역배열 (4개)', [P('a', '이평1', 5), P('b', '이평2', 20), P('c', '이평3', 60), P('d', '이평4', 120), PT],
      'ma(C, {a}, {t}) < ma(C, {b}, {t}) and ma(C, {b}, {t}) < ma(C, {c}, {t}) and ma(C, {c}, {t}) < ma(C, {d}, {t})'),
    I('ma_bull_start', '이평 정배열 전환 (오늘 처음 정배열)', [P('a', '단기', 5), P('b', '중기', 20), P('c', '장기', 60), PT],
      'X = ma(C, {a}, {t}) > ma(C, {b}, {t}) and ma(C, {b}, {t}) > ma(C, {c}, {t}); X and !X(1)'),
    I('ma_bear_start', '이평 역배열 전환 (오늘 처음 역배열)', [P('a', '단기', 5), P('b', '중기', 20), P('c', '장기', 60), PT],
      'X = ma(C, {a}, {t}) < ma(C, {b}, {t}) and ma(C, {b}, {t}) < ma(C, {c}, {t}); X and !X(1)'),
    I('ma_turn_up', '이평 상승 전환', [P('n', '이평 기간', 20), PT], 'A = ma(C, {n}, {t}); A > A(1) and A(1) <= A(2)'),
    I('ma_turn_dn', '이평 하락 전환', [P('n', '이평 기간', 20), PT], 'A = ma(C, {n}, {t}); A < A(1) and A(1) >= A(2)'),
    I('ma_rising', '이평 N봉 연속 상승', [P('n', '이평 기간', 20), P('k', '연속 봉 수', 3), PT], 'A = ma(C, {n}, {t}); sum(if(A > A(1), 1, 0), {k}) == {k}'),
    I('ma_falling', '이평 N봉 연속 하락', [P('n', '이평 기간', 20), P('k', '연속 봉 수', 3), PT], 'A = ma(C, {n}, {t}); sum(if(A < A(1), 1, 0), {k}) == {k}'),
    I('ma_slope_up', '이평 기울기 (N봉 전 대비 % 이상)', [P('n', '이평 기간', 20), P('k', 'N봉', 5), P('p', '% 이상', 0.5, 0.1), PT], 'A = ma(C, {n}, {t}); (A - A({k})) / A({k}) * 100 >= {p}'),
    I('ma_slope_dn', '이평 기울기 (N봉 전 대비 % 이하 하락)', [P('n', '이평 기간', 20), P('k', 'N봉', 5), P('p', '% 이상 하락', 0.5, 0.1), PT], 'A = ma(C, {n}, {t}); (A({k}) - A) / A({k}) * 100 >= {p}'),
    I('ma_near', '주가가 이평 근처 (±%)', [P('n', '이평 기간', 20), P('p', '± %', 0.3, 0.1), PT], 'A = ma(C, {n}, {t}); abs(C - A) / A * 100 <= {p}'),
    I('ma_support', '이평 지지 (저가가 이평 터치 후 종가 위)', [P('n', '이평 기간', 20), PT], 'A = ma(C, {n}, {t}); L <= A and C > A'),
    I('ma_resist', '이평 저항 (고가가 이평 터치 후 종가 아래)', [P('n', '이평 기간', 20), PT], 'A = ma(C, {n}, {t}); H >= A and C < A'),
    I('ma_converge', '이평 수렴 (단기·장기 차이 % 이내)', [P('s', '단기', 5), P('l', '장기', 20), P('p', '% 이내', 0.3, 0.1), PT], 'A = ma(C, {s}, {t}); B = ma(C, {l}, {t}); abs(A - B) / B * 100 <= {p}'),
    I('ma_diverge', '이평 확산 (단기·장기 차이 % 이상)', [P('s', '단기', 5), P('l', '장기', 20), P('p', '% 이상', 1, 0.1), PT], 'A = ma(C, {s}, {t}); B = ma(C, {l}, {t}); abs(A - B) / B * 100 >= {p}'),
    I('ma_pullback', '정배열 중 단기 이평까지 눌림', [P('s', '단기', 20), P('l', '장기', 60), PT], 'A = ma(C, {s}, {t}); B = ma(C, {l}, {t}); A > B and L <= A and C >= A'),
    I('disparity', '이격도 범위', [P('n', '이평 기간', 20), P('lo', '이상', 98), P('hi', '이하', 102)], 'between(이격도({n}), {lo}, {hi})'),
    I('price_ma_cross_days', '주가 이평 상향돌파 후 N봉 이내 유지', [P('n', '이평 기간', 20), P('k', 'N봉 이내', 5), PT], 'A = ma(C, {n}, {t}); B = BarsSince(CrossUp(C, A)); B <= {k} and sum(if(C > A, 1, 0), B + 1) == B + 1'),
  ]);

  // -----------------------------------------------------------------------------
  // 기술적분석 > 지표별 폴더 (오실레이터 공통 조건 묶음)
  // -----------------------------------------------------------------------------
  const OSC = [
    // id, 이름, 지표 인자, 식, {ob 과열, os 침체, mid 중심, lv 기본 기준}
    ['rsi', 'RSI', [P('n', 'RSI 기간', 14)], 'RSI({n})', { ob: 70, os: 30, mid: 50 }],
    ['stoK', '스토캐스틱 Slow %K', [P('n', '기간', 14), P('k', '%K 평활', 3)], 'StochasticsK({n}, {k})', { ob: 80, os: 20, mid: 50 }],
    ['stoD', '스토캐스틱 Slow %D', [P('n', '기간', 14), P('k', '%K 평활', 3), P('d', '%D 기간', 3)], 'StochasticsD({n}, {k}, {d})', { ob: 80, os: 20, mid: 50 }],
    ['stoF', '스토캐스틱 Fast %K', [P('n', '기간', 14)], 'StochasticsFast({n})', { ob: 80, os: 20, mid: 50 }],
    ['srsi', '스토캐스틱 RSI', [P('n', '기간', 14), P('k', '평활', 3)], 'StochRSI({n}, {k})', { ob: 80, os: 20, mid: 50 }],
    ['cci', 'CCI', [P('n', 'CCI 기간', 20)], 'CCI({n})', { ob: 100, os: -100, mid: 0 }],
    ['macd', 'MACD', [P('s', '단기', 12), P('l', '장기', 26)], 'MACD({s}, {l})', { mid: 0 }],
    ['macdo', 'MACD 오실레이터', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'MACDOsc({s}, {l}, {g})', { mid: 0 }],
    ['wr', '윌리엄스 %R', [P('n', '기간', 14)], 'WilliamsR({n})', { ob: -20, os: -80, mid: -50 }],
    ['mfi', 'MFI', [P('n', '기간', 14)], 'MFI({n})', { ob: 80, os: 20, mid: 50 }],
    ['mom', '모멘텀', [P('n', '기간', 10)], 'Momentum({n})', { mid: 100 }],
    ['roc', 'ROC (변화율)', [P('n', '기간', 12)], 'ROC({n})', { mid: 0 }],
    ['trix', 'TRIX', [P('n', '기간', 12)], 'TRIX({n})', { mid: 0 }],
    ['cmo', 'CMO (샹드 모멘텀)', [P('n', '기간', 9)], 'CMO({n})', { ob: 50, os: -50, mid: 0 }],
    ['uo', '얼티밋 오실레이터', [P('a', '단기', 7), P('b', '중기', 14), P('c', '장기', 28)], 'UltimateOsc({a}, {b}, {c})', { ob: 70, os: 30, mid: 50 }],
    ['aroon', '아룬 오실레이터', [P('n', '기간', 25)], 'AroonOsc({n})', { ob: 50, os: -50, mid: 0 }],
    ['dpo', 'DPO (추세 제거 가격)', [P('n', '기간', 20)], 'DPO({n})', { mid: 0 }],
    ['adx', 'ADX', [P('n', '기간', 14)], 'ADX({n})', { ob: 40, os: 20, mid: 25 }],
    ['bbb', '볼린저 %B', [P('n', '기간', 20), P('d', '승수', 2, 0.1)], 'BBandsB({n}, {d})', { ob: 100, os: 0, mid: 50 }],
    ['bbw', '볼린저 밴드폭 %', [P('n', '기간', 20), P('d', '승수', 2, 0.1)], 'BBandsWidth({n}, {d})', { lv: 2 }],
    ['disp', '이격도', [P('n', '이평 기간', 20)], '이격도({n})', { ob: 102, os: 98, mid: 100 }],
    ['psy', '심리도', [P('n', '기간', 10)], '심리도({n})', { ob: 75, os: 25, mid: 50 }],
    ['vr', 'VR (볼륨 레이시오)', [P('n', '기간', 20)], 'VR({n})', { ob: 450, os: 70, mid: 100 }],
    ['obv', 'OBV', [], 'OBV()', { lv: 0 }],
    ['ad', 'A/D 라인', [], 'AD()', { lv: 0 }],
    ['cho', '차이킨 오실레이터', [P('f', '단기', 3), P('s', '장기', 10)], 'ChaikinOsc({f}, {s})', { mid: 0 }],
    ['fi', '포스 인덱스', [P('n', '기간', 13)], 'ForceIndex({n})', { mid: 0 }],
    ['eom', 'EOM', [P('n', '기간', 14)], 'EOM({n})', { mid: 0 }],
    ['ebull', '엘더 불파워', [P('n', '기간', 13)], 'ElderBull({n})', { mid: 0 }],
    ['ebear', '엘더 베어파워', [P('n', '기간', 13)], 'ElderBear({n})', { mid: 0 }],
    ['vosc', '거래량 오실레이터 %', [P('f', '단기', 5), P('s', '장기', 20)], 'VolumeOsc({f}, {s})', { mid: 0 }],
    ['atrp', 'ATR % (변동성)', [P('n', 'ATR 기간', 14)], 'ATR({n}) / C * 100', { lv: 1 }],
    ['std', '표준편차 %', [P('n', '기간', 20)], 'stdev(C, {n}) / C * 100', { lv: 1 }],
    ['lrs', '선형회귀 기울기', [P('n', '기간', 20)], 'LinRegSlope(C, {n})', { mid: 0 }],
  ];

  function oscItems(o) {
    const id = o[0], nm = o[1], ip = o[2], expr = o[3], lv = o[4];
    const X = 'X = ' + expr + '; ';
    const base = lv.mid !== undefined ? lv.mid : lv.lv;
    const lo = lv.os !== undefined ? lv.os : base, hi = lv.ob !== undefined ? lv.ob : base;
    const out = [];
    function add(sfx, name, extra, f) { out.push(I('osc_' + id + '_' + sfx, nm + ' ' + name, ip.concat(extra), X + f)); }
    add('xup', '기준선 상향돌파', [P('lv', '기준선', base)], 'CrossUp(X, {lv})');
    add('xdn', '기준선 하향돌파', [P('lv', '기준선', base)], 'CrossDown(X, {lv})');
    add('above', '기준선 위', [P('lv', '기준선', base)], 'X > {lv}');
    add('below', '기준선 아래', [P('lv', '기준선', base)], 'X < {lv}');
    if (lv.ob !== undefined && lv.os !== undefined) add('range', '범위', [P('lo', '이상', lo), P('hi', '이하', hi)], 'between(X, {lo}, {hi})');
    if (lv.ob !== undefined) {
      add('obin', '과열권 진입', [P('ob', '과열 기준', lv.ob)], 'CrossUp(X, {ob})');
      add('obout', '과열권 이탈 (하향)', [P('ob', '과열 기준', lv.ob)], 'CrossDown(X, {ob})');
      add('inob', '과열권 위치', [P('ob', '과열 기준', lv.ob)], 'X >= {ob}');
    }
    if (lv.os !== undefined) {
      add('osin', '침체권 진입', [P('os', '침체 기준', lv.os)], 'CrossDown(X, {os})');
      add('osout', '침체권 탈출 (상향)', [P('os', '침체 기준', lv.os)], 'CrossUp(X, {os})');
      add('inos', '침체권 위치', [P('os', '침체 기준', lv.os)], 'X <= {os}');
    }
    add('turnup', '상승 전환', [], 'X > X(1) and X(1) <= X(2)');
    add('turndn', '하락 전환', [], 'X < X(1) and X(1) >= X(2)');
    add('upn', 'N봉 연속 상승', [P('cnt', '연속 봉 수', 3)], 'sum(if(X > X(1), 1, 0), {cnt}) == {cnt}');
    add('dnn', 'N봉 연속 하락', [P('cnt', '연속 봉 수', 3)], 'sum(if(X < X(1), 1, 0), {cnt}) == {cnt}');
    add('sgc', '시그널 골든크로스', [P('sg', '시그널 (이평)', 9)], 'CrossUp(X, avg(X, {sg}))');
    add('sdc', '시그널 데드크로스', [P('sg', '시그널 (이평)', 9)], 'CrossDown(X, avg(X, {sg}))');
    add('sabove', '시그널 위', [P('sg', '시그널 (이평)', 9)], 'X > avg(X, {sg})');
    add('hin', 'N봉 최고치', [P('lb', '기간', 20)], 'X >= highest(X, {lb})');
    add('lon', 'N봉 최저치', [P('lb', '기간', 20)], 'X <= lowest(X, {lb})');
    add('bdiv', '강세 다이버전스 (주가 신저가, 지표는 아님)', [P('lb', '기간', 20)], 'L <= lowest(L, {lb}) and X > lowest(X, {lb}, 1)');
    add('sdiv', '약세 다이버전스 (주가 신고가, 지표는 아님)', [P('lb', '기간', 20)], 'H >= highest(H, {lb}) and X < highest(X, {lb}, 1)');
    add('chg', 'N봉 전보다 상승', [P('cnt', 'N봉', 5)], 'X > X({cnt})');
    return out;
  }
  OSC.forEach(function (o) { folder('기술적분석', o[1], oscItems(o)); });

  // 지표 고유 조건
  folder('기술적분석', 'MACD 시그널', [
    I('macd_golden', 'MACD 시그널 골든크로스', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'CrossUp(MACD({s}, {l}), MACDSignal({s}, {l}, {g}))'),
    I('macd_dead', 'MACD 시그널 데드크로스', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'CrossDown(MACD({s}, {l}), MACDSignal({s}, {l}, {g}))'),
    I('macd_golden_below0', 'MACD 0선 아래에서 골든크로스', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'M = MACD({s}, {l}); CrossUp(M, MACDSignal({s}, {l}, {g})) and M < 0'),
    I('macd_dead_above0', 'MACD 0선 위에서 데드크로스', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'M = MACD({s}, {l}); CrossDown(M, MACDSignal({s}, {l}, {g})) and M > 0'),
    I('macd_above_sig', 'MACD가 시그널 위', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'MACD({s}, {l}) > MACDSignal({s}, {l}, {g})'),
    I('macd_both_above0', 'MACD·시그널 모두 0선 위', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'MACD({s}, {l}) > 0 and MACDSignal({s}, {l}, {g}) > 0'),
    I('macd_zero_up', 'MACD 0선 상향돌파', [P('s', '단기', 12), P('l', '장기', 26)], 'CrossUp(MACD({s}, {l}), 0)'),
    I('macd_zero_dn', 'MACD 0선 하향돌파', [P('s', '단기', 12), P('l', '장기', 26)], 'CrossDown(MACD({s}, {l}), 0)'),
    I('macdo_turn_pos', 'MACD 오실레이터 음→양 전환', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'X = MACDOsc({s}, {l}, {g}); X > 0 and X(1) <= 0'),
    I('macdo_shrink', 'MACD 오실레이터 음수 구간 축소 (바닥 신호)', [P('s', '단기', 12), P('l', '장기', 26), P('g', '시그널', 9)], 'X = MACDOsc({s}, {l}, {g}); X < 0 and X > X(1) and X(1) <= X(2)'),
  ]);
  folder('기술적분석', '스토캐스틱 교차', [
    I('stoch_golden', '스토캐스틱 골든크로스 (침체권)', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3), P('lv', '침체 기준 이하', 30)], 'K = StochasticsK({n}, {k}); D = StochasticsD({n}, {k}, {d}); CrossUp(K, D) and K <= {lv}'),
    I('stoch_dead', '스토캐스틱 데드크로스 (과열권)', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3), P('lv', '과열 기준 이상', 70)], 'K = StochasticsK({n}, {k}); D = StochasticsD({n}, {k}, {d}); CrossDown(K, D) and K >= {lv}'),
    I('stoch_golden_any', '스토캐스틱 %K·%D 골든크로스', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3)], 'CrossUp(StochasticsK({n}, {k}), StochasticsD({n}, {k}, {d}))'),
    I('stoch_dead_any', '스토캐스틱 %K·%D 데드크로스', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3)], 'CrossDown(StochasticsK({n}, {k}), StochasticsD({n}, {k}, {d}))'),
    I('stoch_k_above_d', '스토캐스틱 %K가 %D 위', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3)], 'StochasticsK({n}, {k}) > StochasticsD({n}, {k}, {d})'),
    I('stoch_fast_slow', '스토캐스틱 Fast가 Slow 상향돌파', [P('n', '기간', 14), P('k', '%K', 3)], 'CrossUp(StochasticsFast({n}), StochasticsK({n}, {k}))'),
    I('srsi_golden', '스토캐스틱 RSI 골든크로스 (침체권)', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3), P('lv', '침체 기준 이하', 20)], 'K = StochRSI({n}, {k}); D = avg(K, {d}); CrossUp(K, D) and K <= {lv}'),
    I('srsi_dead', '스토캐스틱 RSI 데드크로스 (과열권)', [P('n', '기간', 14), P('k', '%K', 3), P('d', '%D', 3), P('lv', '과열 기준 이상', 80)], 'K = StochRSI({n}, {k}); D = avg(K, {d}); CrossDown(K, D) and K >= {lv}'),
  ]);
  folder('기술적분석', 'RSI 응용', [
    I('rsi_2line_golden', 'RSI 단기가 장기 상향돌파', [P('s', '단기 기간', 7), P('l', '장기 기간', 14)], 'CrossUp(RSI({s}), RSI({l}))'),
    I('rsi_2line_dead', 'RSI 단기가 장기 하향돌파', [P('s', '단기 기간', 7), P('l', '장기 기간', 14)], 'CrossDown(RSI({s}), RSI({l}))'),
    I('rsi_bull_zone', 'RSI 강세 구간 유지 (N봉 동안 기준 이상)', [P('n', 'RSI 기간', 14), P('lv', '기준', 50), P('cnt', 'N봉', 5)], 'R = RSI({n}); lowest(R, {cnt}) >= {lv}'),
    I('rsi_bear_zone', 'RSI 약세 구간 유지 (N봉 동안 기준 이하)', [P('n', 'RSI 기간', 14), P('lv', '기준', 50), P('cnt', 'N봉', 5)], 'R = RSI({n}); highest(R, {cnt}) <= {lv}'),
    I('rsi_os_rebound', 'RSI 침체 후 N봉 이내 50 돌파', [P('n', 'RSI 기간', 14), P('os', '침체', 30), P('cnt', 'N봉 이내', 10)], 'R = RSI({n}); CrossUp(R, 50) and lowest(R, {cnt}) <= {os}'),
  ]);
  folder('기술적분석', 'CCI·윌리엄스 응용', [
    I('cci_zero_up', 'CCI 0선 상향돌파 (침체 경유)', [P('n', 'CCI 기간', 20), P('cnt', '최근 N봉 안에 -100 이하', 10)], 'X = CCI({n}); CrossUp(X, 0) and lowest(X, {cnt}) <= -100'),
    I('cci_woodies', 'CCI 터보·일반 골든크로스', [P('a', '터보 기간', 6), P('n', '일반 기간', 14)], 'CrossUp(CCI({a}), CCI({n}))'),
    I('wr_double_os', '윌리엄스 %R 침체권 두 번째 진입', [P('n', '기간', 14), P('lb', '기간 (봉)', 20)], 'X = WilliamsR({n}); CrossDown(X, -80) and CountSince(CrossUp(X, -50), CrossDown(X, -80)) >= 1'),
  ]);

  // -----------------------------------------------------------------------------
  // 기술적분석 > 추세·채널
  // -----------------------------------------------------------------------------
  const BBP = [P('n', '기간', 20), P('d', '승수', 2, 0.1)];
  folder('추세·채널', '볼린저밴드', [
    I('bb_up_break', '상단 상향돌파', BBP, 'CrossUp(C, BBandsUp({n}, {d}))'),
    I('bb_up_return', '상단 돌파 후 하향 복귀', BBP, 'CrossDown(C, BBandsUp({n}, {d}))'),
    I('bb_dn_break', '하단 하향이탈', BBP, 'CrossDown(C, BBandsDown({n}, {d}))'),
    I('bb_dn_return', '하단 이탈 후 상향 복귀', BBP, 'CrossUp(C, BBandsDown({n}, {d}))'),
    I('bb_mid_up', '중심선 상향돌파', BBP, 'CrossUp(C, avg(C, {n}))'),
    I('bb_mid_dn', '중심선 하향돌파', BBP, 'CrossDown(C, avg(C, {n}))'),
    I('bb_above_up', '종가가 상단 위', BBP, 'C > BBandsUp({n}, {d})'),
    I('bb_below_dn', '종가가 하단 아래', BBP, 'C < BBandsDown({n}, {d})'),
    I('bb_touch_up', '고가가 상단 터치', BBP, 'H >= BBandsUp({n}, {d})'),
    I('bb_dn_rebound', '하단 터치 후 반등 (종가는 하단 위)', BBP, 'B = BBandsDown({n}, {d}); L <= B and C > B'),
    I('bb_up_reject', '상단 터치 후 밀림 (종가는 상단 아래)', BBP, 'B = BBandsUp({n}, {d}); H >= B and C < B'),
    I('bb_squeeze', '밴드폭 수축 (이하 %)', BBP.concat([P('w', '밴드폭 % 이하', 1, 0.1)]), 'BBandsWidth({n}, {d}) <= {w}'),
    I('bb_squeeze_low', '밴드폭 N봉 최저 (스퀴즈)', BBP.concat([P('lb', '기간', 120)]), 'W = BBandsWidth({n}, {d}); W <= lowest(W, {lb})'),
    I('bb_expand', '밴드폭 확장 시작 (스퀴즈 후 상단 돌파)', BBP.concat([P('lb', '스퀴즈 판단 기간', 50)]), 'W = BBandsWidth({n}, {d}); CrossUp(C, BBandsUp({n}, {d})) and lowest(W, 5, 1) <= lowest(W, {lb})'),
    I('bb_walk_up', '상단 밴드 타기 (N봉 연속 상단 근처)', BBP.concat([P('cnt', 'N봉', 3)]), 'sum(if(H >= BBandsUp({n}, {d}), 1, 0), {cnt}) == {cnt}'),
    I('bb_upper_half', '중심선과 상단 사이', BBP, 'C > avg(C, {n}) and C < BBandsUp({n}, {d})'),
  ]);
  const ENVP = [P('n', '기간', 20), P('p', '%', 1, 0.1)];
  folder('추세·채널', '엔벨로프', [
    I('env_up_break', '상단 상향돌파', ENVP, 'CrossUp(C, EnvelopeUp({n}, {p}))'),
    I('env_dn_break', '하단 하향이탈', ENVP, 'CrossDown(C, EnvelopeDown({n}, {p}))'),
    I('env_dn_return', '하단 이탈 후 복귀', ENVP, 'CrossUp(C, EnvelopeDown({n}, {p}))'),
    I('env_up_return', '상단 돌파 후 복귀', ENVP, 'CrossDown(C, EnvelopeUp({n}, {p}))'),
    I('env_touch_dn', '저가가 하단 터치', ENVP, 'L <= EnvelopeDown({n}, {p})'),
    I('env_touch_up', '고가가 상단 터치', ENVP, 'H >= EnvelopeUp({n}, {p})'),
  ]);
  const KCP = [P('n', '기간', 20), P('m', 'ATR 배수', 2, 0.1)];
  folder('추세·채널', '켈트너 채널', [
    I('kc_up_break', '상단 상향돌파', KCP, 'CrossUp(C, KeltnerUp({n}, {m}))'),
    I('kc_dn_break', '하단 하향이탈', KCP, 'CrossDown(C, KeltnerDown({n}, {m}))'),
    I('kc_dn_return', '하단 이탈 후 복귀', KCP, 'CrossUp(C, KeltnerDown({n}, {m}))'),
    I('kc_up_return', '상단 돌파 후 복귀', KCP, 'CrossDown(C, KeltnerUp({n}, {m}))'),
    I('kc_above_mid', '중심선(EMA) 위', KCP, 'C > eavg(C, {n})'),
    I('kc_squeeze', 'TTM 스퀴즈 (볼린저가 켈트너 안)', [P('n', '기간', 20), P('d', '볼린저 승수', 2, 0.1), P('m', '켈트너 배수', 1.5, 0.1)], 'BBandsUp({n}, {d}) < KeltnerUp({n}, {m}) and BBandsDown({n}, {d}) > KeltnerDown({n}, {m})'),
    I('kc_squeeze_fire', 'TTM 스퀴즈 해제', [P('n', '기간', 20), P('d', '볼린저 승수', 2, 0.1), P('m', '켈트너 배수', 1.5, 0.1)], 'S = BBandsUp({n}, {d}) < KeltnerUp({n}, {m}) and BBandsDown({n}, {d}) > KeltnerDown({n}, {m}); !S and S(1)'),
  ]);
  folder('추세·채널', '돈치안 채널', [
    I('dc_up_break', '상단 돌파 (직전 N봉 최고가)', [P('n', '기간', 20)], 'C > highest(H, {n}, 1)'),
    I('dc_dn_break', '하단 이탈 (직전 N봉 최저가)', [P('n', '기간', 20)], 'C < lowest(L, {n}, 1)'),
    I('dc_mid_up', '중심선 상향돌파', [P('n', '기간', 20)], 'CrossUp(C, (DonchianUp({n}) + DonchianDown({n})) / 2)'),
    I('dc_mid_dn', '중심선 하향돌파', [P('n', '기간', 20)], 'CrossDown(C, (DonchianUp({n}) + DonchianDown({n})) / 2)'),
    I('dc_turtle_long', '터틀 진입 (N봉 고가 돌파, 첫 돌파)', [P('n', '기간', 20)], 'X = H > highest(H, {n}, 1); X and !X(1)'),
    I('dc_turtle_short', '터틀 매도 진입 (N봉 저가 이탈, 첫 이탈)', [P('n', '기간', 20)], 'X = L < lowest(L, {n}, 1); X and !X(1)'),
    I('dc_narrow', '채널 폭 수축 (% 이하)', [P('n', '기간', 20), P('w', '폭 % 이하', 1, 0.1)], '(DonchianUp({n}) - DonchianDown({n})) / C * 100 <= {w}'),
  ]);
  const ICHI = [P('a', '전환', 9), P('b', '기준', 26), P('c', '선행2 기간', 52)];
  const CLOUD_TOP = 'max(선행스팬1({a}, {b}, {b}), 선행스팬2({c}, {b}))';
  const CLOUD_BOT = 'min(선행스팬1({a}, {b}, {b}), 선행스팬2({c}, {b}))';
  folder('추세·채널', '일목균형표', [
    I('ichi_tk', '전환선이 기준선 상향돌파', ICHI.slice(0, 2), 'CrossUp(전환선({a}), 기준선({b}))'),
    I('ichi_tk_dead', '전환선이 기준선 하향돌파', ICHI.slice(0, 2), 'CrossDown(전환선({a}), 기준선({b}))'),
    I('ichi_tk_above_cloud', '구름 위에서 전환선·기준선 골든크로스', ICHI, 'CrossUp(전환선({a}), 기준선({b})) and C > ' + CLOUD_TOP),
    I('ichi_above', '주가가 구름 위', ICHI, 'C > ' + CLOUD_TOP),
    I('ichi_below', '주가가 구름 아래', ICHI, 'C < ' + CLOUD_BOT),
    I('ichi_inside', '주가가 구름 안', ICHI, 'C <= ' + CLOUD_TOP + ' and C >= ' + CLOUD_BOT),
    I('ichi_break', '구름 상향돌파', ICHI, 'CrossUp(C, ' + CLOUD_TOP + ')'),
    I('ichi_break_dn', '구름 하향이탈', ICHI, 'CrossDown(C, ' + CLOUD_BOT + ')'),
    I('ichi_kijun_up', '주가가 기준선 상향돌파', [P('b', '기준', 26)], 'CrossUp(C, 기준선({b}))'),
    I('ichi_kijun_dn', '주가가 기준선 하향돌파', [P('b', '기준', 26)], 'CrossDown(C, 기준선({b}))'),
    I('ichi_tenkan_up', '주가가 전환선 상향돌파', [P('a', '전환', 9)], 'CrossUp(C, 전환선({a}))'),
    I('ichi_chikou', '후행스팬이 과거 주가 위', [P('b', '후행 기간', 26)], 'C > H({b} - 1)'),
    I('ichi_bull_cloud', '양운 (선행스팬1 > 선행스팬2)', ICHI, '선행스팬1({a}, {b}, {b}) > 선행스팬2({c}, {b})'),
    I('ichi_twist', '구름 꼬임 (양운 전환)', ICHI, 'CrossUp(선행스팬1({a}, {b}, {b}), 선행스팬2({c}, {b}))'),
    I('ichi_three', '삼역호전 (구름 위·전환>기준·후행 위)', ICHI, 'C > ' + CLOUD_TOP + ' and 전환선({a}) > 기준선({b}) and C > H({b} - 1)'),
    I('ichi_thin', '구름 두께 얇음 (% 이하)', ICHI.concat([P('w', '두께 % 이하', 0.3, 0.1)]), '(' + CLOUD_TOP + ' - ' + CLOUD_BOT + ') / C * 100 <= {w}'),
  ]);
  const SARP = [P('a', '가속', 0.02, 0.01), P('m', '최대', 0.2, 0.01)];
  folder('추세·채널', '파라볼릭 SAR', [
    I('sar_buy', '매수 전환', SARP, 'S = SAR({a}, {m}); C > S and C(1) <= S(1)'),
    I('sar_sell', '매도 전환', SARP, 'S = SAR({a}, {m}); C < S and C(1) >= S(1)'),
    I('sar_up', '상승 추세 중 (주가 > SAR)', SARP, 'C > SAR({a}, {m})'),
    I('sar_dn', '하락 추세 중 (주가 < SAR)', SARP, 'C < SAR({a}, {m})'),
    I('sar_up_n', '상승 추세 N봉 이상 지속', SARP.concat([P('cnt', 'N봉', 5)]), 'S = SAR({a}, {m}); sum(if(C > S, 1, 0), {cnt}) == {cnt}'),
  ]);
  const STP = [P('n', 'ATR 기간', 10), P('m', '배수', 3, 0.1)];
  folder('추세·채널', '슈퍼트렌드', [
    I('st_up', '상승 전환', STP, 'T = SuperTrendDir({n}, {m}); T == 1 and T(1) == -1'),
    I('st_dn', '하락 전환', STP, 'T = SuperTrendDir({n}, {m}); T == -1 and T(1) == 1'),
    I('st_bull', '상승 추세 중', STP, 'SuperTrendDir({n}, {m}) == 1'),
    I('st_bear', '하락 추세 중', STP, 'SuperTrendDir({n}, {m}) == -1'),
    I('st_pullback', '상승 추세 중 선 근처 눌림 (ATR 배 이내)', STP.concat([P('x', 'ATR 배 이내', 0.5, 0.1)]), 'SuperTrendDir({n}, {m}) == 1 and L - SuperTrend({n}, {m}) <= ATR({n}) * {x}'),
  ]);
  const DMIP = [P('n', '기간', 14)];
  folder('추세·채널', 'DMI·ADX', [
    I('di_golden', '+DI가 -DI 상향돌파', DMIP, 'CrossUp(DiPlus({n}), DiMinus({n}))'),
    I('di_dead', '+DI가 -DI 하향돌파', DMIP, 'CrossDown(DiPlus({n}), DiMinus({n}))'),
    I('adx_trend_up', '강한 상승 추세 (ADX 이상, +DI > -DI)', DMIP.concat([P('lv', 'ADX 이상', 25)]), 'ADX({n}) >= {lv} and DiPlus({n}) > DiMinus({n})'),
    I('adx_trend_dn', '강한 하락 추세 (ADX 이상, -DI > +DI)', DMIP.concat([P('lv', 'ADX 이상', 25)]), 'ADX({n}) >= {lv} and DiMinus({n}) > DiPlus({n})'),
    I('adx_rising_up', 'ADX 상승 중 + 상승 방향', DMIP, 'A = ADX({n}); A > A(1) and DiPlus({n}) > DiMinus({n})'),
    I('adx_weak', '추세 없음 (ADX 이하)', DMIP.concat([P('lv', 'ADX 이하', 20)]), 'ADX({n}) <= {lv}'),
    I('adx_above_di', 'ADX가 +DI·-DI 모두 위', DMIP, 'A = ADX({n}); A > DiPlus({n}) and A > DiMinus({n})'),
    I('di_golden_adx', '+DI 골든크로스 + ADX 상승', DMIP, 'A = ADX({n}); CrossUp(DiPlus({n}), DiMinus({n})) and A > A(1)'),
  ]);
  folder('추세·채널', '아룬', [
    I('aroon_up100', 'Aroon Up 100 (신고가 직후)', [P('n', '기간', 25)], 'AroonUp({n}) >= 100'),
    I('aroon_dn100', 'Aroon Down 100 (신저가 직후)', [P('n', '기간', 25)], 'AroonDown({n}) >= 100'),
    I('aroon_golden', 'Aroon Up이 Down 상향돌파', [P('n', '기간', 25)], 'CrossUp(AroonUp({n}), AroonDown({n}))'),
    I('aroon_dead', 'Aroon Up이 Down 하향돌파', [P('n', '기간', 25)], 'CrossDown(AroonUp({n}), AroonDown({n}))'),
    I('aroon_strong', '강한 상승 (Up ≥ 70, Down ≤ 30)', [P('n', '기간', 25)], 'AroonUp({n}) >= 70 and AroonDown({n}) <= 30'),
  ]);
  folder('추세·채널', '선형회귀', [
    I('lr_above', '주가가 회귀선 위', [P('n', '기간', 50)], 'C > LinReg(C, {n})'),
    I('lr_below', '주가가 회귀선 아래', [P('n', '기간', 50)], 'C < LinReg(C, {n})'),
    I('lr_cross_up', '회귀선 상향돌파', [P('n', '기간', 50)], 'CrossUp(C, LinReg(C, {n}))'),
    I('lr_slope_pos', '회귀 기울기 양수 전환', [P('n', '기간', 50)], 'S = LinRegSlope(C, {n}); S > 0 and S(1) <= 0'),
    I('lr_slope_neg', '회귀 기울기 음수 전환', [P('n', '기간', 50)], 'S = LinRegSlope(C, {n}); S < 0 and S(1) >= 0'),
    I('lr_channel_low', '회귀 채널 하단 (회귀값 - 표준편차 × 배) 터치', [P('n', '기간', 50), P('d', '배', 2, 0.1)], 'R = LinReg(C, {n}); L <= R - {d} * stdev(C, {n})'),
    I('lr_channel_high', '회귀 채널 상단 터치', [P('n', '기간', 50), P('d', '배', 2, 0.1)], 'R = LinReg(C, {n}); H >= R + {d} * stdev(C, {n})'),
  ]);
  folder('추세·채널', '피봇 포인트 (전일 기준)', [
    I('pv_above', '주가가 피봇 위', [], 'C > Pivot()'),
    I('pv_below', '주가가 피봇 아래', [], 'C < Pivot()'),
    I('pv_cross_up', '피봇 상향돌파', [], 'CrossUp(C, Pivot())'),
    I('pv_cross_dn', '피봇 하향돌파', [], 'CrossDown(C, Pivot())'),
    I('pv_r1_break', '1차 저항(R1) 돌파', [], 'CrossUp(C, PivotR1())'),
    I('pv_r2_break', '2차 저항(R2) 돌파', [], 'CrossUp(C, PivotR2())'),
    I('pv_s1_break', '1차 지지(S1) 이탈', [], 'CrossDown(C, PivotS1())'),
    I('pv_s2_break', '2차 지지(S2) 이탈', [], 'CrossDown(C, PivotS2())'),
    I('pv_s1_bounce', 'S1 터치 후 반등', [], 'S = PivotS1(); L <= S and C > S'),
    I('pv_r1_reject', 'R1 터치 후 밀림', [], 'R = PivotR1(); H >= R and C < R'),
  ]);

  // -----------------------------------------------------------------------------
  // 시세분석
  // -----------------------------------------------------------------------------
  folder('시세분석', '신고가·신저가', [
    I('new_high', 'N봉 신고가 (고가)', [P('n', '기간', 20)], 'H >= highest(H, {n})'),
    I('new_low', 'N봉 신저가 (저가)', [P('n', '기간', 20)], 'L <= lowest(L, {n})'),
    I('new_high_close', 'N봉 최고 종가', [P('n', '기간', 20)], 'C >= highest(C, {n})'),
    I('new_low_close', 'N봉 최저 종가', [P('n', '기간', 20)], 'C <= lowest(C, {n})'),
    I('break_high', '직전 N봉 최고가 종가 돌파', [P('n', '기간', 20)], 'C > highest(H, {n}, 1)'),
    I('break_low', '직전 N봉 최저가 종가 이탈', [P('n', '기간', 20)], 'C < lowest(L, {n}, 1)'),
    I('first_new_high', 'N봉 신고가 첫 발생 (최근 M봉 동안 없었음)', [P('n', '기간', 60), P('cnt', 'M봉', 10)], 'X = H >= highest(H, {n}); X and sum(if(X, 1, 0), {cnt}) == 1'),
    I('near_high', 'N봉 최고가 근처 (% 이내)', [P('n', '기간', 60), P('p', '% 이내', 1, 0.1)], 'HH = highest(H, {n}); (HH - C) / HH * 100 <= {p}'),
    I('near_low', 'N봉 최저가 근처 (% 이내)', [P('n', '기간', 60), P('p', '% 이내', 1, 0.1)], 'LL = lowest(L, {n}); (C - LL) / LL * 100 <= {p}'),
    I('drop_from_high', 'N봉 최고가 대비 하락률 (% 이상)', [P('n', '기간', 60), P('p', '% 이상', 5, 0.1)], 'HH = highest(H, {n}); (HH - C) / HH * 100 >= {p}'),
    I('rise_from_low', 'N봉 최저가 대비 상승률 (% 이상)', [P('n', '기간', 60), P('p', '% 이상', 5, 0.1)], 'LL = lowest(L, {n}); (C - LL) / LL * 100 >= {p}'),
    I('high_bars_ago', 'N봉 최고가가 M봉 이내에 발생', [P('n', '기간', 60), P('cnt', 'M봉 이내', 5)], 'highestbars(H, {n}) < {cnt}'),
    I('low_bars_ago', 'N봉 최저가가 M봉 이내에 발생', [P('n', '기간', 60), P('cnt', 'M봉 이내', 5)], 'lowestbars(L, {n}) < {cnt}'),
  ]);
  folder('시세분석', '등락률', [
    I('chg_bar', '전봉 대비 등락률 범위 (%)', [P('lo', '% 이상', 0.5, 0.1), P('hi', '% 이하', 100, 0.1)], 'between((C - C(1)) / C(1) * 100, {lo}, {hi})'),
    I('chg_day', '전일 종가 대비 등락률 범위 (%)', [P('lo', '% 이상', 1, 0.1), P('hi', '% 이하', 100, 0.1)], 'PC = PredayClose(); between((C - PC) / PC * 100, {lo}, {hi})'),
    I('chg_n', 'N봉 전 대비 등락률 범위 (%)', [P('n', 'N봉', 10), P('lo', '% 이상', 2, 0.1), P('hi', '% 이하', 100, 0.1)], 'between((C - C({n})) / C({n}) * 100, {lo}, {hi})'),
    I('chg_dayopen', '당일 시가 대비 등락률 범위 (%)', [P('lo', '% 이상', 0.5, 0.1), P('hi', '% 이하', 100, 0.1)], 'DO = DayOpen(); between((C - DO) / DO * 100, {lo}, {hi})'),
    I('chg_bar_open', '봉 시가 대비 등락률 범위 (%)', [P('lo', '% 이상', 0.3, 0.1), P('hi', '% 이하', 100, 0.1)], 'between((C - O) / O * 100, {lo}, {hi})'),
    I('chg_n_rank_up', 'N봉 동안 상승한 봉 비율 (% 이상)', [P('n', 'N봉', 20), P('p', '% 이상', 60)], 'sum(if(C > C(1), 1, 0), {n}) / {n} * 100 >= {p}'),
    I('day_range_pct', '당일 변동폭 (고가-저가) % 이상', [P('p', '% 이상', 1, 0.1)], '(DayHigh() - DayLow()) / DayLow() * 100 >= {p}'),
  ]);
  folder('시세분석', '가격 위치', [
    I('price_range', '가격 범위', [P('lo', '이상', 0), P('hi', '이하', 1000000)], 'between(C, {lo}, {hi})'),
    I('above_dayopen', '당일 시가 위', [], 'C > DayOpen()'),
    I('below_dayopen', '당일 시가 아래', [], 'C < DayOpen()'),
    I('above_daymid', '당일 중심가 위 ((고가+저가)/2)', [], 'C > (DayHigh() + DayLow()) / 2'),
    I('day_high_now', '당일 고가 갱신 중', [], 'H >= DayHigh()'),
    I('day_low_now', '당일 저가 갱신 중', [], 'L <= DayLow()'),
    I('preday_high_break', '전일 고가 상향돌파', [], 'CrossUp(C, PredayHigh())'),
    I('preday_low_break', '전일 저가 하향이탈', [], 'CrossDown(C, PredayLow())'),
    I('above_preday_close', '전일 종가 위', [], 'C > PredayClose()'),
    I('above_preday_high', '전일 고가 위', [], 'C > PredayHigh()'),
    I('below_preday_low', '전일 저가 아래', [], 'C < PredayLow()'),
    I('inside_preday', '전일 범위 안 (전일 고가~저가 사이)', [], 'C <= PredayHigh() and C >= PredayLow()'),
    I('open_eq_low', '시가 = 저가 (봉, % 이내)', [P('p', '% 이내', 0.02, 0.01)], '(O - L) / O * 100 <= {p} and C > O'),
    I('open_eq_high', '시가 = 고가 (봉, % 이내)', [P('p', '% 이내', 0.02, 0.01)], '(H - O) / O * 100 <= {p} and C < O'),
    I('close_near_high', '종가가 봉 고가 근처 (범위의 % 이내)', [P('p', '% 이내', 10)], 'H > L and (H - C) / (H - L) * 100 <= {p}'),
    I('close_near_low', '종가가 봉 저가 근처 (범위의 % 이내)', [P('p', '% 이내', 10)], 'H > L and (C - L) / (H - L) * 100 <= {p}'),
    I('box_n', 'N봉 박스권 (고저 폭 % 이하)', [P('n', '기간', 20), P('w', '폭 % 이하', 1, 0.1)], '(highest(H, {n}) - lowest(L, {n})) / lowest(L, {n}) * 100 <= {w}'),
    I('box_break_up', 'N봉 박스권 상단 돌파', [P('n', '박스 기간', 20), P('w', '박스 폭 % 이하', 1, 0.1)], 'HH = highest(H, {n}, 1); LL = lowest(L, {n}, 1); (HH - LL) / LL * 100 <= {w} and C > HH'),
    I('box_break_dn', 'N봉 박스권 하단 이탈', [P('n', '박스 기간', 20), P('w', '박스 폭 % 이하', 1, 0.1)], 'HH = highest(H, {n}, 1); LL = lowest(L, {n}, 1); (HH - LL) / LL * 100 <= {w} and C < LL'),
    I('round_number', '라운드 넘버 돌파 (단위)', [P('u', '단위', 100)], 'R = floor(C / {u}) * {u}; C >= R and C(1) < R'),
  ]);
  folder('시세분석', '갭', [
    I('gap_up', '갭 상승 (%)', [P('p', '% 이상', 0.3, 0.1)], '(O - C(1)) / C(1) * 100 >= {p}'),
    I('gap_dn', '갭 하락 (%)', [P('p', '% 이상', 0.3, 0.1)], '(C(1) - O) / C(1) * 100 >= {p}'),
    I('gap_up_full', '완전 갭 상승 (저가 > 전봉 고가)', [], 'L > H(1)'),
    I('gap_dn_full', '완전 갭 하락 (고가 < 전봉 저가)', [], 'H < L(1)'),
    I('gap_fill_up', '갭 하락 메우기 (전봉 종가 회복)', [P('p', '갭 % 이상', 0.3, 0.1)], '(C(1) - O) / C(1) * 100 >= {p} and C >= C(1)'),
    I('gap_fill_dn', '갭 상승 메우기 (전봉 종가 하회)', [P('p', '갭 % 이상', 0.3, 0.1)], '(O - C(1)) / C(1) * 100 >= {p} and C <= C(1)'),
    I('gap_up_hold', '갭 상승 후 양봉 유지', [P('p', '갭 % 이상', 0.3, 0.1)], '(O - C(1)) / C(1) * 100 >= {p} and C > O'),
    I('day_gap_up', '당일 시가 갭 상승 (전일 종가 대비 %)', [P('p', '% 이상', 0.3, 0.1)], 'PC = PredayClose(); (DayOpen() - PC) / PC * 100 >= {p}'),
    I('day_gap_dn', '당일 시가 갭 하락 (전일 종가 대비 %)', [P('p', '% 이상', 0.3, 0.1)], 'PC = PredayClose(); (PC - DayOpen()) / PC * 100 >= {p}'),
  ]);
  folder('시세분석', '연속', [
    I('consec_up', 'N봉 연속 양봉', [P('n', '봉 수', 3)], 'sum(if(C > O, 1, 0), {n}) == {n}'),
    I('consec_dn', 'N봉 연속 음봉', [P('n', '봉 수', 3)], 'sum(if(C < O, 1, 0), {n}) == {n}'),
    I('consec_rise', 'N봉 연속 종가 상승', [P('n', '봉 수', 3)], 'sum(if(C > C(1), 1, 0), {n}) == {n}'),
    I('consec_fall', 'N봉 연속 종가 하락', [P('n', '봉 수', 3)], 'sum(if(C < C(1), 1, 0), {n}) == {n}'),
    I('higher_highs', 'N봉 연속 고점 상승', [P('n', '봉 수', 3)], 'sum(if(H > H(1), 1, 0), {n}) == {n}'),
    I('higher_lows', 'N봉 연속 저점 상승', [P('n', '봉 수', 3)], 'sum(if(L > L(1), 1, 0), {n}) == {n}'),
    I('lower_highs', 'N봉 연속 고점 하락', [P('n', '봉 수', 3)], 'sum(if(H < H(1), 1, 0), {n}) == {n}'),
    I('lower_lows', 'N봉 연속 저점 하락', [P('n', '봉 수', 3)], 'sum(if(L < L(1), 1, 0), {n}) == {n}'),
    I('up_after_down', 'N봉 연속 하락 후 첫 상승', [P('n', '하락 봉 수', 3)], 'C > C(1) and sum(if(C < C(1), 1, 0), {n}, 1) == {n}'),
    I('down_after_up', 'N봉 연속 상승 후 첫 하락', [P('n', '상승 봉 수', 3)], 'C < C(1) and sum(if(C > C(1), 1, 0), {n}, 1) == {n}'),
    I('bull_ratio', '최근 N봉 중 양봉 M개 이상', [P('n', 'N봉', 10), P('cnt', 'M개 이상', 7)], 'sum(if(C > O, 1, 0), {n}) >= {cnt}'),
  ]);
  folder('시세분석', '변동성', [
    I('atr_range', 'ATR % 범위', [P('n', 'ATR 기간', 14), P('lo', '% 이상', 0.5, 0.1), P('hi', '% 이하', 100, 0.1)], 'between(ATR({n}) / C * 100, {lo}, {hi})'),
    I('bar_range_pct', '봉 범위 (고가-저가) % 이상', [P('p', '% 이상', 0.5, 0.1)], '(H - L) / L * 100 >= {p}'),
    I('bar_range_atr', '봉 범위가 ATR의 N배 이상', [P('n', 'ATR 기간', 14), P('x', '배 이상', 2, 0.1)], 'H - L >= ATR({n}) * {x}'),
    I('vol_contract', '변동성 수축 (ATR < ATR 이평)', [P('n', 'ATR 기간', 14), P('m', '이평 기간', 50)], 'A = ATR({n}); A < avg(A, {m})'),
    I('vol_expand', '변동성 확대 (ATR > ATR 이평 × 배)', [P('n', 'ATR 기간', 14), P('m', '이평 기간', 50), P('x', '배', 1.5, 0.1)], 'A = ATR({n}); A > avg(A, {m}) * {x}'),
    I('nr_n', 'NR-N (최근 N봉 중 범위가 가장 좁은 봉)', [P('n', 'N봉', 7)], 'R = H - L; R <= lowest(R, {n})'),
    I('wr_n', 'WR-N (최근 N봉 중 범위가 가장 넓은 봉)', [P('n', 'N봉', 7)], 'R = H - L; R >= highest(R, {n})'),
    I('hv_low', '역사적 변동성 낮음 (표준편차 % 이하)', [P('n', '기간', 20), P('p', '% 이하', 0.5, 0.1)], 'stdev(C, {n}) / C * 100 <= {p}'),
    I('atr_breakout', 'ATR 돌파 (전봉 종가 + ATR × 배 상향)', [P('n', 'ATR 기간', 14), P('x', '배', 1, 0.1)], 'C > C(1) + shift(ATR({n}), 1) * {x}'),
  ]);

  // -----------------------------------------------------------------------------
  // 거래량분석 (CFD 거래량은 틱 거래량)
  // -----------------------------------------------------------------------------
  folder('거래량분석', '거래량', [
    I('vol_spike', '거래량 급증 (이전 평균 대비 배)', [P('n', '평균 기간', 20), P('x', '배 이상', 2, 0.1)], 'V >= avg(V, {n}, 1) * {x}'),
    I('vol_dry', '거래량 감소 (이전 평균 대비 배 이하)', [P('n', '평균 기간', 20), P('x', '배 이하', 0.5, 0.1)], 'V <= avg(V, {n}, 1) * {x}'),
    I('vol_max_n', 'N봉 최대 거래량', [P('n', '기간', 20)], 'V >= highest(V, {n})'),
    I('vol_min_n', 'N봉 최소 거래량', [P('n', '기간', 20)], 'V <= lowest(V, {n})'),
    I('vol_ma_golden', '거래량 이평 골든크로스', [P('s', '단기', 5), P('l', '장기', 20)], 'CrossUp(avg(V, {s}), avg(V, {l}))'),
    I('vol_ma_dead', '거래량 이평 데드크로스', [P('s', '단기', 5), P('l', '장기', 20)], 'CrossDown(avg(V, {s}), avg(V, {l}))'),
    I('vol_above_ma', '거래량이 이평 위', [P('n', '이평 기간', 20)], 'V > avg(V, {n})'),
    I('vol_rising', '거래량 N봉 연속 증가', [P('n', '봉 수', 3)], 'sum(if(V > V(1), 1, 0), {n}) == {n}'),
    I('vol_price_up', '가격 상승 + 거래량 증가', [P('n', '평균 기간', 20), P('x', '배 이상', 1.5, 0.1)], 'C > C(1) and V >= avg(V, {n}, 1) * {x}'),
    I('vol_price_dn', '가격 하락 + 거래량 증가', [P('n', '평균 기간', 20), P('x', '배 이상', 1.5, 0.1)], 'C < C(1) and V >= avg(V, {n}, 1) * {x}'),
    I('vol_spike_bull', '거래량 급증 양봉', [P('n', '평균 기간', 20), P('x', '배 이상', 2, 0.1)], 'C > O and V >= avg(V, {n}, 1) * {x}'),
    I('vol_spike_bear', '거래량 급증 음봉', [P('n', '평균 기간', 20), P('x', '배 이상', 2, 0.1)], 'C < O and V >= avg(V, {n}, 1) * {x}'),
    I('vol_climax', '거래량 클라이맥스 (N봉 최대 거래량 + 긴 꼬리)', [P('n', '기간', 50)], 'V >= highest(V, {n}) and (H - max(C, O) > abs(C - O) or min(C, O) - L > abs(C - O))'),
    I('vol_break_high', '거래량 동반 신고가 돌파', [P('n', '기간', 20), P('x', '거래량 배 이상', 1.5, 0.1)], 'C > highest(H, {n}, 1) and V >= avg(V, {n}, 1) * {x}'),
    I('account_min', '거래대금 (종가×거래량) 이상', [P('v', '이상', 1000000)], 'account >= {v}'),
    I('vwap_above', '롤링 VWAP 위 (N봉)', [P('n', '기간', 24)], 'C > sum(C * V, {n}) / sum(V, {n})'),
    I('vwap_cross_up', '롤링 VWAP 상향돌파 (N봉)', [P('n', '기간', 24)], 'CrossUp(C, sum(C * V, {n}) / sum(V, {n}))'),
  ]);

  // -----------------------------------------------------------------------------
  // 패턴분석
  // -----------------------------------------------------------------------------
  const BODY = 'BD = abs(C - O); RG = H - L; UW = H - max(C, O); LW = min(C, O) - L; ';
  folder('패턴분석', '단일 캔들', [
    I('big_bull', '장대양봉 (몸통 ≥ ATR × 배)', [P('n', 'ATR 기간', 14), P('x', '배', 1.5, 0.1)], 'C > O and C - O >= ATR({n}) * {x}'),
    I('big_bear', '장대음봉 (몸통 ≥ ATR × 배)', [P('n', 'ATR 기간', 14), P('x', '배', 1.5, 0.1)], 'C < O and O - C >= ATR({n}) * {x}'),
    I('big_bull_pct', '장대양봉 (시가 대비 % 이상)', [P('p', '% 이상', 1, 0.1)], '(C - O) / O * 100 >= {p}'),
    I('big_bear_pct', '장대음봉 (시가 대비 % 이상)', [P('p', '% 이상', 1, 0.1)], '(O - C) / O * 100 >= {p}'),
    I('hammer', '망치형 (아래꼬리 ≥ 몸통 × 2)', [], BODY + 'BD > 0 and LW >= BD * 2 and UW <= BD * 0.5'),
    I('inv_hammer', '역망치형 (위꼬리 ≥ 몸통 × 2)', [], BODY + 'BD > 0 and UW >= BD * 2 and LW <= BD * 0.5'),
    I('hanging_man', '교수형 (상승 추세 중 망치형)', [P('n', '추세 이평', 20)], BODY + 'BD > 0 and LW >= BD * 2 and UW <= BD * 0.5 and C > avg(C, {n}) and avg(C, {n}) > avg(C, {n}, 3)'),
    I('shooting_star', '유성형 (상승 추세 중 역망치형)', [P('n', '추세 이평', 20)], BODY + 'BD > 0 and UW >= BD * 2 and LW <= BD * 0.5 and C > avg(C, {n})'),
    I('hammer_downtrend', '하락 추세 중 망치형 (바닥 신호)', [P('n', '추세 이평', 20)], BODY + 'BD > 0 and LW >= BD * 2 and UW <= BD * 0.5 and C < avg(C, {n})'),
    I('doji', '도지 (몸통 ≤ 범위의 %)', [P('p', '% 이하', 10)], 'H > L and abs(C - O) <= (H - L) * {p} / 100'),
    I('dragonfly', '잠자리형 도지 (긴 아래꼬리)', [P('p', '몸통 % 이하', 10)], BODY + 'RG > 0 and BD <= RG * {p} / 100 and UW <= RG * 0.1 and LW >= RG * 0.6'),
    I('gravestone', '비석형 도지 (긴 위꼬리)', [P('p', '몸통 % 이하', 10)], BODY + 'RG > 0 and BD <= RG * {p} / 100 and LW <= RG * 0.1 and UW >= RG * 0.6'),
    I('long_legged_doji', '긴 다리 도지', [P('p', '몸통 % 이하', 10)], BODY + 'RG > 0 and BD <= RG * {p} / 100 and UW >= RG * 0.3 and LW >= RG * 0.3'),
    I('spinning_top', '팽이형 (작은 몸통, 위아래 꼬리)', [], BODY + 'RG > 0 and BD <= RG * 0.3 and BD > RG * 0.1 and UW >= BD and LW >= BD'),
    I('marubozu_bull', '양봉 마루보주 (꼬리 거의 없음)', [P('p', '꼬리 % 이하', 5)], BODY + 'C > O and RG > 0 and UW + LW <= RG * {p} / 100'),
    I('marubozu_bear', '음봉 마루보주 (꼬리 거의 없음)', [P('p', '꼬리 % 이하', 5)], BODY + 'C < O and RG > 0 and UW + LW <= RG * {p} / 100'),
    I('pinbar_bull', '상승 핀바 (아래꼬리 ≥ 범위의 %)', [P('p', '% 이상', 66)], BODY + 'RG > 0 and LW >= RG * {p} / 100'),
    I('pinbar_bear', '하락 핀바 (위꼬리 ≥ 범위의 %)', [P('p', '% 이상', 66)], BODY + 'RG > 0 and UW >= RG * {p} / 100'),
    I('long_upper', '긴 위꼬리 (위꼬리 ≥ 몸통 × 배)', [P('x', '배', 3, 0.1)], BODY + 'UW >= max(BD, RG * 0.05) * {x}'),
    I('long_lower', '긴 아래꼬리 (아래꼬리 ≥ 몸통 × 배)', [P('x', '배', 3, 0.1)], BODY + 'LW >= max(BD, RG * 0.05) * {x}'),
  ]);
  folder('패턴분석', '2봉 패턴', [
    I('bull_engulf', '상승장악형', [], 'C(1) < O(1) and C > O and C >= O(1) and O <= C(1)'),
    I('bear_engulf', '하락장악형', [], 'C(1) > O(1) and C < O and C <= O(1) and O >= C(1)'),
    I('bull_harami', '상승잉태형', [], 'C(1) < O(1) and C > O and C < O(1) and O > C(1)'),
    I('bear_harami', '하락잉태형', [], 'C(1) > O(1) and C < O and C > O(1) and O < C(1)'),
    I('harami_cross', '잉태 십자형', [P('p', '도지 몸통 % 이하', 10)], 'abs(C(1) - O(1)) > 0 and H < max(O(1), C(1)) and L > min(O(1), C(1)) and abs(C - O) <= (H - L) * {p} / 100'),
    I('piercing', '관통형', [], 'C(1) < O(1) and O < C(1) and C > (O(1) + C(1)) / 2 and C < O(1)'),
    I('dark_cloud', '흑운형', [], 'C(1) > O(1) and O > C(1) and C < (O(1) + C(1)) / 2 and C > O(1)'),
    I('tweezer_bottom', '집게형 바닥 (저가 비슷, % 이내)', [P('p', '% 이내', 0.05, 0.01)], 'C(1) < O(1) and C > O and abs(L - L(1)) / L * 100 <= {p}'),
    I('tweezer_top', '집게형 천장 (고가 비슷, % 이내)', [P('p', '% 이내', 0.05, 0.01)], 'C(1) > O(1) and C < O and abs(H - H(1)) / H * 100 <= {p}'),
    I('bull_counter', '상승 반격형 (종가가 전봉 종가 근처)', [P('p', '% 이내', 0.05, 0.01)], 'C(1) < O(1) and C > O and O < C(1) and abs(C - C(1)) / C * 100 <= {p}'),
    I('bear_counter', '하락 반격형', [P('p', '% 이내', 0.05, 0.01)], 'C(1) > O(1) and C < O and O > C(1) and abs(C - C(1)) / C * 100 <= {p}'),
    I('inside_bar', '인사이드 바', [], 'H < H(1) and L > L(1)'),
    I('outside_bar', '아웃사이드 바', [], 'H > H(1) and L < L(1)'),
    I('outside_bull', '상승 아웃사이드 바 (양봉)', [], 'H > H(1) and L < L(1) and C > O and C > H(1)'),
    I('key_rev_up', '상승 키 리버설 (신저가 후 전봉 종가 위)', [P('n', '신저가 기간', 10)], 'L <= lowest(L, {n}) and C > C(1)'),
    I('key_rev_dn', '하락 키 리버설 (신고가 후 전봉 종가 아래)', [P('n', '신고가 기간', 10)], 'H >= highest(H, {n}) and C < C(1)'),
    I('bull_belt', '상승 샅바형 (시가=저가 장대양봉)', [P('p', '% 이내', 0.02, 0.01)], 'C > O and (O - L) / O * 100 <= {p} and C - O >= (H - L) * 0.7 and C(1) < O(1)'),
    I('bear_belt', '하락 샅바형 (시가=고가 장대음봉)', [P('p', '% 이내', 0.02, 0.01)], 'C < O and (H - O) / O * 100 <= {p} and O - C >= (H - L) * 0.7 and C(1) > O(1)'),
  ]);
  folder('패턴분석', '3봉 이상 패턴', [
    I('morning_star', '샛별형', [], 'B2 = abs(C(2) - O(2)); C(2) < O(2) and abs(C(1) - O(1)) <= B2 * 0.3 and C > O and C > (O(2) + C(2)) / 2'),
    I('evening_star', '석별형', [], 'B2 = abs(C(2) - O(2)); C(2) > O(2) and abs(C(1) - O(1)) <= B2 * 0.3 and C < O and C < (O(2) + C(2)) / 2'),
    I('morning_doji', '십자 샛별형', [P('p', '도지 몸통 % 이하', 10)], 'C(2) < O(2) and abs(C(1) - O(1)) <= (H(1) - L(1)) * {p} / 100 and C > O and C > (O(2) + C(2)) / 2'),
    I('evening_doji', '십자 석별형', [P('p', '도지 몸통 % 이하', 10)], 'C(2) > O(2) and abs(C(1) - O(1)) <= (H(1) - L(1)) * {p} / 100 and C < O and C < (O(2) + C(2)) / 2'),
    I('three_soldiers', '적삼병', [], 'C > O and C(1) > O(1) and C(2) > O(2) and C > C(1) and C(1) > C(2)'),
    I('three_crows', '흑삼병', [], 'C < O and C(1) < O(1) and C(2) < O(2) and C < C(1) and C(1) < C(2)'),
    I('three_inside_up', '상승 삼내부형 (잉태 후 상승 확인)', [], 'C(2) < O(2) and C(1) > O(1) and C(1) < O(2) and O(1) > C(2) and C > O(2)'),
    I('three_inside_dn', '하락 삼내부형', [], 'C(2) > O(2) and C(1) < O(1) and C(1) > O(2) and O(1) < C(2) and C < O(2)'),
    I('three_outside_up', '상승 삼외부형 (장악 후 상승 확인)', [], 'C(2) < O(2) and C(1) > O(1) and C(1) >= O(2) and O(1) <= C(2) and C > C(1)'),
    I('three_outside_dn', '하락 삼외부형', [], 'C(2) > O(2) and C(1) < O(1) and C(1) <= O(2) and O(1) >= C(2) and C < C(1)'),
    I('rising_three', '상승 삼법형 (장대양봉, 작은 3봉, 양봉 돌파)', [], 'C(4) > O(4) and max(H(3), H(2), H(1)) < H(4) and min(L(3), L(2), L(1)) > L(4) and C > O and C > C(4)'),
    I('falling_three', '하락 삼법형', [], 'C(4) < O(4) and max(H(3), H(2), H(1)) < H(4) and min(L(3), L(2), L(1)) > L(4) and C < O and C < C(4)'),
    I('abandoned_baby_bull', '상승 버려진 아기형 (갭 도지)', [], 'C(2) < O(2) and H(1) < L(2) and abs(C(1) - O(1)) <= (H(1) - L(1)) * 0.1 and L > H(1) and C > O'),
    I('three_white_small', '적삼병 (몸통 커짐)', [], 'C > O and C(1) > O(1) and C(2) > O(2) and C - O > C(1) - O(1) and C(1) - O(1) > C(2) - O(2)'),
    I('double_bottom_rough', '쌍바닥 근사 (두 저점 % 이내 + 넥라인 돌파)', [P('n', '기간', 30), P('p', '저점 차이 % 이내', 0.5, 0.1)],
      'L1 = lowest(L, {n}); B1 = lowestbars(L, {n}); L2 = lowest(L, floor({n} / 3)); B1 >= floor({n} / 3) and abs(L2 - L1) / L1 * 100 <= {p} and C > highest(H, B1)'),
    I('double_top_rough', '쌍봉 근사 (두 고점 % 이내 + 넥라인 이탈)', [P('n', '기간', 30), P('p', '고점 차이 % 이내', 0.5, 0.1)],
      'H1 = highest(H, {n}); B1 = highestbars(H, {n}); H2 = highest(H, floor({n} / 3)); B1 >= floor({n} / 3) and abs(H2 - H1) / H1 * 100 <= {p} and C < lowest(L, B1)'),
  ]);

  const PRESETS = [];
  PRESET_TREE.forEach(function (c) { c.folders.forEach(function (f) { f.items.forEach(function (it) { PRESETS.push(it); }); }); });
  // 이전 버전에서 저장된 항목 이름 호환
  const PRESET_ALIAS = {
    rsi_range: 'osc_rsi_range', rsi_up: 'osc_rsi_xup', rsi_dn: 'osc_rsi_xdn', stoch_range: 'osc_stoK_range',
    cci_range: 'osc_cci_range', cci_up: 'osc_cci_xup', wr_range: 'osc_wr_range', mfi_range: 'osc_mfi_range',
    momentum_up: 'osc_mom_xup', obv_up: 'osc_obv_sgc',
  };
  function presetById(id) { return PRESET_MAP[id] || PRESET_MAP[PRESET_ALIAS[id]]; }

  // =============================================================================
  // 페이지 통합: 차트 커스텀 지표 + 수식관리자 + 조건검색
  // (빌드 시 ccfMain() 안에 engine.js 다음으로 들어가며, ENG = ccFormulaEngine())
  // =============================================================================
  const ENG = ccFormulaEngine();
  const LOG = '[CC 수식]';

  // -----------------------------------------------------------------------------
  // 저장소
  // -----------------------------------------------------------------------------
  const LS_KEY = 'ccf-library-v1';
  const LS_SYMBOLS = 'ccf-symbols-v1';
  const LS_UI = 'ccf-ui-v1';

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lsGet(k, d) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function seedLib() {
    return {
      version: 1,
      defs: [
        { id: uid(), type: 'indicator', name: 'MACD 세트', overlay: false, vars: { 단기: 12, 장기: 26, 시그널: 9 },
          desc: 'MACD, 시그널, 오실레이터를 한 창에 표시',
          lines: [
            { name: 'MACD', formula: 'eavg(C, 단기) - eavg(C, 장기)', color: '#2962FF', width: 2, style: 'line' },
            { name: '시그널', formula: 'M = eavg(C, 단기) - eavg(C, 장기);\neavg(M, 시그널)', color: '#FF6D00', width: 1, style: 'line' },
            { name: '오실레이터', formula: 'M = eavg(C, 단기) - eavg(C, 장기);\nM - eavg(M, 시그널)', color: '#26A69A', width: 3, style: 'histogram' },
          ],
          bands: [{ value: 0, color: '#787B86' }] },
        { id: uid(), type: 'indicator', name: 'RSI + 이평 (지표 조합)', overlay: false, vars: { 기간: 14, 이평: 9 },
          desc: 'RSI와 RSI의 이동평균을 겹쳐서 표시하는 조합 예시',
          lines: [
            { name: 'RSI', formula: 'RSI(기간)', color: '#7E57C2', width: 2, style: 'line' },
            { name: 'RSI 이평', formula: 'avg(RSI(기간), 이평)', color: '#FFB300', width: 1, style: 'line' },
          ],
          bands: [{ value: 70, color: '#F23645' }, { value: 50, color: '#787B86' }, { value: 30, color: '#089981' }] },
        { id: uid(), type: 'indicator', name: '스토캐스틱 RSI', overlay: false, vars: { RSI기간: 14, 스토기간: 14, K: 3, D: 3 },
          desc: 'RSI에 스토캐스틱 공식을 적용 (지표 위의 지표)',
          lines: [
            { name: '%K', formula: 'R = RSI(RSI기간);\nHH = highest(R, 스토기간); LL = lowest(R, 스토기간);\navg(if(HH == LL, 50, (R - LL) / (HH - LL) * 100), K)', color: '#2962FF', width: 2, style: 'line' },
            { name: '%D', formula: 'R = RSI(RSI기간);\nHH = highest(R, 스토기간); LL = lowest(R, 스토기간);\navg(avg(if(HH == LL, 50, (R - LL) / (HH - LL) * 100), K), D)', color: '#FF6D00', width: 1, style: 'line' },
          ],
          bands: [{ value: 80, color: '#F23645' }, { value: 20, color: '#089981' }] },
        { id: uid(), type: 'indicator', name: '이평 리본', overlay: true, vars: { 이평1: 5, 이평2: 20, 이평3: 60, 이평4: 120 },
          desc: '가격 차트 위에 이동평균 4개',
          lines: [
            { name: '이평1', formula: 'avg(C, 이평1)', color: '#F23645', width: 1, style: 'line' },
            { name: '이평2', formula: 'avg(C, 이평2)', color: '#FFB300', width: 1, style: 'line' },
            { name: '이평3', formula: 'avg(C, 이평3)', color: '#26A69A', width: 2, style: 'line' },
            { name: '이평4', formula: 'avg(C, 이평4)', color: '#7E57C2', width: 2, style: 'line' },
          ], bands: [] },
        { id: uid(), type: 'signal', name: '이평 골든·데드크로스', overlay: true, vars: { 단기: 5, 장기: 20 },
          desc: '단기 이평이 장기 이평을 상향 돌파하면 매수, 하향 돌파하면 매도',
          signal: { buy: 'A = avg(C, 단기); B = avg(C, 장기);\nCrossUp(A, B)', sell: 'A = avg(C, 단기); B = avg(C, 장기);\nCrossDown(A, B)' } },
        { id: uid(), type: 'signal', name: 'RSI 과매도 탈출', overlay: true, vars: { 기간: 14, 침체: 30, 과열: 70 },
          desc: 'RSI가 침체선을 상향 돌파하면 매수, 과열선을 하향 돌파하면 매도',
          signal: { buy: 'CrossUp(RSI(기간), 침체)', sell: 'CrossDown(RSI(기간), 과열)' } },
        { id: uid(), type: 'strategy', name: 'MACD 크로스 전략', overlay: true, vars: { 단기: 12, 장기: 26, 시그널기간: 9 },
          desc: '키움 도움말의 MACD 크로스 예제',
          strategy: {
            mode: 'both',
            buyEntry: 'A = eavg(C, 단기); B = eavg(C, 장기); M = A - B;\nSignal = eavg(M, 시그널기간);\nCrossUp(M, Signal)',
            buyExit: 'A = eavg(C, 단기); B = eavg(C, 장기); M = A - B;\nSignal = eavg(M, 시그널기간);\nCrossDown(M, Signal)',
            sellEntry: 'A = eavg(C, 단기); B = eavg(C, 장기); M = A - B;\nSignal = eavg(M, 시그널기간);\nCrossDown(M, Signal)',
            sellExit: 'A = eavg(C, 단기); B = eavg(C, 장기); M = A - B;\nSignal = eavg(M, 시그널기간);\nCrossUp(M, Signal)',
          } },
        { id: uid(), type: 'strength', name: '20이평 강세약세', overlay: true, vars: { 기간: 20 },
          desc: '종가가 상승 중인 이평 위면 강세, 하락 중인 이평 아래면 약세로 봉 색칠',
          strength: { bull: 'A = avg(C, 기간);\nC > A and A > A(1)', bear: 'A = avg(C, 기간);\nC < A and A < A(1)', bullColor: '#FFD600', bearColor: '#2962FF' } },
      ],
      funcs: [
        { id: uid(), name: 'MAO', params: ['short', 'long'], body: 'avg(C, short) - avg(C, long)', desc: '이평 오실레이터 (키움 도움말 예제)' },
      ],
      conds: [
        { id: uid(), name: '골든크로스 + RSI 50 이상', logic: 'A and B', target: { kind: 'all', list: '' }, bars: 500,
          items: [
            { preset: 'ma_golden', params: { s: 5, l: 20 }, res: '60', offset: 0, within: 3 },
            { preset: 'rsi_range', params: { n: 14, lo: 50, hi: 100 }, res: '60', offset: 0, within: 1 },
          ] },
      ],
    };
  }

  let LIB = loadLib();
  function loadLib() {
    const o = lsGet(LS_KEY, null);
    if (o && Array.isArray(o.defs)) {
      o.funcs = o.funcs || []; o.conds = o.conds || [];
      return o;
    }
    const s = seedLib();
    lsSet(LS_KEY, s);
    return s;
  }
  function saveLib() {
    if (!lsSet(LS_KEY, LIB)) toast('브라우저 저장소에 저장하지 못했습니다', 'err');
  }
  window.addEventListener('storage', function (e) { if (e.key === LS_KEY) { LIB = loadLib(); if (UI.manager) UI.manager.refresh(); if (UI.search) UI.search.refreshList(); } });

  function findDef(name) { return LIB.defs.find(function (d) { return d.name === name; }); }
  function funcsFor(d) { return LIB.funcs.concat((d && d.funcs) || []); }

  // -----------------------------------------------------------------------------
  // 차트 접근
  // -----------------------------------------------------------------------------
  function tvFrame() { return document.querySelector('iframe[id^="tradingview_"]'); }
  function tvApi() { const f = tvFrame(); try { return f && f.contentWindow.tradingViewApi; } catch (e) { return null; } }
  function activeChart() { const a = tvApi(); try { return a ? a.activeChart() : null; } catch (e) { return null; } }
  function datafeed() { const f = tvFrame(); const o = f && window[f.id]; return o && o.datafeed; }

  // -----------------------------------------------------------------------------
  // 차트용 커스텀 지표 2종 (보조 창 / 가격 차트)
  //   plot 0~4 수식1~5, 5~7 기준선, 8 매수(진입), 9 매도(진입), 10 매수청산, 11 매도청산, 12 강세약세 봉 색
  // -----------------------------------------------------------------------------
  const STUDY_PANE = 'CC 사용자 수식';
  const STUDY_PRICE = 'CC 사용자 수식 (가격)';
  const PLOT_TYPES = { line: 0, histogram: 1, cross: 3, area: 4, columns: 5, circles: 6, breaks: 7, step: 9 };
  const PLOT_TYPE_NAMES = [['line', '선'], ['breaks', '끊김 선'], ['histogram', '히스토그램'], ['columns', '막대'], ['circles', '점'], ['area', '영역'], ['step', '계단']];
  const SHAPES = [
    { title: '매수 (진입)', shape: 'shape_triangle_up', location: 'BelowBar', color: '#F23645', text: '매수' },
    { title: '매도 (진입)', shape: 'shape_triangle_down', location: 'AboveBar', color: '#2962FF', text: '매도' },
    { title: '매수청산', shape: 'shape_xcross', location: 'AboveBar', color: '#FF9800', text: '매수청산' },
    { title: '매도청산', shape: 'shape_xcross', location: 'BelowBar', color: '#00BCD4', text: '매도청산' },
  ];
  const LINE_COLORS = ['#2962FF', '#FF6D00', '#26A69A', '#E91E63', '#7E57C2'];

  function buildMetainfo(overlay) {
    const name = overlay ? STUDY_PRICE : STUDY_PANE;
    const plots = [], styles = {}, defStyles = {};
    for (let j = 0; j < 5; j++) {
      plots.push({ id: 'plot_' + j, type: 'line' });
      styles['plot_' + j] = { title: '수식' + (j + 1), histogramBase: 0 };
      defStyles['plot_' + j] = { linestyle: 0, linewidth: 2, plottype: 0, trackPrice: false, transparency: 0, visible: true, color: LINE_COLORS[j] };
    }
    for (let j = 0; j < 3; j++) {
      const id = 'plot_' + (5 + j);
      plots.push({ id: id, type: 'line' });
      styles[id] = { title: '기준선' + (j + 1), histogramBase: 0 };
      defStyles[id] = { linestyle: 2, linewidth: 1, plottype: 0, trackPrice: false, transparency: 20, visible: true, color: '#787B86' };
    }
    // 신호 마커와 봉 색칠은 가격 차트용에만 둔다.
    // (보조 창에 있으면 마커 위치 계산 때문에 세로 축이 가격 범위까지 늘어나 선이 납작해진다)
    if (overlay) {
      SHAPES.forEach(function (s, j) {
        const id = 'plot_' + (8 + j);
        plots.push({ id: id, type: 'shapes' });
        styles[id] = { title: s.title, isHidden: false, size: 'small', text: s.text };
        defStyles[id] = { plottype: s.shape, location: s.location, visible: true, color: s.color, textColor: s.color, transparency: 0 };
      });
      plots.push({ id: 'plot_12', type: 'bar_colorer', palette: 'palette_12' });
      styles.plot_12 = { title: '강세약세', isHidden: false };
    }
    const meta = {
      _metainfoVersion: 53,
      id: (overlay ? 'CCFormulaPrice' : 'CCFormulaPane') + '@tv-basicstudies-1',
      name: name,
      description: name,
      shortDescription: overlay ? '수식(가격)' : '수식',
      is_price_study: overlay,
      isCustomIndicator: true,
      format: overlay ? { type: 'inherit' } : { type: 'price', precision: 4 },
      plots: plots,
      styles: styles,
      inputs: [
        { id: 'name', name: '수식 이름 (수식관리자에 저장된 이름)', defval: '', type: 'text' },
        { id: 'vars', name: '지표변수 바꾸기 (예: 단기=5, 장기=20)', defval: '', type: 'text' },
        { id: 'rev', name: '갱신 번호', defval: 0, type: 'integer', min: 0, max: 1000000000, isHidden: true },
      ],
      defaults: {
        styles: defStyles,
        inputs: { name: '', vars: '', rev: 0 },
      },
    };
    if (overlay) {
      meta.palettes = { palette_12: { colors: [{ name: '강세' }, { name: '약세' }], valToIndex: { 0: 0, 1: 1 } } };
      meta.defaults.palettes = { palette_12: { colors: [{ color: '#FFD600' }, { color: '#2962FF' }] } };
    }
    return meta;
  }

  const EMPTY_OUT = new Array(13).fill(NaN);
  const EMPTY_PANE = new Array(8).fill(NaN);
  const reportedErrors = new Set();

  // 수식 정의 → 슬롯별 수식 (0~4 선, 5~7 기준선, 8~11 신호, 12 강세, 13 약세)
  function defSlots(d) {
    const s = new Array(14).fill(null);
    if (d.type === 'indicator') {
      (d.lines || []).slice(0, 5).forEach(function (ln, j) { if (ln && ln.formula && ln.formula.trim()) s[j] = ln.formula; });
      (d.bands || []).slice(0, 3).forEach(function (b, j) { if (b && b.value !== '' && b.value !== null && isFinite(+b.value)) s[5 + j] = String(+b.value); });
    } else if (d.type === 'signal') {
      const g = d.signal || {};
      s[8] = g.buy || null; s[9] = g.sell || null;
    } else if (d.type === 'strategy') {
      const g = d.strategy || {};
      s[8] = g.buyEntry || null; s[9] = g.sellEntry || null; s[10] = g.buyExit || null; s[11] = g.sellExit || null;
    } else if (d.type === 'strength') {
      const g = d.strength || {};
      s[12] = g.bull || null; s[13] = g.bear || null;
    }
    return s.map(function (x) { return x && String(x).trim() ? x : null; });
  }
  const SLOT_LABEL = ['수식1', '수식2', '수식3', '수식4', '수식5', '기준선1', '기준선2', '기준선3', '매수(진입)', '매도(진입)', '매수청산', '매도청산', '강세', '약세'];

  // 정의 하나를 계산할 수 있게 컴파일 (ctx 공유)
  function compileDef(d, varsOverride, ctx) {
    const vars = Object.assign({}, d.vars || {}, varsOverride || {});
    const table = ENG.buildFuncTable(funcsFor(d));
    ctx = ctx || ENG.makeCtx();
    const slots = defSlots(d);
    const progs = slots.map(function (src, j) {
      if (!src) return null;
      try { return ENG.compile(src, { ctx: ctx, funcTable: table, vars: vars }); } catch (e) {
        const err = new Error(SLOT_LABEL[j] + ': ' + e.message); err.slot = j; throw err;
      }
    });
    return { ctx: ctx, progs: progs, strategy: d.type === 'strategy', mode: (d.strategy && d.strategy.mode) || 'both', pos: [] };
  }

  // 전략: 포지션 상태에 맞는 신호만 남긴다 (진입 중복, 포지션 없는 청산 제거)
  function strategyStep(rt, i, be, se, bx, sx) {
    const prev = i > 0 ? (rt.pos[i - 1] || 0) : 0;
    const allowLong = rt.mode !== 'short', allowShort = rt.mode !== 'long';
    let p = prev, oBE = 0, oSE = 0, oBX = 0, oSX = 0;
    if (p === 1 && (bx || (se && allowShort))) { oBX = 1; p = 0; }
    else if (p === -1 && (sx || (be && allowLong))) { oSX = 1; p = 0; }
    if (p === 0) {
      if (be && allowLong && prev !== 1) { oBE = 1; p = 1; }
      else if (se && allowShort && prev !== -1) { oSE = 1; p = -1; }
    }
    rt.pos[i] = p;
    return [oBE, oSE, oBX, oSX];
  }

  function evalBar(rt, i) {
    const v = rt.progs.map(function (p) { return p ? p.run(i) : NaN; });
    const out = new Array(13);
    for (let j = 0; j < 8; j++) out[j] = v[j];
    const t = ENG.truthy;
    if (rt.strategy) {
      const s = strategyStep(rt, i, t(v[8]), t(v[9]), t(v[10]), t(v[11]));
      for (let j = 0; j < 4; j++) out[8 + j] = s[j] ? 1 : NaN;
    } else {
      for (let j = 8; j < 12; j++) out[j] = t(v[j]) ? 1 : NaN;
    }
    out[12] = t(v[12]) ? 0 : t(v[13]) ? 1 : NaN;
    return out;
  }

  function makeStudy(overlay) {
    return {
      name: overlay ? STUDY_PRICE : STUDY_PANE,
      metainfo: buildMetainfo(overlay),
      constructor: function () {
        this.init = function () { this._rt = null; };
        this.main = function (context, input) {
          const Std = window.__ccfPineStd;
          const name = String(input(0) || '').trim(), vars = String(input(1) || ''), rev = input(2);
          const t = Std.time(context);
          let rt = this._rt;
          const k = name + '\u0001' + vars + '\u0001' + rev;
          if (!rt || rt.key !== k || (rt.lastT !== null && t < rt.lastT)) {
            rt = this._rt = { key: k, lastT: null, i: -1 };
            const d = findDef(name);
            try {
              if (!name) throw new Error('지표 설정에서 수식 이름을 입력하세요');
              if (!d) throw new Error("수식관리자에 '" + name + "'이(가) 없습니다");
              Object.assign(rt, compileDef(d, ENG.parseVars(vars)));
            } catch (e) {
              rt.error = e.message;
              const ek = name + '|' + e.message;
              if (!reportedErrors.has(ek)) { reportedErrors.add(ek); toast('수식 오류 [' + (name || '이름 없음') + '] ' + e.message, 'err', 8000); console.warn(LOG, e.message); }
            }
          }
          if (rt.error) return overlay ? EMPTY_OUT : EMPTY_PANE;
          const i = rt.lastT === null ? 0 : (t === rt.lastT ? rt.i : rt.i + 1);
          rt.i = i; rt.lastT = t;
          rt.ctx.set(i, { time: t, open: Std.open(context), high: Std.high(context), low: Std.low(context), close: Std.close(context), volume: Std.volume(context) });
          const out = evalBar(rt, i);
          return overlay ? out : out.slice(0, 8);
        };
      },
    };
  }

  function customIndicators(PineJS) {
    window.__ccfPineStd = PineJS.Std;
    return [makeStudy(false), makeStudy(true)];
  }

  function patchWidget(id) {
    const opts = window[id];
    if (!opts || opts.__ccfPatched) return;
    const orig = opts.getCustomIndicators;
    opts.getCustomIndicators = async function (PineJS) {
      const base = orig ? (await orig.call(this, PineJS)) || [] : [];
      return base.concat(customIndicators(PineJS));
    };
    opts.__ccfPatched = true;
    console.log(LOG, '사용자 수식 지표 주입:', id);
  }

  // -----------------------------------------------------------------------------
  // 차트에 적용
  // -----------------------------------------------------------------------------
  // 키 형식: 'styles.plot_N.속성' (차트 라이브러리에서 확인한 형식)
  function styleOverrides(d) {
    const o = {};
    const S = function (j, prop, v) { o['styles.plot_' + j + '.' + prop] = v; };
    const slots = defSlots(d);
    const overlay = d.type !== 'indicator' || !!d.overlay;
    for (let j = 0; j < 5; j++) {
      const ln = (d.lines || [])[j];
      if (slots[j] && ln) {
        S(j, 'visible', true);
        S(j, 'color', ln.color || LINE_COLORS[j]);
        S(j, 'linewidth', +ln.width || 1);
        S(j, 'plottype', PLOT_TYPES[ln.style] !== undefined ? PLOT_TYPES[ln.style] : 0);
      } else S(j, 'visible', false);
    }
    for (let j = 0; j < 3; j++) {
      const b = (d.bands || [])[j];
      S(5 + j, 'visible', !!slots[5 + j]);
      if (slots[5 + j] && b && b.color) S(5 + j, 'color', b.color);
    }
    if (!overlay) return o;
    for (let j = 0; j < 4; j++) S(8 + j, 'visible', !!slots[8 + j]);
    S(12, 'visible', !!(slots[12] || slots[13]));
    if (d.type === 'strength' && d.strength) {
      o['palettes.palette_12.colors.0.color'] = d.strength.bullColor || '#FFD600';
      o['palettes.palette_12.colors.1.color'] = d.strength.bearColor || '#2962FF';
    }
    return o;
  }

  function studiesUsing(name) {
    const chart = activeChart();
    if (!chart) return [];
    const out = [];
    chart.getAllStudies().forEach(function (s) {
      if (s.name !== STUDY_PANE && s.name !== STUDY_PRICE) return;
      try {
        const st = chart.getStudyById(s.id);
        const inputs = st.getInputValues();
        const nm = (inputs.find(function (x) { return x.id === 'name'; }) || {}).value;
        if (name === undefined || nm === name) out.push(st);
      } catch (e) { /* 무시 */ }
    });
    return out;
  }

  async function applyToChart(d) {
    const chart = activeChart();
    if (!chart) { toast('차트가 아직 준비되지 않았습니다', 'err'); return; }
    const overlay = d.type !== 'indicator' || !!d.overlay;
    const studyName = overlay ? STUDY_PRICE : STUDY_PANE;
    try {
      const id = await chart.createStudy(studyName, false, false, { name: d.name, vars: '', rev: Date.now() % 1000000000 });
      const st = chart.getStudyById(id);
      try { st.applyOverrides(styleOverrides(d)); } catch (e) { console.warn(LOG, '스타일 적용 실패', e); }
      toast("'" + d.name + "'을(를) 차트에 추가했습니다", 'ok');
    } catch (e) {
      console.warn(LOG, e);
      toast('차트에 추가하지 못했습니다: ' + (e && e.message ? e.message : e) + ' (페이지를 새로고침한 뒤 다시 시도하세요)', 'err', 8000);
    }
  }

  // 저장 후 차트에 이미 올라간 같은 이름의 지표를 다시 계산
  function refreshStudies(oldName, d) {
    studiesUsing(oldName).forEach(function (st) {
      try {
        st.setInputValues([{ id: 'name', value: d.name }, { id: 'rev', value: Date.now() % 1000000000 }]);
        st.applyOverrides(styleOverrides(d));
      } catch (e) { console.warn(LOG, e); }
    });
  }

  // -----------------------------------------------------------------------------
  // 데이터: 종목 목록, 봉 조회
  // -----------------------------------------------------------------------------
  const RES_LIST = [['1', '1분'], ['5', '5분'], ['15', '15분'], ['30', '30분'], ['60', '1시간'], ['240', '4시간'], ['D', '일'], ['W', '주'], ['M', '월']];
  const RES_SEC = { 1: 60, 5: 300, 15: 900, 30: 1800, 60: 3600, 240: 14400, D: 86400, W: 604800, M: 2678400 };
  function resLabel(r) { const x = RES_LIST.find(function (p) { return p[0] === r; }); return x ? x[1] : r; }
  function chartRes() {
    const c = activeChart(); if (!c) return '60';
    const r = String(c.resolution());
    if (r === '1D') return 'D'; if (r === '1W') return 'W'; if (r === '1M') return 'M';
    return r;
  }

  let symbolCache = lsGet(LS_SYMBOLS, null);
  async function loadSymbols(force) {
    if (symbolCache && !force && symbolCache.list && symbolCache.list.length && Date.now() - symbolCache.at < 86400000) return symbolCache.list;
    const df = datafeed();
    if (!df) throw new Error('차트 데이터 연결을 찾지 못했습니다');
    const all = new Map();
    const qs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
    for (const q of qs) {
      const r = await new Promise(function (res) { try { df.searchSymbols(q, '', '', res); } catch (e) { res([]); } });
      (r || []).forEach(function (s) { const k = s.symbol || s.ticker; if (k) all.set(k, { symbol: k, desc: s.description || '' }); });
    }
    const list = Array.from(all.values()).sort(function (a, b) { return a.symbol.localeCompare(b.symbol); });
    symbolCache = { at: Date.now(), list: list };
    lsSet(LS_SYMBOLS, symbolCache);
    return list;
  }

  const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'SEK', 'NOK', 'DKK', 'HKD', 'SGD', 'ZAR', 'MXN', 'TRY', 'PLN', 'CNH', 'HUF', 'CZK']);
  function category(s) {
    const n = s.symbol.toUpperCase(), d = (s.desc || '').toLowerCase();
    if (n.length === 6 && FIAT.has(n.slice(0, 3)) && FIAT.has(n.slice(3))) return 'fx';
    if (/^(XAU|XAG|XPT|XPD)/.test(n)) return 'cmd';
    if (/index|indices|225|30|100|500|2000|40|50/.test(d) || /\d/.test(n) || /IND$/.test(n)) return 'idx';
    if (/vs us dollar|bitcoin|ethereum|crypto/.test(d) || /^(BTC|ETH|XRP|ADA|DOG|TRX|LNK|LTC|SOL|BNB|DOT|AVX|AVAX|MATIC|XLM|BCH|SHIB|UNI)/.test(n)) return 'crypto';
    return 'cmd';
  }
  const TARGETS = [['all', '전체 종목'], ['fav', '관심종목 (Favorites)'], ['fx', '외환'], ['idx', '지수'], ['cmd', '원자재·금속'], ['crypto', '암호화폐'], ['list', '직접 지정']];

  function favoriteSymbols() {
    const els = document.querySelectorAll('.trade-favorites__list-items .trade-instrument-symbol__symbol, .trade-favorites__list-items .trade-instrument-symbol-name__wrapper');
    const set = new Set();
    els.forEach(function (e) { const t = (e.textContent || '').trim().split(/\s/)[0]; if (t) set.add(t); });
    const arr = Array.from(set);
    if (arr.length) lsSet('ccf-favs', arr);
    return arr.length ? arr : lsGet('ccf-favs', []);
  }

  async function targetSymbols(target) {
    const kind = (target && target.kind) || 'all';
    if (kind === 'list') return String(target.list || '').split(/[\s,]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    if (kind === 'fav') return favoriteSymbols();
    const list = await loadSymbols();
    return list.filter(function (s) { return kind === 'all' || category(s) === kind; }).map(function (s) { return s.symbol; });
  }

  const symInfoCache = new Map();
  function resolveSym(sym) {
    if (symInfoCache.has(sym)) return symInfoCache.get(sym);
    const df = datafeed();
    const p = new Promise(function (res, rej) {
      if (!df) { rej(new Error('데이터 연결 없음')); return; }
      df.resolveSymbol(sym, res, function (e) { rej(new Error(String(e || '종목을 찾을 수 없음'))); });
    });
    symInfoCache.set(sym, p);
    p.catch(function () { symInfoCache.delete(sym); });
    return p;
  }
  const barCache = new Map();
  async function fetchBars(sym, res, count) {
    const ck = sym + '|' + res + '|' + count;
    const hit = barCache.get(ck);
    if (hit && Date.now() - hit.at < 20000) return hit.bars;
    const info = await resolveSym(sym);
    const df = datafeed();
    const to = Math.floor(Date.now() / 1000) + 60;
    const from = to - Math.min(count * (RES_SEC[res] || 3600) * 3, 86400 * 365 * 20);
    const bars = await new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () { if (!done) { done = true; reject(new Error('응답 시간 초과')); } }, 15000);
      df.getBars(info, res, { from: from, to: to, countBack: count, firstDataRequest: true },
        function (b) { if (done) return; done = true; clearTimeout(timer); resolve(b || []); },
        function (e) { if (done) return; done = true; clearTimeout(timer); reject(new Error(String(e))); });
    });
    bars.sort(function (a, b) { return a.time - b.time; });
    const trimmed = bars.length > count ? bars.slice(bars.length - count) : bars;
    barCache.set(ck, { at: Date.now(), bars: trimmed });
    return trimmed;
  }

  async function pool(items, n, fn) {
    let k = 0;
    const workers = new Array(Math.min(n, items.length)).fill(0).map(async function () {
      while (k < items.length) { const idx = k++; await fn(items[idx], idx); }
    });
    await Promise.all(workers);
  }

  // -----------------------------------------------------------------------------
  // 사이트 방식으로 종목 열기 (차트 API로 바꾸면 주문 패널과 어긋나므로 사이트 검색 사용)
  // -----------------------------------------------------------------------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function waitFor(fn, ms) {
    const end = Date.now() + (ms || 3000);
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  }
  async function openSymbol(sym) {
    const market = document.querySelector('#desktopMarket');
    if (!market) { toast('종목 패널을 찾지 못했습니다. 사이트에서 ' + sym + '을(를) 직접 선택하세요', 'err'); return false; }
    // 검색 전에 보고 있던 탭(Favorites / 상승·하락 상위)을 기억해 두었다가 돌아간다
    const prevTab = market.querySelector('[data-testid="fav-tab-button"].ui-tab--selected, [data-testid="top-movers-tab-button"].ui-tab--selected');
    let input = market.querySelector('input[placeholder*="검색"], input[placeholder*="earch"]');
    if (!input) {
      let btn = market.querySelector('[data-testid="symbols-tab-button"]');
      if (!btn) btn = Array.from(market.querySelectorAll('ui-tab, button, [role="button"]')).find(function (b) {
        const u = b.querySelector('use');
        const href = u ? (u.getAttribute('xlink:href') || u.getAttribute('href') || '') : '';
        return /search/i.test(href);
      });
      if (btn) btn.click();
      input = await waitFor(function () { return market.querySelector('input[placeholder*="검색"], input[placeholder*="earch"]'); }, 2000);
    }
    if (!input) { toast('검색창을 열지 못했습니다. ' + sym + '을(를) 직접 선택하세요', 'err'); return false; }
    input.focus();
    input.value = sym;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = await waitFor(function () {
      return Array.from(market.querySelectorAll('.trade-symbol-search-results__row-item-symbol')).find(function (r) {
        const s = r.querySelector('.trade-instrument-symbol__symbol');
        return s && s.textContent.trim().split(/\s/)[0] === sym;
      });
    }, 4000);
    if (!row) { toast(sym + ' 검색 결과가 없습니다', 'err'); return false; }
    row.click();
    await sleep(400);
    const back = prevTab || market.querySelector('[data-testid="fav-tab-button"]');
    if (back) back.click();
    const ok = await waitFor(function () { const c = activeChart(); return c && c.symbol() === sym; }, 3000);
    if (!ok) toast(sym + '을(를) 여는 중입니다… 바뀌지 않으면 사이트에서 직접 선택하세요');
    return !!ok;
  }

  // -----------------------------------------------------------------------------
  // 조건검색: 조건 항목 (프리셋은 수식 템플릿)
  // -----------------------------------------------------------------------------
  const WHICH = { signal: [['buy', '매수 신호'], ['sell', '매도 신호']], strategy: [['buyEntry', '매수진입'], ['buyExit', '매수청산'], ['sellEntry', '매도진입'], ['sellExit', '매도청산']], strength: [['bull', '강세'], ['bear', '약세']] };

  function paramValue(preset, params, k) {
    const p = preset.params.find(function (x) { return x.k === k; });
    const raw = params ? params[k] : undefined;
    if (p && p.options) return p.options.indexOf(raw) >= 0 ? raw : p.def;
    const v = raw !== undefined && raw !== '' ? +raw : NaN;
    return isFinite(v) ? v : (p ? p.def : 0);
  }
  function fillTemplate(f, params, preset) {
    return f.replace(/\{(\w+)\}/g, function (_, k) { return String(paramValue(preset, params, k)); });
  }
  // 조건 항목 → { src, funcs, label }
  function itemFormula(it) {
    if (it.preset === 'formula') return { src: it.formula || '', funcs: LIB.funcs, label: '수식: ' + oneLine(it.formula || '') };
    if (it.preset === 'user') {
      const d = LIB.defs.find(function (x) { return x.name === it.defName; });
      if (!d) throw new Error("수식관리자에 '" + it.defName + "'이(가) 없습니다");
      let src = null;
      if (d.type === 'signal') src = (d.signal || {})[it.which || 'buy'];
      else if (d.type === 'strategy') src = (d.strategy || {})[it.which || 'buyEntry'];
      else if (d.type === 'strength') src = (d.strength || {})[it.which || 'bull'];
      else { const ln = (d.lines || [])[+(it.which || 0)] || (d.lines || [])[0]; src = ln ? ln.formula : null; }
      if (!src) throw new Error("'" + d.name + "'에 선택한 수식이 비어 있습니다");
      const opt = (WHICH[d.type] || []).find(function (w) { return w[0] === it.which; });
      return { src: src, funcs: funcsFor(d), vars: d.vars || {}, label: '사용자: ' + d.name + (opt ? ' · ' + opt[1] : '') };
    }
    const p = presetById(it.preset);
    if (!p) throw new Error('알 수 없는 조건 항목: ' + it.preset);
    const paramText = p.params.map(function (x) { return x.label + ' ' + paramValue(p, it.params, x.k); }).join(', ');
    return { src: fillTemplate(p.f, it.params, p), funcs: LIB.funcs, label: p.grp + ' › ' + p.name + (paramText ? ' (' + paramText + ')' : '') };
  }
  function oneLine(s) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 57) + '…' : s; }
  function letters(n) { return Array.from({ length: n }, function (_, i) { return String.fromCharCode(65 + i); }); }

  // 항목 평가: 기준봉(offset) 기준 최근 within봉 안에 한 번이라도 참이면 충족
  function itemHit(series, it) {
    const n = series.length;
    const end = n - 1 - (Math.max(0, +it.offset || 0));
    const w = Math.max(1, +it.within || 1);
    for (let i = end; i > end - w && i >= 0; i--) if (ENG.truthy(series[i])) return { ok: true, at: i };
    return { ok: false };
  }

  async function runCondition(cond, onProgress) {
    const items = cond.items || [];
    if (!items.length) throw new Error('조건을 하나 이상 추가하세요');
    const L = letters(items.length);
    const logicSrc = (cond.logic && cond.logic.trim()) || L.join(' and ');
    const logic = ENG.compileLogic(logicSrc, L);
    const forms = items.map(function (it, j) {
      const f = itemFormula(it);
      // 미리 컴파일해서 오류를 먼저 알린다
      try { ENG.compile(f.src, { userFuncs: f.funcs, vars: f.vars }); } catch (e) { throw new Error(L[j] + ' 조건 오류: ' + e.message); }
      return f;
    });
    const syms = await targetSymbols(cond.target);
    if (!syms.length) throw new Error('검색 대상 종목이 없습니다');
    const count = Math.max(100, Math.min(5000, +cond.bars || 500));
    const byRes = {};
    items.forEach(function (it, j) { const r = it.res || '60'; (byRes[r] || (byRes[r] = [])).push(j); });
    const resKeys = Object.keys(byRes);
    const results = [], errors = [];
    let done = 0;
    const t0 = performance.now();
    await pool(syms, 4, async function (sym) {
      try {
        const hits = new Array(items.length);
        let last = null, chg = NaN, at = null, dec = null;
        try { const info = await resolveSym(sym); if (info && info.pricescale) dec = Math.max(0, Math.round(Math.log10(info.pricescale))); } catch (e) { /* 자릿수 모름 */ }
        for (const r of resKeys) {
          let bars = await fetchBars(sym, r, count);
          // 완성된 봉 기준: 지금 만들어지고 있는 마지막 봉은 빼고 계산
          if (cond.closedOnly && bars.length > 2) bars = bars.slice(0, -1);
          if (bars.length < 2) throw new Error('봉 데이터 부족');
          const idxs = byRes[r];
          // 같은 주기 항목은 한 번에 계산 (사용자함수·지표변수가 다르면 따로)
          const outs = idxs.map(function (j) { return ENG.runOnBars(bars, [forms[j].src], { userFuncs: forms[j].funcs, vars: forms[j].vars })[0]; });
          idxs.forEach(function (j, q) {
            const h = itemHit(outs[q], items[j]);
            hits[j] = h.ok;
            if (h.ok && (at === null || bars[h.at].time > at)) at = bars[h.at].time;
          });
          if (!last) {
            const b = bars[bars.length - 1];
            last = b.close;
            const pc = ENG.runOnBars(bars, ['PredayClose()'])[0];
            const p = pc[pc.length - 1];
            chg = isFinite(p) && p ? (b.close - p) / p * 100 : (bars.length > 1 ? (b.close - bars[bars.length - 2].close) / bars[bars.length - 2].close * 100 : NaN);
          }
        }
        const m = {};
        L.forEach(function (l, j) { m[l] = !!hits[j]; });
        if (logic(m)) results.push({ symbol: sym, price: last, dec: dec, chg: chg, hits: m, at: at });
      } catch (e) {
        errors.push(sym + ': ' + e.message);
      }
      done++;
      if (onProgress) onProgress(done, syms.length);
    });
    results.sort(function (a, b) { return a.symbol.localeCompare(b.symbol); });
    return { results: results, errors: errors, total: syms.length, ms: performance.now() - t0, letters: L };
  }

  // 조건식 → 차트 신호 수식 (조건 항목마다 사용자함수로 감싸서 변수 이름 충돌 방지)
  function conditionToDef(cond) {
    const items = cond.items || [];
    const L = letters(items.length);
    const funcs = [];
    const lines = [];
    items.forEach(function (it, j) {
      const f = itemFormula(it);
      const fname = '조건_' + L[j];
      let body = f.src;
      if (f.vars && Object.keys(f.vars).length) body = Object.keys(f.vars).map(function (k) { return k + ' = ' + f.vars[k] + ';'; }).join(' ') + '\n' + body;
      funcs.push({ name: fname, params: [], body: body });
      const w = Math.max(1, +it.within || 1), off = Math.max(0, +it.offset || 0);
      if (w === 1 && off === 0) lines.push(L[j] + ' = ' + fname + '();');
      else lines.push(L[j] + ' = highest(if(' + fname + '(), 1, 0), ' + w + (off ? ', ' + off : '') + ') == 1;');
    });
    const logic = (cond.logic && cond.logic.trim()) || L.join(' and ');
    const src = lines.join('\n') + '\n' + logic;
    const resSet = new Set(items.map(function (it) { return it.res || '60'; }));
    return { def: { id: uid(), type: 'signal', name: '조건검색: ' + cond.name, overlay: true, vars: {}, desc: '조건검색 "' + cond.name + '"에서 만든 신호', signal: { buy: src, sell: '' }, funcs: funcs }, resSet: resSet };
  }

  // -----------------------------------------------------------------------------
  // 수식검증 / 성과검증 / 자동수정용 실행 점검
  // -----------------------------------------------------------------------------
  // 정의 하나의 수식 칸 목록 (이름, 슬롯 번호, 읽기/쓰기)
  function formulaFields(d) {
    const F = [];
    const f = function (label, slot, obj, k) { if (obj) F.push({ label: label, slot: slot, kind: slot < 8 ? 'value' : 'cond', get: function () { return obj[k] || ''; }, set: function (v) { obj[k] = v; } }); };
    if (d.type === 'indicator') (d.lines || []).slice(0, 5).forEach(function (ln, j) { f(ln.name || ('수식' + (j + 1)), j, ln, 'formula'); });
    if (d.type === 'signal') { f('매수 신호', 8, d.signal, 'buy'); f('매도 신호', 9, d.signal, 'sell'); }
    if (d.type === 'strategy') { f('매수진입', 8, d.strategy, 'buyEntry'); f('매도진입', 9, d.strategy, 'sellEntry'); f('매수청산', 10, d.strategy, 'buyExit'); f('매도청산', 11, d.strategy, 'sellExit'); }
    if (d.type === 'strength') { f('강세 조건', 12, d.strength, 'bull'); f('약세 조건', 13, d.strength, 'bear'); }
    return F;
  }
  async function chartBars(n) {
    const chart = activeChart();
    if (!chart) return null;
    const sym = chart.symbol(), res = chartRes();
    return { sym: sym, res: res, bars: await fetchBars(sym, res, n || 1000) };
  }
  // 슬롯별 원래 값(참/거짓 변환 전)
  function runSlots(d, bars) {
    const ctx = ENG.makeCtx();
    const rt = compileDef(d, null, ctx);
    const raw = rt.progs.map(function () { return new Array(bars.length); });
    for (let i = 0; i < bars.length; i++) { ctx.set(i, bars[i]); rt.progs.forEach(function (pg, j) { raw[j][i] = pg ? pg.run(i) : NaN; }); }
    return raw;
  }
  function countTrue(d, src, bars) {
    const one = ENG.runOnBars(bars, [src], { userFuncs: funcsFor(d), vars: d.vars })[0];
    return one.filter(function (x) { return ENG.truthy(x); }).length;
  }
  // 문법은 맞지만 결과가 이상한 경우를 찾는다. fix 가 있으면 자동수정으로 고칠 수 있음
  function semanticIssues(d, bars) {
    const N = bars.length, out = [];
    if (!N) return out;
    const raw = runSlots(d, bars);
    formulaFields(d).forEach(function (fd) {
      const src = fd.get();
      if (!src || !src.trim()) return;
      const vals = raw[fd.slot] || [];
      let fin = 0, tr = 0, lo = Infinity, hi = -Infinity, bin = true;
      vals.forEach(function (x) {
        if (isFinite(x)) { fin++; if (x < lo) lo = x; if (x > hi) hi = x; if (x !== 0 && x !== 1) bin = false; }
        if (ENG.truthy(x)) tr++;
      });
      if (!fin) { out.push({ label: fd.label, msg: '계산 결과가 전부 "값 없음"이에요. 기간이 봉 개수(' + N + '개)보다 길거나, 0으로 나누는 부분이 있는지 확인하세요.' }); return; }
      if (fd.kind === 'value') {
        if (lo === hi) out.push({ label: fd.label, msg: '값이 계속 ' + (+lo.toPrecision(6)) + '(으)로 똑같아요. 수식이 의도대로인지 확인하세요.' });
        else if (bin) out.push({ label: fd.label, msg: '0과 1만 나와요. 참/거짓 조건식이라 선이 계단 모양이 돼요. 신호로 쓰려면 [신호검색] 탭에 만드세요.' });
        return;
      }
      if (tr === 0) {
        let msg = N + '봉 동안 한 번도 참이 아니에요.';
        try {
          const parts = ENG.splitAnd(src);
          const dead = parts.filter(function (pt) { try { return countTrue(d, pt.src, bars) === 0; } catch (e) { return false; } });
          if (dead.length) msg += ' 막는 부분: ' + dead.map(function (pt) { return '"' + pt.text + '"'; }).join(', ') + ' (이 부분이 한 번도 참이 아니에요).';
          else if (parts.length) msg += ' 조건 하나하나는 참이 되는데 동시에 참인 봉이 없어요. 서로 반대인 조건이 없는지 보세요.';
          else msg += ' 숫자 범위(예: RSI는 0~100)나 비교 방향(> <)을 확인하세요.';
        } catch (e) { /* 무시 */ }
        out.push({ label: fd.label, msg: msg });
        return;
      }
      if (d.type === 'signal' && N >= 50 && tr / N > 0.2) {
        const msg = '신호가 ' + N + '봉 중 ' + tr + '번(' + Math.round(tr / N * 100) + '%) 나와서 거의 매 봉 표시돼요. "A > B"처럼 상태를 쓰면 조건이 계속되는 동안 매 봉 신호가 나요.';
        let fix = null;
        try {
          const ev = ENG.toEventFormula(src);
          ENG.compile(ev.src, { funcTable: ENG.buildFuncTable(funcsFor(d)), vars: d.vars });
          fix = { field: fd, src: ev.src, how: ev.how };
        } catch (e) { fix = null; }
        out.push({ label: fd.label, msg: msg, fix: fix });
      }
    });
    return out;
  }

  async function verifyDef(d) {
    // 1) 컴파일
    compileDef(d);
    // 2) 현재 차트 종목·주기 데이터로 계산
    const chart = activeChart();
    if (!chart) return { text: '문법 정상 (차트가 없어 계산은 건너뜀)' };
    const sym = chart.symbol(), res = chartRes();
    const bars = await fetchBars(sym, res, 1000);
    const ctx = ENG.makeCtx();
    const rt = compileDef(d, null, ctx);
    const outs = [];
    for (let i = 0; i < bars.length; i++) { ctx.set(i, bars[i]); outs.push(evalBar(rt, i)); }
    const lines = ['문법 정상 · ' + sym + ' ' + resLabel(res) + '봉 ' + bars.length + '개로 계산'];
    const last = outs[outs.length - 1] || [];
    const fmt = function (x) { return isFinite(x) ? (Math.abs(x) >= 1000 ? x.toFixed(2) : +x.toPrecision(6)) : '값 없음'; };
    if (d.type === 'indicator') {
      (d.lines || []).forEach(function (ln, j) { if (ln.formula && ln.formula.trim()) lines.push((ln.name || '수식' + (j + 1)) + ' 마지막 값: ' + fmt(last[j])); });
    } else if (d.type === 'signal') {
      const nb = outs.filter(function (o) { return o[8] === 1; }).length, ns = outs.filter(function (o) { return o[9] === 1; }).length;
      lines.push('매수 신호 ' + nb + '회, 매도 신호 ' + ns + '회');
      const lastSig = lastIndex(outs, function (o) { return o[8] === 1 || o[9] === 1; });
      if (lastSig >= 0) lines.push('마지막 신호: ' + (outs[lastSig][8] === 1 ? '매수' : '매도') + ' · ' + fmtTime(bars[lastSig].time));
    } else if (d.type === 'strength') {
      const nb = outs.filter(function (o) { return o[12] === 0; }).length, ns = outs.filter(function (o) { return o[12] === 1; }).length;
      lines.push('강세 봉 ' + nb + '개, 약세 봉 ' + ns + '개 (전체 ' + bars.length + '개)');
    } else if (d.type === 'strategy') {
      lines.push.apply(lines, backtest(bars, outs));
    }
    let issues = [];
    try { issues = semanticIssues(d, bars); } catch (e) { issues = []; }
    if (issues.length) {
      lines.push('', '⚠ 점검');
      issues.forEach(function (is) { lines.push('· ' + is.label + ': ' + is.msg); });
      if (issues.some(function (is) { return is.fix; })) lines.push('→ [자동수정]을 누르면 고칠 수 있는 항목이 있어요.');
    }
    return { text: lines.join('\n'), warn: issues.length > 0 };
  }
  function lastIndex(arr, f) { for (let i = arr.length - 1; i >= 0; i--) if (f(arr[i])) return i; return -1; }
  function fmtTime(t) {
    const d = new Date(t);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // 신호 봉 종가에 체결된다고 가정한 단순 성과
  function backtest(bars, outs) {
    const trades = [];
    let pos = 0, entry = 0, entryT = 0;
    for (let i = 0; i < bars.length; i++) {
      const o = outs[i], c = bars[i].close;
      if (pos === 1 && o[10] === 1) { trades.push({ dir: 1, pnl: (c - entry) / entry * 100 }); pos = 0; }
      if (pos === -1 && o[11] === 1) { trades.push({ dir: -1, pnl: (entry - c) / entry * 100 }); pos = 0; }
      if (pos === 0 && o[8] === 1) { pos = 1; entry = c; entryT = bars[i].time; }
      else if (pos === 0 && o[9] === 1) { pos = -1; entry = c; entryT = bars[i].time; }
    }
    const out = [];
    const wins = trades.filter(function (t) { return t.pnl > 0; });
    const sum = trades.reduce(function (a, t) { return a + t.pnl; }, 0);
    const gw = wins.reduce(function (a, t) { return a + t.pnl; }, 0);
    const gl = -trades.filter(function (t) { return t.pnl <= 0; }).reduce(function (a, t) { return a + t.pnl; }, 0);
    let eq = 0, peak = 0, mdd = 0;
    trades.forEach(function (t) { eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); });
    out.push('[성과검증 · 신호 봉 종가 체결 가정, 수수료·스프레드 제외]');
    out.push('거래 ' + trades.length + '회 · 승률 ' + (trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0') + '% · 누적 수익률 ' + sum.toFixed(2) + '%');
    out.push('손익비(PF) ' + (gl > 0 ? (gw / gl).toFixed(2) : (gw > 0 ? '∞' : '-')) + ' · 최대 낙폭 ' + mdd.toFixed(2) + '%p');
    if (pos !== 0) out.push('현재 ' + (pos === 1 ? '매수' : '매도') + ' 포지션 보유 중 (진입 ' + fmtTime(entryT) + ', ' + entry + ')');
    return out;
  }

  // -----------------------------------------------------------------------------
  // UI 공통
  // -----------------------------------------------------------------------------
  const UI = { manager: null, search: null };
  const CSS = `
  .ccf-win{position:fixed;z-index:2147483000;background:#1b222c;color:#e3e7ee;border:1px solid #323c4a;border-radius:10px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;
    display:flex;flex-direction:column;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden}
  .ccf-win *{box-sizing:border-box}
  .ccf-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#222b37;border-bottom:1px solid #323c4a;cursor:move;user-select:none}
  .ccf-head b{font-size:14px;flex:1}
  .ccf-x{background:none;border:0;color:#9aa4b5;font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
  .ccf-x:hover{color:#fff}
  .ccf-body{display:flex;flex:1;min-height:0}
  .ccf-side{width:230px;flex-shrink:0;border-right:1px solid #323c4a;display:flex;flex-direction:column;min-height:0}
  .ccf-main{flex:1;min-width:0;overflow:auto;padding:12px 14px}
  .ccf-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px}
  .ccf-tab{background:#26303d;border:1px solid #323c4a;color:#b9c2d0;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px}
  .ccf-tab.on{background:#1e88e5;border-color:#1e88e5;color:#fff}
  .ccf-list{flex:1;overflow:auto;padding:4px 8px}
  .ccf-li{padding:6px 8px;border-radius:6px;cursor:pointer;color:#cfd6e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ccf-li:hover{background:#26303d}.ccf-li.on{background:#1e3a5c;color:#fff}
  .ccf-li small{color:#7f8a9c;margin-left:4px}
  .ccf-sidebtns{display:flex;flex-wrap:wrap;gap:4px;padding:8px;border-top:1px solid #323c4a}
  .ccf-btn{background:#2a3442;border:1px solid #3a4656;color:#dfe5ee;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
  .ccf-btn:hover{background:#334052}.ccf-btn:disabled{opacity:.5;cursor:default}
  .ccf-btn.pri{background:#1e88e5;border-color:#1e88e5;color:#fff}.ccf-btn.pri:hover{background:#1976d2}
  .ccf-btn.red{color:#ff8a80}
  .ccf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
  .ccf-lab{color:#8c97a8;font-size:12px;min-width:64px}
  .ccf-in,.ccf-sel,.ccf-ta{background:#121820;border:1px solid #353f4d;color:#e8ecf2;border-radius:6px;padding:5px 7px;font:inherit;font-size:12px}
  .ccf-in:focus,.ccf-sel:focus,.ccf-ta:focus{outline:none;border-color:#1e88e5}
  .ccf-ta{width:100%;min-height:64px;font-family:Consolas,"D2Coding","Courier New",monospace;font-size:12.5px;resize:vertical;tab-size:2}
  .ccf-num{width:72px}
  .ccf-card{background:#202833;border:1px solid #2f3946;border-radius:8px;padding:8px 10px;margin:8px 0}
  .ccf-card h4{margin:0 0 6px;font-size:12px;color:#aeb8c7;font-weight:600;display:flex;align-items:center;gap:8px}
  .ccf-sec{font-size:12px;color:#8c97a8;margin:12px 0 4px;font-weight:600}
  .ccf-out{white-space:pre-wrap;background:#121820;border:1px solid #2f3946;border-radius:6px;padding:8px;font-size:12px;margin-top:8px;font-family:Consolas,monospace}
  .ccf-out.err{border-color:#7a2a2a;color:#ff9b93}.ccf-out.ok{border-color:#245c3c;color:#9be3b5}.ccf-out.warn{border-color:#7a6224;color:#ffd77a}
  .ccf-btn.fix{background:#3b2f63;border-color:#5c4a99;color:#e4dcff}.ccf-btn.fix:hover{background:#4a3b7c}
  .ccf-color{width:30px;height:24px;padding:0;border:1px solid #353f4d;border-radius:4px;background:none;cursor:pointer}
  .ccf-docs{width:300px;flex-shrink:0;border-left:1px solid #323c4a;overflow:auto;padding:8px 10px;font-size:12px}
  .ccf-docs h5{margin:10px 0 4px;color:#9fb3c8;font-size:12px}
  .ccf-doc{padding:3px 4px;border-radius:4px;cursor:pointer}.ccf-doc:hover{background:#26303d}
  .ccf-doc code{color:#82c4ff;font-family:Consolas,monospace;font-size:11.5px}.ccf-doc div{color:#8c97a8}
  .ccf-table{width:100%;border-collapse:collapse;font-size:12px}
  .ccf-table th{text-align:left;color:#8c97a8;font-weight:500;padding:5px 6px;border-bottom:1px solid #323c4a;position:sticky;top:0;background:#1b222c;cursor:pointer}
  .ccf-table td{padding:5px 6px;border-bottom:1px solid #262f3b}
  .ccf-table tr.click:hover td{background:#243142;cursor:pointer}
  .ccf-chip{display:inline-block;min-width:18px;text-align:center;border-radius:4px;padding:0 4px;margin-right:2px;font-size:11px;background:#2a3442;color:#6f7b8d}
  .ccf-chip.on{background:#1e5f3a;color:#a8f0c4}
  .ccf-up{color:#26a69a}.ccf-dn{color:#ef5350}
  .ccf-letter{display:inline-flex;width:22px;height:22px;border-radius:5px;background:#1e88e5;color:#fff;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0}
  .ccf-items .ccf-card{display:flex;gap:8px;align-items:flex-start}
  .ccf-pick{display:flex;gap:0;min-height:260px;border:1px solid #2f3946;border-radius:8px;overflow:hidden}
  .ccf-pick>div{overflow:auto;max-height:340px}
  .ccf-pick .c1{width:130px;border-right:1px solid #2f3946}.ccf-pick .c2{width:250px;border-right:1px solid #2f3946}.ccf-pick .c3{flex:1;padding:8px}
  .ccf-pick2{display:flex;min-height:0;flex:1;border:1px solid #2f3946;border-radius:8px;overflow:hidden;height:400px}
  .ccf-tleft{width:340px;flex-shrink:0;border-right:1px solid #2f3946;display:flex;flex-direction:column;padding:8px;min-height:0}
  .ccf-tree{flex:1;overflow:auto;min-height:0}
  .ccf-tright{flex:1;overflow:auto;padding:10px 12px;min-width:0}
  .ccf-node{display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:5px;cursor:pointer;color:#cfd6e1;user-select:none;white-space:nowrap}
  .ccf-node:hover{background:#26303d}.ccf-node.on{background:#1e3a5c;color:#fff}
  .ccf-node small{color:#6f7b8d}
  .ccf-caret{width:12px;color:#7f8a9c;font-size:11px;display:inline-block}
  .ccf-leaf{padding:3px 6px;border-radius:5px;cursor:pointer;color:#b9c2d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ccf-leaf:hover{background:#26303d;color:#fff}.ccf-leaf.on{background:#1e3a5c;color:#fff}
  .ccf-toasts{position:fixed;left:16px;bottom:16px;z-index:2147483600;display:flex;flex-direction:column;gap:6px;max-width:min(420px,calc(100vw - 32px))}
  .ccf-toast{background:#263241;color:#e8edf4;border-left:4px solid #1e88e5;border-radius:6px;padding:8px 12px;font:12.5px/1.4 "Malgun Gothic",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  .ccf-toast.err{border-color:#ef5350}.ccf-toast.ok{border-color:#26a69a}
  .ccf-tbtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;margin-left:4px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--content-secondary,#b5bdc9);cursor:pointer;font:600 12px "Malgun Gothic",sans-serif}
  .ccf-tbtn:hover{background:rgba(255,255,255,.07);color:#fff}
  .ccf-fab{position:fixed;right:12px;bottom:84px;z-index:2147482000;display:flex;flex-direction:column;gap:6px}
  .ccf-fab button{background:#1e88e5;color:#fff;border:0;border-radius:18px;padding:7px 12px;font:600 12px "Malgun Gothic",sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer}
  .ccf-hint{color:#7f8a9c;font-size:11.5px}
  @media (max-width:760px){.ccf-body{flex-direction:column}.ccf-side{width:auto;max-height:180px;border-right:0;border-bottom:1px solid #323c4a}.ccf-docs{width:auto;border-left:0;border-top:1px solid #323c4a;max-height:220px}
    .ccf-pick2{flex-direction:column;height:auto}.ccf-tleft{width:auto;max-height:260px;border-right:0;border-bottom:1px solid #2f3946}
    .ccf-pick{flex-direction:column}.ccf-pick .c1,.ccf-pick .c2{width:auto;max-height:140px;border-right:0;border-bottom:1px solid #2f3946}}
  `;

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }

  function ensureCss() {
    if (document.getElementById('ccf-css')) return;
    document.head.appendChild(h('style', { id: 'ccf-css', text: CSS }));
  }

  let toastBox = null;
  function toast(msg, kind, ms) {
    try {
      ensureCss();
      if (!toastBox || !toastBox.isConnected) { toastBox = h('div', { class: 'ccf-toasts' }); document.body.appendChild(toastBox); }
      const el = h('div', { class: 'ccf-toast ' + (kind || ''), text: msg });
      toastBox.appendChild(el);
      setTimeout(function () { el.remove(); }, ms || 4000);
    } catch (e) { console.log(LOG, msg); }
  }

  function makeWindow(title, w, hgt, key) {
    ensureCss();
    const ui = lsGet(LS_UI, {});
    const pos = ui[key] || {};
    const win = h('div', { class: 'ccf-win', style: { width: (pos.w || w) + 'px', height: (pos.h || hgt) + 'px' } });
    const x = Math.max(8, Math.min(pos.x !== undefined ? pos.x : (window.innerWidth - w) / 2, window.innerWidth - 120));
    const y = Math.max(8, Math.min(pos.y !== undefined ? pos.y : 60, window.innerHeight - 60));
    win.style.left = x + 'px'; win.style.top = y + 'px';
    const close = h('button', { class: 'ccf-x', title: '닫기', text: '×' });
    const head = h('div', { class: 'ccf-head' }, [h('b', { text: title }), close]);
    const body = h('div', { class: 'ccf-body' });
    win.appendChild(head); win.appendChild(body);
    win.style.resize = 'both';
    let drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target === close) return;
      drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag) return;
      win.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - 80)) + 'px';
      win.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - 40)) + 'px';
    });
    function remember() {
      const u = lsGet(LS_UI, {});
      u[key] = { x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight };
      lsSet(LS_UI, u);
    }
    head.addEventListener('pointerup', function () { if (drag) { drag = null; remember(); } });
    win.addEventListener('mouseup', remember);
    // 사이트 단축키가 입력 중에 동작하지 않도록
    win.addEventListener('keydown', function (e) { e.stopPropagation(); });
    document.body.appendChild(win);
    return { win: win, body: body, close: close, head: head };
  }

  function sel(options, value, onchange, cls) {
    const s = h('select', { class: 'ccf-sel ' + (cls || ''), onchange: function () { onchange(s.value); } });
    options.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); });
    s.value = value;
    return s;
  }
  function inp(value, oninput, attrs) {
    const e = h('input', Object.assign({ class: 'ccf-in', value: value === undefined || value === null ? '' : String(value) }, attrs || {}));
    e.addEventListener('input', function () { oninput(e.value); });
    return e;
  }
  function colorIn(value, onchange) {
    const e = h('input', { type: 'color', class: 'ccf-color', value: value || '#2962FF' });
    e.addEventListener('input', function () { onchange(e.value); });
    return e;
  }
  let lastTa = null;
  function ta(value, oninput, rows) {
    const e = h('textarea', { class: 'ccf-ta', rows: rows || 3, spellcheck: 'false' });
    e.value = value || '';
    e.addEventListener('input', function () { oninput(e.value); });
    e.addEventListener('focus', function () { lastTa = e; });
    e.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab') { ev.preventDefault(); const s = e.selectionStart; e.setRangeText('  ', s, e.selectionEnd, 'end'); e.dispatchEvent(new Event('input')); }
    });
    return e;
  }
  function insertAtCursor(text) {
    const e = lastTa;
    if (!e || !e.isConnected) { toast('먼저 수식 입력칸을 클릭하세요'); return; }
    e.focus();
    e.setRangeText(text, e.selectionStart, e.selectionEnd, 'end');
    e.dispatchEvent(new Event('input'));
  }

  function docsPanel() {
    const box = h('div', { class: 'ccf-docs' });
    const q = h('input', { class: 'ccf-in', placeholder: '함수 찾기 (예: 이평, cross)', style: { width: '100%' } });
    const list = h('div');
    function render() {
      list.innerHTML = '';
      const s = q.value.trim().toLowerCase();
      ENG.DOCS.forEach(function (g) {
        const rows = g[1].filter(function (r) { return !s || (r[0] + ' ' + r[1]).toLowerCase().includes(s); });
        if (!rows.length) return;
        list.appendChild(h('h5', { text: g[0] }));
        rows.forEach(function (r) {
          const sig = r[0].split(' / ')[0].trim();
          list.appendChild(h('div', { class: 'ccf-doc', title: '클릭하면 수식에 넣습니다', onclick: function () { insertAtCursor(sig.replace(/\[.*?\]/g, '')); } }, [h('code', { text: r[0] }), h('div', { text: r[1] })]));
        });
      });
    }
    q.addEventListener('input', render);
    box.appendChild(h('div', { class: 'ccf-hint', text: '함수를 클릭하면 마지막으로 클릭한 수식 칸에 들어갑니다.' }));
    box.appendChild(q);
    box.appendChild(list);
    render();
    return box;
  }

  // -----------------------------------------------------------------------------
  // 수식관리자
  // -----------------------------------------------------------------------------
  const TYPE_TABS = [['indicator', '기술적지표'], ['signal', '신호검색'], ['strategy', '시스템트레이딩'], ['strength', '강세약세'], ['func', '사용자함수']];

  function newDef(type) {
    const base = { id: uid(), type: type, name: '새 ' + TYPE_TABS.find(function (t) { return t[0] === type; })[1], overlay: type !== 'indicator', vars: {}, desc: '' };
    if (type === 'indicator') Object.assign(base, { lines: [{ name: '수식1', formula: '', color: LINE_COLORS[0], width: 2, style: 'line' }], bands: [] });
    if (type === 'signal') base.signal = { buy: '', sell: '' };
    if (type === 'strategy') base.strategy = { mode: 'both', buyEntry: '', buyExit: '', sellEntry: '', sellExit: '' };
    if (type === 'strength') base.strength = { bull: '', bear: '', bullColor: '#FFD600', bearColor: '#2962FF' };
    return base;
  }
  function uniqueName(name, list, selfId) {
    let n = name, k = 2;
    while (list.some(function (d) { return d.name === n && d.id !== selfId; })) n = name + ' (' + (k++) + ')';
    return n;
  }

  function openManager() {
    if (UI.manager && UI.manager.win.isConnected) { UI.manager.win.style.display = 'flex'; return; }
    const W = makeWindow('수식관리자', 1060, 640, 'manager');
    const st = { tab: 'indicator', selId: null, draft: null, dirty: false, showDocs: true };
    const tabs = h('div', { class: 'ccf-tabs' });
    const list = h('div', { class: 'ccf-list' });
    const sideBtns = h('div', { class: 'ccf-sidebtns' });
    const side = h('div', { class: 'ccf-side' }, [tabs, list, sideBtns]);
    const main = h('div', { class: 'ccf-main' });
    const docs = docsPanel();
    W.body.appendChild(side); W.body.appendChild(main); W.body.appendChild(docs);
    W.close.addEventListener('click', function () {
      if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 닫을까요?')) return;
      W.win.remove(); UI.manager = null;
    });

    function items() { return st.tab === 'func' ? LIB.funcs : LIB.defs.filter(function (d) { return d.type === st.tab; }); }
    function current() { return items().find(function (d) { return d.id === st.selId; }); }
    function select(id) {
      if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 버릴까요?')) return false;
      st.selId = id; const c = current(); st.draft = c ? clone(c) : null; st.dirty = false; st.undo = null; render(); return true;
    }
    function markDirty() { st.dirty = true; saveBtnState(); }
    let saveBtn = null;
    function saveBtnState() { if (saveBtn) saveBtn.textContent = st.dirty ? '저장 *' : '저장'; }

    function renderSide() {
      tabs.innerHTML = '';
      TYPE_TABS.forEach(function (t) {
        tabs.appendChild(h('button', { class: 'ccf-tab' + (st.tab === t[0] ? ' on' : ''), text: t[1], onclick: function () {
          if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 버릴까요?')) return;
          st.dirty = false; st.tab = t[0]; const f = items()[0]; st.selId = f ? f.id : null; st.draft = f ? clone(f) : null; render();
        } }));
      });
      list.innerHTML = '';
      const arr = items();
      if (!arr.length) list.appendChild(h('div', { class: 'ccf-hint', style: { padding: '8px' }, text: '아직 없습니다. [새로 만들기]를 누르세요.' }));
      arr.forEach(function (d) {
        list.appendChild(h('div', { class: 'ccf-li' + (d.id === st.selId ? ' on' : ''), title: d.desc || d.name, onclick: function () { select(d.id); } },
          [d.name, st.tab === 'func' ? h('small', { text: '(' + (d.params || []).join(', ') + ')' }) : (d.type === 'indicator' && !d.overlay ? null : h('small', { text: d.type === 'indicator' ? '가격' : '' }))]));
      });
      sideBtns.innerHTML = '';
      sideBtns.appendChild(h('button', { class: 'ccf-btn pri', text: '새로 만들기', onclick: function () {
        if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 버릴까요?')) return;
        const coll = st.tab === 'func' ? LIB.funcs : LIB.defs;
        const d = st.tab === 'func' ? { id: uid(), name: 'MyFunc', params: ['N'], body: 'avg(C, N)', desc: '' } : newDef(st.tab);
        d.name = uniqueName(d.name, coll);
        coll.push(d); saveLib();
        st.dirty = false; st.selId = d.id; st.draft = clone(d); render();
      } }));
      sideBtns.appendChild(h('button', { class: 'ccf-btn', text: '복사', disabled: !current(), onclick: function () {
        const c = current(); if (!c) return;
        const coll = st.tab === 'func' ? LIB.funcs : LIB.defs;
        const d = clone(st.draft || c); d.id = uid(); d.name = uniqueName(d.name + ' 복사', coll);
        coll.push(d); saveLib(); st.dirty = false; st.selId = d.id; st.draft = clone(d); render();
      } }));
      sideBtns.appendChild(h('button', { class: 'ccf-btn red', text: '삭제', disabled: !current(), onclick: function () {
        const c = current(); if (!c) return;
        if (!window.confirm("'" + c.name + "'을(를) 삭제할까요?")) return;
        const coll = st.tab === 'func' ? LIB.funcs : LIB.defs;
        coll.splice(coll.indexOf(c), 1); saveLib();
        st.dirty = false; const f = items()[0]; st.selId = f ? f.id : null; st.draft = f ? clone(f) : null; render();
      } }));
      sideBtns.appendChild(h('button', { class: 'ccf-btn', text: '백업·복원', onclick: openBackup }));
    }

    function varsEditor(d) {
      const box = h('div', { class: 'ccf-card' }, [h('h4', { text: '지표변수' }, [])]);
      const rows = h('div');
      function draw() {
        rows.innerHTML = '';
        const keys = Object.keys(d.vars || {});
        if (!keys.length) rows.appendChild(h('div', { class: 'ccf-hint', text: '수식에서 쓸 기간 같은 값을 이름으로 만들어 두면 나중에 숫자만 바꿀 수 있습니다. (예: 단기 = 5)' }));
        keys.forEach(function (k) {
          let name = k;
          const nameIn = inp(k, function (v) { name = v; }, { style: { width: '110px' } });
          nameIn.addEventListener('change', function () {
            const nv = name.trim();
            if (!nv || nv === k) { nameIn.value = k; return; }
            if (!/^[A-Za-z_ㄱ-ㆎ가-힣][A-Za-z0-9_ㄱ-ㆎ가-힣]*$/.test(nv)) { toast('변수 이름은 한글·영문·숫자·_ 만 쓸 수 있고 숫자로 시작할 수 없습니다', 'err'); nameIn.value = k; return; }
            const nvObj = {}; Object.keys(d.vars).forEach(function (x) { nvObj[x === k ? nv : x] = d.vars[x]; }); d.vars = nvObj;
            markDirty(); draw();
          });
          rows.appendChild(h('div', { class: 'ccf-row' }, [nameIn, h('span', { text: '=' }),
            inp(d.vars[k], function (v) { d.vars[k] = v === '' ? 0 : +v; markDirty(); }, { type: 'number', step: 'any', class: 'ccf-in ccf-num' }),
            h('button', { class: 'ccf-btn red', text: '삭제', onclick: function () { delete d.vars[k]; markDirty(); draw(); } })]));
        });
      }
      draw();
      box.appendChild(rows);
      box.appendChild(h('button', { class: 'ccf-btn', text: '+ 변수 추가', onclick: function () {
        d.vars = d.vars || {};
        let n = 'Period', k = 1; while (n in d.vars) n = 'Period' + (++k);
        d.vars[n] = 14; markDirty(); draw();
      } }));
      return box;
    }

    function formulaCard(title, value, set, extra, rows) {
      return h('div', { class: 'ccf-card' }, [h('h4', null, [title].concat(extra || [])), ta(value, function (v) { set(v); markDirty(); }, rows || 3)]);
    }

    function renderMain() {
      main.innerHTML = '';
      const d = st.draft;
      if (!d) { main.appendChild(h('div', { class: 'ccf-hint', text: '왼쪽에서 항목을 고르거나 새로 만드세요.' })); return; }
      const isFunc = st.tab === 'func';
      // 공통: 이름
      main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: isFunc ? '함수 이름' : '이름' }),
        inp(d.name, function (v) { d.name = v; markDirty(); }, { style: { flex: '1', minWidth: '180px' } })]));
      if (isFunc) {
        main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '인자' }),
          inp((d.params || []).join(', '), function (v) { d.params = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean); markDirty(); }, { placeholder: '예: short, long', style: { flex: '1' } })]));
        main.appendChild(h('div', { class: 'ccf-hint', text: '다른 수식에서 ' + (d.name || '함수') + '(' + (d.params || []).join(', ') + ') 처럼 부릅니다. 본문에서는 인자, 가격 데이터, 지표변수를 쓸 수 있습니다.' }));
        main.appendChild(formulaCard('함수 본문', d.body, function (v) { d.body = v; }, null, 6));
      } else {
        main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '설명' }),
          inp(d.desc, function (v) { d.desc = v; markDirty(); }, { style: { flex: '1' } })]));
        if (d.type === 'indicator') {
          main.appendChild(h('div', { class: 'ccf-row' }, [h('label', null, [
            h('input', { type: 'checkbox', checked: d.overlay, onchange: function (e) { d.overlay = e.target.checked; markDirty(); } }),
            ' 가격 차트에 겹쳐서 표시 (이동평균·밴드처럼 가격과 같은 단위일 때)'])]));
        }
        main.appendChild(varsEditor(d));
        if (d.type === 'indicator') renderIndicator(d);
        if (d.type === 'signal') {
          main.appendChild(h('div', { class: 'ccf-hint', text: '조건식이 참(0이 아님)인 봉에 신호가 표시됩니다. 둘 중 하나만 써도 됩니다.' }));
          main.appendChild(formulaCard('매수 신호 ▲', d.signal.buy, function (v) { d.signal.buy = v; }));
          main.appendChild(formulaCard('매도 신호 ▼', d.signal.sell, function (v) { d.signal.sell = v; }));
        }
        if (d.type === 'strategy') {
          main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '포지션' }),
            sel([['both', '매수·매도 모두'], ['long', '매수만'], ['short', '매도만']], d.strategy.mode || 'both', function (v) { d.strategy.mode = v; markDirty(); }),
            h('span', { class: 'ccf-hint', text: '반대 진입 신호가 나오면 기존 포지션을 청산하고 뒤집습니다.' })]));
          main.appendChild(formulaCard('매수진입', d.strategy.buyEntry, function (v) { d.strategy.buyEntry = v; }));
          main.appendChild(formulaCard('매수청산', d.strategy.buyExit, function (v) { d.strategy.buyExit = v; }));
          main.appendChild(formulaCard('매도진입', d.strategy.sellEntry, function (v) { d.strategy.sellEntry = v; }));
          main.appendChild(formulaCard('매도청산', d.strategy.sellExit, function (v) { d.strategy.sellExit = v; }));
        }
        if (d.type === 'strength') {
          main.appendChild(h('div', { class: 'ccf-hint', text: '강세 조건이 참이면 강세 색, 아니고 약세 조건이 참이면 약세 색으로 봉을 칠합니다.' }));
          main.appendChild(formulaCard('강세 조건', d.strength.bull, function (v) { d.strength.bull = v; }, [colorIn(d.strength.bullColor, function (v) { d.strength.bullColor = v; markDirty(); })]));
          main.appendChild(formulaCard('약세 조건', d.strength.bear, function (v) { d.strength.bear = v; }, [colorIn(d.strength.bearColor, function (v) { d.strength.bearColor = v; markDirty(); })]));
        }
      }
      // 버튼
      const out = h('div', { class: 'ccf-out', style: { display: 'none' } });
      saveBtn = h('button', { class: 'ccf-btn pri', text: '저장', onclick: function () { doSave(out); } });
      saveBtnState();
      const btns = [h('button', { class: 'ccf-btn', text: '수식검증', onclick: function () { doVerify(out); } }),
        h('button', { class: 'ccf-btn fix', text: '자동수정', title: '틀린 수식을 찾아 고칩니다 (저장 전까지는 되돌릴 수 있어요)', onclick: function () { doAutoFix(out); } }), saveBtn];
      if (!isFunc) btns.push(h('button', { class: 'ccf-btn', text: '저장 후 차트에 적용', onclick: async function () { if (doSave(out)) await applyToChart(current()); } }));
      btns.push(h('button', { class: 'ccf-btn', text: st.showDocs ? '함수설명 숨기기' : '함수설명', onclick: function () { st.showDocs = !st.showDocs; docs.style.display = st.showDocs ? '' : 'none'; renderMain(); } }));
      main.appendChild(h('div', { class: 'ccf-row', style: { marginTop: '12px' } }, btns));
      main.appendChild(out);
      if (st.pendingOut) { const po = st.pendingOut; st.pendingOut = null; showOut(out, po.text, po.kind, po.extra); }
    }

    function renderIndicator(d) {
      main.appendChild(h('div', { class: 'ccf-sec', text: '수식 (최대 5개, 각각 선 하나)' }));
      d.lines.forEach(function (ln, j) {
        const extra = [
          inp(ln.name, function (v) { ln.name = v; markDirty(); }, { placeholder: '이름', style: { width: '110px' } }),
          colorIn(ln.color, function (v) { ln.color = v; markDirty(); }),
          sel([[1, '굵기 1'], [2, '굵기 2'], [3, '굵기 3'], [4, '굵기 4']], ln.width || 1, function (v) { ln.width = +v; markDirty(); }),
          sel(PLOT_TYPE_NAMES, ln.style || 'line', function (v) { ln.style = v; markDirty(); }),
          h('button', { class: 'ccf-btn red', text: '삭제', onclick: function () { d.lines.splice(j, 1); markDirty(); renderMain(); } }),
        ];
        main.appendChild(formulaCard('수식' + (j + 1), ln.formula, function (v) { ln.formula = v; }, extra));
      });
      if (d.lines.length < 5) main.appendChild(h('button', { class: 'ccf-btn', text: '+ 수식 추가', onclick: function () {
        d.lines.push({ name: '수식' + (d.lines.length + 1), formula: '', color: LINE_COLORS[d.lines.length % 5], width: 1, style: 'line' }); markDirty(); renderMain();
      } }));
      main.appendChild(h('div', { class: 'ccf-sec', text: '기준선 (최대 3개)' }));
      const bl = h('div');
      d.bands.forEach(function (b, j) {
        bl.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '기준선' + (j + 1) }),
          inp(b.value, function (v) { b.value = v === '' ? '' : +v; markDirty(); }, { type: 'number', step: 'any', class: 'ccf-in ccf-num' }),
          colorIn(b.color || '#787B86', function (v) { b.color = v; markDirty(); }),
          h('button', { class: 'ccf-btn red', text: '삭제', onclick: function () { d.bands.splice(j, 1); markDirty(); renderMain(); } })]));
      });
      main.appendChild(bl);
      if (d.bands.length < 3) main.appendChild(h('button', { class: 'ccf-btn', text: '+ 기준선 추가', onclick: function () { d.bands.push({ value: 0, color: '#787B86' }); markDirty(); renderMain(); } }));
    }

    function validate(d) {
      if (!d.name || !d.name.trim()) throw new Error('이름을 입력하세요');
      d.name = d.name.trim();
      if (st.tab === 'func') {
        if (!/^[A-Za-z_ㄱ-ㆎ가-힣][A-Za-z0-9_ㄱ-ㆎ가-힣]*$/.test(d.name)) throw new Error('함수 이름은 한글·영문·숫자·_ 만 쓸 수 있고 숫자로 시작할 수 없습니다');
        if (LIB.funcs.some(function (f) { return f.id !== d.id && f.name.toLowerCase() === d.name.toLowerCase() && (f.params || []).length === (d.params || []).length; })) throw new Error('같은 이름·인자 수의 사용자함수가 이미 있습니다');
        const others = LIB.funcs.filter(function (f) { return f.id !== d.id; }).concat([d]);
        const args = (d.params || []).map(function () { return '1'; }).join(', ');
        ENG.compile(d.name + '(' + args + ')', { userFuncs: others });
        return;
      }
      if (LIB.defs.some(function (x) { return x.id !== d.id && x.name === d.name; })) throw new Error('같은 이름이 이미 있습니다 (지표 설정에서 이름으로 찾기 때문에 이름이 겹치면 안 됩니다)');
      if (d.type === 'indicator' && !d.lines.some(function (l) { return l.formula && l.formula.trim(); })) throw new Error('수식을 하나 이상 입력하세요');
      compileDef(d);
    }
    function doSave(out) {
      const d = st.draft; if (!d) return false;
      try { validate(d); } catch (e) { showOut(out, '저장하지 않았습니다: ' + e.message, 'err'); return false; }
      const coll = st.tab === 'func' ? LIB.funcs : LIB.defs;
      const idx = coll.findIndex(function (x) { return x.id === d.id; });
      const oldName = idx >= 0 ? coll[idx].name : d.name;
      if (idx >= 0) coll[idx] = clone(d); else coll.push(clone(d));
      saveLib();
      st.dirty = false;
      if (st.tab === 'func') studiesUsing().forEach(function (s) { try { s.setInputValues([{ id: 'rev', value: Date.now() % 1000000000 }]); } catch (e) { /* 무시 */ } });
      else refreshStudies(oldName, d);
      showOut(out, '저장했습니다.', 'ok');
      renderSide(); saveBtnState();
      return true;
    }
    async function doVerify(out) {
      const d = st.draft; if (!d) return;
      showOut(out, '검증 중…', '');
      try {
        if (st.tab === 'func') { validate(clone(d)); showOut(out, '문법 정상', 'ok'); return; }
        const r = await verifyDef(d);
        showOut(out, r.text, r.warn ? 'warn' : 'ok', r.warn ? [fixBtn(out)] : null);
      } catch (e) { showOut(out, '오류: ' + e.message, 'err', [fixBtn(out)]); }
    }
    function fixBtn(out) { return h('button', { class: 'ccf-btn fix', text: '자동수정 해보기', onclick: function () { doAutoFix(out); } }); }
    function showOut(out, text, kind, extra) {
      out.style.display = ''; out.className = 'ccf-out ' + (kind || ''); out.textContent = text;
      if (extra && extra.length) out.appendChild(h('div', { class: 'ccf-row', style: { marginTop: '8px' } }, extra));
      setTimeout(function () { try { out.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* 무시 */ } }, 0);
    }
    // 자동수정: 문법 오류 → 흔한 실수 → (차트가 있으면) 실제 봉으로 돌려 보고 이상한 신호까지 고친다
    async function doAutoFix(out) {
      const d = st.draft; if (!d) return;
      const before = clone(d);
      showOut(out, '자동수정 중…', '');
      const done = [], left = [], hints = [];
      const fmtChange = function (label, c) {
        let t = '· ' + label + (c.line ? ' ' + c.line + '번째 줄' : '') + ': ' + c.why;
        if (c.before !== undefined && c.after !== undefined && c.before !== c.after) t += '\n    ' + c.before + '\n  → ' + c.after;
        return t;
      };
      try {
        if (st.tab === 'func') {
          const others = LIB.funcs.filter(function (f) { return f.id !== d.id; });
          const r = ENG.autoFix(d.body || '', { userFuncs: others, params: d.params || [], allowNewVars: false });
          if (r.src !== d.body) d.body = r.src;
          r.changes.forEach(function (c) { done.push(fmtChange('함수 본문', c)); });
          if (!r.ok) left.push('· 함수 본문: ' + r.error);
        } else {
          d.vars = d.vars || {};
          formulaFields(d).forEach(function (fd) {
            const v = fd.get();
            if (!v || !v.trim()) return;
            const r = ENG.autoFix(v, { userFuncs: funcsFor(d), vars: d.vars, allowNewVars: true });
            if (r.src !== v) fd.set(r.src);
            Object.keys(r.newVars).forEach(function (k) { if (!(k in d.vars)) d.vars[k] = r.newVars[k]; });
            r.changes.forEach(function (c) { done.push(fmtChange(fd.label, c)); });
            if (!r.ok) left.push('· ' + fd.label + ': ' + r.error);
          });
          if (!left.length) {
            let cb = null;
            try { cb = await chartBars(1000); } catch (e) { cb = null; }
            if (!cb) hints.push('차트가 열려 있지 않아 실제 봉으로 돌려 보는 점검은 건너뛰었어요.');
            else {
              semanticIssues(d, cb.bars).forEach(function (is) {
                if (is.fix) { is.fix.field.set(is.fix.src); done.push('· ' + is.label + ': ' + is.fix.how + '\n    (' + is.msg + ')'); }
                else hints.push('· ' + is.label + ': ' + is.msg);
              });
            }
          }
        }
      } catch (e) { left.push('· ' + e.message); }
      const lines = [];
      if (done.length) lines.push('✔ 고친 내용 ' + done.length + '건', done.join('\n'));
      else if (!left.length) lines.push('✔ 고칠 곳이 없어요. 수식이 정상이에요.');
      if (left.length) lines.push('', '✘ 자동으로 못 고친 곳', left.join('\n'), '  → 오류 위치(줄 번호) 근처의 괄호·쉼표·이름을 직접 확인하세요.');
      if (hints.length) lines.push('', 'ℹ 참고', hints.join('\n'));
      if (done.length) lines.push('', '아직 저장되지 않았어요. 확인 후 [저장]을 누르세요. 마음에 안 들면 [되돌리기].');
      const changed = JSON.stringify(before) !== JSON.stringify(d);
      if (changed) { st.dirty = true; st.undo = before; }
      const extra = [];
      if (changed) extra.push(h('button', { class: 'ccf-btn', text: '되돌리기', onclick: function () {
        if (!st.undo) return;
        st.draft = st.undo; st.undo = null; st.dirty = true;
        st.pendingOut = { text: '자동수정 전으로 되돌렸어요.', kind: '' };
        renderMain();
      } }));
      st.pendingOut = { text: lines.join('\n'), kind: left.length ? 'err' : (hints.length && !done.length ? 'warn' : 'ok'), extra: extra };
      if (changed) renderMain(); else { const po = st.pendingOut; st.pendingOut = null; showOut(out, po.text, po.kind, po.extra); }
      saveBtnState();
    }

    function render() { renderSide(); renderMain(); }
    const f = items()[0]; st.selId = f ? f.id : null; st.draft = f ? clone(f) : null;
    render();
    UI.manager = { win: W.win, refresh: function () { if (!st.dirty) { const c = current(); st.draft = c ? clone(c) : null; } render(); } };
  }

  function openBackup() {
    const W = makeWindow('백업·복원', 560, 420, 'backup');
    const area = h('textarea', { class: 'ccf-ta', style: { flex: '1', minHeight: '220px' } });
    area.value = JSON.stringify(LIB, null, 1);
    const box = h('div', { class: 'ccf-main', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
      h('div', { class: 'ccf-hint', text: '수식·사용자함수·조건식 전체입니다. 복사해서 보관하거나, 다른 브라우저에서 붙여넣고 [복원]을 누르세요.' }),
      area,
      h('div', { class: 'ccf-row' }, [
        h('button', { class: 'ccf-btn', text: '복사', onclick: function () { area.select(); try { navigator.clipboard.writeText(area.value); toast('복사했습니다', 'ok'); } catch (e) { document.execCommand('copy'); } } }),
        h('button', { class: 'ccf-btn pri', text: '복원 (덮어쓰기)', onclick: function () {
          let o; try { o = JSON.parse(area.value); } catch (e) { toast('JSON 형식이 아닙니다', 'err'); return; }
          if (!o || !Array.isArray(o.defs)) { toast('수식 백업 형식이 아닙니다', 'err'); return; }
          if (!window.confirm('지금 저장된 내용을 모두 바꿉니다. 계속할까요?')) return;
          LIB = { version: 1, defs: o.defs, funcs: o.funcs || [], conds: o.conds || [] }; saveLib();
          toast('복원했습니다', 'ok'); W.win.remove();
          if (UI.manager) { UI.manager.win.remove(); UI.manager = null; openManager(); }
          if (UI.search) UI.search.refreshList();
        } }),
        h('button', { class: 'ccf-btn red', text: '예제로 초기화', onclick: function () {
          if (!window.confirm('모든 수식과 조건식을 지우고 예제로 되돌립니다. 계속할까요?')) return;
          LIB = seedLib(); saveLib(); toast('초기화했습니다', 'ok'); W.win.remove();
          if (UI.manager) { UI.manager.win.remove(); UI.manager = null; openManager(); }
          if (UI.search) UI.search.refreshList();
        } }),
      ]),
    ]);
    W.body.appendChild(box);
    W.close.addEventListener('click', function () { W.win.remove(); });
  }

  // -----------------------------------------------------------------------------
  // 조건검색 화면
  // -----------------------------------------------------------------------------
  function newCond() { return { id: uid(), name: '새 조건식', logic: '', target: { kind: 'all', list: '' }, bars: 500, items: [] }; }

  function openSearch() {
    if (UI.search && UI.search.win.isConnected) { UI.search.win.style.display = 'flex'; return; }
    const W = makeWindow('조건검색', 1080, 660, 'search');
    const st = { selId: null, draft: null, dirty: false, running: false, live: null, liveMin: 5, lastSet: null, result: null, sort: { k: 'symbol', dir: 1 } };
    const list = h('div', { class: 'ccf-list' });
    const sideBtns = h('div', { class: 'ccf-sidebtns' });
    const side = h('div', { class: 'ccf-side' }, [h('div', { class: 'ccf-sec', style: { padding: '8px 8px 0' }, text: '내 조건식' }), list, sideBtns]);
    const main = h('div', { class: 'ccf-main' });
    W.body.appendChild(side); W.body.appendChild(main);
    W.close.addEventListener('click', function () {
      if (st.dirty && !window.confirm('저장하지 않은 조건식 변경이 있습니다. 닫을까요?')) return;
      stopLive(); W.win.remove(); UI.search = null;
    });

    function current() { return LIB.conds.find(function (c) { return c.id === st.selId; }); }
    function select(id) {
      if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 버릴까요?')) return;
      stopLive();
      st.selId = id; const c = current(); st.draft = c ? clone(c) : null; st.dirty = false; st.result = null; render();
    }
    function markDirty() { st.dirty = true; const b = main.querySelector('[data-save]'); if (b) b.textContent = '저장 *'; }

    function renderSide() {
      list.innerHTML = '';
      if (!LIB.conds.length) list.appendChild(h('div', { class: 'ccf-hint', style: { padding: '8px' }, text: '조건식이 없습니다.' }));
      LIB.conds.forEach(function (c) {
        list.appendChild(h('div', { class: 'ccf-li' + (c.id === st.selId ? ' on' : ''), onclick: function () { select(c.id); } }, [c.name, h('small', { text: '(' + (c.items || []).length + ')' })]));
      });
      sideBtns.innerHTML = '';
      sideBtns.appendChild(h('button', { class: 'ccf-btn pri', text: '새로 작성', onclick: function () {
        if (st.dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 버릴까요?')) return;
        const c = newCond(); c.name = uniqueName(c.name, LIB.conds); LIB.conds.push(c); saveLib();
        st.dirty = false; st.selId = c.id; st.draft = clone(c); st.result = null; render();
      } }));
      sideBtns.appendChild(h('button', { class: 'ccf-btn', text: '다른 이름 저장', disabled: !st.draft, onclick: function () {
        const c = clone(st.draft); c.id = uid(); c.name = uniqueName(c.name + ' 복사', LIB.conds); LIB.conds.push(c); saveLib();
        st.dirty = false; st.selId = c.id; st.draft = clone(c); render();
      } }));
      sideBtns.appendChild(h('button', { class: 'ccf-btn red', text: '삭제', disabled: !current(), onclick: function () {
        const c = current(); if (!c || !window.confirm("'" + c.name + "' 조건식을 삭제할까요?")) return;
        LIB.conds.splice(LIB.conds.indexOf(c), 1); saveLib(); stopLive();
        st.dirty = false; const f = LIB.conds[0]; st.selId = f ? f.id : null; st.draft = f ? clone(f) : null; st.result = null; render();
      } }));
    }

    function renderMain() {
      main.innerHTML = '';
      const c = st.draft;
      if (!c) { main.appendChild(h('div', { class: 'ccf-hint', text: '왼쪽에서 조건식을 고르거나 새로 작성하세요.' })); return; }
      main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '조건식 이름' }),
        inp(c.name, function (v) { c.name = v; markDirty(); }, { style: { flex: '1', minWidth: '200px' } })]));
      // 조건 목록
      main.appendChild(h('div', { class: 'ccf-sec', text: '조건 (최대 20개)' }));
      const L = letters(c.items.length);
      const itemsBox = h('div', { class: 'ccf-items' });
      c.items.forEach(function (it, j) {
        let label;
        try { label = itemFormula(it).label; } catch (e) { label = '⚠ ' + e.message; }
        itemsBox.appendChild(h('div', { class: 'ccf-card' }, [
          h('span', { class: 'ccf-letter', text: L[j] }),
          h('div', { style: { flex: '1', minWidth: '0' } }, [
            h('div', { text: label, style: { marginBottom: '4px', wordBreak: 'break-all' } }),
            h('div', { class: 'ccf-row', style: { margin: '0' } }, [
              h('span', { class: 'ccf-hint', text: '주기' }),
              sel(RES_LIST, it.res || '60', function (v) { it.res = v; markDirty(); }),
              h('span', { class: 'ccf-hint', text: '기준봉' }),
              inp(it.offset || 0, function (v) { it.offset = Math.max(0, Math.round(+v || 0)); markDirty(); }, { type: 'number', min: 0, class: 'ccf-in ccf-num', title: '0 = 현재 봉, 1 = 1봉 전 기준' }),
              h('span', { class: 'ccf-hint', text: '봉전 · 최근' }),
              inp(it.within || 1, function (v) { it.within = Math.max(1, Math.round(+v || 1)); markDirty(); }, { type: 'number', min: 1, class: 'ccf-in ccf-num', title: '기준봉부터 N봉 안에 한 번이라도 만족하면 충족' }),
              h('span', { class: 'ccf-hint', text: '봉 이내 만족' }),
            ]),
          ]),
          h('div', { style: { display: 'flex', gap: '4px', flexShrink: '0' } }, [
            h('button', { class: 'ccf-btn', text: '수정', onclick: function () { openPicker(it, function (ni) { c.items[j] = ni; markDirty(); renderMain(); }); } }),
            h('button', { class: 'ccf-btn red', text: '삭제', onclick: function () { c.items.splice(j, 1); c.logic = ''; markDirty(); renderMain(); } }),
          ]),
        ]));
      });
      if (!c.items.length) itemsBox.appendChild(h('div', { class: 'ccf-hint', text: '[+ 조건 추가]로 기술적분석·시세분석·패턴분석 항목이나 직접 만든 수식을 넣으세요.' }));
      main.appendChild(itemsBox);
      if (c.items.length < 20) main.appendChild(h('button', { class: 'ccf-btn', text: '+ 조건 추가', onclick: function () {
        openPicker(null, function (ni) { ni.res = ni.res || chartRes(); c.items.push(ni); c.logic = ''; markDirty(); renderMain(); });
      } }));
      // 조합식
      const defLogic = L.join(' and ');
      const logicIn = inp(c.logic || defLogic, function (v) { c.logic = v; markDirty(); checkLogic(); }, { style: { flex: '1', minWidth: '200px', fontFamily: 'Consolas,monospace' } });
      const logicMsg = h('span', { class: 'ccf-hint' });
      function checkLogic() {
        try { if (L.length) ENG.compileLogic(logicIn.value || defLogic, L); logicMsg.textContent = '예: A and (B or !C)'; logicMsg.style.color = ''; } catch (e) { logicMsg.textContent = e.message; logicMsg.style.color = '#ff8a80'; }
      }
      main.appendChild(h('div', { class: 'ccf-row', style: { marginTop: '10px' } }, [h('span', { class: 'ccf-lab', text: '조합식' }), logicIn, logicMsg]));
      checkLogic();
      // 대상
      const listIn = inp(c.target.list || '', function (v) { c.target.list = v; markDirty(); }, { placeholder: '예: XAUUSD, BTCUSD, US100', style: { flex: '1', minWidth: '200px', display: c.target.kind === 'list' ? '' : 'none' } });
      main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '대상' }),
        sel(TARGETS, c.target.kind || 'all', function (v) { c.target.kind = v; listIn.style.display = v === 'list' ? '' : 'none'; markDirty(); }),
        listIn,
        h('span', { class: 'ccf-hint', text: '조회 봉 수' }),
        inp(c.bars || 500, function (v) { c.bars = Math.max(100, Math.min(5000, Math.round(+v || 500))); markDirty(); }, { type: 'number', min: 100, max: 5000, step: 100, class: 'ccf-in ccf-num' }),
        h('button', { class: 'ccf-btn', text: '종목 목록 새로고침', onclick: async function () { try { const l = await loadSymbols(true); toast('종목 ' + l.length + '개를 불러왔습니다', 'ok'); } catch (e) { toast(e.message, 'err'); } } }),
      ]));
      main.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '봉 기준' }),
        h('label', { title: '체크하면 지금 만들어지고 있는 봉을 빼고, 마감된 봉까지만 계산합니다' }, [
          h('input', { type: 'checkbox', checked: !!c.closedOnly, onchange: function (e) { c.closedOnly = e.target.checked; markDirty(); } }),
          ' 완성된 봉만 (진행 중인 봉 제외)']),
        h('span', { class: 'ccf-hint', text: '끄면 키움처럼 현재 봉(0봉전)까지 실시간으로 봅니다' })]));
      // 실행
      const status = h('span', { class: 'ccf-hint' });
      const liveSel = sel([[1, '1분'], [3, '3분'], [5, '5분'], [15, '15분'], [30, '30분'], [60, '60분']], st.liveMin, function (v) { st.liveMin = +v; if (st.live) startLive(); });
      const liveBtn = h('button', { class: 'ccf-btn' + (st.live ? ' pri' : ''), text: st.live ? '실시간 감시 중지' : '실시간 감시 시작', onclick: function () { if (st.live) stopLive(); else startLive(); renderMain(); } });
      main.appendChild(h('div', { class: 'ccf-row', style: { marginTop: '10px' } }, [
        h('button', { class: 'ccf-btn pri', text: st.running ? '검색 중…' : '검색', disabled: st.running, onclick: function () { doSearch(false); } }),
        h('button', { class: 'ccf-btn', 'data-save': '1', text: st.dirty ? '저장 *' : '저장', onclick: doSave }),
        h('button', { class: 'ccf-btn', text: '현재 차트에 신호 표시', title: '조건식을 신호검색 수식으로 바꿔 차트에 표시합니다', onclick: doChart }),
        liveBtn, liveSel,
        status,
      ]));
      st.statusEl = status;
      // 결과
      const resBox = h('div', { style: { marginTop: '8px' } });
      main.appendChild(resBox);
      st.resBox = resBox;
      renderResult();
    }

    function renderResult() {
      const box = st.resBox; if (!box) return;
      box.innerHTML = '';
      const r = st.result;
      if (!r) return;
      if (r.error) { box.appendChild(h('div', { class: 'ccf-out err', text: r.error })); return; }
      const s = st.sort;
      const rows = r.results.slice().sort(function (a, b) {
        const x = a[s.k], y = b[s.k];
        if (typeof x === 'string') return x.localeCompare(y) * s.dir;
        return ((isFinite(x) ? x : -Infinity) - (isFinite(y) ? y : -Infinity)) * s.dir;
      });
      box.appendChild(h('div', { class: 'ccf-hint', text: '검색 결과 ' + r.results.length + '종목 / 대상 ' + r.total + '종목 · ' + (r.ms / 1000).toFixed(1) + '초 · ' + fmtTime(r.at) + (r.errors.length ? ' · 실패 ' + r.errors.length : '') + ' · 종목을 누르면 사이트에서 그 종목을 엽니다' }));
      function th(k, label) {
        return h('th', { text: label + (s.k === k ? (s.dir > 0 ? ' ▲' : ' ▼') : ''), onclick: function () { if (s.k === k) s.dir = -s.dir; else { s.k = k; s.dir = k === 'symbol' ? 1 : -1; } renderResult(); } });
      }
      const table = h('table', { class: 'ccf-table' }, [h('thead', null, h('tr', null, [th('symbol', '종목'), th('price', '현재가'), th('chg', '전일 대비'), h('th', { text: '조건' }), th('at', '최근 충족 봉')]))]);
      const tb = h('tbody');
      rows.forEach(function (x) {
        const chg = isFinite(x.chg) ? x.chg : NaN;
        tb.appendChild(h('tr', { class: 'click', onclick: function () { openSymbol(x.symbol); } }, [
          h('td', null, [h('b', { text: x.symbol }), x.isNew ? h('span', { class: 'ccf-chip on', style: { marginLeft: '6px' }, text: '신규' }) : null]),
          h('td', { text: isFinite(x.price) ? (x.dec !== null && x.dec !== undefined ? x.price.toFixed(x.dec) : String(+x.price.toPrecision(10))) : '-' }),
          h('td', { class: chg > 0 ? 'ccf-up' : chg < 0 ? 'ccf-dn' : '', text: isFinite(chg) ? (chg > 0 ? '+' : '') + chg.toFixed(2) + '%' : '-' }),
          h('td', null, r.letters.map(function (l) { return h('span', { class: 'ccf-chip' + (x.hits[l] ? ' on' : ''), text: l }); })),
          h('td', { text: x.at ? fmtTime(x.at) : '-' }),
        ]));
      });
      if (!rows.length) tb.appendChild(h('tr', null, h('td', { colspan: 5, class: 'ccf-hint', text: '조건을 만족하는 종목이 없습니다.' })));
      table.appendChild(tb);
      box.appendChild(table);
      if (r.errors.length) box.appendChild(h('details', { style: { marginTop: '6px' } }, [h('summary', { class: 'ccf-hint', text: '조회 실패 ' + r.errors.length + '건' }), h('div', { class: 'ccf-out err', text: r.errors.join('\n') })]));
    }

    async function doSearch(isLive) {
      if (st.running) return;
      const c = st.draft; if (!c) return;
      st.running = true;
      if (!isLive) renderMain();
      try {
        const r = await runCondition(c, function (d, n) { if (st.statusEl) st.statusEl.textContent = '조회 중 ' + d + ' / ' + n; });
        r.at = Date.now();
        const set = new Set(r.results.map(function (x) { return x.symbol; }));
        if (st.lastSet) {
          r.results.forEach(function (x) { x.isNew = !st.lastSet.has(x.symbol); });
          const added = r.results.filter(function (x) { return x.isNew; }).map(function (x) { return x.symbol; });
          const removed = Array.from(st.lastSet).filter(function (s) { return !set.has(s); });
          if (isLive && (added.length || removed.length)) notifyLive(c.name, added, removed);
        }
        if (isLive || st.live) st.lastSet = set;
        st.result = r;
      } catch (e) {
        st.result = { error: e.message };
      }
      st.running = false;
      renderMain();
    }
    function notifyLive(name, added, removed) {
      const msg = '[' + name + '] ' + (added.length ? '편입: ' + added.join(', ') : '') + (added.length && removed.length ? ' · ' : '') + (removed.length ? '이탈: ' + removed.join(', ') : '');
      toast(msg, added.length ? 'ok' : '', 12000);
      try {
        if (added.length) {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const o = ac.createOscillator(), g = ac.createGain();
          o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.25);
        }
        if (window.Notification && Notification.permission === 'granted') new Notification('조건검색 ' + name, { body: msg });
      } catch (e) { /* 알림 불가 */ }
    }
    function startLive() {
      stopLive(true);
      if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* 무시 */ } }
      st.lastSet = st.result && st.result.results ? new Set(st.result.results.map(function (x) { return x.symbol; })) : null;
      st.live = setInterval(function () { doSearch(true); }, st.liveMin * 60000);
      toast('실시간 감시: ' + st.liveMin + '분마다 다시 검색합니다 (이 창을 닫으면 멈춤)', 'ok');
      if (!st.result) doSearch(true);
    }
    function stopLive(quiet) {
      if (st.live) { clearInterval(st.live); st.live = null; if (!quiet) toast('실시간 감시를 멈췄습니다'); }
      st.lastSet = null;
    }
    function doSave() {
      const c = st.draft; if (!c) return;
      if (!c.name.trim()) { toast('조건식 이름을 입력하세요', 'err'); return; }
      if (LIB.conds.some(function (x) { return x.id !== c.id && x.name === c.name.trim(); })) { toast('같은 이름의 조건식이 있습니다', 'err'); return; }
      c.name = c.name.trim();
      const idx = LIB.conds.findIndex(function (x) { return x.id === c.id; });
      if (idx >= 0) LIB.conds[idx] = clone(c); else LIB.conds.push(clone(c));
      saveLib(); st.dirty = false; toast('조건식을 저장했습니다', 'ok'); render();
    }
    async function doChart() {
      const c = st.draft; if (!c || !c.items.length) { toast('조건을 먼저 추가하세요', 'err'); return; }
      try {
        const r = conditionToDef(c);
        ENG.compileLogic((c.logic && c.logic.trim()) || letters(c.items.length).join(' and '), letters(c.items.length));
        const old = LIB.defs.findIndex(function (d) { return d.name === r.def.name; });
        if (old >= 0) { r.def.id = LIB.defs[old].id; LIB.defs[old] = r.def; } else LIB.defs.push(r.def);
        compileDef(r.def);
        saveLib();
        if (studiesUsing(r.def.name).length) refreshStudies(r.def.name, r.def); else await applyToChart(r.def);
        const cr = chartRes();
        if (r.resSet.size > 1 || !r.resSet.has(cr)) toast('참고: 조건 주기(' + Array.from(r.resSet).map(resLabel).join(', ') + ')와 차트 주기(' + resLabel(cr) + ')가 달라도 차트 주기로 계산됩니다', '', 9000);
        if (UI.manager) UI.manager.refresh();
      } catch (e) { toast(e.message, 'err', 8000); }
    }

    function render() { renderSide(); renderMain(); }
    const f = LIB.conds[0]; st.selId = f ? f.id : null; st.draft = f ? clone(f) : null;
    render();
    UI.search = { win: W.win, refreshList: function () { renderSide(); } };
  }

  // 조건 항목 고르기: 폴더 트리(대분류 → 폴더 → 항목) + 검색
  function openPicker(existing, onDone) {
    const W = makeWindow(existing ? '조건 수정' : '조건 추가', 860, 540, 'picker');
    const item = existing ? clone(existing) : { preset: 'ma_golden', params: {}, res: null, offset: 0, within: 1 };
    if (item.preset !== 'formula' && item.preset !== 'user') {
      const p0 = presetById(item.preset);
      if (p0) item.preset = p0.id;
    }
    const openSet = new Set(lsGet('ccf-tree-open', ['기술적분석']));
    function saveOpen() { lsSet('ccf-tree-open', Array.from(openSet)); }
    // 처음 열 때 선택된 항목의 폴더는 펼친다
    const cur0 = presetById(item.preset);
    if (cur0) { openSet.add(cur0.cat); openSet.add(cur0.cat + '/' + cur0.grp); }
    if (item.preset === 'user') openSet.add('사용자수식');

    const search = h('input', { class: 'ccf-in', placeholder: '조건 찾기 (예: 골든, RSI, 망치)', style: { width: '100%' } });
    const tree = h('div', { class: 'ccf-tree' });
    const left = h('div', { class: 'ccf-tleft' }, [search, h('div', { class: 'ccf-hint', style: { margin: '4px 2px' }, text: '전체 ' + PRESETS.length + '개 항목' }), tree]);
    const right = h('div', { class: 'ccf-tright' });
    const wrap = h('div', { class: 'ccf-main', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [h('div', { class: 'ccf-pick2' }, [left, right])]);
    W.body.appendChild(wrap);
    W.close.addEventListener('click', function () { W.win.remove(); });
    const okBtn = h('button', { class: 'ccf-btn pri', text: existing ? '수정' : '추가', onclick: function () {
      try {
        const f = itemFormula(item);
        ENG.compile(f.src, { userFuncs: f.funcs, vars: f.vars });
      } catch (e) { toast(e.message, 'err', 6000); return; }
      W.win.remove(); onDone(item);
    } });
    wrap.appendChild(h('div', { class: 'ccf-row' }, [okBtn, h('button', { class: 'ccf-btn', text: '취소', onclick: function () { W.win.remove(); } })]));
    search.addEventListener('input', drawTree);

    function nodeRow(key, label, count, depth) {
      const open = openSet.has(key) || !!search.value.trim();
      return h('div', { class: 'ccf-node', style: { paddingLeft: (4 + depth * 14) + 'px' }, onclick: function () {
        if (openSet.has(key)) openSet.delete(key); else openSet.add(key);
        saveOpen(); drawTree();
      } }, [h('span', { class: 'ccf-caret', text: open ? '▾' : '▸' }), h('span', { text: (depth ? '📁 ' : '📂 ') + label }), count !== null ? h('small', { text: ' ' + count }) : null]);
    }
    function leafRow(label, on, depth, onclick, title) {
      return h('div', { class: 'ccf-leaf' + (on ? ' on' : ''), style: { paddingLeft: (22 + depth * 14) + 'px' }, title: title || label, onclick: onclick, text: label });
    }

    function drawTree() {
      tree.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const match = function (s) { return !q || s.toLowerCase().indexOf(q) >= 0; };
      PRESET_TREE.forEach(function (c) {
        const folders = c.folders.map(function (f) {
          const its = f.items.filter(function (it) { return match(it.name) || match(f.name); });
          return { f: f, its: its };
        }).filter(function (x) { return x.its.length; });
        if (!folders.length) return;
        const total = folders.reduce(function (a, x) { return a + x.its.length; }, 0);
        tree.appendChild(nodeRow(c.name, c.name, total, 0));
        if (!openSet.has(c.name) && !q) return;
        folders.forEach(function (x) {
          const fk = c.name + '/' + x.f.name;
          tree.appendChild(nodeRow(fk, x.f.name, x.its.length, 1));
          if (!openSet.has(fk) && !q) return;
          x.its.forEach(function (it) {
            tree.appendChild(leafRow(it.name, item.preset === it.id, 2, function () {
              if (item.preset !== it.id) { item.preset = it.id; item.params = {}; }
              drawTree(); drawRight();
            }));
          });
        });
      });
      // 사용자 수식 (수식관리자에 저장된 것)
      const defs = LIB.defs.filter(function (d) { return match(d.name) || match('사용자수식'); });
      if (defs.length) {
        tree.appendChild(nodeRow('사용자수식', '사용자수식 (수식관리자)', defs.length, 0));
        if (openSet.has('사용자수식') || q) {
          TYPE_TABS.filter(function (t) { return t[0] !== 'func'; }).forEach(function (t) {
            const ds = defs.filter(function (d) { return d.type === t[0]; });
            if (!ds.length) return;
            const fk = '사용자수식/' + t[0];
            tree.appendChild(nodeRow(fk, t[1], ds.length, 1));
            if (!openSet.has(fk) && !q) return;
            ds.forEach(function (d) {
              tree.appendChild(leafRow(d.name, item.preset === 'user' && item.defName === d.name, 2, function () {
                item.preset = 'user'; if (item.defName !== d.name) { item.defName = d.name; item.which = null; }
                drawTree(); drawRight();
              }, d.desc));
            });
          });
        }
      }
      if (match('직접입력') || match('수식')) {
        tree.appendChild(h('div', { class: 'ccf-node' + (item.preset === 'formula' ? ' on' : ''), style: { paddingLeft: '4px' }, onclick: function () {
          item.preset = 'formula'; item.formula = item.formula || ''; drawTree(); drawRight();
        } }, [h('span', { class: 'ccf-caret', text: '✎' }), h('span', { text: '직접입력 (수식으로 쓰기)' })]));
      }
      if (!tree.children.length) tree.appendChild(h('div', { class: 'ccf-hint', style: { padding: '8px' }, text: '찾는 항목이 없습니다.' }));
    }

    function drawRight() {
      right.innerHTML = '';
      if (item.preset === 'formula') {
        right.appendChild(h('div', { class: 'ccf-sec', text: '직접입력' }));
        right.appendChild(h('div', { class: 'ccf-hint', style: { whiteSpace: 'pre-wrap' }, text: '수식관리자와 같은 문법으로 참/거짓 조건을 쓰세요.\n예) A = avg(C, 5); B = avg(C, 20);\n    CrossUp(A, B) and V > avg(V, 20)' }));
        right.appendChild(ta(item.formula, function (v) { item.formula = v; }, 10));
        return;
      }
      if (item.preset === 'user') {
        const d = LIB.defs.find(function (x) { return x.name === item.defName; });
        if (!d) { right.appendChild(h('div', { class: 'ccf-hint', text: '왼쪽에서 수식을 고르세요.' })); return; }
        const opts = d.type === 'indicator' ? (d.lines || []).map(function (l, j) { return [String(j), (l.name || '수식' + (j + 1)) + ' (0이 아니면 참)']; }) : WHICH[d.type];
        if (!item.which || !opts.some(function (o) { return o[0] === item.which; })) item.which = opts[0] ? opts[0][0] : null;
        right.appendChild(h('div', { class: 'ccf-sec', text: '사용자수식 › ' + d.name }));
        if (d.desc) right.appendChild(h('div', { class: 'ccf-hint', text: d.desc }));
        right.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: '사용할 수식' }), sel(opts, item.which, function (v) { item.which = v; })]));
        right.appendChild(h('div', { class: 'ccf-hint', text: '지표변수는 수식관리자에 저장된 값을 씁니다.' }));
        return;
      }
      const p = presetById(item.preset);
      if (!p) { right.appendChild(h('div', { class: 'ccf-hint', text: '왼쪽에서 조건을 고르세요.' })); return; }
      right.appendChild(h('div', { class: 'ccf-hint', text: p.cat + ' › ' + p.grp }));
      right.appendChild(h('div', { class: 'ccf-sec', style: { fontSize: '13px', color: '#e3e7ee' }, text: p.name }));
      item.params = item.params || {};
      const preview = h('div', { class: 'ccf-out' });
      const upd = function () { preview.textContent = fillTemplate(p.f, item.params, p); };
      p.params.forEach(function (x) {
        if (item.params[x.k] === undefined) item.params[x.k] = x.def;
        const field = x.options
          ? sel(x.options.map(function (o) { return [o, o]; }), paramValue(p, item.params, x.k), function (v) { item.params[x.k] = v; upd(); })
          : inp(item.params[x.k], function (v) { item.params[x.k] = v === '' ? '' : +v; upd(); }, { type: 'number', step: x.step || 'any', class: 'ccf-in ccf-num' });
        right.appendChild(h('div', { class: 'ccf-row' }, [h('span', { class: 'ccf-lab', text: x.label }), field]));
      });
      if (!p.params.length) right.appendChild(h('div', { class: 'ccf-hint', text: '설정할 값이 없습니다.' }));
      right.appendChild(h('div', { class: 'ccf-sec', text: '수식' }));
      right.appendChild(preview);
      upd();
      right.appendChild(h('button', { class: 'ccf-btn', style: { marginTop: '6px' }, text: '이 수식을 직접입력으로 고치기', onclick: function () {
        item.formula = fillTemplate(p.f, item.params, p); item.preset = 'formula'; drawTree(); drawRight();
      } }));
    }
    drawTree(); drawRight();
    setTimeout(function () { const on = tree.querySelector('.ccf-leaf.on'); if (on) on.scrollIntoView({ block: 'center' }); }, 0);
  }

  // -----------------------------------------------------------------------------
  // 툴바 버튼
  // -----------------------------------------------------------------------------
  function injectButtons() {
    const bar = document.querySelector('.chart-tv-toolbox-desktop__buttons');
    if (bar) {
      if (bar.querySelector('.ccf-tbtn')) return true;
      ensureCss();
      bar.appendChild(h('button', { class: 'ccf-tbtn', title: '수식관리자 (사용자 지표·신호·전략·강세약세)', onclick: openManager }, ['ƒx 수식']));
      bar.appendChild(h('button', { class: 'ccf-tbtn', title: '조건검색', onclick: openSearch }, ['🔍 조건검색']));
      const fab = document.querySelector('.ccf-fab'); if (fab) fab.remove();
      return true;
    }
    return false;
  }
  function ensureFab() {
    if (document.querySelector('.ccf-tbtn') || document.querySelector('.ccf-fab') || !document.querySelector('iframe[id^="tradingview_"]')) return;
    ensureCss();
    document.body.appendChild(h('div', { class: 'ccf-fab' }, [h('button', { onclick: openManager, text: 'ƒx 수식' }), h('button', { onclick: openSearch, text: '조건검색' })]));
  }

  // -----------------------------------------------------------------------------
  // 시작
  // -----------------------------------------------------------------------------
  new MutationObserver(function (muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const frames = n.tagName === 'IFRAME' ? [n] : n.querySelectorAll('iframe');
        for (const f of frames) if (f.id && f.id.indexOf('tradingview_') === 0) patchWidget(f.id);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  setInterval(function () {
    if (!document.body) return;
    if (!injectButtons()) ensureFab();
  }, 1500);

  window.ccFormula = { engine: ENG, openManager: openManager, openSearch: openSearch, runCondition: runCondition, lib: function () { return LIB; } };
  console.log(LOG, '로드됨');

}

// 차트 위젯 옵션(window[iframe id])에 접근하려면 페이지 안에서 실행해야 하므로 코드를 페이지에 직접 넣는다
(function inject() {
  const root = document.head || document.documentElement;
  if (!root) {
    new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); inject(); } })
      .observe(document, { childList: true });
    return;
  }
  const s = document.createElement('script');
  s.textContent = '(' + ccfMain.toString() + ')();';
  root.appendChild(s);
  s.remove();
})();
