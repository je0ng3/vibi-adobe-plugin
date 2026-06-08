// UXP runtime shims + diagnostics. Loaded as a classic <script src> BEFORE the bundle
// (see vite.config.ts transformIndexHtml). Plain ES5 — no modules, no template literals —
// so it parses in UXP and runs before any Spectrum/Lit/React code.
//
// Background: the panel is built on @spectrum-web-components 1.x (Lit), which assumes browser
// DOM APIs UXP does not implement. Each shim below lets that init path survive in UXP. This is
// a stopgap — the supported path is migrating to @swc-uxp-wrappers pinned to 0.37.0.
(function () {
  "use strict";

  // --- DIAGNOSTICS: paint uncaught errors onto the panel -------------------------------
  // Dev/UDT only. Adobe Marketplace review rejects production builds that ship debugging
  // overlays, and raw stack traces shouldn't reach end users. The prod build omits the
  // __VIBI_DIAG__ enabling flag (see vite.config.ts uxpHtml), so this whole block is inert.
  if (globalThis.__VIBI_DIAG__) {
    var paint = function (text, color, pos) {
      function add() {
        if (!document.body) { return setTimeout(add, 10); }
        var d = document.createElement("div");
        d.textContent = text;
        d.style.cssText =
          "position:fixed;" + pos + ":0;left:0;right:0;z-index:99999;background:" + color +
          ";color:#fff;padding:4px 8px;font:11px sans-serif;white-space:pre-wrap";
        document.body.appendChild(d);
      }
      add();
    };
    window.addEventListener("error", function (e) {
      var err = e && e.error;
      var msg = (e && e.message) || (err && err.message) || "";
      var where = e && e.filename ? (" @ " + e.filename + ":" + e.lineno + ":" + e.colno) : "";
      var stack = err && err.stack ? ("\n" + String(err.stack).split("\n").slice(0, 6).join("\n")) : "";
      // Message-less errors are common in UXP (native/CustomEvent errors arrive with empty
      // .message and no .error). Dig out whatever IS present so the overlay isn't just "error".
      if (!msg && !stack) {
        var extra = [];
        if (err) {
          if (err.name) extra.push("name=" + err.name);
          if (err.code != null) extra.push("code=" + err.code);
          try { extra.push("err=" + String(err)); } catch (_) {}
          try {
            var own = Object.getOwnPropertyNames(err).filter(function (k) { return k !== "stack"; });
            if (own.length) extra.push("keys={" + own.join(",") + "}");
          } catch (_) {}
        }
        msg = extra.length ? extra.join(" ") : e.type;
      }
      try { console.error("[diag] window.error:", msg, where, err || e); } catch (_) {}
      paint("JS ERROR: " + (msg || e.type) + where + stack, "#900", "bottom");
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      var msg = (r && r.message) || String(r);
      var stack = r && r.stack ? ("\n" + String(r.stack).split("\n").slice(0, 5).join("\n")) : "";
      paint("PROMISE REJECT: " + msg + stack, "#930", "bottom");
    });
  }

  // --- customElements.define: tolerate duplicate registrations -----------------------------
  // The @swc-uxp-wrappers and their internal @spectrum-web-components copy both register the
  // same sp-* tag names. Browsers ignore a redefine of an already-defined element; UXP throws
  // NotSupportedError, aborting the bundle. Make redefine a no-op.
  if (window.customElements && typeof customElements.define === "function") {
    var __origDefine = customElements.define.bind(customElements);
    customElements.define = function (name, ctor, options) {
      if (customElements.get(name)) { return; }
      try {
        return __origDefine(name, ctor, options);
      } catch (e) {
        if (String((e && e.message) || "").indexOf("already") === -1) { throw e; }
      }
    };
  }

  // --- appendChild/insertBefore: adopt cross-document nodes ---------------------------------
  // React creates text/element nodes and appends them into Spectrum custom elements (e.g.
  // sp-help-text). UXP considers those nodes to belong to a different document than the
  // element and throws WrongDocumentError (browsers silently adopt). Adopt the node into the
  // parent's document first; adoptNode keeps node identity so React's references stay valid.
  if (typeof Node !== "undefined" && Node.prototype && Node.prototype.appendChild) {
    var __adopt = function (parent, node) {
      if (!node || !parent || !parent.ownerDocument) return node;
      var pdoc = parent.ownerDocument;
      if (node.ownerDocument === pdoc) return node;
      if (typeof pdoc.adoptNode === "function") {
        try { return pdoc.adoptNode(node); } catch (e) { /* fall through */ }
      }
      // Last resort for text nodes (identity is lost, but static text is unaffected).
      if (node.nodeType === 3 && typeof pdoc.createTextNode === "function") {
        return pdoc.createTextNode(node.data != null ? node.data : (node.textContent || ""));
      }
      return node;
    };
    var __append = Node.prototype.appendChild;
    Node.prototype.appendChild = function (node) {
      return __append.call(this, __adopt(this, node));
    };
    var __insert = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (node, ref) {
      return __insert.call(this, __adopt(this, node), ref);
    };
  }

  // --- TextEncoder / TextDecoder: UXP has neither global ----------------------------------
  // secureStorage persistence (auth/tokenStore.ts) and tar extraction (perso/tar.ts) encode/
  // decode UTF-8 through these. Without them, saveToken throws "TextEncoder is not defined"
  // and the token never persists (sign-in works in-memory but dies on next launch). Minimal
  // UTF-8 implementations covering the full BMP + surrogate pairs.
  //
  // Must define on globalThis, NOT window: bundled code references bare `TextEncoder`, which
  // resolves against the JS global object. In UXP `window` is NOT that object (assigning
  // `window.TextEncoder` left bare `TextEncoder` still undefined). Cover all aliases.
  var __g = (typeof globalThis !== "undefined" && globalThis) ||
            (typeof self !== "undefined" && self) ||
            (typeof global !== "undefined" && global) || window;
  if (typeof __g.TextEncoder === "undefined") {
    __g.TextEncoder = function TextEncoder() {};
    __g.TextEncoder.prototype.encode = function (str) {
      str = String(str == null ? "" : str);
      var bytes = [];
      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          var lo = str.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00); i++; }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
          bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return new Uint8Array(bytes);
    };
  }
  if (typeof __g.TextDecoder === "undefined") {
    // Label/options are ignored — UTF-8 is assumed (the only encoding the plugin uses).
    __g.TextDecoder = function TextDecoder() {};
    __g.TextDecoder.prototype.decode = function (input) {
      if (input == null) return "";
      var bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
      var out = "", i = 0, len = bytes.length, b1, b2, b3, b4, cp;
      while (i < len) {
        b1 = bytes[i++];
        if (b1 < 0x80) {
          out += String.fromCharCode(b1);
        } else if (b1 >= 0xc0 && b1 < 0xe0) {
          b2 = bytes[i++] & 0x3f;
          out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
        } else if (b1 >= 0xe0 && b1 < 0xf0) {
          b2 = bytes[i++] & 0x3f; b3 = bytes[i++] & 0x3f;
          out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
        } else {
          b2 = bytes[i++] & 0x3f; b3 = bytes[i++] & 0x3f; b4 = bytes[i++] & 0x3f;
          cp = (((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4) - 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    };
  }
  // Mirror onto window too, in case any library reads them as window-qualified properties.
  if (typeof window !== "undefined" && window !== __g) {
    if (typeof window.TextEncoder === "undefined") { window.TextEncoder = __g.TextEncoder; }
    if (typeof window.TextDecoder === "undefined") { window.TextDecoder = __g.TextDecoder; }
  }

  // --- CSSStyleSheet: bare stub (no replace()) so Lit falls back to <style> injection ----
  if (typeof window.CSSStyleSheet === "undefined") {
    window.CSSStyleSheet = function CSSStyleSheet() {};
  }

  // --- CSS global: UXP has none; Spectrum/Lit calls CSS.supports()/CSS.escape() -----------
  if (typeof window.CSS === "undefined") {
    window.CSS = {
      supports: function () { return false; },
      // Spec-compliant CSS.escape (per https://drafts.csswg.org/cssom/#serialize-an-identifier)
      escape: function (value) {
        var str = String(value);
        var length = str.length;
        var index = -1;
        var codeUnit;
        var result = "";
        var firstCodeUnit = str.charCodeAt(0);
        while (++index < length) {
          codeUnit = str.charCodeAt(index);
          if (codeUnit === 0x0000) { result += "�"; continue; }
          if (
            (codeUnit >= 0x0001 && codeUnit <= 0x001f) || codeUnit === 0x007f ||
            (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
            (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
          ) {
            result += "\\" + codeUnit.toString(16) + " ";
            continue;
          }
          if (index === 0 && length === 1 && codeUnit === 0x002d) {
            result += "\\" + str.charAt(index);
            continue;
          }
          if (
            codeUnit >= 0x0080 || codeUnit === 0x002d || codeUnit === 0x005f ||
            (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
            (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
            (codeUnit >= 0x0061 && codeUnit <= 0x007a)
          ) {
            result += str.charAt(index);
            continue;
          }
          result += "\\" + str.charAt(index);
        }
        return result;
      }
    };
  }

  // --- document.createTreeWalker: UXP lacks it; Spectrum focus mgmt needs it --------------
  if (typeof document.createTreeWalker !== "function") {
    var NF = window.NodeFilter || (window.NodeFilter = {});
    if (NF.SHOW_ALL == null) {
      NF.SHOW_ALL = 0xffffffff; NF.SHOW_ELEMENT = 1; NF.SHOW_TEXT = 4; NF.SHOW_COMMENT = 128;
      NF.FILTER_ACCEPT = 1; NF.FILTER_REJECT = 2; NF.FILTER_SKIP = 3;
    }
    var show = function (n, w) { return (w & (1 << (n.nodeType - 1))) !== 0; };
    var judge = function (n, w, f) {
      if (!show(n, w)) return NF.FILTER_SKIP;
      if (!f) return NF.FILTER_ACCEPT;
      var fn = typeof f === "function" ? f : f.acceptNode;
      return fn ? fn.call(f, n) : NF.FILTER_ACCEPT;
    };
    document.createTreeWalker = function (root, whatToShow, filter) {
      var w = whatToShow == null ? NF.SHOW_ALL : whatToShow;
      var cur = root;
      function next() {
        var n = cur, r = NF.FILTER_ACCEPT;
        for (;;) {
          while (r !== NF.FILTER_REJECT && n.firstChild) {
            n = n.firstChild; r = judge(n, w, filter);
            if (r === NF.FILTER_ACCEPT) { cur = n; return n; }
          }
          var f = null, t = n;
          while (t && t !== root) { if (t.nextSibling) { f = t.nextSibling; break; } t = t.parentNode; }
          if (!f) return null;
          n = f; r = judge(n, w, filter);
          if (r === NF.FILTER_ACCEPT) { cur = n; return n; }
        }
      }
      function prev() {
        var n = cur, r;
        for (;;) {
          var s = n.previousSibling;
          while (s) {
            n = s; r = judge(n, w, filter);
            while (r !== NF.FILTER_REJECT && n.lastChild) { n = n.lastChild; r = judge(n, w, filter); }
            if (r === NF.FILTER_ACCEPT) { cur = n; return n; }
            s = n.previousSibling;
          }
          if (n === root || !n.parentNode) return null;
          n = n.parentNode;
          if (judge(n, w, filter) === NF.FILTER_ACCEPT) { cur = n; return n; }
        }
      }
      function scan(get) { var n = get(cur); while (n) { if (judge(n, w, filter) === NF.FILTER_ACCEPT) { cur = n; return n; } n = get(n); } return null; }
      return {
        root: root, whatToShow: w, filter: filter || null,
        get currentNode() { return cur; }, set currentNode(n) { cur = n; },
        nextNode: next, previousNode: prev,
        parentNode: function () { var n = cur; while (n && n !== root) { n = n.parentNode; if (n && judge(n, w, filter) === NF.FILTER_ACCEPT) { cur = n; return n; } } return null; },
        firstChild: function () { return scan(function (x) { return x === cur ? cur.firstChild : x.nextSibling; }); },
        lastChild: function () { return scan(function (x) { return x === cur ? cur.lastChild : x.previousSibling; }); },
        nextSibling: function () { return scan(function (x) { return x.nextSibling; }); },
        previousSibling: function () { return scan(function (x) { return x.previousSibling; }); }
      };
    };
  }
})();
