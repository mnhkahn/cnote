// Keep embedded editors in sync with the application's theme preference.
(() => {
 const system = matchMedia('(prefers-color-scheme: dark)');
 let preference = 'system';
 const themes = /* THEME_CATALOG */ [];
 const apply = () => {
  const id = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  const palette = themes.find(theme => theme.id === id);
  if (!palette) return;
  const root = document.documentElement;
  root.dataset.theme = id;
  root.dataset.appearance = palette.dark ? 'dark' : 'light';
  root.style.colorScheme = root.dataset.appearance;
  root.style.setProperty('--on-accent', palette.dark ? '#111111' : '#ffffff');
  for (const key of ['bg','ink','muted','line','active','accent','soft']) root.style.setProperty('--' + key, '#' + palette[key]);
 };
 window.cnoteTheme = {set(value) {if (value !== 'system' && !themes.some(theme => theme.id === value)) return; preference = value; apply();}};
 system.addEventListener('change', () => {if (preference === 'system') apply();});
 apply();
})();
// Capture before tool editors handle shortcuts, including inside text inputs.
(() => {
 // Navigation function keys are commands, even if a native input method sends
 // their private-use/C0 representation as a text insertion.
 document.addEventListener('beforeinput', event => {
  if (!event.isComposing && event.inputType === 'insertText' && /^[\u001c-\u001f\uf700-\uf703]$/.test(event.data || '')) {
   event.preventDefault();
  }
 }, true);
 document.addEventListener('keydown', event => {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
  if (event.code === 'KeyS') {
   event.preventDefault();
   event.stopImmediatePropagation();
   window.cnote?.action('save');
   return;
  }
  const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
  if (index < 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.ipc.postMessage(JSON.stringify({type:'workspace', index}));
 }, true);
})();
