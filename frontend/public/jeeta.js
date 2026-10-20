/* Jeeta site snippet - docs/marketing/site-snippet.md */
(function (w, d) {
  'use strict';
  var s = d.currentScript, key = s && s.getAttribute('data-site-key');
  if (!key || !/^jst_[0-9a-f]{32}$/.test(key)) return;
  var api = (s.getAttribute('data-api') || s.src.replace(/^(https?:\/\/[^\/]+).*$/, '$1')).replace(/\/+$/, '');
  var ok = s.getAttribute('data-consent') != 'denied', L = w.location, E = encodeURIComponent;
  var U = ['Source', 'Medium', 'Campaign', 'Content', 'Term'], K = ['fbclid', 'gclid', 'ttclid'];
  var src = { s: '', m: '', c: '' }, last, i, c;

  function q(n) {
    var m = L.search.match(new RegExp('[?&]' + n + '=([^&#]*)'));
    try { return m && decodeURIComponent(m[1].replace(/\+/g, ' ')) || null; } catch (e) { return m[1] || null; }
  }
  function host(u) {
    var m = /^https?:\/\/([^\/?#:]+)/i.exec(u || '');
    return m ? m[1].toLowerCase() : '';
  }
  function read() {
    var m = d.cookie.match(/(?:^|; )_jeeta_attr=([^;]*)/);
    try { return m && JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; }
  }
  function write(a) {
    var v, k, b;
    // <= 1200 bytes: halve the longest text until it fits
    while ((v = E(JSON.stringify(a))).length > 1200) {
      b = 0;
      for (k in a) if (typeof a[k] == 'string' && (!b || a[k].length > a[b].length)) b = k;
      if (!b) return;
      a[b] = a[b].slice(0, a[b].length >> 1);
    }
    d.cookie = '_jeeta_attr=' + v + '; Max-Age=7776000; Path=/; SameSite=Lax' + (L.protocol == 'https:' ? '; Secure' : '');
  }

  // last meaningful touch: UTM / click id, or another site sent us
  var ref = d.referrer, rh = host(ref), ext = !!rh && rh != L.hostname.toLowerCase();
  var a = { v: 1 }, sig = false;
  for (i = 0; i < 5; i++) sig = !!(a['utm' + U[i]] = q('utm_' + U[i].toLowerCase())) || sig;
  for (i = 0; i < 3; i++) sig = !!(a[K[i]] = q(K[i])) || sig;
  a.landingUrl = L.href;
  a.referrer = ref || null;
  a.ts = +new Date();

  if (a.utmSource) src = { s: a.utmSource, m: a.utmMedium || '', c: a.utmCampaign || '' };
  else if (ext) src = { s: rh, m: 'referral', c: '' };
  else if (rh && ok && (c = read())) src = { s: c.utmSource || host(c.referrer), m: c.utmMedium || (c.referrer ? 'referral' : ''), c: c.utmCampaign || '' };
  if (ok && (sig || ext)) write(a);

  function pv() {
    var p = L.pathname;
    if (p == last) return;
    last = p;
    new w.Image().src = api + '/api/public/s/' + key + '/pv.gif?p=' + E(p) + '&s=' + E(src.s) +
      '&m=' + E(src.m) + '&c=' + E(src.c) + '&r=' + E(rh) + '&_=' + +new Date();
  }
  w.jeeta = { pv: pv };
  pv();

  // client-side navigation: each new path counts once
  var h = w.history, push = h && h.pushState;
  if (push && !push.__jeeta) {
    h.pushState = function () {
      var r = push.apply(this, arguments);
      w.jeeta && w.jeeta.pv();
      return r;
    };
    h.pushState.__jeeta = 1;
    w.addEventListener('popstate', function () { w.jeeta && w.jeeta.pv(); });
  }
})(window, document);
