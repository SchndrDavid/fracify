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
  var PAN_ROOM = 0.25;        // how far past the fit an offset may scale to make room

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
      else if (key === 'centre') spec.centre = parseFloat(value);
      else if (key === 'vcentre') spec.vcentre = value !== 'false';
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
          problems.push('image ' + def.image + ' (champ « ' + def.id + ' ») absente de ce fichier');
          return;
        }
        found.push({ def: def, imageIndex: image });
        return;
      }
      var indices = def.texts || [];
      var missing = indices.filter(function (n) { return !texts[n]; });
      if (missing.length) {
        problems.push('le champ « ' + def.id + ' » vise <text> ' + missing.join(', ') + ', absent de ce fichier');
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
      // Where the block belongs, when the template cannot be trusted to say.
      centreOn: typeof def.centre === 'number' ? def.centre : null,
      vcentre: !!def.vcentre,
      align: def.align || 'auto',
      maxLines: def.maxLines || sorted.length,
      maxWidth: maxWidth || null,
      original: original,
      // What the form starts with. The template's own words are the last real
      // post the designer made; a field should open on something that asks to
      // be replaced instead.
      placeholder: typeof def.placeholder === 'string' ? def.placeholder : null
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
      offsetX: 0,
      offsetY: 0,
      zoom: 0,
      blur: 0,
      frame: 0,
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
      var source = 'les calques nommés slot:';
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

  /* Two templates share a page in a paired editor, and Affinity numbers the
   * ids in every file from scratch: both have a #_clip1, both have a #_Image3.
   * A reference resolves to whichever came first in the document, so the story
   * would quietly draw the post's logo. Every id gets the template's name in
   * front of it, and every reference to it follows. */
  function namespaceIds(root, prefix) {
    var owners = toArray(root.querySelectorAll('[id]'));
    if (root.getAttribute('id')) owners.push(root);
    var renamed = {};
    owners.forEach(function (node) {
      var id = node.getAttribute('id');
      renamed[id] = prefix + id;
      node.setAttribute('id', renamed[id]);
    });
    if (!owners.length) return;

    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var attributes = all[i].attributes;
      for (var j = 0; j < attributes.length; j++) {
        var value = attributes[j].value;
        if (value.indexOf('#') < 0) continue;
        // Matches both xlink:href="#id" and any url(#id) inside a style.
        var next = value.replace(/#([^\s"')]+)/g, function (whole, id) {
          return renamed[id] ? '#' + renamed[id] : whole;
        });
        if (next !== value) attributes[j].value = next;
      }
    }
  }

  function mount(template, container) {
    var live = template.root.cloneNode(true);
    namespaceIds(live, template.entry.id + '--');
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

  /* A `centre` in the manifest is given in the artboard's own coordinates - 540
   * is the middle of a 1080 wide template - but a slot lives inside whatever
   * transforms Affinity wrapped it in, and that is the space its x attributes
   * are written in. This walks the one back into the other.
   *
   * Both matrices are taken against the screen and divided out, rather than
   * asking getCTM() for the transform to the viewport: the preview is drawn at
   * whatever width the column happens to be, and getCTM() would fold that
   * scale in - correct on a page showing the template at 1080 px, and wrong
   * everywhere else. Screen space cancels, so what is left is the viewBox. */
  function toLocalX(node, x) {
    var owner = node.ownerSVGElement;
    if (!owner || !owner.createSVGPoint || !node.getScreenCTM) return null;
    var here = node.getScreenCTM();
    var root = owner.getScreenCTM();
    if (!here || !root) return null;
    var point = owner.createSVGPoint();
    point.x = x;
    point.y = 0;
    return point.matrixTransform(here.inverse().multiply(root)).x;
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

    /* That centre is Affinity's own x plus a width measured in our cut of the
     * font, which runs a little narrower than the designer's - so it drifts a
     * few pixels left, and it is only ever as well placed as the template. A
     * slot that says where its middle is gets put there exactly. */
    if (slot.centreOn != null) {
      var pinned = toLocalX(slot.holder, slot.centreOn);
      if (pinned != null) slot.centre = pinned;
    }
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

    /* Lines are laid out downwards from the first baseline, so a block shorter
     * than the one the design drew leaves its space empty underneath and sits
     * high - a one line message in a banner built for two. Where a slot asks
     * for it, the block keeps the middle the design gave it instead, and grows
     * or shrinks around that. */
    var top = slot.y;
    if (slot.vcentre) {
      top += (slot.originals.length - 1) * slot.lineGap / 2 -
        (result.lines.length - 1) * result.lineGap / 2;
    }

    result.lines.forEach(function (line, i) {
      var node = document.createElementNS(SVG_NS, 'text');
      node.setAttribute('style', style);
      node.setAttribute('x', round(centred ? slot.centre : slot.x));
      node.setAttribute('y', round(top + i * result.lineGap));
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

  var canvasFilter = null;

  function supportsCanvasFilter() {
    if (canvasFilter === null) {
      var ctx = document.createElement('canvas').getContext('2d');
      try {
        ctx.filter = 'blur(2px)';
        canvasFilter = ctx.filter === 'blur(2px)';
      } catch (err) {
        canvasFilter = false;
      }
    }
    return canvasFilter;
  }

  function drawBlurred(ctx, source, x, y, width, height, blur) {
    if (!blur) {
      ctx.drawImage(source, x, y, width, height);
      return;
    }
    if (supportsCanvasFilter()) {
      ctx.filter = 'blur(' + blur + 'px)';
      ctx.drawImage(source, x, y, width, height);
      ctx.filter = 'none';
      return;
    }
    // Safari before 17 has no canvas filter. Going down to a small canvas and
    // letting the upscale smooth it back out is not a Gaussian, but for a
    // background sitting behind a panel it is indistinguishable.
    var factor = Math.max(1, blur / 1.5);
    var small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(width / factor));
    small.height = Math.max(1, Math.round(height / factor));
    var reduced = small.getContext('2d');
    reduced.imageSmoothingQuality = 'high';
    reduced.drawImage(source, 0, 0, small.width, small.height);
    ctx.drawImage(small, x, y, width, height);
  }

  /* Centre-crop and fill, never letterbox: the aspect ratio of an upload
   * practically never matches the slot, and empty margins always look wrong.
   * Zoom pushes in past that fit and the two offsets slide the visible window
   * around inside the slack, so the part of the photo worth showing can be put
   * where the design leaves room for it. Zoom also pulls back the other way,
   * down to the whole photograph on a white ground, for the upload that only
   * makes sense entire.
   *
   * Blur is drawn into the bitmap rather than layered over it, because these
   * photos sit behind a panel of text and softening them is what makes the
   * text readable. The crop is rendered with a margin of three times the
   * radius which is then thrown away, so the faded edge a blur leaves behind
   * never reaches the canvas. */
  function cropPhoto(framing, targetWidth, targetHeight) {
    var source = framing.source;
    var blur = framing.blur || 0;
    var pad = Math.ceil(blur * 3);
    var width = targetWidth + pad * 2;
    var height = targetHeight + pad * 2;

    /* A cover fit leaves slack in one direction only: whichever side the
     * photograph is long on hangs over the slot, and the other one meets it
     * exactly. The slider for that second axis then has nothing to slide, and
     * which of the two it is depends on the upload and on the slot - the same
     * photograph has room sideways in the square post and none in the tall
     * story. So the crop may scale past the fit, by up to PAN_ROOM of the
     * slot and only as far as the slider is actually pushed, to open the room
     * it asks for. Both sliders centred means no extra scale at all, and the
     * plain centred cover crop the template has always had. */
    var cover = Math.max(width / source.width, height / source.height);
    var zoom = framing.zoom || 0;
    var scale;
    if (zoom >= 0) {
      var roomX = width * (1 + PAN_ROOM * Math.abs(framing.offsetX) / 100) / source.width;
      var roomY = height * (1 + PAN_ROOM * Math.abs(framing.offsetY) / 100) / source.height;
      scale = Math.max(cover * (1 + zoom / 100), roomX, roomY);
    } else {
      /* Pulling back stops where the whole photograph is in the slot, because
       * past that point there is nothing further to reveal - only more margin.
       * A photograph shaped like its slot would have nothing to give at all,
       * so the far end of the slider is never less than half the fill either,
       * and the two offsets ask for no extra scale down here: there is already
       * room to spare. */
      var contain = Math.min(width / source.width, height / source.height);
      var pulled = Math.min(contain, cover / 2);
      scale = cover + (cover - pulled) * (zoom / 100);
    }
    var drawWidth = source.width * scale;
    var drawHeight = source.height * scale;
    var slackX = Math.max(0, drawWidth - width);
    var slackY = Math.max(0, drawHeight - height);

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    /* The crop is encoded as a JPEG, which has no transparency, so a photo
     * pulled back off the edges of its slot would leave black. White is the
     * one margin that reads as deliberate. */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    /* Centred on both axes - which is the familiar -slack / 2 wherever the
     * photo hangs over the slot, and half the leftover margin where it no
     * longer reaches. Only the overhang can be slid, so a pulled-back photo
     * simply sits in the middle. */
    drawBlurred(ctx, source,
      (width - drawWidth) / 2 + (framing.offsetX / 100) * (slackX / 2),
      (height - drawHeight) / 2 + (framing.offsetY / 100) * (slackY / 2),
      drawWidth, drawHeight, blur);

    if (pad) {
      var trimmed = document.createElement('canvas');
      trimmed.width = targetWidth;
      trimmed.height = targetHeight;
      trimmed.getContext('2d').drawImage(canvas, pad, pad, targetWidth, targetHeight,
        0, 0, targetWidth, targetHeight);
      canvas = trimmed;
    }
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  /* One photo field can stand for several templates at once - the post and the
   * story take the same photograph in two different shapes - so the crop is
   * redone for every slot the field feeds. */
  function applyPhoto(field) {
    if (!field.source) return;
    var members = field.members || [field];
    members.forEach(function (slot) {
      if (!slot.liveImage) return;
      slot.liveImage.setAttributeNS(XLINK_NS, 'xlink:href', cropPhoto(field, slot.width, slot.height));
      slot.liveImage.removeAttribute('href');
      slot.liveImage.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    });
  }

  /* Dragging a slider fires far faster than a 1080 x 1920 crop can be redrawn
   * and re-encoded, so the work is collapsed to one pass per frame. */
  function schedulePhoto(field) {
    if (field.frame) return;
    field.frame = requestAnimationFrame(function () {
      field.frame = 0;
      applyPhoto(field);
    });
  }

  function adoptImage(field, image) {
    var fitted = scaleToFit(image.naturalWidth || image.width, image.naturalHeight || image.height, SOURCE_MAX_SIDE);
    field.source = drawTo(image, fitted.width, fitted.height);
    var persist = scaleToFit(field.source.width, field.source.height, PERSIST_MAX_SIDE);
    field.persistUrl = drawTo(field.source, persist.width, persist.height).toDataURL('image/jpeg', 0.75);
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

  function saveState(workspace) {
    var data = { values: {}, photos: {} };
    workspace.slots.forEach(function (field) {
      if (field.kind === 'text') {
        data.values[field.id] = workspace.values[field.id];
      } else if (field.persistUrl) {
        data.photos[field.id] = {
          src: field.persistUrl,
          x: field.offsetX,
          y: field.offsetY,
          z: field.zoom,
          blur: field.blur,
          name: field.fileName
        };
      }
    });
    var key = storageKey(workspace.entry.id);
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (err) {
      // Photos are what blows the quota. Drop the other templates' photos
      // first, and this one's own photos only if that was not enough.
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
    next: $('#btn-next'),
    reset: $('#btn-reset'),
    png: $('#btn-png'),
    svg: $('#btn-svg')
  };

  var state = { manifest: null, workspace: null, saveTimer: 0 };

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

  /* A picker entry either names one template or pairs several under one
   * editor. The post and the story always carry the same words, so filling
   * them in twice was only ever a way to get them out of step. */
  function membersOf(entry) {
    var ids = entry.pair || [entry.id];
    var all = (state.manifest && state.manifest.templates) || [];
    return ids.map(function (id) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) return all[i];
      }
      throw new Error('le manifeste associe « ' + id + ' », qui n’y est pas défini');
    });
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
      meta.textContent = entry.pair
        ? entry.pair.length + ' formats, un seul formulaire'
        : ratioLabel(shot.naturalWidth, shot.naturalHeight);
    };
    shot.src = TEMPLATE_DIR + 'thumbs/' + (entry.pair ? entry.pair[0] : entry.id) + '.jpg';

    card.appendChild(thumb);
    card.appendChild(body);
    card.onclick = function () { openWorkspace(entry, card); };
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
    var entries = (manifest.templates || [])
      .filter(function (entry) { return !entry.hidden; })
      .concat(manifest.pairs || []);
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
    if (loose.length) ui.pickerGroups.appendChild(buildGroup('Autres', loose));
    state.entries = entries;
    return entries;
  }

  /* What comes after this one in its own group, wrapping at the end. A
   * presentation is six templates in a row, and going back to the picker
   * between each of them is five clicks nobody needs. */
  function nextInGroup(entry) {
    var siblings = (state.entries || []).filter(function (other) {
      return other.group === entry.group;
    });
    if (siblings.length < 2) return null;
    var here = siblings.indexOf(entry);
    return here < 0 ? null : siblings[(here + 1) % siblings.length];
  }

  function markUnsupported(entry, reason) {
    if (!entry._card) return;
    entry._card.classList.add('is-unsupported');
    entry._card.onclick = null;
    if (!entry._body.querySelector('.card-warn')) {
      entry._body.appendChild(make('div', 'card-warn', reason));
    }
  }

  /* Collapses the slots of every template in the workspace into one list of
   * fields, keyed by slot id. A field drives every slot that shares its name,
   * which is what lets one form fill a square post and a tall story at once. */
  function buildWorkspace(entry, templates) {
    var order = [];
    var byId = {};
    templates.forEach(function (template) {
      template.slots.forEach(function (slot) {
        var field = byId[slot.id];
        if (!field) {
          field = byId[slot.id] = {
            id: slot.id,
            kind: slot.kind,
            label: slot.label,
            hint: slot.hint,
            members: [],
            maxLines: slot.kind === 'text' ? slot.maxLines : 0,
            fontSize: slot.fontSize,
            original: slot.original,
            placeholder: slot.placeholder,
            offsetX: 0, offsetY: 0, zoom: 0, blur: 0, frame: 0,
            source: null, persistUrl: null, fileName: ''
          };
          order.push(field);
        }
        field.members.push(slot);
        if (slot.kind === 'text') field.maxLines = Math.max(field.maxLines, slot.maxLines);
      });
    });
    return { entry: entry, templates: templates, slots: order, values: {} };
  }

  function openWorkspace(entry, card) {
    ui.pickerStatus.textContent = 'Chargement de ' + entry.name + '…';
    var members;
    try {
      members = membersOf(entry);
    } catch (err) {
      markUnsupported(entry, err.message);
      ui.pickerStatus.textContent = '';
      return;
    }

    Promise.all(members.map(loadTemplate)).then(function (templates) {
      var problems = [];
      templates.forEach(function (template) {
        if (!template.slots.length) {
          problems.push(template.entry.name +
            ' n’a ni calques nommés slot: ni champs dans templates/manifest.json');
        }
        template.problems.forEach(function (problem) {
          problems.push(template.entry.name + ': ' + problem);
        });
      });
      if (templates.some(function (template) { return !template.slots.length; })) {
        markUnsupported(entry, 'Non pris en charge : ' + problems.join(' ; ') + '.');
        ui.pickerStatus.textContent = '';
        return;
      }
      if (problems.length) {
        notice('<strong>' + entry.name + ' :</strong> ' + problems.join(' ; ') +
          '. Ces champs manquent au formulaire ; le reste fonctionne.');
      }
      state.workspace = buildWorkspace(entry, templates);
      restore(state.workspace);
      showEditor(state.workspace);
      ui.pickerStatus.textContent = '';
      if (location.hash.slice(1) !== entry.id) location.hash = entry.id;
    }).catch(function (err) {
      ui.pickerStatus.textContent = '';
      markUnsupported(entry, 'Chargement impossible : ' + err.message);
      console.error(err);
    });
    if (card) card.blur();
  }

  function startingValue(field) {
    return field.placeholder != null ? field.placeholder : field.original;
  }

  function restore(workspace) {
    var saved = readState(workspace.entry.id) || { values: {}, photos: {} };
    workspace.slots.forEach(function (field) {
      if (field.kind === 'text') {
        workspace.values[field.id] = saved.values && typeof saved.values[field.id] === 'string'
          ? saved.values[field.id]
          : startingValue(field);
      } else {
        var photo = saved.photos && saved.photos[field.id];
        field.pendingPhoto = photo || null;
        field.offsetX = photo ? (photo.x || 0) : 0;
        field.offsetY = photo ? (photo.y || 0) : 0;
        /* Zoom used to be a percentage of the fill that started at 100 and
         * only ever grew; it is now signed, and centred on the fill at 0. A
         * state saved under the old name is carried over rather than dropped. */
        field.zoom = photo ? (photo.z || (photo.zoom ? photo.zoom - 100 : 0)) : 0;
        field.blur = photo ? (photo.blur || 0) : 0;
        field.fileName = photo ? (photo.name || 'photo enregistrée') : '';
      }
    });
  }

  function showEditor(workspace) {
    var many = workspace.templates.length > 1;
    var sizes = workspace.templates.map(function (t) { return t.width + ' × ' + t.height; });
    ui.editorTitle.textContent = workspace.entry.name;
    ui.editorKind.textContent = sizes.join('  ·  ') + '  ·  champs définis par ' +
      workspace.templates[0].source;
    ui.picker.classList.add('is-hidden');
    ui.editor.classList.remove('is-hidden');
    ui.back.classList.remove('is-hidden');
    ui.exportStatus.textContent = '';

    var following = nextInGroup(workspace.entry);
    ui.next.classList.toggle('is-hidden', !following);
    if (following) {
      ui.next.textContent = 'Suivant : ' + following.name + '  →';
      ui.next.onclick = function () {
        flushSave();
        openWorkspace(following, null);
      };
    }
    ui.png.textContent = many ? 'Exporter les deux PNG' : 'Exporter en PNG';
    ui.svg.textContent = many ? 'Télécharger les deux SVG' : 'Télécharger le SVG';

    buildStage(workspace);
    buildFields(workspace);

    workspace.slots.forEach(function (field) {
      if (field.kind === 'text') {
        applyText(workspace, field);
      } else if (field.pendingPhoto) {
        loadImageElement(field.pendingPhoto.src).then(function (img) {
          adoptImage(field, img);
          field.persistUrl = field.pendingPhoto.src;
          applyPhoto(field);
          updatePhotoUI(field);
        }).catch(function () { /* a stale photo just does not come back */ });
      }
    });
    window.scrollTo(0, 0);
  }

  /* Every template in the workspace gets its own canvas, side by side, with
   * flex-grow set to its aspect ratio so a square and a nine-by-sixteen come
   * out the same height instead of one towering over the other. */
  function buildStage(workspace) {
    clear(ui.stage);
    ui.stage.classList.toggle('is-multi', workspace.templates.length > 1);
    workspace.templates.forEach(function (template) {
      var figure = make('figure', 'canvas');
      figure.style.flexGrow = String(template.width / template.height);
      var art = make('div', 'canvas-art');
      figure.appendChild(art);

      var caption = make('figcaption', 'canvas-foot');
      caption.appendChild(make('span', 'canvas-name', template.entry.name));
      var png = make('button', 'btn btn-small', 'PNG');
      png.type = 'button';
      png.onclick = function () { exportOne(template, png); };
      var svg = make('button', 'btn btn-small', 'SVG');
      svg.type = 'button';
      svg.onclick = function () { downloadSVG(template); };
      caption.appendChild(png);
      caption.appendChild(svg);
      figure.appendChild(caption);

      ui.stage.appendChild(figure);
      mount(template, art);
    });
  }

  function applyText(workspace, field) {
    var value = workspace.values[field.id];
    var shrunk = false;
    var overflow = false;
    var size = field.fontSize;
    field.members.forEach(function (slot) {
      var result = renderTextSlot(slot, value);
      if (result.overflow) overflow = true;
      if (result.shrunk) {
        shrunk = true;
        size = Math.min(size, result.size);
      }
    });
    if (!field.ui) return;
    var warn = field.ui.warn;
    if (overflow) {
      warn.className = 'field-warn is-error';
      warn.textContent = 'Ne tient toujours pas à ' + Math.round(size) + ' px — raccourcissez le texte.';
      warn.classList.remove('is-hidden');
    } else if (shrunk) {
      warn.className = 'field-warn';
      warn.textContent = 'Réduit de ' + Math.round(field.fontSize) + ' px à ' + Math.round(size) +
        ' px pour tenir. C’est plus petit que ce que le modèle prévoit.';
      warn.classList.remove('is-hidden');
    } else {
      warn.classList.add('is-hidden');
    }
  }

  /* Leaving the editor has to beat the save timer, or the last thing typed
   * before clicking away is the one thing that does not come back. */
  function flushSave() {
    clearTimeout(state.saveTimer);
    if (state.workspace) saveState(state.workspace);
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      if (!state.workspace) return;
      if (!saveState(state.workspace)) {
        notice('Le stockage local du navigateur est plein : les photos ne sont plus mémorisées — ' +
          'les textes le sont toujours.');
      }
    }, 400);
  }

  function buildFields(workspace) {
    clear(ui.fields);
    workspace.slots.forEach(function (field) {
      var wrap = make('div', 'field');
      if (field.kind === 'text') buildTextField(workspace, field, wrap);
      else buildPhotoField(field, wrap);
      ui.fields.appendChild(wrap);
    });
  }

  function buildTextField(workspace, field, wrap) {
    var id = 'f-' + field.id;
    var label = make('label', null, field.label);
    label.htmlFor = id;
    wrap.appendChild(label);

    var input;
    if (field.maxLines > 1) {
      input = document.createElement('textarea');
      input.rows = Math.min(4, field.maxLines + 1);
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.id = id;
    input.value = workspace.values[field.id];
    input.spellcheck = false;
    input.oninput = function () {
      workspace.values[field.id] = input.value;
      applyText(workspace, field);
      scheduleSave();
    };
    wrap.appendChild(input);

    if (field.maxLines > 1) {
      wrap.appendChild(make('p', 'field-note',
        'Retour à la ligne automatique, ' + field.maxLines +
        ' lignes au maximum. Entrée pour forcer un saut.'));
    } else if (field.hint) {
      wrap.appendChild(make('p', 'field-note', field.hint));
    }

    var warn = make('p', 'field-warn is-hidden');
    wrap.appendChild(warn);
    field.ui = { input: input, warn: warn };
  }

  function buildPhotoField(field, wrap) {
    wrap.appendChild(make('div', 'field-label', field.label));

    var box = make('div', 'photo-slot');
    var row = make('div', 'photo-row');
    var preview = make('div', 'photo-preview', 'aucune');
    var actions = make('div', 'photo-actions');

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.id = 'photo-' + field.id;
    input.className = 'is-hidden';

    var pick = make('button', 'btn btn-small', 'Choisir une photo…');
    pick.type = 'button';
    pick.onclick = function () { input.click(); };

    var shapes = field.members.map(function (slot) {
      return slot.width + ' × ' + slot.height;
    }).join(' et ');
    var name = make('div', 'photo-name', field.fileName || shapes + ' px');

    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      loadImageElement(url).then(function (img) {
        URL.revokeObjectURL(url);
        adoptImage(field, img);
        field.fileName = file.name;
        applyPhoto(field);
        updatePhotoUI(field);
        scheduleSave();
      }).catch(function () {
        URL.revokeObjectURL(url);
        name.textContent = 'Ce fichier n’a pas pu être lu comme une image.';
      });
    };

    actions.appendChild(pick);
    actions.appendChild(name);
    row.appendChild(preview);
    row.appendChild(actions);
    box.appendChild(row);
    box.appendChild(input);

    field.ui = { preview: preview, name: name, sliders: {} };
    PHOTO_CONTROLS.forEach(function (control) {
      box.appendChild(buildSlider(field, control));
    });

    if (field.hint) box.appendChild(make('p', 'field-note', field.hint));
    wrap.appendChild(box);
    updatePhotoUI(field);
  }

  function shift(value, positive, negative) {
    return value === 0 ? 'centré' : (value > 0 ? positive : negative) + ' ' + Math.abs(value) + '%';
  }

  var PHOTO_CONTROLS = [
    { key: 'offsetX', label: 'X', min: -100, max: 100,
      format: function (v) { return shift(v, 'droite', 'gauche'); } },
    { key: 'offsetY', label: 'Y', min: -100, max: 100,
      format: function (v) { return shift(v, 'bas', 'haut'); } },
    { key: 'zoom', label: 'Zoom', min: -100, max: 150,
      format: function (v) {
        return v === 0 ? 'plein cadre' : (v > 0 ? '+' : '−') + Math.abs(v) + ' %';
      } },
    { key: 'blur', label: 'Flou', min: 0, max: 40,
      format: function (v) { return v ? v + ' px' : 'aucun'; } }
  ];

  function buildSlider(field, control) {
    var row = make('div', 'slider-row');
    var input = document.createElement('input');
    input.type = 'range';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = '1';
    input.value = String(field[control.key]);
    input.disabled = !field.source;
    input.setAttribute('aria-label', field.label + ' — ' + control.label);

    var readout = make('span', 'slider-readout', control.format(field[control.key]));
    input.oninput = function () {
      field[control.key] = parseInt(input.value, 10) || 0;
      readout.textContent = control.format(field[control.key]);
      schedulePhoto(field);
      scheduleSave();
    };

    row.appendChild(make('span', 'slider-label', control.label));
    row.appendChild(input);
    row.appendChild(readout);
    field.ui.sliders[control.key] = { input: input, readout: readout, format: control.format };
    return row;
  }

  function updatePhotoUI(field) {
    if (!field.ui) return;
    PHOTO_CONTROLS.forEach(function (control) {
      var slider = field.ui.sliders[control.key];
      if (!slider) return;
      slider.input.disabled = !field.source;
      slider.input.value = String(field[control.key]);
      slider.readout.textContent = control.format(field[control.key]);
    });
    if (field.fileName) field.ui.name.textContent = field.fileName;
    if (field.source) {
      // The swatch shows the source, not the crop, so moving a slider never
      // has to redraw it.
      field.ui.preview.textContent = '';
      field.ui.preview.style.backgroundImage = 'url("' +
        drawTo(field.source, 148, Math.round(148 * field.source.height / field.source.width))
          .toDataURL('image/jpeg', 0.7) + '")';
    }
  }

  /* -------------------------------------------------------------- actions */

  function fileName(template, extension) {
    return 'frac-' + template.entry.id + '-' + stamp() + '.' + extension;
  }

  function exportOne(template, button) {
    if (button) button.disabled = true;
    ui.exportStatus.textContent = 'Rendu de ' + template.entry.name + ' en ' +
      template.width + ' × ' + template.height + '…';
    return renderPNG(template).then(function (blob) {
      saveBlob(blob, fileName(template, 'png'));
      ui.exportStatus.textContent = template.entry.name + ' : ' + Math.round(blob.size / 1024) + ' ko.';
    }).catch(function (err) {
      ui.exportStatus.textContent = 'Échec de l’export : ' + err.message;
      console.error(err);
    }).then(function () {
      if (button) button.disabled = false;
    });
  }

  function downloadSVG(template) {
    var svg = buildExportSVG(template);
    saveBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), fileName(template, 'svg'));
    ui.exportStatus.textContent = template.entry.name + ' : SVG enregistré avec les polices intégrées.';
  }

  ui.back.onclick = function () {
    flushSave();
    ui.editor.classList.add('is-hidden');
    ui.back.classList.add('is-hidden');
    ui.next.classList.add('is-hidden');
    ui.picker.classList.remove('is-hidden');
    ui.notice.classList.add('is-hidden');
    clear(ui.stage);
    state.workspace = null;
    if (location.hash) location.hash = '';
  };

  ui.reset.onclick = function () {
    var workspace = state.workspace;
    if (!workspace) return;
    var hasPhoto = workspace.slots.some(function (field) {
      return field.kind === 'image' && field.source;
    });
    if (hasPhoto && !window.confirm('Cela efface les textes et les photos ajoutées. Continuer ?')) return;
    forgetState(workspace.entry.id);
    workspace.slots.forEach(function (field) {
      if (field.kind === 'text') {
        workspace.values[field.id] = startingValue(field);
      } else {
        field.source = null;
        field.persistUrl = null;
        field.offsetX = 0;
        field.offsetY = 0;
        field.zoom = 0;
        field.blur = 0;
        field.fileName = '';
        field.pendingPhoto = null;
      }
    });
    showEditor(workspace);
  };

  ui.png.onclick = function () {
    var workspace = state.workspace;
    if (!workspace) return;
    ui.png.disabled = true;
    // One at a time: two canvases this size at once is a lot of memory on a
    // phone, and browsers are happier being handed downloads in sequence.
    var queue = workspace.templates.slice();
    (function next() {
      if (!queue.length) {
        ui.png.disabled = false;
        if (workspace.templates.length > 1) ui.exportStatus.textContent = 'Les deux sont exportés.';
        return;
      }
      exportOne(queue.shift(), null).then(function () { setTimeout(next, 400); });
    })();
  };

  ui.svg.onclick = function () {
    var workspace = state.workspace;
    if (!workspace) return;
    workspace.templates.forEach(function (template, i) {
      setTimeout(function () { downloadSVG(template); }, i * 400);
    });
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
        buildPicker(state.manifest);
        ui.pickerStatus.textContent = '';
        // index.html#event opens straight into that editor.
        var wanted = decodeURIComponent(location.hash.slice(1));
        var direct = (state.entries || []).filter(function (e) { return e.id === wanted; })[0];
        if (direct) openWorkspace(direct, null);
      })
      .catch(function (err) {
        console.error(err);
        if (location.protocol === 'file:') {
          ui.pickerStatus.textContent = '';
          notice('<strong>Ouvert directement depuis le disque.</strong> Les navigateurs refusent de lire ' +
            '<code>templates/</code> via <code>file://</code>, donc rien ne peut se charger. Servez plutôt le ' +
            'dossier — <code>python -m http.server</code> dans ce répertoire, puis ouvrez ' +
            '<code>http://localhost:8000/</code>. N’importe quel hébergement statique convient, GitHub Pages compris.');
        } else {
          ui.pickerStatus.textContent = 'Lecture de templates/manifest.json impossible — ' + err.message;
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
