// Minimal DOM-node shim so webview-inject.js's pure functions can be unit-tested
// under plain node (no jsdom, no dependency). Implements exactly the API subset
// the converter/sanitizer use: nodeType, tagName, childNodes, textContent,
// getAttribute, className, cloneNode(deep), removeChild.
"use strict";
function txt(s) {
  return { nodeType: 3, textContent: String(s), childNodes: [], cloneNode() { return txt(this.textContent); } };
}
function el(tag, attrs, children) {
  attrs = attrs || {};
  children = (children || []).slice();
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: children,
    className: attrs.class || attrs.className || "",
    _attrs: Object.assign({}, attrs),
    getAttribute(n) {
      if (n === "class") return this.className;
      return n in this._attrs ? this._attrs[n] : null;
    },
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this.childNodes = [txt(v)];
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      return c;
    },
    cloneNode(deep) {
      return el(tag, this._attrs, deep ? this.childNodes.map((c) => c.cloneNode(true)) : []);
    },
  };
  return node;
}
module.exports = { el, txt };
