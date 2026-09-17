// Injected first into the game page by the Harness pane (never into a build). It reports what
// would otherwise be a blank frame — a runtime error, a rejected promise, a module that failed to
// load — to the frame around the game. Outside that frame it does nothing.
(function () {
  var host = null;
  try { host = window.parent !== window && window.parent.__harnessFrame; } catch (e) { host = null; }
  if (typeof host !== 'function') return;
  function tell(type, data) { try { host(type, data || {}); } catch (e) { /* the frame went away */ } }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      tell('load-error', { tag: target.tagName.toLowerCase(), src: target.src || target.href || '' });
      return;
    }
    var error = event.error;
    tell('runtime-error', {
      message: (error && error.name && error.message) ? error.name + ': ' + error.message : String(event.message || 'Error'),
      file: event.filename || '', line: event.lineno || 0, column: event.colno || 0,
      stack: error && error.stack ? String(error.stack) : ''
    });
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    tell('runtime-error', {
      message: reason && reason.message ? (reason.name ? reason.name + ': ' : '') + reason.message : 'Unhandled rejection: ' + String(reason),
      file: '', line: 0, column: 0, stack: reason && reason.stack ? String(reason.stack) : '', promise: true
    });
  });
  window.addEventListener('pagehide', function () { tell('unload'); });
  tell('page');
})();
