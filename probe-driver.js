(function () {
  var log = [];
  var box = document.createElement('div');
  box.id = 'probe';
  box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9999;background:#000;color:#0f0;font:12px monospace;white-space:pre';
  document.body.appendChild(box);
  function say(s) { log.push(s); box.textContent = log.join('\n'); }
  window.onerror = function (m, u, l) { say('ONERROR ' + m + ' @' + l); };

  function wait(test, ms) {
    return new Promise(function (res, rej) {
      var tries = 0;
      (function tick() {
        var v;
        try { v = test(); } catch (e) { return rej(e); }
        if (v) return res(v);
        if (++tries > (ms || 200)) return rej(new Error('timeout'));
        setTimeout(tick, 50);
      })();
    });
  }

  function photoBlob(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1d7a4f'); g.addColorStop(1, '#7a1d5f');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineWidth = 4;
    for (var i = 0; i <= w; i += 80) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
    for (var j = 0; j <= h; j += 80) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); }
    return new Promise(function (res) { c.toBlob(res, 'image/png'); });
  }

  function hrefOf(im) {
    return im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || im.getAttribute('href') || '';
  }

  // For each stage figure: the id and href-length of every <image> that is not
  // in <defs>, plus a short fingerprint of the data URL.
  function shots() {
    return Array.prototype.map.call(document.querySelectorAll('#stage figure'), function (fig) {
      var name = fig.querySelector('.canvas-name').textContent;
      var parts = [];
      Array.prototype.forEach.call(fig.querySelectorAll('svg image'), function (im) {
        var h = hrefOf(im);
        var where = im.closest('defs') ? 'defs' : 'canvas';
        if (where === 'defs') return;
        parts.push(im.getAttribute('id') + '[par=' + im.getAttribute('preserveAspectRatio') +
          ',len' + h.length + ',fp' + h.slice(-16) + ']');
      });
      return name + ' :: ' + parts.join(' ');
    });
  }

  var ranges;
  function move(idx, val) {
    var s = ranges[idx];
    s.value = String(val);
    s.dispatchEvent(new Event('input'));
    return new Promise(function (r) { setTimeout(r, 400); });
  }

  var changes = 0;
  new MutationObserver(function (recs) { changes += recs.length; })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['href', 'xlink:href'] });

  var savedInput = null;
  wait(function () { return document.querySelectorAll('#stage figure svg').length >= 2; })
    .then(function () {
      say('figures: ' + document.querySelectorAll('#stage figure').length +
        '  files: ' + document.querySelectorAll('#fields input[type=file]').length +
        '  ranges: ' + document.querySelectorAll('#fields input[type=range]').length);
      return photoBlob(1600, 900);
    })
    .then(function (blob) {
      var input = savedInput = document.querySelector('#fields input[type=file]');
      var dt = new DataTransfer();
      dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      return wait(function () {
        return document.querySelectorAll('#fields input[type=range]')[0].disabled === false;
      });
    })
    .then(function () { return new Promise(function (r) { setTimeout(r, 600); }); })
    .then(function () {
      say('photo-name: ' + document.querySelector('.photo-name').textContent);
      say('slider readouts: ' + Array.prototype.map.call(document.querySelectorAll('.slider-readout'), function (n) { return n.textContent; }).join(' | '));
    })
    .then(function () {
      var base = shots();
      say('AFTER UPLOAD');
      base.forEach(function (l) { say('  ' + l); });
      ranges = document.querySelectorAll('#fields input[type=range]');
      return move(0, 100).then(function () {
        var a = shots();
        say('AFTER X=+100');
        a.forEach(function (l, i) { say('  changed=' + (l !== base[i]) + '  ' + l); });
        return move(0, 0);
      }).then(function () {
        return move(1, 100);
      }).then(function () {
        var b = shots();
        say('AFTER Y=+100');
        b.forEach(function (l, i) { say('  changed=' + (l !== base[i]) + '  ' + l); });
      });
    })
    .then(function () {
      say('href mutations seen: ' + changes);
      (window.__probe || []).forEach(function (l) { say('  · ' + l); });
      say('file input still connected: ' + savedInput.isConnected);
      say('stage svgs: ' + document.querySelectorAll('#stage svg').length);
      say('DONE');
    })
    .catch(function (e) { say('ERROR ' + (e && e.stack || e)); });
})();
