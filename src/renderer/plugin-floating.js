'use strict';

// 纯布局函数同时供宿主和回归测试使用。所有坐标均为应用内容区 CSS 像素。
(function (root) {
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.min(Math.max(min, value), Math.max(min, max));
  function dimensions(value, fallback) {
    return {
      width: clamp(finite(value && value.width, fallback.width), 32, 1000),
      height: clamp(finite(value && value.height, fallback.height), 32, 1000),
    };
  }
  function layout(anchor, viewport, config, expanded) {
    const margin = 8;
    const widget = dimensions(config && config.widget, { width: 72, height: 72 });
    const panel = dimensions(config && config.panel, { width: 360, height: 280 });
    const width = Math.min(Math.max(1, viewport.width), expanded ? Math.max(panel.width, widget.width + 24) : widget.width + 24);
    const height = Math.min(Math.max(1, viewport.height), expanded ? Math.max(panel.height, widget.height + 24) : widget.height + 24);
    const x = clamp(finite(anchor && anchor.x, viewport.width - widget.width - 24), margin, viewport.width - widget.width - margin);
    const y = clamp(finite(anchor && anchor.y, viewport.height - widget.height - 24), margin, viewport.height - widget.height - margin);
    const right = x + widget.width / 2 >= viewport.width / 2;
    const bottom = y + widget.height / 2 >= viewport.height / 2;
    const left = clamp(x - (expanded && right ? width - widget.width - 12 : 12), 0, viewport.width - width);
    const top = clamp(y - (expanded && bottom ? height - widget.height - 12 : 12), 0, viewport.height - height);
    return { left, top, width, height, ballX: x - left, ballY: y - top,
      anchor: { x, y }, edge: `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`, expanded: !!expanded, widget };
  }

  function create({ frame, host, notify, savePosition, initialPosition }) {
    let anchor = initialPosition || {};
    let config = {};
    let expanded = false;
    let drag = null;
    let disposed = false;
    let state;
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    function render() {
      if (disposed) return state;
      state = layout(anchor, viewport(), config, expanded);
      anchor = state.anchor;
      Object.assign(host.style, { left: `${state.left}px`, top: `${state.top}px`, right: 'auto', bottom: 'auto',
        width: `${state.width}px`, height: `${state.height}px` });
      host.hidden = false;
      notify({ ...state, mode: 'floating' });
      return state;
    }
    function save() { if (savePosition) Promise.resolve(savePosition(anchor)).catch(() => {}); }
    const resize = () => render();
    window.addEventListener('resize', resize);
    // iframe 仅挂载一次，页面切换时不移动 DOM，避免浏览上下文被重建。
    host.appendChild(frame);
    render();
    return {
      render,
      configure(value) {
        config = { widget: dimensions(value && value.widget, state.widget),
          panel: dimensions(value && value.panel, config.panel || { width: 360, height: 280 }) };
        return render();
      },
      setExpanded(value) { expanded = !!value; return render(); },
      event(data) {
        if (data.event === 'popover') { expanded = !!data.open; return render(); }
        if (data.event === 'drag-start') { drag = { ...anchor }; return state; }
        if (data.event === 'drag-move' && drag && Number.isFinite(data.dx) && Number.isFinite(data.dy)) {
          anchor = { x: drag.x + data.dx, y: drag.y + data.dy };
          return render();
        }
        if (data.event === 'drag-end' || data.event === 'drag-cancel') { drag = null; save(); }
        return state;
      },
      dispose() {
        disposed = true;
        window.removeEventListener('resize', resize);
        frame.remove();
        host.remove();
        drag = null;
      },
    };
  }
  const api = { layout, dimensions, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PluginFloating = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
