// Capture before tool editors handle shortcuts, including inside text inputs.
(() => {
 document.addEventListener('keydown', event => {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
  const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(event.code);
  if (index < 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.ipc.postMessage(JSON.stringify({type:'workspace', index}));
 }, true);
})();
