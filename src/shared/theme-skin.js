'use strict';

/** Declarative skin renderer. Plugins supply visual values, never host DOM scripts or selectors. */
(function (root) {
  const Spec = typeof module === 'object' && module.exports ? require('./theme-spec') : root.ThemeSpec;
  const SELECTORS = {
    sidebar: '.sidebar', topbar: '.topbar',
    panel: '.panel, .plugin-card, .writing-stat-card, .stat-card, .writer-book-card',
    button: '.btn:not(.primary):not(.danger), .writer-tool', primaryButton: '.btn.primary',
    navItem: '.nav-item:not(.is-active)', navActive: '.nav-item.is-active',
    input: '.input, select.input', writerWorkspace: '.writer-editor, .writer-paper-wrap',
    writerPaper: '.writer-paper', writerDirectory: '.writer-chapters', writerStats: '.writer-stats',
    toolbar: '.writer-toolbar, .writer-findbar, .writer-statusbar', dialog: '.notice-card, .modal-card',
    title: '.topbar h1, .writer-library-head h2, .panel-head h3',
  };
  const PLUGIN_SELECTORS = {
    panel: '.panel, .summary article, .skin-card', button: 'button', primaryButton: 'button.primary, #save',
    input: 'input, select', title: 'h1, h2',
  };
  const IDS = ['plugin-theme-skin-style', 'plugin-theme-backdrop', 'plugin-theme-art-back',
    'plugin-theme-art-front', 'plugin-theme-effects', 'plugin-theme-sidebar-stage', 'plugin-theme-brand-icon'];

  function declarations(style) {
    const result = [];
    const put = (key, value) => result.push(key + ':' + value + ' !important');
    for (const [key, value] of Object.entries(style)) {
      if (key === 'gradient') put('background-image', `linear-gradient(${value.angle}deg,${value.from},${value.to})`);
      else if (key === 'shadow') put('box-shadow', `${value.x}px ${value.y}px ${value.blur}px ${value.spread}px ${value.color}`);
      else if (key === 'backdropBlur') put('backdrop-filter', `blur(${value}px)`);
      else if (key === 'background') put('background', value);
      else if (key === 'paddingX') { put('padding-left', value + 'px'); put('padding-right', value + 'px'); }
      else if (key === 'paddingY') { put('padding-top', value + 'px'); put('padding-bottom', value + 'px'); }
      else {
        const property = key.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
        put(property, value + (['borderWidth', 'borderRadius'].includes(key) ? 'px' : ''));
      }
    }
    return result.join(';');
  }

  function css(raw, plugin = false) {
    if (!raw) return '';
    const recipe = Spec.theme(raw);
    const prefix = plugin ? ':root' : ':root[data-theme-plugin]';
    const slots = plugin ? PLUGIN_SELECTORS : SELECTORS;
    const blocks = [];
    for (const [slot, style] of Object.entries(recipe.styles || {})) {
      if (!slots[slot]) continue;
      const selectors = slots[slot].split(',').map(selector => prefix + ' ' + selector.trim());
      blocks.push(selectors.join(',') + '{' + declarations(style) + '}');
    }
    if (plugin && recipe.background && recipe.background.image) blocks.push('html,body{background:transparent!important}');
    if (!plugin && recipe.background && recipe.background.image) blocks.push(
      ':root[data-theme-plugin] .plugin-host,:root[data-theme-plugin] .plugin-host iframe{background:transparent!important}');
    return blocks.join('\n');
  }

  function apply(doc, raw) {
    const recipe = raw ? Spec.theme(raw) : null;
    const compiled = recipe ? css(recipe) : '';
    for (const id of IDS) doc.getElementById(id)?.remove();
    if (!recipe) return;
    const style = doc.createElement('style');
    style.id = IDS[0];
    style.textContent = compiled + `
      body{isolation:isolate}
      #plugin-theme-backdrop,#plugin-theme-art-back,#plugin-theme-art-front,#plugin-theme-effects{
        position:fixed;inset:0;pointer-events:none!important;user-select:none;overflow:hidden;
      }
      #plugin-theme-backdrop{z-index:-3;background-repeat:no-repeat}
      #plugin-theme-art-back{z-index:-2}
      #plugin-theme-effects{z-index:-1}
      #plugin-theme-art-front{z-index:8}
      .plugin-theme-portrait{position:absolute;object-fit:contain;pointer-events:none!important}
      #plugin-theme-brand-icon{display:none;width:34px;height:34px;flex:0 0 34px;object-fit:contain;filter:none}
      #plugin-theme-brand-icon[data-ready="true"]{display:block}
      :root[data-theme-plugin] .brand:has(#plugin-theme-brand-icon[data-ready="true"]) > .brand-mark:not(#plugin-theme-brand-icon){display:none!important}
      #plugin-theme-sidebar-stage{display:flex;justify-content:center;align-items:end;flex:0 0 auto;
        margin-top:auto;height:min(112px,16vh);pointer-events:none;user-select:none}
      #plugin-theme-sidebar-stage .plugin-theme-portrait{position:static;max-height:100%!important;max-width:100%}
      :root[data-theme-plugin] .sidebar:has(#plugin-theme-sidebar-stage) .nav{min-height:0;overflow-y:auto;flex:0 1 auto}
      :root[data-theme-plugin] .sidebar:has(#plugin-theme-sidebar-stage) .sidebar-foot{margin-top:0}
      .plugin-theme-bubble{position:absolute;bottom:-100px;border:1px solid #cab2e984;border-radius:50%;
        background:radial-gradient(circle at 30% 25%,#ffffff99,transparent 32%),
          linear-gradient(130deg,#b5e5ff38,#f7c0e735,#b0b9ff20);
        box-shadow:inset 0 0 10px #ffffff55;animation:plugin-theme-rise linear infinite}
      @keyframes plugin-theme-rise{from{transform:translateY(0) rotate(0deg);opacity:0}
        12%{opacity:.65}88%{opacity:.4}to{transform:translateY(calc(-100vh - 140px)) rotate(90deg);opacity:0}}
      #plugin-theme-art-front[data-trim="true"]{border-top:3px solid transparent;
        border-image:linear-gradient(90deg,#eab6db,#9fbde9,#b29cde) 1}
      #plugin-theme-art-front[data-trim="true"]::before{content:"";position:absolute;top:16px;bottom:16px;
        left:210px;width:9px;opacity:.45;background:repeating-linear-gradient(135deg,
        transparent 0 6px,var(--accent) 6px 8px,transparent 8px 14px);
        border-left:1px dashed var(--accent)}
      #plugin-theme-art-front[data-stars="true"]::after{content:"✧　✦　✧";position:absolute;
        right:28px;top:70px;color:var(--accent);font-size:21px;letter-spacing:10px;opacity:.5}
      body.is-focus #plugin-theme-art-front,body.is-focus #plugin-theme-art-back,body.is-focus #plugin-theme-effects{display:none!important}
      @media(max-width:980px){.plugin-theme-portrait,#plugin-theme-sidebar-stage{display:none!important}
        #plugin-theme-art-front::before,#plugin-theme-art-front::after{display:none!important}}
      @media(prefers-reduced-motion:reduce){.plugin-theme-bubble{animation:none;display:none}}
    `;
    doc.head.appendChild(style);
    if (!doc.body) return;
    if (recipe.branding?.icon?.startsWith('data:image/')) {
      const brand = doc.querySelector('.brand');
      if (brand) {
        const icon = doc.createElement('img');
        icon.id = IDS[6]; icon.className = 'brand-mark'; icon.alt = '主题图标';
        icon.width = icon.height = 34; icon.draggable = false;
        icon.addEventListener('load', () => {
          if (doc.getElementById(IDS[6]) === icon) icon.dataset.ready = 'true';
        }, { once: true });
        icon.addEventListener('error', () => icon.remove(), { once: true });
        icon.src = recipe.branding.icon;
        brand.insertBefore(icon, brand.firstChild);
      }
    }
    const layer = id => {
      const node = doc.createElement('div');
      node.id = id;
      node.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(node);
      return node;
    };
    if (recipe.background?.image?.startsWith('data:image/')) {
      const node = layer(IDS[1]);
      node.style.backgroundImage = 'url("' + recipe.background.image + '")';
      node.style.backgroundSize = recipe.background.fit || 'cover';
      node.style.backgroundPosition = recipe.background.position || 'center';
      node.style.opacity = recipe.background.opacity ?? 1;
      node.style.filter = 'blur(' + (recipe.background.blur || 0) + 'px)';
      if (recipe.background.blur) node.style.transform = 'scale(1.06)';
    }
    const back = layer(IDS[2]);
    const front = layer(IDS[3]);
    front.dataset.trim = String(!!recipe.effects?.trim);
    front.dataset.stars = String(!!recipe.effects?.stars);
    for (const item of recipe.decorations || []) {
      if (!item.enabled || !item.image?.startsWith('data:image/')) continue;
      const portrait = doc.createElement('img');
      portrait.className = 'plugin-theme-portrait';
      portrait.dataset.decoration = item.id;
      portrait.alt = '';
      portrait.draggable = false;
      portrait.src = item.image;
      portrait.style.width = 'min(' + item.width + 'px, 28vw)';
      portrait.style.maxHeight = item.height + 'vh';
      portrait.style.opacity = item.opacity;
      if (item.anchor === 'sidebar-bottom') {
        const sidebar = doc.querySelector('.sidebar');
        if (sidebar) {
          let stage = doc.getElementById(IDS[5]);
          if (!stage) {
            stage = doc.createElement('div'); stage.id = IDS[5]; stage.setAttribute('aria-hidden', 'true');
            sidebar.insertBefore(stage, sidebar.querySelector('.sidebar-foot'));
          }
          stage.appendChild(portrait);
        }
      } else {
        portrait.style[item.anchor.endsWith('left') ? 'left' : 'right'] = item.offsetX + 'px';
        portrait.style[item.anchor.startsWith('top') ? 'top' : 'bottom'] = item.offsetY + 'px';
        (item.layer === 'foreground' ? front : back).appendChild(portrait);
      }
    }
    if (recipe.effects?.bubbles) {
      const bubbles = layer(IDS[4]);
      const count = recipe.effects.bubbleCount || 12;
      for (let i = 0; i < count; i++) {
        const node = doc.createElement('i');
        node.className = 'plugin-theme-bubble';
        const size = 16 + (i * 31 % 55);
        node.style.width = node.style.height = size + 'px';
        node.style.left = (i * 37 % 100) + '%';
        node.style.animationDuration = (18 + i * 7 % 16) / (recipe.effects.bubbleSpeed || 1) + 's';
        node.style.animationDelay = -(i * 3) + 's';
        bubbles.appendChild(node);
      }
    }
  }

  const api = { apply, css, SELECTORS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ThemeSkin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
