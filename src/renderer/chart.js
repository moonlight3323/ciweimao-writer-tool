'use strict';

/**
 * 极简折线图，纯 SVG 手绘，无任何外部依赖。
 * 只负责「一组 (日期, 数值) 画成折线」这一件事，业务口径由调用方决定。
 */
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const PAD = { top: 22, right: 24, bottom: 30, left: 62 };
  const HEIGHT = 250;

  /**
   * 取主题变量。颜色不能写死——深色主题下线条与网格要换一档，
   * 而 SVG 属性不认 CSS 变量（只能用字符串），所以每次绘制时从 :root 读当前值。
   */
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  /** Y 轴刻度缩写：1234567 → 123万 */
  function shortNum(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 100000000) return trimZero((n / 100000000).toFixed(2)) + '亿';
    if (a >= 10000) return trimZero((n / 10000).toFixed(a >= 100000 ? 1 : 2)) + '万';
    return String(Math.round(n));
  }

  function trimZero(s) {
    return String(s).replace(/\.?0+$/, '');
  }

  /** 'YYYY-MM-DD' → UTC 毫秒，用 UTC 避免本地时区把日期推前/推后一天 */
  function dayToTime(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function mmdd(day) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(day || ''));
    return m ? `${m[1]}-${m[2]}` : String(day || '');
  }

  function el(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * @param {HTMLElement} box  容器
   * @param {Object} opts
   *   points  [{ day:'2026-11-04', value: 123 }]，须按日期升序
   *   unit    数值单位后缀，如 '字'
   */
  function lineChart(box, opts) {
    const points = (opts && opts.points) || [];
    const unit = (opts && opts.unit) || '';
    // 品牌金 #F9BF03 在浅色底上太浅，线条用深一档的金；深色主题反过来要亮一档
    const COLOR = cssVar('--chart-line', '#c89600');
    const GRID = cssVar('--chart-grid', '#f0e7d3');
    const INK_3 = cssVar('--chart-ink', '#a79d89');
    const DOT = cssVar('--chart-dot', '#ffffff');
    box.innerHTML = '';

    if (points.length === 0) {
      box.appendChild(el('div', { class: 'chart-empty' }, '这本书在已有的历史快照中没有记录'));
      return;
    }

    const width = Math.max(360, box.clientWidth || 680);
    const svg = el('svg', {
      width: '100%',
      height: HEIGHT,
      viewBox: `0 0 ${width} ${HEIGHT}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
    });

    const vals = points.map((p) => p.value);
    const tMin = dayToTime(points[0].day);
    const tMax = dayToTime(points[points.length - 1].day);

    // ---- Y 轴范围 ----
    let vMin = Math.min.apply(null, vals);
    let vMax = Math.max.apply(null, vals);
    if (vMin === vMax) {
      // 一条水平线（或只有一个点）：人为撑开一点，否则除零
      const bump = vMin === 0 ? 1 : Math.abs(vMin) * 0.02;
      vMin -= bump;
      vMax += bump;
    }
    const span = vMax - vMin;
    let yLo = vMin - span * 0.18;
    let yHi = vMax + span * 0.18;
    // 非负指标不要画到 0 以下
    if (Math.min.apply(null, vals) >= 0) yLo = Math.max(0, yLo);
    if (yLo === yHi) yHi = yLo + 1;

    const plotL = PAD.left;
    const plotR = width - PAD.right;
    const plotT = PAD.top;
    const plotB = HEIGHT - PAD.bottom;

    // ---- 刻度步长：整数指标（订阅数、收藏数这类）必须落在整数值上 ----
    // 否则 0~5 的范围会被切成 1.475/2.95…，四舍五入后标签与线位置对不上。
    const ticks = 4;
    const allInt = vals.every((v) => Number.isInteger(v));
    if (allInt && yHi - yLo <= 40) {
      yLo = Math.max(0, Math.floor(yLo));
      const step = Math.max(1, Math.ceil((yHi - yLo) / ticks));
      yHi = yLo + step * ticks;
    }

    const xOf = (day) => {
      const t = dayToTime(day);
      if (!isFinite(tMin) || tMax === tMin) return (plotL + plotR) / 2;
      return plotL + ((t - tMin) / (tMax - tMin)) * (plotR - plotL);
    };
    const yOf = (v) => plotB - ((v - yLo) / (yHi - yLo)) * (plotB - plotT);

    // ---- 横向网格 + Y 轴刻度 ----
    for (let i = 0; i <= ticks; i++) {
      const v = yLo + ((yHi - yLo) * i) / ticks;
      const y = yOf(v);
      svg.appendChild(el('line', {
        x1: plotL, y1: y, x2: plotR, y2: y,
        stroke: GRID, 'stroke-width': 1,
      }));
      svg.appendChild(el('text', {
        x: plotL - 10, y: y + 3.5,
        'text-anchor': 'end',
        'font-size': 10,
        fill: INK_3,
      }, shortNum(v)));
    }

    // ---- X 轴日期标签：最多 8 个，首尾必含 ----
    const n = points.length;
    const maxLabels = 8;
    const idxSet = new Set();
    if (n <= maxLabels) {
      for (let i = 0; i < n; i++) idxSet.add(i);
    } else {
      for (let i = 0; i < maxLabels; i++) {
        idxSet.add(Math.round((i * (n - 1)) / (maxLabels - 1)));
      }
    }
    Array.from(idxSet).sort((a, b) => a - b).forEach((i) => {
      const x = xOf(points[i].day);
      svg.appendChild(el('text', {
        x, y: plotB + 18,
        'text-anchor': 'middle',
        'font-size': 10,
        fill: INK_3,
      }, mmdd(points[i].day)));
    });

    // ---- 折线 ----
    if (points.length >= 2) {
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.day)},${yOf(p.value)}`).join(' ');
      svg.appendChild(el('path', {
        d, fill: 'none', stroke: COLOR, 'stroke-width': 2.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }

    // ---- 数据点 + 悬停提示 ----
    points.forEach((p, i) => {
      const x = xOf(p.day);
      const y = yOf(p.value);
      const last = i === points.length - 1;

      svg.appendChild(el('circle', {
        cx: x, cy: y, r: last ? 3.5 : 2.5,
        fill: DOT, stroke: COLOR, 'stroke-width': 2,
      }));

      // 透明热区，扩大悬停命中范围
      const hit = el('circle', { cx: x, cy: y, r: 11, fill: 'transparent' });
      hit.appendChild(el('title', null, `${p.day}　${p.value.toLocaleString('zh-CN')}${unit}`));
      svg.appendChild(hit);
    });

    // ---- 最新值直接标在图上 ----
    const lastP = points[points.length - 1];
    const lx = xOf(lastP.day);
    const ly = yOf(lastP.value);
    const anchor = lx > plotR - 60 ? 'end' : 'start';
    svg.appendChild(el('text', {
      x: anchor === 'end' ? lx - 8 : lx + 8,
      y: Math.max(plotT + 10, ly - 10),
      'text-anchor': anchor,
      'font-size': 11,
      'font-weight': 500,
      fill: COLOR,
    }, shortNum(lastP.value) + unit));

    box.appendChild(svg);
  }

  /**
   * 多系列折线图（道具趋势用：推荐票 / 月票 / 打赏 / 刀片 四条线同图）。
   *
   * 与 lineChart 的区别不只是"多条线"，还有几处刻意的处理：
   * - **Y 轴按所有系列的最大值统一**。各系列共用一个刻度才看得出量级差
   *   （打赏常常是几百，刀片是个位数，分开画会让人误以为量级接近）。
   * - **某天某系列为 null 时，那个点断开**而不是画成 0 —— 0 是"当天没有"，
   *   null 是"当天没抓到"，把两者画成一样会编造数据。
   * - 图例按传进来的顺序画，颜色也按顺序取（调用方负责顺序与配色一致）。
   *
   * @param {HTMLElement} box
   * @param {Object} opts
   *   days     ['2026-11-01', ...]  横轴日期，升序
   *   series   [{ key, label, color, values: number|null[] }]
   */
  function multiLineChart(box, opts) {
    const days = (opts && opts.days) || [];
    const series = ((opts && opts.series) || []).filter((s) => s && Array.isArray(s.values));
    const GRID = cssVar('--chart-grid', '#f0e7d3');
    const INK_3 = cssVar('--chart-ink', '#a79d89');
    const DOT = cssVar('--chart-dot', '#ffffff');
    const HEIGHT_M = 240;
    box.innerHTML = '';

    const allValues = [];
    for (const s of series) {
      for (const v of s.values) {
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) allValues.push(Number(v));
      }
    }
    if (!days.length || !allValues.length) {
      box.appendChild(el('div', { class: 'chart-empty' }, '还没有可用于画趋势的数据'));
      return;
    }

    const width = Math.max(360, box.clientWidth || 680);
    const svg = el('svg', {
      width: '100%',
      height: HEIGHT_M,
      viewBox: `0 0 ${width} ${HEIGHT_M}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
    });

    const tMin = dayToTime(days[0]);
    const tMax = dayToTime(days[days.length - 1]);
    let yHi = Math.max.apply(null, allValues);
    const yLo = 0;   // 道具数量非负，从 0 起才看得出涨落比例
    if (yHi === yLo) yHi = 1;
    yHi += (yHi - yLo) * 0.15;

    const plotL = PAD.left;
    const plotR = width - PAD.right;
    const plotT = PAD.top;
    const plotB = HEIGHT_M - PAD.bottom;

    const xOf = (day) => {
      const t = dayToTime(day);
      if (!isFinite(tMin) || tMax === tMin) return (plotL + plotR) / 2;
      return plotL + ((t - tMin) / (tMax - tMin)) * (plotR - plotL);
    };
    const yOf = (v) => plotB - ((v - yLo) / (yHi - yLo)) * (plotB - plotT);

    // 网格 + Y 刻度
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = yLo + ((yHi - yLo) * i) / ticks;
      const y = yOf(v);
      svg.appendChild(el('line', {
        x1: plotL, y1: y, x2: plotR, y2: y, stroke: GRID, 'stroke-width': 1,
      }));
      svg.appendChild(el('text', {
        x: plotL - 10, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: INK_3,
      }, shortNum(v)));
    }

    // X 轴日期：最多 8 个，首尾必含
    const n = days.length;
    const maxLabels = 8;
    const idxSet = new Set();
    if (n <= maxLabels) {
      for (let i = 0; i < n; i++) idxSet.add(i);
    } else {
      for (let i = 0; i < maxLabels; i++) {
        idxSet.add(Math.round((i * (n - 1)) / (maxLabels - 1)));
      }
    }
    Array.from(idxSet).sort((a, b) => a - b).forEach((i) => {
      svg.appendChild(el('text', {
        x: xOf(days[i]), y: plotB + 18, 'text-anchor': 'middle', 'font-size': 10, fill: INK_3,
      }, mmdd(days[i])));
    });

    // 各系列折线：null 处断开（分段画），不补 0
    series.forEach((s) => {
      const color = s.color || cssVar('--chart-line', '#c89600');
      let seg = [];
      const flush = () => {
        if (seg.length >= 2) {
          svg.appendChild(el('path', {
            d: seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '),
            fill: 'none',
            stroke: color,
            'stroke-width': 2,
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
          }));
        }
        // 只有一个点也画出来，否则那一天的数据等于没显示
        if (seg.length === 1) {
          svg.appendChild(el('circle', {
            cx: seg[0].x, cy: seg[0].y, r: 2.5, fill: color,
          }));
        }
        seg = [];
      };

      s.values.forEach((v, i) => {
        if (v === null || v === undefined || !Number.isFinite(Number(v))) {
          flush();
          return;
        }
        const x = xOf(days[i]);
        const y = yOf(Number(v));
        seg.push({ x, y });

        svg.appendChild(el('circle', {
          cx: x, cy: y, r: 3, fill: DOT, stroke: color, 'stroke-width': 2,
        }));
        const hit = el('circle', { cx: x, cy: y, r: 10, fill: 'transparent' });
        hit.appendChild(el('title', null,
          `${days[i]}　${s.label} ${Number(v).toLocaleString('zh-CN')}`));
        svg.appendChild(hit);
      });
      flush();
    });

    box.appendChild(svg);
  }

  const api = { lineChart, multiLineChart, shortNum, dayToTime };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Chart = api;
})(typeof window !== 'undefined' ? window : globalThis);
