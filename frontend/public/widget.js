(function () {
  // kds-marketing web-chat embed loader. Usage:
  //   <script src="https://<marketing-host>/widget.js" data-widget-key="wc_..." async></script>
  // It injects a floating launcher button + an iframe to /widget?key=<key>.
  // The iframe isolates the chat app (its own React) from the host page.
  'use strict';
  var current = document.currentScript;
  if (!current) return;
  var key = current.getAttribute('data-widget-key');
  if (!key) {
    console.warn('[kds-widget] missing data-widget-key');
    return;
  }
  var origin = new URL(current.src).origin;
  var accent = current.getAttribute('data-accent') || '#1e40af';

  var open = false;
  var iframe = null;

  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Chat');
  btn.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'width:56px', 'height:56px',
    'border-radius:50%', 'border:none', 'cursor:pointer', 'z-index:2147483000',
    'background:' + accent, 'color:#fff', 'font-size:24px',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)',
  ].join(';');
  btn.innerHTML = '💬';

  function makeFrame() {
    var f = document.createElement('iframe');
    f.src = origin + '/widget?key=' + encodeURIComponent(key);
    f.title = 'Chat';
    f.style.cssText = [
      'position:fixed', 'bottom:88px', 'right:20px', 'width:370px', 'height:560px',
      'max-width:calc(100vw - 40px)', 'max-height:calc(100vh - 120px)',
      'border:none', 'border-radius:16px', 'z-index:2147483000',
      'box-shadow:0 8px 30px rgba(0,0,0,.28)', 'background:#fff',
    ].join(';');
    return f;
  }

  function toggle() {
    open = !open;
    if (open) {
      if (!iframe) {
        iframe = makeFrame();
        document.body.appendChild(iframe);
      }
      iframe.style.display = 'block';
      btn.innerHTML = '✕';
    } else if (iframe) {
      iframe.style.display = 'none';
      btn.innerHTML = '💬';
    }
  }

  btn.addEventListener('click', toggle);
  if (document.body) {
    document.body.appendChild(btn);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(btn);
    });
  }
})();
