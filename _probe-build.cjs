// TEMP diagnostic harness (deleted after the investigation).
//
// The site's layout comes from four CDN stylesheets plus local style.css. This
// machine cannot open TLS connections from a program, so the CDN CSS is
// vendored under _diag/vendor/ (through the harness fetch tool) and linked
// locally here. External references are stripped so the load event fires and
// the geometry report lands in the DOM for `chrome --dump-dom`.
//
// Named .cjs on purpose: tests glob root *.js as "page scripts that must be
// pre-cached", and this file is not part of the app.
const fs = require('fs');
const path = require('path');
const root = __dirname;
const vendorDir = path.join(root, '_diag', 'vendor');

const VENDOR_CSS = [
  'bootstrap.min.css',
  'bootstrap-utilities.min.css',
  'font-awesome.min.css',
  'select2.min.css',
  'select2-bootstrap5-rtl.min.css'
];

const backendStub = `
<script>
(function () {
  var chain = new Proxy(function () {}, {
    get: function (t, p) { if (p === 'then') return undefined; return chain; },
    apply: function () { return chain; }
  });
  window.google = { script: { run: chain, host: { close: function () {} } } };
})();
</script>
`;

const REPORTER = `
<script>
function dshRect(el) {
  var r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
}
function dshSel(s) { var el = document.querySelector(s); return el ? dshRect(el) : null; }
function dshVis(el) {
  if (!el || !el.getBoundingClientRect) return false;
  var cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  var r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function dshName(el) {
  var cls = (typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
}
function dshReport() {
  var vw = window.innerWidth, vh = window.innerHeight;
  var out = {
    vw: vw, vh: vh,
    docW: document.documentElement.scrollWidth,
    docH: document.documentElement.scrollHeight,
    hOverflow: document.documentElement.scrollWidth - vw
  };
  out.key = {
    navbar: dshSel('.navbar'), brand: dshSel('.navbar-brand'), toggler: dshSel('.navbar-toggler'),
    mainNav: dshSel('#mainNav'), navList: dshSel('.navbar-nav'), navControls: dshSel('#mainNav > .d-flex'),
    hero: dshSel('.page-hero-inner'), main: dshSel('.main-container'),
    card: dshSel('.main-container .card'), loginForm: dshSel('.login-form'), loginCard: dshSel('.login-container')
  };

  // (1) anything pushed outside the viewport horizontally
  var off = [];
  document.querySelectorAll('body *').forEach(function (el) {
    if (!dshVis(el)) return;
    if (getComputedStyle(el).position === 'fixed') return;
    var r = el.getBoundingClientRect();
    var over = Math.round(r.right - vw), under = Math.round(-r.left);
    if (over > 1 || under > 1) off.push({ t: dshName(el), over: over, under: under, w: Math.round(r.width) });
  });
  out.overflow = off.slice(0, 30);
  out.overflowCount = off.length;

  // (2) horizontally overflowing text boxes (content wider than its box)
  var clip = [];
  document.querySelectorAll('body *').forEach(function (el) {
    if (!dshVis(el)) return;
    if (el.scrollWidth - el.clientWidth <= 2) return;
    var cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll') return;
    if (cs.overflowX === 'hidden' || cs.overflow === 'hidden') return;
    clip.push({ t: dshName(el), sw: el.scrollWidth, cw: el.clientWidth });
  });
  out.clipped = clip.slice(0, 20);
  out.clippedCount = clip.length;

  // (3) sibling overlap inside the same row (the classic "unformatted" look)
  var overlaps = [];
  function scan(container) {
    var kids = [].slice.call(container.children).filter(dshVis);
    for (var i = 0; i < kids.length; i++) {
      for (var j = i + 1; j < kids.length; j++) {
        var a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) {
          overlaps.push({ parent: dshName(container), a: dshName(kids[i]), b: dshName(kids[j]), ox: Math.round(ox), oy: Math.round(oy) });
        }
      }
    }
  }
  ['.navbar .container-fluid', '#mainNav', '.navbar-nav', '.row', '.card-header', '.d-flex', '.page-hero-inner', '.login-form'].forEach(function (s) {
    document.querySelectorAll(s).forEach(function (c) { if (dshVis(c)) scan(c); });
  });
  out.overlaps = overlaps.slice(0, 20);
  out.overlapCount = overlaps.length;

  // (4) navbar / controls geometry, row by row
  var nb = document.querySelector('.navbar .container-fluid');
  if (nb) {
    out.navChildren = [];
    Array.prototype.forEach.call(nb.children, function (c) {
      if (!dshVis(c)) return;
      var r = c.getBoundingClientRect();
      out.navChildren.push({ t: dshName(c), row: Math.round(r.top), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) });
    });
  }
  var links = [].slice.call(document.querySelectorAll('.navbar-nav .nav-link')).filter(dshVis);
  out.navLinkRows = {};
  links.forEach(function (l) {
    var k = Math.round(l.getBoundingClientRect().top);
    out.navLinkRows[k] = (out.navLinkRows[k] || 0) + 1;
  });
  out.navLinkCount = links.length;
  var controls = document.querySelector('#mainNav > .d-flex');
  if (controls && dshVis(controls)) {
    out.controlRow = { w: Math.round(controls.getBoundingClientRect().width), wrap: getComputedStyle(controls).flexWrap, children: [] };
    [].forEach.call(controls.children, function (c) {
      if (!dshVis(c)) return;
      var r = c.getBoundingClientRect();
      out.controlRow.children.push({ t: dshName(c), row: Math.round(r.top), x: Math.round(r.left), w: Math.round(r.width) });
    });
  }

  out.tables = [].slice.call(document.querySelectorAll('.table-responsive')).filter(dshVis).map(function (t) {
    var r = t.getBoundingClientRect();
    return { w: Math.round(r.width), sw: t.scrollWidth };
  });

  var main = document.querySelector('.main-container');
  if (main && dshVis(main)) {
    var mr = main.getBoundingClientRect();
    out.mainFit = { w: Math.round(mr.width), x: Math.round(mr.left), fill: +(mr.width / vw).toFixed(3) };
  }
  var lf = document.querySelector('.login-form');
  if (lf && dshVis(lf)) {
    var lr = lf.getBoundingClientRect();
    out.loginFit = { w: Math.round(lr.width), h: Math.round(lr.height), top: Math.round(lr.top), bottom: Math.round(lr.bottom), fits: lr.top >= 0 && lr.bottom <= vh, bodyScrollH: document.body.scrollHeight };
  }

  var d = document.getElementById('dsh-diag');
  if (d) d.textContent = 'DSHDIAG_START' + JSON.stringify(out) + 'DSHDIAG_END';
}
window.addEventListener('load', function () { setTimeout(function () { try { dshReport(); } catch (e) {} }, 500); });
setTimeout(function () { try { dshReport(); } catch (e) {} }, 2500);
</script>
`;

const shellScript = (viewId) => `
<script>
document.addEventListener('DOMContentLoaded', function () {
  var sp = document.getElementById('app-splash'); if (sp) sp.remove();
  var lg = document.getElementById('view-login'); if (lg) lg.style.display = 'none';
  var sh = document.getElementById('app-shell'); if (sh) sh.classList.remove('d-none');
  ['view-reports','view-history','view-expenses','view-users','view-salary','view-attendance','view-movement','view-dashboard'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.classList.add('d-none');
  });
  var want = document.getElementById('${viewId}');
  if (want) want.classList.remove('d-none');
  var nav = document.getElementById('mainNav'); if (nav) nav.classList.add('show');
});
</script>
`;

const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function adapt(html, extraCss) {
  let h = html;
  h = h.replace(/<link\b[^>]*href="https?:\/\/[^"]*"[^>]*>/g, '');
  h = h.replace(/<script\b[^>]*src="https?:\/\/[^"]*"[^>]*><\/script>/g, '');

  const available = VENDOR_CSS.filter(f => fs.existsSync(path.join(vendorDir, f)));
  const links = available.map(f => `<link rel="stylesheet" href="_diag/vendor/${f}">`).join('\n');
  h = h.replace('<link rel="stylesheet" href="style.css">', links + '\n<link rel="stylesheet" href="style.css">');
  if (!/href="style.css"/.test(h)) h = h.replace('</head>', links + '</head>');

  if (extraCss) h = h.replace('</head>', '<style id="dsh-extra">' + extraCss + '</style></head>');
  h = h.replace('</head>', backendStub + '</head>');
  h = h.replace('<body>', '<body>\n<div id="dsh-diag" style="display:none"></div>');
  return h;
}

const outDir = path.join(root, '_diag');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function build(name, view, extraCss) {
  let h = adapt(src, extraCss);
  h = h.replace('</body>', (view ? shellScript(view) : '') + REPORTER + '</body>');
  fs.writeFileSync(path.join(root, '_preview-' + name + '.html'), h);
}

build('login', null);
build('reports', 'view-reports');
build('history', 'view-history');
build('dashboard', 'view-dashboard');

console.log('variants built; vendor css: ' + VENDOR_CSS.filter(f => fs.existsSync(path.join(vendorDir, f))).join(', '));
