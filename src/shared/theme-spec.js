'use strict';

(function (root) {
  const ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
  const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const COLORS = [
    '--bg', '--surface', '--surface-2', '--surface-3', '--surface-4',
    '--border', '--border-strong', '--text', '--text-2', '--text-3',
    '--accent', '--accent-hover', '--accent-weak', '--accent-ink', '--accent-line',
    '--ok-bg', '--ok-ink', '--warn-bg', '--warn-ink', '--up', '--down',
    '--danger-bg', '--danger-ink', '--danger-line', '--chip-bg', '--chip-ink',
    '--hl-bg', '--hl-ink', '--track', '--seg-active', '--step-bg',
    '--chart-line', '--chart-grid', '--chart-ink', '--chart-dot',
    '--props-c1', '--props-c2', '--props-c3', '--props-c4',
    '--scroll', '--scroll-hover', '--chevron',
  ];
  const VARIABLES = COLORS.concat('--radius');
  const BASES = ['light', 'pink', 'dark'];
  const CACHE_KEY = 'ciweimao.pluginTheme';
  const IMAGE_LIMIT = 8 * 1024 * 1024;
  const SLOTS = ['sidebar', 'topbar', 'panel', 'button', 'primaryButton', 'navItem', 'navActive',
    'input', 'writerWorkspace', 'writerPaper', 'writerDirectory', 'writerStats', 'toolbar', 'dialog', 'title'];

  function object(raw, label) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(label + ' 必须是对象');
    return raw;
  }
  function keys(raw, allowed, label) {
    object(raw, label);
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(label + ' 不支持 ' + key);
  }
  function number(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(label + ' 超出范围');
    return value;
  }
  function color(value) {
    if (typeof value !== 'string' || !COLOR.test(value)) throw new Error('样式颜色格式无效');
    return value;
  }
  function image(value) {
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error('图片必须是插件资源路径或图片数据');
    if (/^assets\/[A-Za-z0-9][A-Za-z0-9_-]*\.(png|jpe?g|webp|gif)$/i.test(value)) return value;
    if (value.length <= Math.ceil(IMAGE_LIMIT / 3) * 4 + 64
        && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
    throw new Error('图片仅支持 assets 下的 PNG、JPEG、WebP、GIF，单张最多 8MB');
  }
  function background(raw) {
    keys(raw, ['image', 'opacity', 'blur', 'fit', 'position'], 'background');
    const out = {};
    if ('image' in raw) out.image = image(raw.image);
    if ('opacity' in raw) out.opacity = number(raw.opacity, 0, 1, '背景透明度');
    if ('blur' in raw) out.blur = number(raw.blur, 0, 24, '背景模糊');
    if ('fit' in raw) {
      if (!['cover', 'contain'].includes(raw.fit)) throw new Error('背景 fit 无效');
      out.fit = raw.fit;
    }
    if ('position' in raw) {
      if (!['center', 'top', 'bottom', 'left', 'right'].includes(raw.position)) throw new Error('背景 position 无效');
      out.position = raw.position;
    }
    return out;
  }
  function branding(raw) {
    keys(raw, ['icon'], 'branding');
    return 'icon' in raw ? { icon: image(raw.icon) } : {};
  }
  function styles(raw) {
    keys(raw, SLOTS, 'styles');
    const out = {};
    for (const [slot, style] of Object.entries(raw)) {
      keys(style, ['background', 'color', 'borderColor', 'borderWidth', 'borderStyle', 'borderRadius',
        'shadow', 'backdropBlur', 'gradient', 'fontWeight', 'paddingX', 'paddingY'], '组件样式');
      const clean = {};
      for (const [key, value] of Object.entries(style)) {
        if (['background', 'color', 'borderColor'].includes(key)) clean[key] = color(value);
        else if (key === 'borderStyle') {
          if (!['solid', 'dashed', 'dotted', 'double'].includes(value)) throw new Error('边框样式无效');
          clean[key] = value;
        } else if (key === 'shadow') {
          keys(value, ['x', 'y', 'blur', 'spread', 'color'], '阴影');
          clean.shadow = { x: number(value.x ?? 0, -24, 24, '阴影 x'), y: number(value.y ?? 4, -24, 48, '阴影 y'),
            blur: number(value.blur ?? 20, 0, 80, '阴影模糊'), spread: number(value.spread ?? 0, -20, 20, '阴影扩散'),
            color: color(value.color) };
        } else if (key === 'gradient') {
          keys(value, ['from', 'to', 'angle'], '渐变');
          clean.gradient = { from: color(value.from), to: color(value.to), angle: number(value.angle ?? 135, 0, 360, '渐变角度') };
        } else {
          const ranges = { borderWidth: [0, 6], borderRadius: [0, 48], backdropBlur: [0, 24],
            fontWeight: [400, 800], paddingX: [0, 32], paddingY: [0, 24] };
          clean[key] = number(value, ...ranges[key], key);
        }
      }
      out[slot] = clean;
    }
    return out;
  }
  function decorations(raw) {
    if (!Array.isArray(raw) || raw.length > 6) throw new Error('最多提供 6 个立绘装饰');
    const result = raw.map(item => {
      keys(item, ['id', 'image', 'anchor', 'width', 'height', 'opacity', 'offsetX', 'offsetY', 'layer', 'enabled'], '装饰');
      if (!ID.test(item.id || '')) throw new Error('装饰 ID 无效');
      const anchor = item.anchor || 'bottom-right';
      const layer = item.layer || 'background';
      if (!['bottom-left', 'bottom-right', 'top-left', 'top-right', 'sidebar-bottom'].includes(anchor)) throw new Error('装饰位置无效');
      if (!['background', 'foreground'].includes(layer)) throw new Error('装饰层级无效');
      if ('enabled' in item && typeof item.enabled !== 'boolean') throw new Error('装饰 enabled 无效');
      return { id: item.id, image: image(item.image), anchor, layer, enabled: item.enabled !== false,
        width: number(item.width ?? 240, 32, 640, '立绘宽度'), height: number(item.height ?? 65, 10, 85, '立绘最大高度'),
        opacity: number(item.opacity ?? 1, 0, 1, '立绘透明度'),
        offsetX: number(item.offsetX ?? 0, -200, 400, '立绘水平偏移'), offsetY: number(item.offsetY ?? 0, -200, 400, '立绘竖直偏移') };
    });
    if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('装饰 ID 不能重复');
    return result;
  }
  function effects(raw) {
    keys(raw, ['bubbles', 'bubbleCount', 'bubbleSpeed', 'trim', 'stars'], 'effects');
    const out = {};
    for (const key of ['bubbles', 'trim', 'stars']) {
      if (key in raw) {
        if (typeof raw[key] !== 'boolean') throw new Error(key + ' 必须为布尔值');
        out[key] = raw[key];
      }
    }
    if ('bubbleCount' in raw) out.bubbleCount = Math.round(number(raw.bubbleCount, 4, 30, '气泡数量'));
    if ('bubbleSpeed' in raw) out.bubbleSpeed = number(raw.bubbleSpeed, 0.3, 2, '气泡速度');
    return out;
  }
  function appearance(raw) {
    keys(raw, ['variables', 'background', 'branding', 'styles', 'decorations', 'effects'], '主题外观');
    const out = {};
    if ('variables' in raw) out.variables = variables(raw.variables);
    if ('background' in raw) out.background = background(raw.background);
    if ('branding' in raw) out.branding = branding(raw.branding);
    if ('styles' in raw) out.styles = styles(raw.styles);
    if ('decorations' in raw) out.decorations = decorations(raw.decorations);
    if ('effects' in raw) out.effects = effects(raw.effects);
    return out;
  }
  function merge(base, override) {
    const extra = appearance(override || {});
    const combined = { ...base, ...extra };
    for (const key of ['variables', 'background', 'branding', 'effects']) combined[key] = { ...base[key], ...extra[key] };
    combined.styles = { ...base.styles };
    for (const [slot, style] of Object.entries(extra.styles || {})) combined.styles[slot] = { ...combined.styles[slot], ...style };
    return theme(combined);
  }

  function variables(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('主题 variables 必须是对象');
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!VARIABLES.includes(key)) throw new Error('不支持的主题变量 ' + key);
      if (typeof value !== 'string') throw new Error('主题变量必须使用字符串 ' + key);
      const text = value.trim();
      const valid = key === '--radius'
        ? /^(?:[0-9]|1[0-9]|2[0-4])px$/.test(text)
        : COLOR.test(text);
      if (!valid) throw new Error('主题变量格式无效 ' + key);
      result[key] = text;
    }
    return result;
  }

  function theme(raw) {
    if (!raw || typeof raw !== 'object' || !ID.test(raw.id || '')) throw new Error('主题 ID 格式无效');
    if (!BASES.includes(raw.base)) throw new Error('主题 base 必须为 light、pink 或 dark');
    const colors = variables(raw.variables);
    if (!Object.keys(colors).length) throw new Error('主题至少需要一个样式变量');
    return {
      id: raw.id, name: String(raw.name || raw.id).slice(0, 40),
      base: raw.base, variables: colors,
      ...(raw.background === undefined ? {} : { background: background(raw.background) }),
      ...(raw.branding === undefined ? {} : { branding: branding(raw.branding) }),
      ...(raw.styles === undefined ? {} : { styles: styles(raw.styles) }),
      ...(raw.decorations === undefined ? {} : { decorations: decorations(raw.decorations) }),
      ...(raw.effects === undefined ? {} : { effects: effects(raw.effects) }),
    };
  }

  function themes(raw) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 8) throw new Error('一个插件最多声明 8 个主题');
    const list = raw.map(theme);
    if (new Set(list.map(item => item.id)).size !== list.length) throw new Error('插件中的主题 ID 不能重复');
    return list;
  }

  function selection(raw) {
    return raw && ID.test(raw.pluginId || '') && ID.test(raw.themeId || '')
      ? { pluginId: raw.pluginId, themeId: raw.themeId } : null;
  }

  function applyVariables(element, values) {
    // Validate the entire recipe before changing any previously applied values.
    const clean = variables(values || {});
    for (const key of VARIABLES) element.style.removeProperty(key);
    for (const [key, value] of Object.entries(clean)) element.style.setProperty(key, value);
  }

  const api = { COLORS, VARIABLES, BASES, CACHE_KEY, SLOTS, IMAGE_LIMIT,
    variables, theme, themes, selection, applyVariables, image, appearance, merge };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ThemeSpec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
