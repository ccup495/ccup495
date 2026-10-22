// ==UserScript==
// @name         컬쳐캐피탈 커스텀 지표
// @namespace    culture-capital-custom-indicators
// @version      1.6.2
// @description  컬쳐캐피탈(Match-Trader) 트레이딩뷰 차트: 커스텀 지표 27종 + 차트 유형 메뉴 확장
// @match        https://mtr.culturecapitalllc.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ccup495/ccup495/main/culture-capital-indicators.user.js
// @downloadURL  https://raw.githubusercontent.com/ccup495/ccup495/main/culture-capital-indicators.user.js
// ==/UserScript==

function ccMain() {
  'use strict';

  // ---------------------------------------------------------------------------
  // 커스텀 지표 정의 (TradingView Charting Library custom_indicators_getter 형식)
  // ---------------------------------------------------------------------------
  function customIndicators(PineJS) {
    const Std = PineJS.Std;

    // 슈퍼트렌드 (KivancOzbilgic 버전 로직)
    const superTrend = {
      name: 'CC 슈퍼트렌드',
      metainfo: {
        _metainfoVersion: 53,
        id: 'CCSuperTrend@tv-basicstudies-1',
        name: 'CC 슈퍼트렌드',
        description: 'CC 슈퍼트렌드',
        shortDescription: '슈퍼트렌드',
        is_price_study: true,
        isCustomIndicator: true,
        format: { type: 'inherit' },
        plots: [
          { id: 'plot_0', type: 'line' },
          { id: 'plot_1', type: 'line' },
          { id: 'plot_2', type: 'shapes' },
          { id: 'plot_3', type: 'shapes' },
        ],
        defaults: {
          styles: {
            plot_0: { linestyle: 0, linewidth: 2, plottype: 7, trackPrice: false, transparency: 0, visible: true, color: '#00C853' },
            plot_1: { linestyle: 0, linewidth: 2, plottype: 7, trackPrice: false, transparency: 0, visible: true, color: '#FF1744' },
            plot_2: { plottype: 'shape_triangle_up', location: 'BelowBar', visible: true, color: '#00C853', transparency: 0 },
            plot_3: { plottype: 'shape_triangle_down', location: 'AboveBar', visible: true, color: '#FF1744', transparency: 0 },
          },
          inputs: { period: 10, multiplier: 3 },
        },
        styles: {
          plot_0: { title: '상승 추세선', histogramBase: 0 },
          plot_1: { title: '하락 추세선', histogramBase: 0 },
          plot_2: { title: '매수 신호', isHidden: false },
          plot_3: { title: '매도 신호', isHidden: false },
        },
        inputs: [
          { id: 'period', name: 'ATR 기간', defval: 10, type: 'integer', min: 1, max: 500 },
          { id: 'multiplier', name: 'ATR 배수', defval: 3, type: 'float', min: 0.1, max: 50, step: 0.1 },
        ],
      },
      constructor: function () {
        this.main = function (context, inputCallback) {
          this._context = context;
          this._input = inputCallback;
          const period = this._input(0);
          const mult = this._input(1);

          const close = Std.close(context);
          const src = (Std.high(context) + Std.low(context)) / 2;
          const atr = Std.atr(period, context);
          const closeVar = context.new_var(close);
          const prevClose = closeVar.get(1);

          const upVar = context.new_var();
          const dnVar = context.new_var();
          const trendVar = context.new_var();
          const up1 = upVar.get(1);
          const dn1 = dnVar.get(1);
          const trend1 = trendVar.get(1);

          let up = src - mult * atr;
          let dn = src + mult * atr;
          const prevUp = isNaN(up1) ? up : up1;
          const prevDn = isNaN(dn1) ? dn : dn1;
          if (prevClose > prevUp) up = Math.max(up, prevUp);
          if (prevClose < prevDn) dn = Math.min(dn, prevDn);

          let trend = isNaN(trend1) ? 1 : trend1;
          if (trend === -1 && close > prevDn) trend = 1;
          else if (trend === 1 && close < prevUp) trend = -1;

          upVar.set(up);
          dnVar.set(dn);
          trendVar.set(trend);

          if (isNaN(atr)) return [NaN, NaN, NaN, NaN];
          const buy = trend === 1 && trend1 === -1;
          const sell = trend === -1 && trend1 === 1;
          return [
            trend === 1 ? up : NaN,
            trend === -1 ? dn : NaN,
            buy ? 1 : NaN,
            sell ? 1 : NaN,
          ];
        };
      },
    };

    // 스퀴즈 모멘텀 [LazyBear] — 트레이딩뷰 인기 커뮤니티 지표
    const squeeze = {
      name: 'CC 스퀴즈 모멘텀 [LazyBear]',
      metainfo: {
        _metainfoVersion: 53,
        id: 'CCSqueezeMomentum@tv-basicstudies-1',
        name: 'CC 스퀴즈 모멘텀 [LazyBear]',
        description: 'CC 스퀴즈 모멘텀 [LazyBear]',
        shortDescription: '스퀴즈 모멘텀',
        is_price_study: false,
        isCustomIndicator: true,
        format: { type: 'price', precision: 4 },
        plots: [
          { id: 'plot_0', type: 'line' },
          { id: 'plot_1', type: 'colorer', target: 'plot_0', palette: 'palette_0' },
          { id: 'plot_2', type: 'line' },
          { id: 'plot_3', type: 'colorer', target: 'plot_2', palette: 'palette_1' },
        ],
        palettes: {
          palette_0: {
            colors: { 0: { name: '상승 강화' }, 1: { name: '상승 약화' }, 2: { name: '하락 강화' }, 3: { name: '하락 약화' } },
            valToIndex: { 0: 0, 1: 1, 2: 2, 3: 3 },
          },
          palette_1: {
            colors: { 0: { name: '스퀴즈 없음' }, 1: { name: '스퀴즈 중' }, 2: { name: '스퀴즈 해제' } },
            valToIndex: { 0: 0, 1: 1, 2: 2 },
          },
        },
        defaults: {
          palettes: {
            palette_0: {
              colors: {
                0: { color: '#00E676', width: 4, style: 0 },
                1: { color: '#1B5E20', width: 4, style: 0 },
                2: { color: '#FF1744', width: 4, style: 0 },
                3: { color: '#880E4F', width: 4, style: 0 },
              },
            },
            palette_1: {
              colors: {
                0: { color: '#2962FF', width: 2, style: 0 },
                1: { color: '#000000', width: 2, style: 0 },
                2: { color: '#9E9E9E', width: 2, style: 0 },
              },
            },
          },
          styles: {
            plot_0: { linestyle: 0, linewidth: 4, plottype: 5, trackPrice: false, transparency: 0, visible: true, color: '#00E676' },
            plot_2: { linestyle: 0, linewidth: 2, plottype: 3, trackPrice: false, transparency: 0, visible: true, color: '#9E9E9E' },
          },
          inputs: { bbLength: 20, bbMult: 2, kcLength: 20, kcMult: 1.5, useTrueRange: true },
        },
        styles: {
          plot_0: { title: '모멘텀', histogramBase: 0 },
          plot_2: { title: '스퀴즈 상태', histogramBase: 0 },
        },
        inputs: [
          { id: 'bbLength', name: '볼린저 기간', defval: 20, type: 'integer', min: 1, max: 500 },
          { id: 'bbMult', name: '볼린저 배수', defval: 2, type: 'float', min: 0.1, max: 10, step: 0.1 },
          { id: 'kcLength', name: '켈트너 기간', defval: 20, type: 'integer', min: 1, max: 500 },
          { id: 'kcMult', name: '켈트너 배수', defval: 1.5, type: 'float', min: 0.1, max: 10, step: 0.1 },
          { id: 'useTrueRange', name: '켈트너에 True Range 사용', defval: true, type: 'bool' },
        ],
      },
      constructor: function () {
        this.main = function (context, inputCallback) {
          this._context = context;
          this._input = inputCallback;
          const bbLength = this._input(0);
          // 원본 LazyBear 코드는 BB 표준편차에 켈트너 배수(multKC)를 사용 — 동일하게 재현
          const kcLength = this._input(2);
          const kcMult = this._input(3);
          const useTR = this._input(4);

          const high = Std.high(context);
          const low = Std.low(context);
          const close = Std.close(context);

          const closeVar = context.new_var(close);
          const highVar = context.new_var(high);
          const lowVar = context.new_var(low);
          const prevClose = closeVar.get(1);

          // 볼린저 밴드
          const basis = Std.sma(closeVar, bbLength, context);
          const dev = kcMult * Std.stdev(closeVar, bbLength, context);
          const upperBB = basis + dev;
          const lowerBB = basis - dev;

          // 켈트너 채널
          const ma = Std.sma(closeVar, kcLength, context);
          const tr = isNaN(prevClose)
            ? high - low
            : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
          const rangeVar = context.new_var(useTR ? tr : high - low);
          const rangema = Std.sma(rangeVar, kcLength, context);
          const upperKC = ma + rangema * kcMult;
          const lowerKC = ma - rangema * kcMult;

          const sqzOn = lowerBB > lowerKC && upperBB < upperKC;
          const sqzOff = lowerBB < lowerKC && upperBB > upperKC;

          // 모멘텀: linreg(close - avg(avg(highest, lowest), sma), kcLength, 0)
          const hh = Std.highest(highVar, kcLength, context);
          const ll = Std.lowest(lowVar, kcLength, context);
          // linreg가 과거 kcLength개 값을 직접 읽으므로 히스토리 제한 없는 변수 사용
          const srcVar = context.new_unlimited_var(close - ((hh + ll) / 2 + ma) / 2);
          const val = linreg(srcVar, kcLength);
          const valVar = context.new_var(val);
          const prevVal = valVar.get(1);
          const pv = isNaN(prevVal) ? 0 : prevVal;

          const barColor = val > 0 ? (val > pv ? 0 : 1) : (val < pv ? 2 : 3);
          const sqzColor = !sqzOn && !sqzOff ? 0 : sqzOn ? 1 : 2;
          return [val, barColor, isNaN(val) ? NaN : 0, sqzColor];
        };

        // 최소제곱 선형회귀, 현재 봉(offset 0) 위치의 값
        function linreg(series, n) {
          let sx = 0, sy = 0, sxy = 0, sxx = 0;
          for (let i = 0; i < n; i++) {
            const y = series.get(i);
            if (isNaN(y)) return NaN;
            const x = n - 1 - i;
            sx += x; sy += y; sxy += x * y; sxx += x * x;
          }
          const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
          const intercept = (sy - slope * sx) / n;
          return intercept + slope * (n - 1);
        }
      },
    };

    return [superTrend, squeeze].concat(moreIndicators(PineJS));
  }

  // ---------------------------------------------------------------------------
  // 공통 도우미: 파인스크립트 ta.* 함수 대응. 모두 매 봉 같은 순서로 호출되어야 한다.
  // ---------------------------------------------------------------------------
  function helpers(Std) {
    const H = {
      nz: (x, d) => (isNaN(x) ? (d === undefined ? 0 : d) : x),
      sma: (ctx, x, n) => Std.sma(ctx.new_unlimited_var(x), n, ctx),
      wma: (ctx, x, n) => Std.wma(ctx.new_unlimited_var(x), n, ctx),
      stdev: (ctx, x, n) => Std.stdev(ctx.new_unlimited_var(x), n, ctx),
      highest: (ctx, x, n) => Std.highest(ctx.new_unlimited_var(x), n, ctx),
      lowest: (ctx, x, n) => Std.lowest(ctx.new_unlimited_var(x), n, ctx),
      sum: (ctx, x, n) => Std.sum(ctx.new_unlimited_var(x), n, ctx),
      // 이전 값 참조용: [현재값, 1봉 전, 2봉 전 ...]
      prev: (ctx, x, k) => { const v = ctx.new_unlimited_var(x); return v.get(k || 1); },
      ema: (ctx, x, n) => {
        const v = ctx.new_unlimited_var(); const p = v.get(1); const a = 2 / (n + 1);
        const r = isNaN(p) ? x : isNaN(x) ? p : a * x + (1 - a) * p;
        v.set(r); return r;
      },
      rma: (ctx, x, n) => {
        const s = Std.sma(ctx.new_unlimited_var(x), n, ctx);
        const v = ctx.new_unlimited_var(); const p = v.get(1);
        const r = isNaN(p) ? s : isNaN(x) ? p : (x + (n - 1) * p) / n;
        v.set(r); return r;
      },
      tr: (ctx) => {
        const h = Std.high(ctx), l = Std.low(ctx);
        const c1 = H.prev(ctx, Std.close(ctx));
        return isNaN(c1) ? h - l : Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1));
      },
      rsi: (ctx, x, n) => {
        const x1 = H.prev(ctx, x);
        const ch = x - x1;
        const up = H.rma(ctx, isNaN(ch) ? NaN : Math.max(ch, 0), n);
        const dn = H.rma(ctx, isNaN(ch) ? NaN : -Math.min(ch, 0), n);
        if (isNaN(up) || isNaN(dn)) return NaN;
        return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
      },
      cci: (ctx, x, n) => {
        const h = ctx.new_unlimited_var(x);
        const ma = H.sma(ctx, x, n);
        if (isNaN(ma)) return NaN;
        let md = 0;
        for (let i = 0; i < n; i++) md += Math.abs(h.get(i) - ma);
        md /= n;
        return md === 0 ? 0 : (x - ma) / (0.015 * md);
      },
      // 순위 상관 지수 (ta.rci)
      rci: (ctx, h, n) => {
        const vals = [];
        for (let i = 0; i < n; i++) { const y = h.get(i); if (isNaN(y)) return NaN; vals.push(y); }
        const order = vals.map((y, i) => [y, i]).sort((a, b) => b[0] - a[0]);
        const rank = new Array(n);
        for (let k = 0; k < n;) {
          let j = k; while (j + 1 < n && order[j + 1][0] === order[k][0]) j++;
          const r = (k + j) / 2 + 1;
          for (let m = k; m <= j; m++) rank[order[m][1]] = r;
          k = j + 1;
        }
        let d2 = 0;
        for (let i = 0; i < n; i++) { const d = (i + 1) - rank[i]; d2 += d * d; }
        return (1 - (6 * d2) / (n * (n * n - 1))) * 100;
      },
      ma: (ctx, type, x, n) => {
        switch (type) {
          case 'EMA': return H.ema(ctx, x, n);
          case 'SMMA (RMA)': return H.rma(ctx, x, n);
          case 'WMA': return H.wma(ctx, x, n);
          case 'VWMA': {
            const vol = Std.volume(ctx);
            return H.sma(ctx, x * vol, n) / H.sma(ctx, vol, n);
          }
          default: return H.sma(ctx, x, n);
        }
      },
      // 어느 방향이든 교차 (파인 v4 cross)
      cross: (a, b, a1, b1) => (a > b && a1 <= b1) || (a < b && a1 >= b1),
    };
    return H;
  }

  // ---------------------------------------------------------------------------
  // 지표 정의 빌더: 간단한 선언으로 metainfo를 만든다.
  //  plots: { title, color, width, plottype(0선 1히스토그램 3십자 5컬럼 6원 7끊김선), transparency }
  //         { colorer: true, target: 대상 plot 번호, colors: [[색, 이름], ...] }
  //         { shape: 'shape_triangle_up', location: 'BelowBar', color, title }
  //  bands:  [{ value, color, name }]   (수평 기준선)
  //  main(ctx, inputs) → plots 순서대로 값 배열
  // ---------------------------------------------------------------------------
  function study(d) {
    const plots = [], styles = {}, defStyles = {}, palettes = {}, defPalettes = {};
    d.plots.forEach(function (p, i) {
      const id = 'plot_' + i;
      if (p.colorer) {
        const pal = 'palette_' + i;
        plots.push({ id: id, type: 'colorer', target: 'plot_' + p.target, palette: pal });
        palettes[pal] = { colors: {}, valToIndex: {} };
        defPalettes[pal] = { colors: {} };
        const w = d.plots[p.target].width || 1;
        p.colors.forEach(function (c, k) {
          palettes[pal].colors[k] = { name: c[1] };
          palettes[pal].valToIndex[k] = k;
          defPalettes[pal].colors[k] = { color: c[0], width: w, style: 0 };
        });
      } else if (p.barColorer) {
        // 캔들 색칠: 값은 팔레트 번호, NaN이면 원래 색
        const pal = 'palette_' + i;
        plots.push({ id: id, type: 'bar_colorer', palette: pal });
        styles[id] = { title: p.title, isHidden: false };
        palettes[pal] = { colors: [], valToIndex: {} };
        defPalettes[pal] = { colors: [] };
        p.colors.forEach(function (c, k) {
          palettes[pal].colors.push({ name: c[1] });
          palettes[pal].valToIndex[k] = k;
          defPalettes[pal].colors.push({ color: c[0] });
        });
      } else if (p.shape) {
        plots.push({ id: id, type: 'shapes' });
        styles[id] = { title: p.title, isHidden: false, size: p.size || 'small', text: p.text || '' };
        defStyles[id] = {
          plottype: p.shape, location: p.location, visible: true, color: p.color,
          textColor: p.textColor || p.color, transparency: p.transparency || 0,
        };
      } else {
        plots.push({ id: id, type: 'line' });
        styles[id] = { title: p.title, histogramBase: 0 };
        defStyles[id] = {
          linestyle: p.linestyle || 0, linewidth: p.width || 1, plottype: p.plottype || 0,
          trackPrice: false, transparency: p.transparency || 0, visible: true, color: p.color,
        };
        // 영역 채우기용 보조선: 투명하게 그리고 범례·가격축에는 표시하지 않음 (display 1 = 차트 영역만)
        if (p.hidden) { defStyles[id].transparency = 100; defStyles[id].display = 1; }
        // display 비트: 1 차트, 2 데이터 창, 4 가격축, 8 범례 (15 = 전부)
        if (p.display !== undefined) defStyles[id].display = p.display;
      }
    });
    // fills: [{ a: plot 번호, b: plot 번호, color, transparency, title }]
    const filledAreas = (d.fills || []).map(function (f, i) {
      return { id: 'fill_' + i, objAId: 'plot_' + f.a, objBId: 'plot_' + f.b, type: 'plot_plot', title: f.title };
    });
    const filledAreasStyle = {};
    (d.fills || []).forEach(function (f, i) {
      filledAreasStyle['fill_' + i] = { color: f.color, transparency: f.transparency === undefined ? 85 : f.transparency, visible: true };
    });
    const defInputs = {};
    const inputs = (d.inputs || []).map(function (inp) {
      defInputs[inp.id] = inp.defval;
      return Object.assign({ type: Number.isInteger(inp.defval) ? 'integer' : 'float' }, inp);
    });
    const metainfo = {
      _metainfoVersion: 53,
      id: d.key + '@tv-basicstudies-1',
      name: d.name,
      description: d.name,
      shortDescription: d.short,
      is_price_study: !!d.overlay,
      isCustomIndicator: true,
      format: d.format || (d.overlay ? { type: 'inherit' } : { type: 'price', precision: 2 }),
      plots: plots,
      styles: styles,
      inputs: inputs,
      defaults: { styles: defStyles, inputs: defInputs, palettes: defPalettes },
    };
    if (Object.keys(palettes).length) metainfo.palettes = palettes;
    if (filledAreas.length) {
      metainfo.filledAreas = filledAreas;
      metainfo.defaults.filledAreasStyle = filledAreasStyle;
    }
    if (d.bands) {
      metainfo.bands = d.bands.map(function (b, i) { return { id: 'hline_' + i, name: b.name || String(b.value) }; });
      metainfo.defaults.bands = d.bands.map(function (b) {
        return { color: b.color || '#787B86', linestyle: 2, linewidth: 1, value: b.value, visible: true };
      });
    }
    const main = d.main;
    return {
      name: d.name,
      metainfo: metainfo,
      constructor: function () {
        this.main = function (context, inputCallback) {
          this._context = context;
          this._input = inputCallback;
          const inp = inputs.map(function (_, i) { return inputCallback(i); });
          return main(context, inp);
        };
      },
    };
  }

  // 4색 막대: 양수 증가/감소, 음수 감소/증가
  function fourColor(x, x1) {
    return x >= 0 ? (x > H0(x1) ? 0 : 1) : (x < H0(x1) ? 2 : 3);
  }
  function H0(x) { return isNaN(x) ? 0 : x; }

  function moreIndicators(PineJS) {
    const Std = PineJS.Std;
    const H = helpers(Std);
    const C = (ctx) => Std.close(ctx);
    const hl2 = (ctx) => (Std.high(ctx) + Std.low(ctx)) / 2;
    const hlc3 = (ctx) => (Std.high(ctx) + Std.low(ctx) + Std.close(ctx)) / 3;
    const MA_TYPES = ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'];
    const list = [];

    // ======================= 트레이딩뷰 기본 지표 (컬쳐캐피탈에 없는 것) =======================

    list.push(study({
      key: 'CCBBTrend', name: 'CC 볼린저 트렌드 (BBTrend)', short: 'BBTrend',
      plots: [
        { title: 'BBTrend', color: '#089981', width: 3, plottype: 5 },
        { colorer: true, target: 0, colors: [['#089981', '양수 증가'], ['#B2DFDB', '양수 감소'], ['#F23645', '음수 증가'], ['#FCCBCD', '음수 감소']] },
      ],
      inputs: [
        { id: 'short', name: '짧은 기간', defval: 20, min: 1 },
        { id: 'long', name: '긴 기간', defval: 50, min: 1 },
        { id: 'mult', name: '표준편차 배수', defval: 2.0, type: 'float', min: 0.1, step: 0.1 },
      ],
      bands: [{ value: 0, name: '0' }],
      main: (ctx, [s, l, m]) => {
        const c = C(ctx);
        const sMid = H.sma(ctx, c, s), sDev = m * H.stdev(ctx, c, s);
        const lMid = H.sma(ctx, c, l), lDev = m * H.stdev(ctx, c, l);
        const v = (Math.abs((sMid - sDev) - (lMid - lDev)) - Math.abs((sMid + sDev) - (lMid + lDev))) / sMid * 100;
        const v1 = H.prev(ctx, v);
        return [v, fourColor(v, v1)];
      },
    }));

    list.push(study({
      key: 'CCBullBearPower', name: 'CC 불 베어 파워 (Bull Bear Power)', short: 'BBP',
      plots: [
        { title: 'BBPower', color: '#26A69A', width: 3, plottype: 5 },
        { colorer: true, target: 0, colors: [['#26A69A', '양수 증가'], ['#B2DFDB', '양수 감소'], ['#FF5252', '음수 증가'], ['#FFCDD2', '음수 감소']] },
      ],
      inputs: [{ id: 'len', name: '기간', defval: 13, min: 1 }],
      format: { type: 'inherit' },
      main: (ctx, [n]) => {
        const e = H.ema(ctx, C(ctx), n);
        const v = (Std.high(ctx) - e) + (Std.low(ctx) - e);
        return [v, fourColor(v, H.prev(ctx, v))];
      },
    }));

    list.push(study({
      key: 'CCMARibbon', name: 'CC 이동평균 리본 (Moving Average Ribbon)', short: 'MA 리본', overlay: true,
      plots: [
        { title: 'MA #1', color: '#F6C309', width: 1 },
        { title: 'MA #2', color: '#FB9800', width: 1 },
        { title: 'MA #3', color: '#FB6500', width: 1 },
        { title: 'MA #4', color: '#F60C0C', width: 1 },
      ],
      inputs: [
        { id: 't1', name: 'MA #1 종류', defval: 'SMA', type: 'text', options: MA_TYPES },
        { id: 'l1', name: 'MA #1 기간', defval: 20, min: 1 },
        { id: 't2', name: 'MA #2 종류', defval: 'SMA', type: 'text', options: MA_TYPES },
        { id: 'l2', name: 'MA #2 기간', defval: 50, min: 1 },
        { id: 't3', name: 'MA #3 종류', defval: 'SMA', type: 'text', options: MA_TYPES },
        { id: 'l3', name: 'MA #3 기간', defval: 100, min: 1 },
        { id: 't4', name: 'MA #4 종류', defval: 'SMA', type: 'text', options: MA_TYPES },
        { id: 'l4', name: 'MA #4 기간', defval: 200, min: 1 },
      ],
      main: (ctx, [t1, l1, t2, l2, t3, l3, t4, l4]) => {
        const c = C(ctx);
        return [H.ma(ctx, t1, c, l1), H.ma(ctx, t2, c, l2), H.ma(ctx, t3, c, l3), H.ma(ctx, t4, c, l4)];
      },
    }));

    list.push(study({
      key: 'CCRCI', name: 'CC 순위 상관 지수 (Rank Correlation Index)', short: 'RCI',
      plots: [{ title: 'RCI', color: '#2962FF', width: 1 }],
      inputs: [{ id: 'len', name: '기간', defval: 10, min: 2 }],
      bands: [{ value: 80, name: '상단' }, { value: 0, name: '0' }, { value: -80, name: '하단' }],
      main: (ctx, [n]) => [H.rci(ctx, ctx.new_unlimited_var(C(ctx)), n)],
    }));

    list.push(study({
      key: 'CCRCIRibbon', name: 'CC RCI 리본 (RCI Ribbon)', short: 'RCI 리본',
      plots: [
        { title: '단기 RCI', color: '#F23645', width: 1 },
        { title: '중기 RCI', color: '#2962FF', width: 1 },
        { title: '장기 RCI', color: '#089981', width: 1 },
      ],
      inputs: [
        { id: 's', name: '단기', defval: 10, min: 2 },
        { id: 'm', name: '중기', defval: 30, min: 2 },
        { id: 'l', name: '장기', defval: 50, min: 2 },
      ],
      bands: [{ value: 80, name: '상단' }, { value: -80, name: '하단' }],
      main: (ctx, [s, m, l]) => {
        const h = ctx.new_unlimited_var(C(ctx));
        return [H.rci(ctx, h, s), H.rci(ctx, h, m), H.rci(ctx, h, l)];
      },
    }));

    list.push(study({
      key: 'CCVolatilityStop', name: 'CC 변동성 스탑 (Volatility Stop)', short: 'VStop', overlay: true,
      plots: [
        { title: '변동성 스탑', color: '#009688', width: 1, plottype: 3 },
        { colorer: true, target: 0, colors: [['#009688', '상승'], ['#F44336', '하락']] },
      ],
      inputs: [
        { id: 'len', name: 'ATR 기간', defval: 20, min: 1 },
        { id: 'mult', name: 'ATR 배수', defval: 2.0, type: 'float', min: 0.1, step: 0.1 },
      ],
      main: (ctx, [n, f]) => {
        const src = C(ctx);
        const atr = Std.atr(n, ctx);
        const tr = H.tr(ctx);
        const atrM = isNaN(atr) ? tr : atr * f;
        const maxV = ctx.new_unlimited_var(), minV = ctx.new_unlimited_var(), upV = ctx.new_unlimited_var(), stopV = ctx.new_unlimited_var();
        const first = isNaN(upV.get(1));
        let max = Math.max(first ? src : maxV.get(1), src);
        let min = Math.min(first ? src : minV.get(1), src);
        const up1 = first ? 1 : upV.get(1);
        const stop1 = stopV.get(1);
        let stop = up1 === 1 ? Math.max(stop1, max - atrM) : Math.min(stop1, min + atrM);
        if (isNaN(stop)) stop = src;
        const up = src - stop >= 0 ? 1 : 0;
        if (!first && up !== up1) {
          max = src; min = src;
          stop = up === 1 ? max - atrM : min + atrM;
        }
        maxV.set(max); minV.set(min); upV.set(up); stopV.set(stop);
        return [stop, up === 1 ? 0 : 1];
      },
    }));

    list.push(study({
      key: 'CCTWAP', name: 'CC 시간가중 평균가 (TWAP)', short: 'TWAP', overlay: true,
      plots: [{ title: 'TWAP', color: '#FF9800', width: 2, plottype: 7 }],
      inputs: [{ id: 'anchor', name: '기준 기간', defval: '일', type: 'text', options: ['일', '주', '월'] }],
      main: (ctx, [anchor]) => {
        const t = Std.time(ctx);
        const day = Math.floor(t / 864e5);
        const dt = new Date(t);
        const pid = anchor === '주' ? Math.floor((day + 3) / 7) : anchor === '월' ? dt.getUTCFullYear() * 12 + dt.getUTCMonth() : day;
        const ohlc4 = (Std.open(ctx) + Std.high(ctx) + Std.low(ctx) + C(ctx)) / 4;
        const pidV = ctx.new_unlimited_var(pid), sumV = ctx.new_unlimited_var(), cntV = ctx.new_unlimited_var();
        const reset = pidV.get(1) !== pid;
        const sum = (reset ? 0 : H.nz(sumV.get(1))) + ohlc4;
        const cnt = (reset ? 0 : H.nz(cntV.get(1))) + 1;
        sumV.set(sum); cntV.set(cnt);
        return [sum / cnt];
      },
    }));

    list.push(study({
      key: 'CCRollingVWAP', name: 'CC 롤링 VWAP (Rolling VWAP)', short: '롤링 VWAP', overlay: true,
      plots: [{ title: '롤링 VWAP', color: '#2962FF', width: 2 }],
      inputs: [{ id: 'hours', name: '기간 (시간)', defval: 24, min: 1, max: 720 }],
      main: (ctx, [hours]) => {
        const t = Std.time(ctx), vol = Std.volume(ctx);
        const tV = ctx.new_unlimited_var(t), pvV = ctx.new_unlimited_var(hlc3(ctx) * vol), vV = ctx.new_unlimited_var(vol);
        const from = t - hours * 3600e3;
        let pv = 0, vs = 0;
        for (let i = 0; i < 10000; i++) {
          const ti = tV.get(i);
          if (isNaN(ti) || ti <= from) break;
          pv += pvV.get(i); vs += vV.get(i);
        }
        return [vs > 0 ? pv / vs : NaN];
      },
    }));

    list.push(study({
      key: 'CCMedian', name: 'CC 미디언 (Median)', short: '미디언', overlay: true,
      plots: [
        { title: '미디언', color: '#FF6D00', width: 2 },
        { title: '미디언 EMA', color: '#2962FF', width: 1 },
        { title: '상단', color: '#089981', width: 1 },
        { title: '하단', color: '#F23645', width: 1 },
      ],
      inputs: [
        { id: 'mlen', name: '미디언 기간', defval: 3, min: 1 },
        { id: 'alen', name: 'ATR 기간', defval: 14, min: 1 },
        { id: 'amult', name: 'ATR 배수', defval: 2.0, type: 'float', min: 0.1, step: 0.1 },
      ],
      main: (ctx, [ml, al, am]) => {
        const h = ctx.new_unlimited_var(hl2(ctx));
        const vals = [];
        for (let i = 0; i < ml; i++) vals.push(h.get(i));
        let med = NaN;
        if (!vals.some(isNaN)) { vals.sort((a, b) => a - b); med = vals[Math.ceil(0.5 * ml) - 1]; }
        const atr = am * Std.atr(al, ctx);
        const ema = H.ema(ctx, med, ml);
        return [med, ema, med + atr, med - atr];
      },
    }));

    list.push(study({
      key: 'CCWoodiesCCI', name: 'CC 우디스 CCI (Woodies CCI)', short: '우디스 CCI',
      plots: [
        { title: 'CCI 히스토그램', color: '#787B86', width: 3, plottype: 5, transparency: 40 },
        { colorer: true, target: 0, colors: [['#26A69A', '6봉 이상 0 위'], ['#EF5350', '6봉 이상 0 아래'], ['#FFEB3B', '5번째 봉'], ['#787B86', '추세 없음']] },
        { title: 'CCI 터보', color: '#FF9800', width: 1 },
        { title: 'CCI 14', color: '#5D606B', width: 2 },
      ],
      inputs: [
        { id: 'turbo', name: 'CCI 터보 기간', defval: 6, min: 1 },
        { id: 'len', name: 'CCI 기간', defval: 14, min: 1 },
      ],
      bands: [{ value: 200, name: '+200' }, { value: 100, name: '+100' }, { value: 0, name: '0' }, { value: -100, name: '-100' }, { value: -200, name: '-200' }],
      main: (ctx, [tl, n]) => {
        const src = hlc3(ctx);
        const turbo = H.cci(ctx, src, tl), cci = H.cci(ctx, src, n);
        const upV = ctx.new_unlimited_var(), dnV = ctx.new_unlimited_var();
        const up = cci > 0 ? H.nz(upV.get(1)) + 1 : 0;
        const dn = cci < 0 ? H.nz(dnV.get(1)) + 1 : 0;
        upV.set(up); dnV.set(dn);
        const col = up >= 6 ? 0 : dn >= 6 ? 1 : (up === 5 || dn === 5) ? 2 : 3;
        return [cci, col, turbo, cci];
      },
    }));

    // ======================= 커뮤니티 인기 지표 (알림 기능 없는 것) =======================

    list.push(study({
      key: 'CCWaveTrend', name: 'CC 웨이브트렌드 [LazyBear] (WaveTrend)', short: '웨이브트렌드',
      plots: [
        { title: 'WT1', color: '#00C853', width: 1 },
        { title: 'WT2', color: '#F23645', width: 1, linestyle: 1 },
        { title: 'WT1-WT2', color: '#2962FF', width: 1, plottype: 4, transparency: 80 },
      ],
      inputs: [
        { id: 'n1', name: '채널 기간', defval: 10, min: 1 },
        { id: 'n2', name: '평균 기간', defval: 21, min: 1 },
      ],
      bands: [{ value: 60, name: '과매수 1', color: '#F23645' }, { value: 53, name: '과매수 2', color: '#F23645' }, { value: 0, name: '0' }, { value: -53, name: '과매도 2', color: '#089981' }, { value: -60, name: '과매도 1', color: '#089981' }],
      main: (ctx, [n1, n2]) => {
        const ap = hlc3(ctx);
        const esa = H.ema(ctx, ap, n1);
        const d = H.ema(ctx, Math.abs(ap - esa), n1);
        const ci = d === 0 ? 0 : (ap - esa) / (0.015 * d);
        const wt1 = H.ema(ctx, ci, n2);
        const wt2 = H.sma(ctx, wt1, 4);
        return [wt1, wt2, wt1 - wt2];
      },
    }));

    list.push(study({
      key: 'CCWilliamsVixFix', name: 'CC 윌리엄스 빅스 픽스 [ChrisMoody] (CM_Williams_Vix_Fix)', short: '빅스 픽스',
      plots: [
        { title: 'WVF', color: '#787B86', width: 4, plottype: 5 },
        { colorer: true, target: 0, colors: [['#00E676', '바닥 신호'], ['#787B86', '보통']] },
      ],
      inputs: [
        { id: 'pd', name: '최고가 조회 기간', defval: 22, min: 1 },
        { id: 'bbl', name: '볼린저 기간', defval: 20, min: 1 },
        { id: 'mult', name: '볼린저 배수', defval: 2.0, type: 'float', min: 0.1, step: 0.1 },
        { id: 'lb', name: '백분위 조회 기간', defval: 50, min: 1 },
        { id: 'ph', name: '최고 백분위 (0.85 = 90%)', defval: 0.85, type: 'float', min: 0.01, step: 0.01 },
      ],
      main: (ctx, [pd, bbl, mult, lb, ph]) => {
        const hc = H.highest(ctx, C(ctx), pd);
        const wvf = (hc - Std.low(ctx)) / hc * 100;
        const upper = H.sma(ctx, wvf, bbl) + mult * H.stdev(ctx, wvf, bbl);
        const rangeHigh = H.highest(ctx, wvf, lb) * ph;
        return [wvf, (wvf >= upper || wvf >= rangeHigh) ? 0 : 1];
      },
    }));

    list.push(study({
      key: 'CCSSLChannel', name: 'CC SSL 채널 [ErwinBeckers] (SSL Channel)', short: 'SSL', overlay: true,
      plots: [
        { title: 'SSL 하락선', color: '#F23645', width: 2 },
        { title: 'SSL 상승선', color: '#00E676', width: 2 },
      ],
      inputs: [{ id: 'len', name: '기간', defval: 10, min: 1 }],
      main: (ctx, [n]) => {
        const smaH = H.sma(ctx, Std.high(ctx), n), smaL = H.sma(ctx, Std.low(ctx), n);
        const c = C(ctx);
        const hlvV = ctx.new_unlimited_var();
        const hlv = c > smaH ? 1 : c < smaL ? -1 : H.nz(hlvV.get(1));
        hlvV.set(hlv);
        return [hlv < 0 ? smaH : smaL, hlv < 0 ? smaL : smaH];
      },
    }));

    function qqeCalc(ctx, src, rsiLen, sf, factor) {
      const wilders = rsiLen * 2 - 1;
      const rsi = H.rsi(ctx, src, rsiLen);
      const rsiMaV = ctx.new_unlimited_var(H.ema(ctx, rsi, sf));
      const rsiMa = rsiMaV.get(0), rsiMa1 = rsiMaV.get(1);
      const dar = H.ema(ctx, H.ema(ctx, Math.abs(rsiMa1 - rsiMa), wilders), wilders) * factor;
      const lbV = ctx.new_unlimited_var(), sbV = ctx.new_unlimited_var(), trV = ctx.new_unlimited_var();
      const lb1 = lbV.get(1), lb2 = lbV.get(2), sb1 = sbV.get(1), sb2 = sbV.get(2);
      const newSb = rsiMa + dar, newLb = rsiMa - dar;
      const lb = (rsiMa1 > lb1 && rsiMa > lb1) ? Math.max(lb1, newLb) : newLb;
      const sb = (rsiMa1 < sb1 && rsiMa < sb1) ? Math.min(sb1, newSb) : newSb;
      const trend = H.cross(rsiMa, sb1, rsiMa1, sb2) ? 1 : H.cross(lb1, rsiMa, lb2, rsiMa1) ? -1 : H.nz(trV.get(1), 1);
      lbV.set(lb); sbV.set(sb); trV.set(trend);
      return { tl: trend === 1 ? lb : sb, rsiMa: rsiMa };
    }

    list.push(study({
      key: 'CCQQEMod', name: 'CC QQE MOD [Mihkel00]', short: 'QQE MOD',
      plots: [
        { title: 'QQE 라인', color: '#5D606B', width: 2 },
        { title: 'QQE 히스토그램', color: '#B2B5BE', width: 3, plottype: 5, transparency: 50 },
        { title: 'QQE 상승', color: '#00C3FF', width: 3, plottype: 5 },
        { title: 'QQE 하락', color: '#FF0062', width: 3, plottype: 5 },
      ],
      inputs: [
        { id: 'rsi1', name: 'RSI 기간', defval: 6, min: 1 },
        { id: 'sf1', name: 'RSI 스무딩', defval: 5, min: 1 },
        { id: 'q1', name: 'QQE 배수', defval: 3.0, type: 'float', min: 0.1, step: 0.1 },
        { id: 'bbl', name: '볼린저 기간', defval: 50, min: 1 },
        { id: 'bbm', name: '볼린저 배수', defval: 0.35, type: 'float', min: 0.01, step: 0.01 },
        { id: 'rsi2', name: 'RSI 기간 2', defval: 6, min: 1 },
        { id: 'sf2', name: 'RSI 스무딩 2', defval: 5, min: 1 },
        { id: 'q2', name: 'QQE 배수 2', defval: 1.61, type: 'float', min: 0.1, step: 0.01 },
        { id: 'th2', name: '임계값 2', defval: 3, min: 0 },
      ],
      bands: [{ value: 0, name: '0' }],
      main: (ctx, [r1, s1, q1, bbl, bbm, r2, s2, q2, th2]) => {
        const c = C(ctx);
        const a = qqeCalc(ctx, c, r1, s1, q1);
        const b = qqeCalc(ctx, c, r2, s2, q2);
        const x = a.tl - 50;
        const basis = H.sma(ctx, x, bbl), dev = bbm * H.stdev(ctx, x, bbl);
        const v2 = b.rsiMa - 50, v1 = a.rsiMa - 50;
        const green = v2 > th2 && v1 > basis + dev;
        const red = v2 < -th2 && v1 < basis - dev;
        return [b.tl - 50, Math.abs(v2) > th2 ? v2 : NaN, green ? v2 : NaN, red ? v2 : NaN];
      },
    }));

    list.push(study({
      key: 'CCCoralTrend', name: 'CC 코랄 트렌드 [LazyBear] (Coral Trend)', short: '코랄 트렌드', overlay: true,
      plots: [
        { title: '코랄 트렌드', color: '#00E676', width: 3 },
        { colorer: true, target: 0, colors: [['#00E676', '상승'], ['#F23645', '하락'], ['#2962FF', '보합']] },
      ],
      inputs: [
        { id: 'sm', name: '스무딩 기간', defval: 21, min: 1 },
        { id: 'cd', name: '상수 D', defval: 0.4, type: 'float', min: 0.01, step: 0.01 },
      ],
      main: (ctx, [sm, cd]) => {
        const di = (sm - 1) / 2 + 1, c1 = 2 / (di + 1), c2 = 1 - c1;
        const c3 = 3 * (cd * cd + cd * cd * cd);
        const c4 = -3 * (2 * cd * cd + cd + cd * cd * cd);
        const c5 = 3 * cd + 1 + cd * cd * cd + 3 * cd * cd;
        let x = C(ctx);
        const ii = [];
        for (let k = 0; k < 6; k++) {
          const v = ctx.new_unlimited_var(); x = c1 * x + c2 * H.nz(v.get(1)); v.set(x); ii.push(x);
        }
        const bfr = -cd * cd * cd * ii[5] + c3 * ii[4] + c4 * ii[3] + c5 * ii[2];
        const b1 = H.nz(H.prev(ctx, bfr));
        return [bfr, bfr > b1 ? 0 : bfr < b1 ? 1 : 2];
      },
    }));

    list.push(study({
      key: 'CCImpulseMACD', name: 'CC 임펄스 MACD [LazyBear] (Impulse MACD)', short: '임펄스 MACD',
      plots: [
        { title: '임펄스 MACD', color: '#00E676', width: 2, plottype: 5 },
        { colorer: true, target: 0, colors: [['#00E676', '강한 상승'], ['#1B5E20', '상승'], ['#F23645', '하락'], ['#FF9800', '보합']] },
        { title: '히스토그램', color: '#2962FF', width: 1, plottype: 1 },
        { title: '시그널', color: '#880E4F', width: 1 },
      ],
      inputs: [
        { id: 'len', name: 'MA 기간', defval: 34, min: 1 },
        { id: 'sig', name: '시그널 기간', defval: 9, min: 1 },
      ],
      bands: [{ value: 0, name: '0' }],
      format: { type: 'inherit' },
      main: (ctx, [n, sl]) => {
        const src = hlc3(ctx);
        const hi = H.rma(ctx, Std.high(ctx), n), lo = H.rma(ctx, Std.low(ctx), n);
        const e1 = H.ema(ctx, src, n), e2 = H.ema(ctx, e1, n);
        const mi = e1 + (e1 - e2);
        const md = mi > hi ? mi - hi : mi < lo ? mi - lo : 0;
        const sb = H.sma(ctx, md, sl);
        const col = src > mi ? (src > hi ? 0 : 1) : (src < lo ? 2 : 3);
        return [md, col, md - sb, sb];
      },
    }));

    list.push(study({
      key: 'CCVFI', name: 'CC 볼륨 플로우 [LazyBear] (Volume Flow Indicator)', short: 'VFI',
      plots: [
        { title: 'VFI', color: '#00C853', width: 2 },
        { title: '시그널 EMA', color: '#FF9800', width: 1 },
        { title: '히스토그램', color: '#787B86', width: 1, plottype: 5, transparency: 50 },
      ],
      inputs: [
        { id: 'len', name: 'VFI 기간', defval: 130, min: 1 },
        { id: 'coef', name: '계수', defval: 0.2, type: 'float', min: 0.01, step: 0.01 },
        { id: 'vcoef', name: '최대 거래량 컷오프', defval: 2.5, type: 'float', min: 0.1, step: 0.1 },
        { id: 'sig', name: '시그널 기간', defval: 5, min: 1 },
        { id: 'smooth', name: 'VFI 스무딩', defval: false, type: 'bool' },
      ],
      bands: [{ value: 0, name: '0' }],
      main: (ctx, [n, coef, vcoef, sl, smooth]) => {
        const typical = hlc3(ctx), vol = Std.volume(ctx), c = C(ctx);
        const t1 = H.prev(ctx, typical);
        const inter = Math.log(typical) - Math.log(t1);
        const cutoff = coef * H.stdev(ctx, inter, 30) * c;
        const vave = H.prev(ctx, H.sma(ctx, vol, n));
        const vc = Math.min(vol, vave * vcoef);
        const mf = typical - t1;
        const vcp = mf > cutoff ? vc : mf < -cutoff ? -vc : 0;
        let vfi = H.sum(ctx, vcp, n) / vave;
        const vfiS = H.sma(ctx, vfi, 3);
        if (smooth) vfi = vfiS;
        const ma = H.ema(ctx, vfi, sl);
        return [vfi, ma, vfi - ma];
      },
    }));

    list.push(study({
      key: 'CCWAE', name: 'CC 와다 아타르 익스플로전 [LazyBear] (Waddah Attar Explosion)', short: 'WAE',
      plots: [
        { title: '상승 추세', color: '#00E676', width: 3, plottype: 5 },
        { colorer: true, target: 0, colors: [['#00E676', '상승 강화'], ['#1B5E20', '상승 약화']] },
        { title: '하락 추세', color: '#F23645', width: 3, plottype: 5 },
        { colorer: true, target: 2, colors: [['#F23645', '하락 강화'], ['#FF9800', '하락 약화']] },
        { title: '폭발선', color: '#A0522D', width: 2 },
        { title: '데드존', color: '#2962FF', width: 1, plottype: 3 },
      ],
      inputs: [
        { id: 'sens', name: '민감도', defval: 150, min: 1 },
        { id: 'fast', name: '빠른 EMA', defval: 20, min: 1 },
        { id: 'slow', name: '느린 EMA', defval: 40, min: 1 },
        { id: 'bbl', name: '볼린저 기간', defval: 20, min: 1 },
        { id: 'bbm', name: '볼린저 배수', defval: 2.0, type: 'float', min: 0.1, step: 0.1 },
      ],
      format: { type: 'price', precision: 4 },
      main: (ctx, [sens, fast, slow, bbl, bbm]) => {
        const c = C(ctx);
        const macd = H.ema(ctx, c, fast) - H.ema(ctx, c, slow);
        const t1 = (macd - H.prev(ctx, macd)) * sens;
        const e1 = 2 * bbm * H.stdev(ctx, c, bbl);
        const dead = H.nz(H.rma(ctx, H.tr(ctx), 100)) * 3.7;
        const up = t1 >= 0 ? t1 : 0, dn = t1 < 0 ? -t1 : 0;
        const up1 = H.prev(ctx, up), dn1 = H.prev(ctx, dn);
        return [up, up < up1 ? 1 : 0, dn, dn < dn1 ? 1 : 0, e1, dead];
      },
    }));

    list.push(study({
      key: 'CCMAMA', name: 'CC 메사 적응형 이동평균 [LazyBear] (MESA MAMA/FAMA)', short: 'MAMA', overlay: true,
      plots: [
        { title: 'MAMA', color: '#F23645', width: 2 },
        { title: 'FAMA', color: '#00C853', width: 2 },
      ],
      inputs: [
        { id: 'fl', name: '빠른 한계', defval: 0.5, type: 'float', min: 0.01, step: 0.01 },
        { id: 'sl', name: '느린 한계', defval: 0.05, type: 'float', min: 0.01, step: 0.01 },
      ],
      main: (ctx, [fl, sl]) => {
        const ht = (v, m) => (0.0962 * v.get(0) + 0.5769 * H.nz(v.get(2)) - 0.5769 * H.nz(v.get(4)) - 0.0962 * H.nz(v.get(6))) * m;
        const srcV = ctx.new_unlimited_var(hl2(ctx));
        const smoothV = ctx.new_unlimited_var((4 * srcV.get(0) + 3 * H.nz(srcV.get(1)) + 2 * H.nz(srcV.get(2)) + H.nz(srcV.get(3))) / 10);
        const periodV = ctx.new_unlimited_var();
        const p1 = H.nz(periodV.get(1));
        const mult = 0.075 * p1 + 0.54;
        const detV = ctx.new_unlimited_var(ht(smoothV, mult));
        const i1V = ctx.new_unlimited_var(H.nz(detV.get(3)));
        const q1V = ctx.new_unlimited_var(ht(detV, mult));
        const jI = ht(i1V, mult), jQ = ht(q1V, mult);
        const i1 = i1V.get(0), q1 = q1V.get(0);
        const i2V = ctx.new_unlimited_var(), q2V = ctx.new_unlimited_var();
        const i2 = 0.2 * (i1 - jQ) + 0.8 * H.nz(i2V.get(1));
        const q2 = 0.2 * (q1 + jI) + 0.8 * H.nz(q2V.get(1));
        i2V.set(i2); q2V.set(q2);
        const reV = ctx.new_unlimited_var(), imV = ctx.new_unlimited_var();
        const re = 0.2 * (i2 * H.nz(i2V.get(1)) + q2 * H.nz(q2V.get(1))) + 0.8 * H.nz(reV.get(1));
        const im = 0.2 * (i2 * H.nz(q2V.get(1)) - q2 * H.nz(i2V.get(1))) + 0.8 * H.nz(imV.get(1));
        reV.set(re); imV.set(im);
        let period = 0;
        if (re !== 0 && im !== 0) period = 2 * Math.PI / Math.atan(im / re);
        if (period > 1.5 * p1) period = 1.5 * p1;
        if (period < 0.67 * p1) period = 0.67 * p1;
        if (period < 6) period = 6;
        if (period > 50) period = 50;
        period = 0.2 * period + 0.8 * p1;
        periodV.set(period);
        const phaseV = ctx.new_unlimited_var(i1 !== 0 ? (180 / Math.PI) * Math.atan(q1 / i1) : 0);
        let dPhase = H.nz(phaseV.get(1)) - phaseV.get(0);
        if (dPhase < 1) dPhase = 1;
        let alpha = fl / dPhase;
        if (alpha < sl) alpha = sl;
        const src = srcV.get(0);
        const mamaV = ctx.new_unlimited_var(), famaV = ctx.new_unlimited_var();
        const mama = alpha * src + (1 - alpha) * H.nz(mamaV.get(1));
        mamaV.set(mama);
        const fama = (alpha / 2) * mama + (1 - alpha / 2) * H.nz(famaV.get(1));
        famaV.set(fama);
        // 초기 봉은 0에서 출발해 값이 튀므로 50봉 이후부터 표시
        const cntV = ctx.new_unlimited_var(); const cnt = H.nz(cntV.get(1)) + 1; cntV.set(cnt);
        return cnt > 50 ? [mama, fama] : [NaN, NaN];
      },
    }));

    list.push(study({
      key: 'CCWeisWave', name: 'CC 바이스 웨이브 볼륨 [LazyBear] (Weis Wave Volume)', short: '바이스 웨이브',
      plots: [
        { title: '상승 웨이브', color: '#00C853', width: 3, plottype: 5 },
        { title: '하락 웨이브', color: '#F23645', width: 3, plottype: 5 },
      ],
      inputs: [
        { id: 'len', name: '추세 감지 기간', defval: 2, min: 1 },
        { id: 'below', name: '하락 웨이브를 0 아래로', defval: true, type: 'bool' },
      ],
      format: { type: 'volume' },
      main: (ctx, [n, below]) => {
        const c = C(ctx), vol = Std.volume(ctx);
        const cv = ctx.new_unlimited_var(c);
        const c1 = cv.get(1);
        const mov = c > c1 ? 1 : c < c1 ? -1 : 0;
        const movV = ctx.new_unlimited_var(mov), trendV = ctx.new_unlimited_var();
        const trend = (mov !== 0 && mov !== movV.get(1)) ? mov : H.nz(trendV.get(1));
        trendV.set(trend);
        let hi = -Infinity, lo = Infinity;
        for (let i = 1; i <= n; i++) { const x = cv.get(i); hi = Math.max(hi, x); lo = Math.min(lo, x); }
        const trending = c > hi || c < lo;
        const waveV = ctx.new_unlimited_var(), volV = ctx.new_unlimited_var();
        const w1 = H.nz(waveV.get(1));
        const wave = (trend !== w1 && trending) ? trend : w1;
        waveV.set(wave);
        const wvol = wave === w1 ? H.nz(volV.get(1)) + vol : vol;
        volV.set(wvol);
        const up = wave === 1 ? wvol : 0;
        const dn = below ? (wave === 1 ? 0 : wave === -1 ? -wvol : wvol) : (wave === 1 ? 0 : wvol);
        return [up, dn];
      },
    }));

    list.push(study({
      key: 'CCCMMacdUlt', name: 'CC MacD 커스텀 [ChrisMoody] (CM_MacD_Ult_MTF)', short: 'CM MacD',
      plots: [
        { title: '히스토그램', color: '#00BCD4', width: 4, plottype: 1 },
        { colorer: true, target: 0, colors: [['#00BCD4', '양수 증가'], ['#2962FF', '양수 감소'], ['#F23645', '음수 감소'], ['#880E4F', '음수 증가'], ['#FFEB3B', '변화 없음']] },
        { title: 'MACD', color: '#00E676', width: 4 },
        { colorer: true, target: 2, colors: [['#00E676', '시그널 위'], ['#F23645', '시그널 아래']] },
        { title: '시그널', color: '#FFEB3B', width: 2 },
        { title: '교차 점', color: '#00E676', width: 4, plottype: 6 },
        { colorer: true, target: 5, colors: [['#00E676', '상향 교차'], ['#F23645', '하향 교차']] },
      ],
      inputs: [
        { id: 'fast', name: '빠른 기간', defval: 12, min: 1 },
        { id: 'slow', name: '느린 기간', defval: 26, min: 1 },
        { id: 'sig', name: '시그널 기간', defval: 9, min: 1 },
      ],
      bands: [{ value: 0, name: '0' }],
      format: { type: 'inherit' },
      main: (ctx, [fast, slow, sl]) => {
        const c = C(ctx);
        const macd = H.ema(ctx, c, fast) - H.ema(ctx, c, slow);
        const signal = H.sma(ctx, macd, sl);
        const hist = macd - signal;
        const h1 = H.prev(ctx, hist), m1 = H.prev(ctx, macd), s1 = H.prev(ctx, signal);
        const hc = hist > 0 ? (hist > h1 ? 0 : hist < h1 ? 1 : 4) : (hist < h1 ? 2 : hist > h1 ? 3 : 4);
        const above = macd >= signal ? 0 : 1;
        return [hist, hc, macd, above, signal, H.cross(macd, signal, m1, s1) ? signal : NaN, above];
      },
    }));

    list.push(study({
      key: 'CCADXDI', name: 'CC ADX와 DI [BeikabuOyaji] (ADX and DI)', short: 'ADX DI',
      plots: [
        { title: 'DI+', color: '#00C853', width: 1 },
        { title: 'DI-', color: '#F23645', width: 1 },
        { title: 'ADX', color: '#1A237E', width: 2 },
      ],
      inputs: [
        { id: 'len', name: '기간', defval: 14, min: 1 },
        { id: 'th', name: '기준선', defval: 20, min: 0 },
      ],
      bands: [{ value: 20, name: '기준선', color: '#000000' }],
      main: (ctx, [n]) => {
        const h = Std.high(ctx), l = Std.low(ctx);
        const h1 = H.nz(H.prev(ctx, h)), l1 = H.nz(H.prev(ctx, l)), c1 = H.nz(H.prev(ctx, C(ctx)));
        const tr = Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1));
        const dmp = h - h1 > l1 - l ? Math.max(h - h1, 0) : 0;
        const dmm = l1 - l > h - h1 ? Math.max(l1 - l, 0) : 0;
        const wilder = (x) => { const v = ctx.new_unlimited_var(); const p = H.nz(v.get(1)); const r = p - p / n + x; v.set(r); return r; };
        const str = wilder(tr), sdp = wilder(dmp), sdm = wilder(dmm);
        const dip = sdp / str * 100, dim = sdm / str * 100;
        const dx = Math.abs(dip - dim) / (dip + dim) * 100;
        return [dip, dim, H.sma(ctx, H.nz(dx), n)];
      },
    }));

    // 피벗 고점/저점: R봉 전 값이 좌우 봉보다 높으면(낮으면) 그 값, 아니면 NaN
    function pivot(hv, L, R, isHigh) {
      const v = hv.get(R);
      if (isNaN(v)) return NaN;
      for (let i = 1; i <= L; i++) {
        const x = hv.get(R + i);
        if (isNaN(x) || (isHigh ? x >= v : x <= v)) return NaN;
      }
      for (let i = 1; i <= R; i++) {
        const x = hv.get(R - i);
        if (isHigh ? x > v : x < v) return NaN;
      }
      return v;
    }

    list.push(study({
      key: 'CCUTBot', name: 'CC UT 봇 [QuantNomad] (UT Bot)', short: 'UT 봇', overlay: true,
      plots: [
        { title: '추적 스탑', color: '#089981', width: 2 },
        { colorer: true, target: 0, colors: [['#089981', '상승'], ['#F23645', '하락']] },
        { title: '상승 영역 기준', color: '#089981', hidden: true },
        { title: '하락 영역 기준', color: '#F23645', hidden: true },
        { title: '가격 기준', color: '#787B86', hidden: true },
        { shape: 'shape_label_up', location: 'BelowBar', color: '#089981', textColor: '#FFFFFF', title: '매수 신호', text: '매수', size: 'tiny' },
        { shape: 'shape_label_down', location: 'AboveBar', color: '#F23645', textColor: '#FFFFFF', title: '매도 신호', text: '매도', size: 'tiny' },
        { barColorer: true, title: '캔들 색', colors: [['#089981', '상승'], ['#F23645', '하락']] },
      ],
      fills: [
        { a: 2, b: 4, color: '#089981', transparency: 88, title: '상승 영역' },
        { a: 3, b: 4, color: '#F23645', transparency: 88, title: '하락 영역' },
      ],
      inputs: [
        { id: 'key', name: '민감도 (키 값)', defval: 1.0, type: 'float', min: 0.1, step: 0.1 },
        { id: 'atr', name: 'ATR 기간', defval: 10, min: 1 },
        { id: 'ha', name: '하이킨아시 기준 신호', defval: false, type: 'bool' },
      ],
      main: (ctx, [key, atrLen, ha]) => {
        const src = ha ? (Std.open(ctx) + Std.high(ctx) + Std.low(ctx) + C(ctx)) / 4 : C(ctx);
        const nLoss = key * Std.atr(atrLen, ctx);
        const src1 = H.prev(ctx, src);
        const stopV = ctx.new_unlimited_var();
        const s1raw = stopV.get(1), s1 = H.nz(s1raw);
        let stop = (src > s1 && src1 > s1) ? Math.max(s1, src - nLoss)
          : (src < s1 && src1 < s1) ? Math.min(s1, src + nLoss)
          : (src > s1 ? src - nLoss : src + nLoss);
        if (isNaN(nLoss)) stop = NaN;
        stopV.set(stop);
        if (isNaN(stop)) return [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
        const buy = src > stop && src1 <= s1raw;
        const sell = src < stop && src1 >= s1raw;
        const up = src > stop;
        return [stop, up ? 0 : 1, up ? stop : NaN, up ? NaN : stop, C(ctx), buy ? 1 : NaN, sell ? 1 : NaN, up ? 0 : 1];
      },
    }));

    list.push(study({
      key: 'CCSRBreaks', name: 'CC 지지저항 돌파 [LuxAlgo] (Support and Resistance Levels with Breaks)', short: '지지저항 돌파', overlay: true,
      plots: [
        { title: '저항선', color: '#F23645', width: 2, plottype: 7 },
        { title: '지지선', color: '#2962FF', width: 2, plottype: 7 },
        { shape: 'shape_label_up', location: 'BelowBar', color: '#089981', textColor: '#FFFFFF', title: '저항 돌파', text: '돌파' },
        { shape: 'shape_label_down', location: 'AboveBar', color: '#F23645', textColor: '#FFFFFF', title: '지지 이탈', text: '이탈' },
        { shape: 'shape_arrow_up', location: 'BelowBar', color: '#26A69A', title: '상승 꼬리', text: '꼬리', size: 'tiny' },
        { shape: 'shape_arrow_down', location: 'AboveBar', color: '#EF5350', title: '하락 꼬리', text: '꼬리', size: 'tiny' },
      ],
      inputs: [
        { id: 'left', name: '왼쪽 봉', defval: 15, min: 1 },
        { id: 'right', name: '오른쪽 봉', defval: 15, min: 1 },
        { id: 'vol', name: '거래량 임계값 (%)', defval: 20, min: 0 },
        { id: 'breaks', name: '돌파 표시', defval: true, type: 'bool' },
      ],
      main: (ctx, [L, R, th, show]) => {
        const o = Std.open(ctx), h = Std.high(ctx), l = Std.low(ctx), c = C(ctx), vol = Std.volume(ctx);
        const hv = ctx.new_unlimited_var(h), lv = ctx.new_unlimited_var(l);
        const ph1 = H.prev(ctx, pivot(hv, L, R, true));
        const pl1 = H.prev(ctx, pivot(lv, L, R, false));
        const resV = ctx.new_unlimited_var(), supV = ctx.new_unlimited_var();
        const res1 = resV.get(1), sup1 = supV.get(1);
        const res = isNaN(ph1) ? res1 : ph1, sup = isNaN(pl1) ? sup1 : pl1;
        resV.set(res); supV.set(sup);
        const vs = H.ema(ctx, vol, 5), vl = H.ema(ctx, vol, 10);
        const osc = vl ? 100 * (vs - vl) / vl : 0;
        const c1 = H.prev(ctx, c);
        const crossUp = c > res && c1 <= res1;
        const crossDn = c < sup && c1 >= sup1;
        const bullWick = o - l > c - o, bearWick = o - c < h - o;
        // 원본처럼 선을 (오른쪽 봉 + 1)만큼 왼쪽으로 당겨 실제 피벗 위치에서 시작하게 한다
        return [
          { value: res !== res1 ? NaN : res, offset: -(R + 1) },
          { value: sup !== sup1 ? NaN : sup, offset: -(R + 1) },
          show && crossUp && !bullWick && osc > th ? 1 : NaN,
          show && crossDn && !bearWick && osc > th ? 1 : NaN,
          show && crossUp && bullWick ? 1 : NaN,
          show && crossDn && bearWick ? 1 : NaN,
        ];
      },
    }));

    list.push(study({
      key: 'CCSwingSR', name: 'CC 스윙 고점·저점 지지저항 (Swing High Low S/R)', short: '스윙 지지저항', overlay: true,
      plots: [
        { title: '저항 1 (최근)', color: '#F23645', width: 2, plottype: 7 },
        { title: '저항 2', display: 9, color: '#F23645', width: 1, plottype: 7, transparency: 35 },
        { title: '저항 3', display: 9, color: '#F23645', width: 1, plottype: 7, transparency: 60, linestyle: 2 },
        { title: '지지 1 (최근)', color: '#2962FF', width: 2, plottype: 7 },
        { title: '지지 2', display: 9, color: '#2962FF', width: 1, plottype: 7, transparency: 35 },
        { title: '지지 3', display: 9, color: '#2962FF', width: 1, plottype: 7, transparency: 60, linestyle: 2 },
      ],
      inputs: [
        { id: 'len', name: '스윙 강도 (좌우 봉 수)', defval: 10, min: 1 },
        { id: 'remove', name: '종가 돌파 시 선 지우기', defval: true, type: 'bool' },
      ],
      main: (ctx, [n, remove]) => {
        const c = C(ctx);
        const ph = pivot(ctx.new_unlimited_var(Std.high(ctx)), n, n, true);
        const pl = pivot(ctx.new_unlimited_var(Std.low(ctx)), n, n, false);
        const rV = [0, 1, 2].map(() => ctx.new_unlimited_var());
        const sV = [0, 1, 2].map(() => ctx.new_unlimited_var());
        const rPrev = rV.map(v => v.get(1)), sPrev = sV.map(v => v.get(1));
        let r = isNaN(ph) ? rPrev.slice() : [ph, rPrev[0], rPrev[1]];
        let s = isNaN(pl) ? sPrev.slice() : [pl, sPrev[0], sPrev[1]];
        if (remove) {
          r = r.map(v => (c > v ? NaN : v));
          s = s.map(v => (c < v ? NaN : v));
        }
        r.forEach((v, i) => rV[i].set(v));
        s.forEach((v, i) => sV[i].set(v));
        // 수준이 바뀌는 봉은 비워서 선이 세로로 이어지지 않게 한다
        const out = (vals, prevs) => vals.map((v, i) => (v !== prevs[i] && !(isNaN(v) && isNaN(prevs[i])) ? NaN : v));
        return out(r, rPrev).concat(out(s, sPrev));
      },
    }));

    return list;
  }

  // ---------------------------------------------------------------------------
  // 위젯 옵션 가로채기: 위젯은 window[iframe id]에 옵션을 넣은 뒤 iframe을 만든다.
  // iframe이 DOM에 붙는 순간(내부 문서 로드 전) getCustomIndicators를 덧씌운다.
  // ---------------------------------------------------------------------------
  function patch(id) {
    const opts = window[id];
    if (!opts || opts.__ccPatched) return;
    const orig = opts.getCustomIndicators;
    opts.getCustomIndicators = async function (PineJS) {
      const base = orig ? (await orig(PineJS)) || [] : [];
      return base.concat(customIndicators(PineJS));
    };
    opts.__ccPatched = true;
    console.log('[CC] 커스텀 지표 주입 완료:', id);
  }

  // ---------------------------------------------------------------------------
  // 차트 종류: 사이트의 차트 유형 메뉴(M1 옆 캔들 버튼)에 항목을 추가한다.
  // 사이트 기본 항목은 캔들(1)과 선형(영역, 3) 두 개뿐.
  // 렌코·카기·P&F·라인 브레이크는 이 사이트 라이선스에 빌더(tv-prostudies)가 없어 그려지지 않고,
  // 레인지·볼륨 캔들·HLC 바는 그리기 오류, 계단 라인은 선택 자체가 거부되어 제외했다.
  // ---------------------------------------------------------------------------
  const EXTRA_TYPES = [
    [9, '할로우 캔들', 'candles'],
    [8, '하이킨아시', 'candles'],
    [0, '바', 'chart-bars'],
    [12, '하이-로우', 'chart-bars'],
    [13, '컬럼', 'chart-bars'],
    [2, '라인', 'line'],
    [14, '마커 라인', 'line'],
    [16, 'HLC 영역', 'chart-area'],
    [10, '베이스라인', 'chart-area'],
  ];
  const TYPE_KEY = 'cc-chart-type';
  // 차트 유형 메뉴 두 가지: PC 드롭다운, 모바일 하단 시트
  const MENUS = [
    { list: 'chart-tv-renderer-button-desktop__options', opt: 'chart-tv-renderer-button-desktop__option', on: 'borderBrand' },
    { list: 'chart-tv-renderer-mobile__options-container', opt: 'chart-tv-renderer-mobile__button', on: 'brand',
      close: '[data-testid="overlay-header-close"]',
      // 원래 두 개를 가로로 나란히 놓는 시트라, 항목이 늘면 3열 격자로 바꿔야 글자가 세로로 깨지지 않는다
      css: '.chart-tv-renderer-mobile__options-container[data-cc-extended]{display:grid!important;' +
        'grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}' +
        '.chart-tv-renderer-mobile__options-container[data-cc-extended]>.chart-tv-renderer-mobile__button{' +
        'width:auto!important;min-width:0;margin:0!important;white-space:nowrap}' },
  ];

  function storedType() {
    try { const v = localStorage.getItem(TYPE_KEY); return v === null ? null : +v; } catch (e) { return null; }
  }
  function setStored(v) {
    try { if (v === null) localStorage.removeItem(TYPE_KEY); else localStorage.setItem(TYPE_KEY, String(v)); } catch (e) { /* 저장 불가 시 무시 */ }
  }

  function activeChart() {
    const f = document.querySelector('iframe[id^="tradingview_"]');
    try { return f.contentWindow.tradingViewApi.activeChart(); } catch (e) { return null; }
  }

  function markActive(menu, el, on) {
    el.classList.toggle(menu.opt + '--active', on);
    const svg = el.querySelector('svg');
    if (svg) {
      svg.classList.toggle('ui-icon__svg--color-' + menu.on, on);
      svg.classList.toggle('ui-icon__svg--color-secondary', !on);
    }
  }

  // 항목 글자: PC는 전용 span, 모바일은 아이콘 뒤 글자 노드
  function setLabel(menu, el, label) {
    const span = el.querySelector('.' + menu.opt + '-text');
    if (span) { span.textContent = ' ' + label + ' '; return; }
    const texts = Array.from(el.childNodes).filter(function (n) { return n.nodeType === 3 && n.textContent.trim(); });
    if (texts.length) texts[texts.length - 1].textContent = ' ' + label + ' ';
    else el.appendChild(document.createTextNode(' ' + label + ' '));
  }
  function getLabel(menu, el) {
    const span = el.querySelector('.' + menu.opt + '-text');
    return (span || el).textContent.trim();
  }

  function siteOptions(menu, list) {
    return Array.from(list.children).filter(function (el) { return el.classList.contains(menu.opt) && !el.dataset.ccType; });
  }

  // 선택 표시: 추가 항목이 현재 종류면 그 항목만, 아니면 사이트 표시 그대로
  function refreshActive(menu, list) {
    const chart = activeChart();
    if (!chart) return;
    const cur = chart.chartType();
    let any = false;
    list.querySelectorAll('[data-cc-type]').forEach(function (el) {
      const on = +el.dataset.ccType === cur;
      markActive(menu, el, on);
      any = any || on;
    });
    if (any) siteOptions(menu, list).forEach(function (el) { markActive(menu, el, false); });
  }

  function extendTypeMenu(menu, list) {
    const siteOpts = siteOptions(menu, list);
    if (!siteOpts.length) return; // 메뉴 항목이 아직 그려지기 전
    if (list.dataset.ccExtended) { refreshActive(menu, list); return; }
    list.dataset.ccExtended = '1';
    if (menu.css && !document.getElementById('cc-menu-css-' + menu.opt)) {
      const st = document.createElement('style');
      st.id = 'cc-menu-css-' + menu.opt;
      st.textContent = menu.css;
      document.head.appendChild(st);
    }
    const template = siteOpts[0];
    // 사이트 번역이 빠져 영어로 나오는 항목 정리
    if (getLabel(menu, template) === 'Candles') setLabel(menu, template, '캔들');
    // 사이트 항목을 고르면 사이트가 직접 처리하므로 저장해 둔 종류는 지운다
    siteOpts.forEach(function (el) { el.addEventListener('click', function () { setStored(null); }); });

    for (const [type, label, icon] of EXTRA_TYPES) {
      const el = template.cloneNode(true);
      el.removeAttribute('data-testid');
      el.dataset.ccType = String(type);
      setLabel(menu, el, label);
      const use = el.querySelector('use');
      if (use) use.setAttribute('xlink:href', 'assets/sprite.svg#' + icon);
      el.addEventListener('click', function () {
        const c = activeChart();
        if (c) c.setChartType(type);
        setStored(type);
        // 모바일 시트는 사이트 항목처럼 고르면 닫히게
        if (menu.close) { const x = document.querySelector(menu.close); if (x) x.click(); }
      });
      list.appendChild(el);
    }
    refreshActive(menu, list);
    // 사이트가 렌더링 직후 자기 항목에 선택 표시를 다시 붙이므로 한 번 더 정리
    setTimeout(function () { refreshActive(menu, list); }, 100);
  }

  // 사이트는 차트를 새로 만들거나 종목을 바꿀 때 캔들/선형으로 되돌리므로, 저장해 둔 종류를 다시 적용한다.
  setInterval(function () {
    const want = storedType();
    if (want === null) return;
    const chart = activeChart();
    if (!chart) return;
    try { if (chart.chartType() !== want) chart.setChartType(want); } catch (e) { /* 차트 준비 전 */ }
  }, 1500);

  new MutationObserver(function (muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const frames = n.tagName === 'IFRAME' ? [n] : n.querySelectorAll('iframe');
        for (const f of frames) if (f.id && f.id.indexOf('tradingview_') === 0) patch(f.id);
        for (const menu of MENUS) {
          if (n.classList.contains(menu.opt) && n.parentElement) { extendTypeMenu(menu, n.parentElement); continue; }
          const lists = n.classList.contains(menu.list) ? [n] : n.querySelectorAll('.' + menu.list);
          for (const l of lists) extendTypeMenu(menu, l);
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

// 파이어폭스 탬퍼몽키, 아이폰 사파리 Userscripts 등은 스크립트를 페이지와 분리된 샌드박스에서 실행해서
// 차트 위젯 옵션(window[iframe id])이 보이지 않으므로 항상 코드를 페이지에 직접 넣어 실행한다.
// (이 사이트는 CSP가 없어 인라인 스크립트가 막히지 않고, 크롬처럼 원래 페이지에서 실행되는 경우에도 똑같이 동작한다)
(function inject() {
  const root = document.head || document.documentElement;
  if (!root) {  // 아주 이른 시점이라 <html>도 아직 없으면 생길 때까지 기다림
    new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); inject(); } })
      .observe(document, { childList: true });
    return;
  }
  const s = document.createElement('script');
  s.textContent = '(' + ccMain.toString() + ')();';
  root.appendChild(s);
  s.remove();
})();
