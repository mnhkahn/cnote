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
