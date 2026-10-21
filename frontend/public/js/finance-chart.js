'use strict';

window.FinanceChart = (() => {
  const ns = 'http://www.w3.org/2000/svg';
  const node = (name, attrs = {}, text = '') => {
    const element = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
  };

  function render(target, labels, datasets) {
    target.replaceChildren();
    if (!labels || !labels.length) {
      target.append(h('div', { class: 'muted small' }, 'No savings or loan history yet.'));
      return;
    }
    const width = 760, height = 300, left = 70, right = 20, top = 18, bottom = 45;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = datasets.flatMap(set => set.values || []).map(value => Math.max(0, Number(value) || 0) / 100);
    const max = Math.max(1, ...values);
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const scaleMax = Math.ceil(max / step) * step || 1;
    const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'finance-line-chart', 'aria-label': 'Monthly verified savings and outstanding loans' });

    for (let tick = 0; tick <= 4; tick++) {
      const y = top + plotHeight * tick / 4;
      const amount = scaleMax * (4 - tick) / 4;
      svg.append(node('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'chart-gridline' }));
      svg.append(node('text', { x: left - 9, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' }, amount.toLocaleString('en-KE', { maximumFractionDigits: 0 })));
    }

    const x = index => labels.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (labels.length - 1);
    const y = cents => top + plotHeight - (Math.max(0, Number(cents) || 0) / 100 / scaleMax) * plotHeight;
    labels.forEach((label, index) => {
      if (index % 2 !== 0 && index !== labels.length - 1) return;
      svg.append(node('text', { x: x(index), y: height - 14, 'text-anchor': 'middle', class: 'chart-axis-label' }, label));
    });
    datasets.forEach(set => {
      const points = set.values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
      svg.append(node('polyline', { points, class: 'chart-series', stroke: set.color }));
      set.values.forEach((value, index) => {
        const point = node('circle', { cx: x(index), cy: y(value), r: 3.5, fill: set.color, class: 'chart-point' });
        point.append(node('title', {}, `${set.name} · ${labels[index]} · KES ${(Number(value || 0) / 100).toFixed(2)}`));
        svg.append(point);
      });
    });
    target.append(svg);

    const legend = h('div', { class: 'finance-legend' });
    datasets.forEach(set => legend.append(h('span', { class: 'finance-legend-item' },
      h('i', { style: `background:${set.color}` }), set.name)));
    target.append(legend);
  }

  return { render, kes: cents => 'KES ' + (Number(cents || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
})();
