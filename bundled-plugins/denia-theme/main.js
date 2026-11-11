'use strict';
(async function () {
  const api = window.PluginAPI, $ = id => document.getElementById(id), status = $('status');
  let themes = [], pendingImage = null, pendingIcon = null, busy = false;
  const ownId = 'denia-theme', chosen = () => themes.find(theme => theme.id === $('form').value);
  function ranges() { for (const [id, unit] of [['opacity', '%'], ['blur', 'px'], ['glass', '%']]) $(id + 'Value').textContent = $(id).value + unit; }
  async function refreshCurrent() {
    const selected = (await api.theme.get()).pluginTheme;
    $('builtin').disabled = !selected || selected.pluginId !== ownId;
    for (const [id, themeId] of [['light', 'denia-light'], ['dark', 'denia-dark']]) $(id).disabled = !!(selected && selected.pluginId === ownId && selected.themeId === themeId);
  }
  async function loadForm(id) {
    themes = await api.theme.list(); $('form').value = id || $('form').value;
    const recipe = chosen();
    $('opacity').value = Math.round((recipe.background.opacity ?? 1) * 100);
    $('blur').value = recipe.background.blur || 0;
    const bg = recipe.styles.panel.background;
    $('glass').value = bg.length === 9 ? Math.round(parseInt(bg.slice(-2), 16) / 255 * 100) : 100;
    for (const [control, art] of [['leftArt', 'left-art'], ['rightArt', 'right-art'], ['chibi', 'chibi-art']]) $(control).checked = recipe.decorations.find(item => item.id === art)?.enabled !== false;
    for (const key of ['bubbles', 'trim', 'stars']) $(key).checked = !!recipe.effects[key];
    pendingImage = null; pendingIcon = null;
    $('image').value = ''; $('imageName').textContent = '背景已载入，可选择自己的图片替换';
    $('icon').value = ''; $('defaultIcon').checked = !recipe.branding?.icon;
    $('iconName').textContent = recipe.branding?.icon ? '主题图标已载入，可选择自己的图片替换' : '当前使用软件默认图标';
    ranges(); await refreshCurrent();
  }
  async function operation(callback) {
    if (busy) return; busy = true; $('save').disabled = true;
    try { await callback(); } catch (error) { status.textContent = error.message; }
    finally { busy = false; $('save').disabled = false; }
  }
  try {
    await api.ready;
    const info = await api.app.info();
    if (!info.capabilities.includes('themeBranding')) throw new Error('请在已接入侧栏图标接口的新版作家助手中导入本包');
    const current = await api.theme.get();
    await loadForm(current.pluginTheme?.pluginId === ownId ? current.pluginTheme.themeId : 'denia-light');
    for (const [id, themeId] of [['light', 'denia-light'], ['dark', 'denia-dark']]) $(id).addEventListener('click', () => operation(async () => {
      await api.theme.apply(themeId); await loadForm(themeId); status.textContent = '形态已切换，选择已保存。';
    }));
    $('form').addEventListener('change', () => operation(() => loadForm($('form').value)));
    for (const id of ['opacity', 'blur', 'glass']) $(id).addEventListener('input', ranges);
    for (const [inputId, labelId] of [['image', 'imageName'], ['icon', 'iconName']]) $(inputId).addEventListener('change', async () => {
      const file = $(inputId).files[0]; if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 8 * 1024 * 1024) { $(labelId).textContent = '请选择 8MB 以内的 PNG、JPEG、WebP 或 GIF 图片'; $(inputId).value = ''; return; }
      try {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        if (inputId === 'image') pendingImage = data;
        else { pendingIcon = data; $('defaultIcon').checked = false; }
        $(labelId).textContent = '待保存：' + file.name;
      } catch (_) { $(labelId).textContent = '读取图片失败，请重新选择'; }
    });
    $('save').addEventListener('click', () => operation(async () => {
      const recipe = chosen(), alpha = Math.round(Number($('glass').value) / 100 * 255).toString(16).padStart(2, '0');
      const surface = recipe.base === 'dark' ? '#211c35' : '#fffbff', styles = {};
      for (const slot of ['sidebar', 'topbar', 'panel', 'writerDirectory', 'writerStats', 'toolbar']) styles[slot] = { background: surface + alpha };
      const options = { background: { opacity: Number($('opacity').value) / 100, blur: Number($('blur').value) }, styles,
        decorations: recipe.decorations.map(item => ({ ...item, enabled: item.id === 'left-art' ? $('leftArt').checked : item.id === 'right-art' ? $('rightArt').checked : $('chibi').checked })),
        effects: { bubbles: $('bubbles').checked, trim: $('trim').checked, stars: $('stars').checked } };
      if (pendingImage) options.background.image = pendingImage;
      options.branding = { icon: $('defaultIcon').checked ? null
        : pendingIcon || recipe.branding?.icon || 'assets/chibi-' + (recipe.base === 'dark' ? 'dark' : 'light') + '.gif' };
      await api.theme.configure(recipe.id, options); await api.theme.apply(recipe.id); await loadForm(recipe.id); status.textContent = '已保存并应用，重启后会保留。';
    }));
    $('defaults').addEventListener('click', () => operation(async () => {
      const id = $('form').value; await api.theme.configure(id, null); await api.theme.apply(id); await loadForm(id); status.textContent = '已恢复此形态的默认背景和样式。';
    }));
    $('builtin').addEventListener('click', () => operation(async () => { await api.theme.reset(); await refreshCurrent(); status.textContent = '已恢复软件内置主题。'; }));
    api.on('theme-changed', () => { refreshCurrent().catch(error => { status.textContent = error.message; }); });
    status.textContent = '主题已连接。可切换形态，或在下方自定义外观。';
  } catch (error) { status.textContent = error.message; }
})();
