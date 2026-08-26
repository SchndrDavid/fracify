/* Fracify — fills FRAC's Affinity templates in the browser and exports a PNG.
 *
 * Nothing here regenerates artwork. A template is parsed once, kept pristine,
 * and a clone of it is mounted as the live preview; only the pieces a slot
 * owns are ever swapped out. A slot whose text has not been edited keeps its
 * original nodes untouched, kerning tspans and all, so an untouched export is
 * pixel-identical to the template.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var SERIF_NS = 'http://www.serif.com/';

  // tools/fidelity-test.html runs this file from a subdirectory.
  var TEMPLATE_DIR = window.FRACIFY_TEMPLATE_DIR || 'templates/';
  var MANIFEST_URL = TEMPLATE_DIR + 'manifest.json';
  var SLOT_PREFIX = 'slot:';
  var STORAGE_PREFIX = 'fracify.v1.';

  var FONT_STEP = 2;          // shrink the font in 2 px steps, as designed
  var MIN_FONT_RATIO = 0.6;   // never go below 60 % of the template's size
  var DEFAULT_LINE_RATIO = 1.15;
  var SOURCE_MAX_SIDE = 2200; // uploads are downscaled to this before cropping
  var PERSIST_MAX_SIDE = 1400;
  var JPEG_QUALITY = 0.92;

  /* ---------------------------------------------------------------- helpers */

  function $(sel) { return document.querySelector(sel); }

  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toArray(collection) {
    return Array.prototype.slice.call(collection);
  }

  function len(value, fallback) {
    var n = parseFloat(value);
    return isNaN(n) ? (fallback || 0) : n;
  }

  function styleValue(style, prop) {
    var m = new RegExp(prop + '\\s*:\\s*([^;]+)').exec(style || '');
    return m ? m[1].trim() : '';
  }

  function withFontSize(style, size) {
    if (/font-size\s*:/.test(style)) {
      return style.replace(/font-size\s*:\s*[^;]+/, 'font-size:' + size + 'px');
    }
    return style + (style && !/;\s*$/.test(style) ? ';' : '') + 'font-size:' + size + 'px';
  }

  function withAnchor(style, anchor) {
    var cleaned = (style || '').replace(/text-anchor\s*:\s*[^;]+;?/, '');
    if (cleaned && !/;\s*$/.test(cleaned)) cleaned += ';';
    return cleaned + 'text-anchor:' + anchor + ';';
  }

  function round(n) { return Math.round(n * 1000) / 1000; }

  function fetchText(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.text();
    });
  }

  function loadImageElement(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image failed to load')); };
      img.src = src;
    });
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes());
  }

  /* ------------------------------------------------------- template loading */

  /* Affinity writes `font-family:'ArialMT', 'Arial', sans-serif`. Arial cannot
   * be shipped, so every Arial run is redirected to Liberation Sans, which has
   * the same metrics. Doing it here means the preview and the export agree, and
   * that the result no longer depends on what the viewer has installed. */
  function substituteFonts(root) {
    var all = root.getElementsByTagName('*');
    var frenchScript = false;
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      var style = node.getAttribute('style');
      if (style && /Arial/i.test(style)) {
        node.setAttribute('style', style.replace(
          /font-family\s*:\s*[^;]+/i,
          "font-family:'Liberation Sans', Arial, sans-serif"
        ));
        style = node.getAttribute('style');
      }
      var attr = node.getAttribute('font-family');
      if (attr && /Arial/i.test(attr)) {
        node.setAttribute('font-family', "'Liberation Sans', Arial, sans-serif");
      }
      if ((style && /FrenchScript/i.test(style)) || (attr && /FrenchScript/i.test(attr))) {
        frenchScript = true;
      }
    }
    return { frenchScript: frenchScript };
  }

  /* Safari renders width="100%" height="100%" SVGs blank or badly scaled once
   * they are loaded into an <img>, so pin the root to the viewBox size. */
  function pinRootSize(root) {
    var vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean);
    var width = vb.length === 4 ? parseFloat(vb[2]) : len(root.getAttribute('width'), 1080);
    var height = vb.length === 4 ? parseFloat(vb[3]) : len(root.getAttribute('height'), 1080);
    root.setAttribute('width', width);
    root.setAttribute('height', height);
    return { width: width, height: height };
  }

  function slotName(node) {
    var name = node.getAttributeNS(SERIF_NS, 'id') || node.getAttribute('serif:id') || node.getAttribute('id') || '';
    return name.indexOf(SLOT_PREFIX) === 0 ? name.slice(SLOT_PREFIX.length) : null;
  }

  /* `slot:theme|lines=2|width=700|align=left` — everything after the name is
   * optional, so a layer can simply be called `slot:theme`. */
  function parseSlotName(name) {
    var parts = name.split('|');
    var spec = { id: parts[0].trim(), label: null };
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var key = kv[0].trim().toLowerCase();
      var value = (kv[1] || '').trim();
      if (key === 'lines') spec.maxLines = parseInt(value, 10);
      else if (key === 'width') spec.maxWidth = parseFloat(value);
      else if (key === 'align') spec.align = value;
      else if (key === 'label') spec.label = value;
    }
    return spec;
  }

  function humanLabel(id) {
    return id.replace(/[-_]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function discoverSlots(root, texts, images) {
    var found = [];
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      var name = slotName(node);
      if (!name) continue;
      var spec = parseSlotName(name);
      if (node.localName === 'image') {
        var imageIndex = images.indexOf(node);
        if (imageIndex >= 0) found.push({ def: spec, imageIndex: imageIndex });
        continue;
      }
      var owned = node.localName === 'text' ? [node] : toArray(node.getElementsByTagName('text'));
      var indices = owned.map(function (t) { return texts.indexOf(t); }).filter(function (n) { return n >= 0; });
      if (indices.length) found.push({ def: spec, textIndices: indices });
    }
    return found;
  }

  function slotsFromManifest(defs, texts, images, problems) {
    var found = [];
    defs.forEach(function (def) {
      if (def.image) {
        var image = null;
        for (var i = 0; i < images.length; i++) {
          if (images[i].getAttribute('id') === def.image) { image = i; break; }
        }
        if (image === null) {
          problems.push('image ' + def.image + ' (slot "' + def.id + '") is not in this file');
          return;
        }
        found.push({ def: def, imageIndex: image });
        return;
      }
      var indices = def.texts || [];
      var missing = indices.filter(function (n) { return !texts[n]; });
      if (missing.length) {
        problems.push('slot "' + def.id + '" points at <text> ' + missing.join(', ') + ', which this file does not have');
        return;
      }
      found.push({ def: def, textIndices: indices });
    });
    return found;
  }

  function buildTextSlot(raw, texts) {
    var def = raw.def;
    var els = raw.textIndices.map(function (i) { return texts[i]; });
    var order = raw.textIndices.slice();

    // Document order is Affinity's layer order, which is not always top to
    // bottom. Lines are laid out downwards, so sort by baseline.
    var pairs = order.map(function (index, i) { return { index: index, el: els[i] }; });
    pairs.sort(function (a, b) { return len(a.el.getAttribute('y')) - len(b.el.getAttribute('y')); });

    var sorted = pairs.map(function (p) { return p.el; });
    var first = sorted[0];
    var style = first.getAttribute('style') || '';
    var fontSize = len(styleValue(style, 'font-size'), 16);
    var lineGap = sorted.length > 1
      ? len(sorted[1].getAttribute('y')) - len(first.getAttribute('y'))
      : fontSize * DEFAULT_LINE_RATIO;

    var original = sorted.map(function (el) { return el.textContent; }).join('\n');
    var maxWidth = def.maxWidth;

    return {
      kind: 'text',
      id: def.id,
      label: def.label || humanLabel(def.id),
      hint: def.hint || '',
      textIndices: pairs.map(function (p) { return p.index; }),
      originals: sorted.map(function (el) { return el.cloneNode(true); }),
      style: style,
      fontSize: fontSize,
      lineGap: lineGap,
      x: len(first.getAttribute('x')),
      y: len(first.getAttribute('y')),
      align: def.align || 'auto',
      maxLines: def.maxLines || sorted.length,
      maxWidth: maxWidth || null,
      original: original
    };
  }

  function buildImageSlot(raw, images) {
    var def = raw.def;
    var image = images[raw.imageIndex];
    return {
      kind: 'image',
      id: def.id,
      label: def.label || humanLabel(def.id),
      hint: def.hint || '',
      imageIndex: raw.imageIndex,
      width: Math.round(len(image.getAttribute('width'), 1080)),
      height: Math.round(len(image.getAttribute('height'), 1080)),
      offset: 0,
      source: null,
      persistUrl: null,
      fileName: ''
    };
  }

  function loadTemplate(entry) {
    return fetchText(TEMPLATE_DIR + entry.file).then(function (text) {
      var parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (parsed.getElementsByTagName('parsererror').length) {
        throw new Error(entry.file + ' is not valid SVG');
      }
      var root = parsed.documentElement;
      var size = pinRootSize(root);
      var fonts = substituteFonts(root);
      if (fonts.frenchScript) {
        console.warn('[fracify] ' + entry.file + ' still has live French Script MT text. ' +
          'That font is proprietary and is not shipped, so the browser will substitute ' +
          'something else. Convert the "Frac" logo to curves in Affinity.');
      }

      var texts = toArray(root.getElementsByTagName('text'));
      var images = toArray(root.getElementsByTagName('image'));
      var problems = [];

      var raw = discoverSlots(root, texts, images);
      var source = 'slot: layer names';
      if (!raw.length && entry.slots && entry.slots.length) {
        raw = slotsFromManifest(entry.slots, texts, images, problems);
        source = 'templates/manifest.json';
      }

      var slots = raw.map(function (item) {
        return item.kind === 'image' || item.imageIndex != null
          ? buildImageSlot(item, images)
          : buildTextSlot(item, texts);
      });

      return {
        entry: entry,
        root: root,
        width: size.width,
        height: size.height,
        slots: slots,
        source: source,
        problems: problems,
        values: {},
        live: null
      };
    });
  }

  /* --------------------------------------------------------------- mounting */

  function mount(template, container) {
    var live = template.root.cloneNode(true);
    clear(container);
    container.appendChild(live);
    template.live = live;

    var texts = toArray(live.getElementsByTagName('text'));
    var images = toArray(live.getElementsByTagName('image'));

    template.slots.forEach(function (slot) {
      if (slot.kind === 'image') {
        slot.liveImage = images[slot.imageIndex];
        return;
      }
      var nodes = slot.textIndices.map(function (i) { return texts[i]; });
      var holder = document.createElementNS(SVG_NS, 'g');
      holder.setAttribute('data-slot', slot.id);
      nodes[0].parentNode.insertBefore(holder, nodes[0]);
      nodes.forEach(function (node) { node.parentNode.removeChild(node); });
      slot.holder = holder;
      resolveGeometry(slot);
    });
  }

  /* A ruler lives inside the slot's own group, so it inherits exactly the
   * transforms and the xml:space of the text it stands in for, and
   * getComputedTextLength() comes back in the coordinates maxWidth is in. */
  function withRuler(slot, style, fn) {
    var ruler = document.createElementNS(SVG_NS, 'text');
    ruler.setAttribute('style', style + ';visibility:hidden;');
    slot.holder.appendChild(ruler);
    try {
      return fn(function (text) {
        ruler.textContent = text;
        return ruler.getComputedTextLength();
      }, ruler);
    } finally {
      slot.holder.removeChild(ruler);
    }
  }

  /* Fills in whatever the manifest left out: how wide the block may be, and
   * whether Affinity centred it. Both are read off the template itself, so a
   * new template usually needs nothing but a name. */
  function resolveGeometry(slot) {
    var widths = [];
    var centres = [];
    var lefts = [];
    withRuler(slot, slot.style, function (measure, ruler) {
      slot.originals.forEach(function (el) {
        ruler.setAttribute('style', (el.getAttribute('style') || slot.style) + ';visibility:hidden;');
        var w = measure(el.textContent);
        var x = len(el.getAttribute('x'));
        widths.push(w);
        lefts.push(x);
        centres.push(x + w / 2);
      });
    });

    slot.originalWidths = widths;
    if (!slot.maxWidth) {
      slot.maxWidth = Math.ceil(Math.max.apply(null, widths) * 1.02);
    }

    if (slot.align === 'auto') {
      if (widths.length > 1) {
        var spreadC = Math.max.apply(null, centres) - Math.min.apply(null, centres);
        var spreadL = Math.max.apply(null, lefts) - Math.min.apply(null, lefts);
        slot.align = spreadC < spreadL ? 'center' : 'left';
      } else {
        slot.align = 'center';
      }
    }
    slot.centre = centres.reduce(function (a, b) { return a + b; }, 0) / centres.length;
  }

  /* ---------------------------------------------------------- text layout */

  function wrapParagraphs(value, measure, maxWidth) {
    var lines = [];
    value.split('\n').forEach(function (paragraph) {
      var words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push({ text: '', width: 0 }); return; }
      var current = '';
      words.forEach(function (word) {
        var candidate = current ? current + ' ' + word : word;
        if (current && measure(candidate) > maxWidth) {
          lines.push({ text: current, width: measure(current) });
          current = word;
        } else {
          current = candidate;
        }
      });
      lines.push({ text: current, width: measure(current) });
    });
    return lines;
  }

  function layout(slot, value) {
    var minSize = Math.max(12, Math.round(slot.fontSize * MIN_FONT_RATIO));
    var size = slot.fontSize;
    var result = null;

    while (true) {
      var style = withFontSize(slot.style, size);
      var lines = withRuler(slot, style, function (measure) {
        return wrapParagraphs(value, measure, slot.maxWidth);
      });
      var tooTall = lines.length > slot.maxLines;
      var tooWide = lines.some(function (line) { return line.width > slot.maxWidth + 0.5; });
      result = {
        lines: lines,
        size: size,
        lineGap: slot.lineGap * (size / slot.fontSize),
        shrunk: size < slot.fontSize,
        overflow: tooTall || tooWide
      };
      if (!result.overflow || size <= minSize) return capLines(slot, result);
      size -= FONT_STEP;
      if (size < minSize) size = minSize;
    }
  }

  /* Text that will not fit even at the smallest size has to go somewhere. One
   * line that runs too wide is a smaller sin than a block that grows downwards
   * through whatever the designer put underneath it, so the surplus is folded
   * back into the last line the slot is allowed to have. */
  function capLines(slot, result) {
    if (result.lines.length <= slot.maxLines) return result;
    var kept = result.lines.slice(0, Math.max(0, slot.maxLines - 1));
    var rest = result.lines.slice(Math.max(0, slot.maxLines - 1))
      .map(function (line) { return line.text; }).join(' ');
    kept.push({ text: rest, width: Infinity });
    result.lines = kept;
    result.overflow = true;
    return result;
  }

  /* Rebuilds a block of <text> from scratch: same style, same start point,
   * same parent transform, but none of the tspans Affinity uses to pin
   * individual glyphs — those hold absolute positions and would scatter the
   * letters the moment the string changes. */
  function renderTextSlot(slot, value) {
    clear(slot.holder);

    if (value === slot.original) {
      slot.originals.forEach(function (node) { slot.holder.appendChild(node.cloneNode(true)); });
      return { shrunk: false, overflow: false, size: slot.fontSize, lines: slot.originals.length };
    }

    if (!value.trim()) {
      return { shrunk: false, overflow: false, size: slot.fontSize, lines: 0 };
    }

    var result = layout(slot, value);
    var centred = slot.align === 'center';
    var style = withFontSize(slot.style, result.size);
    if (centred) style = withAnchor(style, 'middle');

    result.lines.forEach(function (line, i) {
      var node = document.createElementNS(SVG_NS, 'text');
      node.setAttribute('style', style);
      node.setAttribute('x', round(centred ? slot.centre : slot.x));
      node.setAttribute('y', round(slot.y + i * result.lineGap));
      node.textContent = line.text;
      slot.holder.appendChild(node);
    });

    return { shrunk: result.shrunk, overflow: result.overflow, size: result.size, lines: result.lines.length };
  }

  /* --------------------------------------------------------------- photos */

  function scaleToFit(width, height, maxSide) {
    var factor = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
  }

  function drawTo(source, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  /* Centre-crop and fill, never letterbox: the aspect ratio of an upload
   * practically never matches the slot, and empty margins always look wrong.
   * The slider shifts the crop up or down, which portraits usually need. */
  function cropToSlot(slot) {
    var source = slot.source;
    var scale = Math.max(slot.width / source.width, slot.height / source.height);
    var drawWidth = source.width * scale;
    var drawHeight = source.height * scale;
    var slack = drawHeight - slot.height;
    var offsetY = -slack / 2 + (slot.offset / 100) * (slack / 2);

    var canvas = document.createElement('canvas');
    canvas.width = slot.width;
    canvas.height = slot.height;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, (slot.width - drawWidth) / 2, Math.min(0, Math.max(-slack, offsetY)), drawWidth, drawHeight);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  function applyPhoto(slot) {
    if (!slot.source || !slot.liveImage) return;
    var url = cropToSlot(slot);
    slot.liveImage.setAttributeNS(XLINK_NS, 'xlink:href', url);
    slot.liveImage.removeAttribute('href');
    slot.liveImage.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    return url;
  }

  function adoptImage(slot, image) {
    var fitted = scaleToFit(image.naturalWidth || image.width, image.naturalHeight || image.height, SOURCE_MAX_SIDE);
    slot.source = drawTo(image, fitted.width, fitted.height);
    var persist = scaleToFit(slot.source.width, slot.source.height, PERSIST_MAX_SIDE);
    slot.persistUrl = drawTo(slot.source, persist.width, persist.height).toDataURL('image/jpeg', 0.75);
  }

  /* --------------------------------------------------------------- export */

  var warnedAboutFonts = false;

  function fontFaceCSS() {
    var faces = window.FRACIFY_FONTS || [];
    if (!faces.length && !warnedAboutFonts) {
      warnedAboutFonts = true;
      console.warn('[fracify] fonts/embedded-fonts.js did not load, so the export ' +
        'carries no fonts and will fall back to system faces.');
    }
    return faces.map(function (face) {
      return "@font-face{font-family:'" + face.family + "';font-style:normal;font-weight:" +
        face.weight + ';font-display:block;src:url(' + face.src + ") format('woff2');}";
    }).join('\n');
  }

  /* An SVG loaded into an <img> is its own isolated document: the page's
   * @font-face rules do not reach it, and Metropolis would silently fall back
   * to a system face. So the faces travel with the file. */
  function buildExportSVG(template) {
    var clone = template.live.cloneNode(true);
    clone.setAttribute('width', template.width);
    clone.setAttribute('height', template.height);

    var defs = null;
    for (var i = 0; i < clone.childNodes.length; i++) {
      if (clone.childNodes[i].localName === 'defs') { defs = clone.childNodes[i]; break; }
    }
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      clone.insertBefore(defs, clone.firstChild);
    }
    var style = document.createElementNS(SVG_NS, 'style');
    style.setAttribute('type', 'text/css');
    style.textContent = fontFaceCSS();
    defs.insertBefore(style, defs.firstChild);

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  function renderPNG(template) {
    var svg = buildExportSVG(template);
    return blobToDataURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      .then(loadImageElement)
      .then(function (img) {
        var canvas = document.createElement('canvas');
        canvas.width = template.width;
        canvas.height = template.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, template.width, template.height);
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            blob ? resolve(blob) : reject(new Error('canvas.toBlob() returned nothing'));
          }, 'image/png');
        });
      });
  }

  /* -------------------------------------------------------------- storage */

  function storageKey(id) { return STORAGE_PREFIX + id; }

  function saveState(template) {
    var data = { values: {}, photos: {} };
    template.slots.forEach(function (slot) {
      if (slot.kind === 'text') {
        data.values[slot.id] = template.values[slot.id];
      } else if (slot.persistUrl) {
        data.photos[slot.id] = { src: slot.persistUrl, offset: slot.offset, name: slot.fileName };
      }
    });
    var key = storageKey(template.entry.id);
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (err) {
      // Photos are what blows the quota. Drop the other templates' photos
      // first, and this template's own photos only if that was not enough.
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var other = localStorage.key(i);
        if (other && other.indexOf(STORAGE_PREFIX) === 0 && other !== key) localStorage.removeItem(other);
      }
      try {
        localStorage.setItem(key, JSON.stringify(data));
        return true;
      } catch (err2) {
        data.photos = {};
        try { localStorage.setItem(key, JSON.stringify(data)); } catch (err3) { /* give up quietly */ }
        return false;
      }
    }
  }

  function readState(id) {
    try {
      var raw = localStorage.getItem(storageKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function forgetState(id) {
    try { localStorage.removeItem(storageKey(id)); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------- UI */

  var ui = {
    picker: $('#picker'),
    pickerGroups: $('#picker-groups'),
    pickerStatus: $('#picker-status'),
    editor: $('#editor'),
    editorTitle: $('#editor-title'),
    editorKind: $('#editor-kind'),
    fields: $('#fields'),
    stage: $('#stage'),
    notice: $('#notice'),
    exportStatus: $('#export-status'),
    back: $('#btn-back'),
    reset: $('#btn-reset'),
    png: $('#btn-png'),
    svg: $('#btn-svg')
  };

  var state = { manifest: null, template: null, saveTimer: 0 };

  function notice(html) {
    ui.notice.innerHTML = html;
    ui.notice.classList.remove('is-hidden');
  }

  var FOLDER_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.1c.5 0 .97.25 1.25.66l.8 1.18c.28.41.75.66 1.25.66h6.65A1.5 1.5 0 0 1 20 9v8.5a1.5 ' +
    '1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linejoin="round"/></svg>';

  // 1:1 and 9:16 are the two shapes the club posts; anything else is spelled
  // out from the thumbnail rather than guessed at.
  function ratioLabel(width, height) {
    if (!width || !height) return '';
    var ratio = width / height;
    if (Math.abs(ratio - 1) < 0.02) return '1:1';
    if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16';
    return ratio.toFixed(2).replace(/0+$/, '') + ':1';
  }

  function buildCard(entry) {
    var card = make('button', 'card');
    card.type = 'button';

    var thumb = make('div', 'card-thumb');
    var fallback = make('div', 'card-thumb-fallback', entry.name.slice(0, 1).toUpperCase());
    thumb.appendChild(fallback);

    var body = make('div', 'card-body');
    var meta = make('div', 'card-meta', '');
    body.appendChild(make('div', 'card-name', entry.name));
    body.appendChild(meta);

    var shot = new Image();
    shot.alt = '';
    shot.loading = 'lazy';
    shot.onload = function () {
      thumb.replaceChild(shot, fallback);
      meta.textContent = ratioLabel(shot.naturalWidth, shot.naturalHeight);
    };
    shot.src = TEMPLATE_DIR + 'thumbs/' + entry.id + '.jpg';

    card.appendChild(thumb);
    card.appendChild(body);
    card.onclick = function () { openTemplate(entry, card); };
    entry._card = card;
    entry._body = body;
    return card;
  }

  function buildGroup(name, members) {
    var section = make('section', 'group');
    var title = make('h2', 'group-title');
    title.innerHTML = FOLDER_ICON;
    title.appendChild(make('span', null, name));
    title.appendChild(make('span', 'group-count', String(members.length)));
    var grid = make('div', 'picker-grid');
    members.forEach(function (entry) { grid.appendChild(buildCard(entry)); });
    section.appendChild(title);
    section.appendChild(grid);
    return section;
  }

  function buildPicker(manifest) {
    var entries = manifest.templates || [];
    var groups = manifest.groups || [];
    clear(ui.pickerGroups);

    var grouped = {};
    groups.forEach(function (group) {
      var members = entries.filter(function (entry) { return entry.group === group.id; });
      members.forEach(function (entry) { grouped[entry.id] = true; });
      if (members.length) ui.pickerGroups.appendChild(buildGroup(group.name, members));
    });

    // A template that names no group, or one the manifest never declares, still
    // has to turn up somewhere.
    var loose = entries.filter(function (entry) { return !grouped[entry.id]; });
    if (loose.length) ui.pickerGroups.appendChild(buildGroup('Other', loose));
  }

  function markUnsupported(entry, reason) {
    entry._card.classList.add('is-unsupported');
    entry._card.onclick = null;
    if (!entry._body.querySelector('.card-warn')) {
      entry._body.appendChild(make('div', 'card-warn', reason));
    }
  }

  function openTemplate(entry, card) {
    ui.pickerStatus.textContent = 'Loading ' + entry.name + '…';
    loadTemplate(entry).then(function (template) {
      if (!template.slots.length) {
        markUnsupported(entry, template.problems.length
          ? 'Unsupported: ' + template.problems.join('; ') + '.'
          : 'Unsupported: no slot: layer names in the file and no slots for it in templates/manifest.json.');
        ui.pickerStatus.textContent = '';
        return;
      }
      if (template.problems.length) {
        notice('<strong>' + entry.name + ':</strong> ' + template.problems.join('; ') +
          '. Those fields are missing from the form; the rest works.');
      }
      state.template = template;
      restore(template);
      showEditor(template);
      ui.pickerStatus.textContent = '';
      if (location.hash.slice(1) !== entry.id) location.hash = entry.id;
    }).catch(function (err) {
      ui.pickerStatus.textContent = '';
      markUnsupported(entry, 'Could not load: ' + err.message);
      console.error(err);
    });
    if (card) card.blur();
  }

  function restore(template) {
    var saved = readState(template.entry.id) || { values: {}, photos: {} };
    template.slots.forEach(function (slot) {
      if (slot.kind === 'text') {
        var value = saved.values && typeof saved.values[slot.id] === 'string'
          ? saved.values[slot.id]
          : slot.original;
        template.values[slot.id] = value;
      } else {
        var photo = saved.photos && saved.photos[slot.id];
        slot.pendingPhoto = photo || null;
        slot.offset = photo ? (photo.offset || 0) : 0;
        slot.fileName = photo ? (photo.name || 'saved photo') : '';
      }
    });
  }

  function showEditor(template) {
    ui.editorTitle.textContent = template.entry.name;
    ui.editorKind.textContent = template.width + ' × ' + template.height +
      ' · fields from ' + template.source;
    ui.picker.classList.add('is-hidden');
    ui.editor.classList.remove('is-hidden');
    ui.back.classList.remove('is-hidden');
    ui.exportStatus.textContent = '';

    mount(template, ui.stage);
    buildFields(template);

    template.slots.forEach(function (slot) {
      if (slot.kind === 'text') {
        applyText(template, slot);
      } else if (slot.pendingPhoto) {
        loadImageElement(slot.pendingPhoto.src).then(function (img) {
          adoptImage(slot, img);
          slot.persistUrl = slot.pendingPhoto.src;
          applyPhoto(slot);
          updatePhotoUI(slot);
        }).catch(function () { /* a stale photo just does not come back */ });
      }
    });
    window.scrollTo(0, 0);
  }

  function applyText(template, slot) {
    var result = renderTextSlot(slot, template.values[slot.id]);
    if (!slot.ui) return;
    var warn = slot.ui.warn;
    if (result.overflow) {
      warn.className = 'field-warn is-error';
      warn.textContent = 'Still does not fit at ' + Math.round(result.size) + ' px — shorten the text.';
      warn.classList.remove('is-hidden');
    } else if (result.shrunk) {
      warn.className = 'field-warn';
      warn.textContent = 'Shrunk from ' + Math.round(slot.fontSize) + ' px to ' + Math.round(result.size) +
        ' px to fit. That is smaller than the template was designed for.';
      warn.classList.remove('is-hidden');
    } else {
      warn.classList.add('is-hidden');
    }
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      if (!state.template) return;
      if (!saveState(state.template)) {
        notice('Your browser ran out of local storage, so the photos are not being remembered — the texts still are.');
      }
    }, 400);
  }

  function buildFields(template) {
    clear(ui.fields);
    template.slots.forEach(function (slot) {
      var field = make('div', 'field');
      if (slot.kind === 'text') buildTextField(template, slot, field);
      else buildPhotoField(template, slot, field);
      ui.fields.appendChild(field);
    });
  }

  function buildTextField(template, slot, field) {
    var id = 'f-' + slot.id;
    var label = make('label', null, slot.label);
    label.htmlFor = id;
    field.appendChild(label);

    var input;
    if (slot.maxLines > 1) {
      input = document.createElement('textarea');
      input.rows = Math.min(4, slot.maxLines + 1);
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.id = id;
    input.value = template.values[slot.id];
    input.spellcheck = false;
    input.oninput = function () {
      template.values[slot.id] = input.value;
      applyText(template, slot);
      scheduleSave();
    };
    field.appendChild(input);

    if (slot.maxLines > 1) {
      field.appendChild(make('p', 'field-note',
        'Wraps automatically, up to ' + slot.maxLines + ' lines. Press Enter to force a break.'));
    } else if (slot.hint) {
      field.appendChild(make('p', 'field-note', slot.hint));
    }

    var warn = make('p', 'field-warn is-hidden');
    field.appendChild(warn);
    slot.ui = { input: input, warn: warn };
  }

  function buildPhotoField(template, slot, field) {
    field.appendChild(make('div', 'field-label', slot.label));

    var wrap = make('div', 'photo-slot');
    var row = make('div', 'photo-row');
    var preview = make('div', 'photo-preview', 'none');
    var actions = make('div', 'photo-actions');

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.id = 'photo-' + slot.id;
    input.className = 'is-hidden';

    var pick = make('button', 'btn btn-small', 'Choose photo…');
    pick.type = 'button';
    pick.onclick = function () { input.click(); };

    var name = make('div', 'photo-name', slot.fileName || slot.width + ' × ' + slot.height + ' px slot');

    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      loadImageElement(url).then(function (img) {
        URL.revokeObjectURL(url);
        adoptImage(slot, img);
        slot.fileName = file.name;
        applyPhoto(slot);
        updatePhotoUI(slot);
        scheduleSave();
      }).catch(function () {
        URL.revokeObjectURL(url);
        name.textContent = 'That file could not be read as an image.';
      });
    };

    actions.appendChild(pick);
    actions.appendChild(name);
    row.appendChild(preview);
    row.appendChild(actions);
    wrap.appendChild(row);
    wrap.appendChild(input);

    var sliderRow = make('div', 'slider-row');
    sliderRow.appendChild(make('span', null, 'Crop'));
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-100';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(slot.offset);
    slider.disabled = true;
    slider.oninput = function () {
      slot.offset = parseInt(slider.value, 10) || 0;
      applyPhoto(slot);
      updatePhotoUI(slot, true);
      scheduleSave();
    };
    sliderRow.appendChild(slider);
    var readout = make('span', null, 'centre');
    sliderRow.appendChild(readout);
    wrap.appendChild(sliderRow);

    if (slot.hint) wrap.appendChild(make('p', 'field-note', slot.hint));

    field.appendChild(wrap);
    slot.ui = { preview: preview, name: name, slider: slider, readout: readout };
    updatePhotoUI(slot);
  }

  function updatePhotoUI(slot, skipPreview) {
    if (!slot.ui) return;
    slot.ui.slider.disabled = !slot.source;
    slot.ui.slider.value = String(slot.offset);
    slot.ui.readout.textContent = slot.offset === 0 ? 'centre' : (slot.offset > 0 ? 'down' : 'up') +
      ' ' + Math.abs(slot.offset) + '%';
    if (slot.fileName) slot.ui.name.textContent = slot.fileName;
    if (slot.source && !skipPreview) {
      slot.ui.preview.textContent = '';
      slot.ui.preview.style.backgroundImage = 'url("' +
        drawTo(slot.source, 148, Math.round(148 * slot.source.height / slot.source.width)).toDataURL('image/jpeg', 0.7) + '")';
    }
  }

  ui.back.onclick = function () {
    ui.editor.classList.add('is-hidden');
    ui.back.classList.add('is-hidden');
    ui.picker.classList.remove('is-hidden');
    ui.notice.classList.add('is-hidden');
    clear(ui.stage);
    state.template = null;
    if (location.hash) location.hash = '';
  };

  ui.reset.onclick = function () {
    var template = state.template;
    if (!template) return;
    var hasPhoto = template.slots.some(function (slot) { return slot.kind === 'image' && slot.source; });
    if (hasPhoto && !window.confirm('This clears the texts and the photos you uploaded. Continue?')) return;
    forgetState(template.entry.id);
    template.slots.forEach(function (slot) {
      if (slot.kind === 'text') {
        template.values[slot.id] = slot.original;
      } else {
        slot.source = null;
        slot.persistUrl = null;
        slot.offset = 0;
        slot.fileName = '';
        slot.pendingPhoto = null;
      }
    });
    showEditor(template);
  };

  ui.png.onclick = function () {
    var template = state.template;
    if (!template) return;
    ui.png.disabled = true;
    ui.exportStatus.textContent = 'Rendering ' + template.width + ' × ' + template.height + '…';
    renderPNG(template).then(function (blob) {
      saveBlob(blob, 'frac-' + template.entry.id + '-' + stamp() + '.png');
      ui.exportStatus.textContent = 'Exported ' + Math.round(blob.size / 1024) + ' kB.';
    }).catch(function (err) {
      ui.exportStatus.textContent = 'Export failed: ' + err.message;
      console.error(err);
    }).then(function () {
      ui.png.disabled = false;
    });
  };

  ui.svg.onclick = function () {
    var template = state.template;
    if (!template) return;
    var svg = buildExportSVG(template);
    saveBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      'frac-' + template.entry.id + '-' + stamp() + '.svg');
    ui.exportStatus.textContent = 'SVG saved with the fonts embedded.';
  };

  /* ----------------------------------------------------------------- boot */

  function fontsReady() {
    if (!document.fonts) return Promise.resolve();
    var wanted = ['400 48px Metropolis', '700 48px Metropolis', '400 48px "Liberation Sans"'];
    return Promise.all(wanted.map(function (spec) {
      return document.fonts.load(spec).catch(function () { return null; });
    })).then(function () { return document.fonts.ready; });
  }

  function boot() {
    fontsReady()
      .then(function () { return fetchText(MANIFEST_URL); })
      .then(function (text) {
        state.manifest = JSON.parse(text);
        var entries = state.manifest.templates || [];
        buildPicker(state.manifest);
        ui.pickerStatus.textContent = entries.length + ' templates. Nothing you type leaves this browser.';
        // index.html#post opens straight into that template.
        var wanted = decodeURIComponent(location.hash.slice(1));
        var direct = entries.filter(function (e) { return e.id === wanted; })[0];
        if (direct) openTemplate(direct, null);
      })
      .catch(function (err) {
        console.error(err);
        if (location.protocol === 'file:') {
          ui.pickerStatus.textContent = '';
          notice('<strong>Opened straight from the disk.</strong> Browsers refuse to read ' +
            '<code>templates/</code> over <code>file://</code>, so nothing can load. Serve the folder instead — ' +
            '<code>python -m http.server</code> in this directory, then open ' +
            '<code>http://localhost:8000/</code>. Any static host works, including GitHub Pages.');
        } else {
          ui.pickerStatus.textContent = 'Could not read templates/manifest.json — ' + err.message;
        }
      });
  }

  // Exposed for tools/fidelity-test.html, which renders a template with no
  // edits at all and diffs the export against the template itself.
  window.Fracify = {
    loadTemplate: loadTemplate,
    mount: mount,
    renderTextSlot: renderTextSlot,
    adoptImage: adoptImage,
    applyPhoto: applyPhoto,
    buildExportSVG: buildExportSVG,
    renderPNG: renderPNG,
    fontsReady: fontsReady,
    manifestURL: MANIFEST_URL
  };

  if (!window.FRACIFY_NO_BOOT) boot();
})();
