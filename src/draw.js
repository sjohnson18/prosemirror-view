const {DOMSerializer} = require("prosemirror-model")

const browser = require("./browser")
const {childContainer} = require("./dompos")

const DIRTY_RESCAN = 1, DIRTY_REDRAW = 2
exports.DIRTY_RESCAN = DIRTY_RESCAN; exports.DIRTY_REDRAW = DIRTY_REDRAW

function getSerializer(view) {
  return view.someProp("domSerializer") || DOMSerializer.fromSchema(view.state.schema)
}

function serialize(node, offset, serializer) {
  function inner(node, offset) {
    let dom = serializer.serializeNodeAndMarks(node, options)
    if (dom.nodeType != 1 || dom.contentEditable == "false") {
      let wrap = document.createElement(node.isInline ? "span" : "div")
      wrap.appendChild(dom)
      dom = wrap
    }

    dom.setAttribute("pm-size", node.nodeSize)
    dom.setAttribute("pm-offset", offset)
    if (node.isTextblock) adjustTrailingHacks(serializer, dom, node)

    return dom
  }

  let options = {
    onContent(parent, target) {
      target.setAttribute("pm-container", true)
      parent.content.forEach((child, offset) => target.appendChild(inner(child, offset)))
    }
  }

  return inner(node, offset)
}

function draw(view, doc) {
  view.content.textContent = ""
  let serializer = getSerializer(view)
  doc.content.forEach((node, offset) => view.content.appendChild(serialize(node, offset, serializer)))
}
exports.draw = draw

function isBR(node, serializer) {
  if (!node.isLeaf || node.isText || !node.isInline) return false
  let ser = serializer.nodes[node.type.name](node)
  return Array.isArray(ser) ? ser[0] == "br" : ser && ser.nodeName == "BR"
}

function adjustTrailingHacks(serializer, dom, node) {
  let needs = node.content.size == 0 || isBR(node.lastChild, serializer) ||
      (node.type.spec.code && node.lastChild.isText && /\n$/.test(node.lastChild.text))
      ? "br" : !node.lastChild.isText && node.lastChild.isLeaf ? "text" : null
  let last = dom.lastChild
  let has = !last || last.nodeType != 1 || !last.hasAttribute("pm-ignore") ? null
      : last.nodeName == "BR" ? "br" : "text"
  if (needs != has) {
    if (has) dom.removeChild(last)
    if (needs) {
      let add = document.createElement(needs == "br" ? "br" : "span")
      add.setAttribute("pm-ignore", needs == "br" ? "trailing-break" : "cursor-text")
      dom.appendChild(add)
    }
  }
}

function findNodeIn(parent, i, node) {
  for (; i < parent.childCount; i++) {
    let child = parent.child(i)
    if (child == node) return i
  }
  return -1
}

function movePast(dom, view, onUnmount) {
  let next = dom.nextSibling
  for (let i = 0; i < onUnmount.length; i++) onUnmount[i](view, dom)
  dom.parentNode.removeChild(dom)
  return next
}

function redraw(view, oldState, newState) {
  let dirty = view.dirtyNodes
  if (dirty.get(oldState.doc) == DIRTY_REDRAW) return draw(view, newState.doc)

  let serializer = getSerializer(view)
  let onUnmountDOM = []
  view.someProp("onUnmountDOM", f => { onUnmountDOM.push(f) })

  function scan(dom, node, prev, pos) {
    let iPrev = 0, oPrev = 0, pChild = prev.firstChild
    let domPos = dom.firstChild

    function syncDOM() {
      while (domPos) {
        let curOff = domPos.nodeType == 1 && domPos.getAttribute("pm-offset")
        if (!curOff || +curOff < oPrev)
          domPos = movePast(domPos, view, onUnmountDOM)
        else
          return +curOff == oPrev
      }
      return false
    }

    for (let iNode = 0, offset = 0; iNode < node.childCount; iNode++) {
      let child = node.child(iNode), matching, reuseDOM
      let found = pChild == child ? iPrev : findNodeIn(prev, iPrev + 1, child)
      if (found > -1) {
        matching = child
        while (iPrev != found) {
          oPrev += pChild.nodeSize
          pChild = prev.maybeChild(++iPrev)
        }
      }

      if (matching && !dirty.get(matching) && syncDOM()) {
        reuseDOM = true
      } else if (pChild && !child.isText && child.sameMarkup(pChild) && dirty.get(pChild) != DIRTY_REDRAW && syncDOM()) {
        reuseDOM = true
        if (!pChild.isLeaf)
          scan(childContainer(domPos), child, pChild, pos + offset + 1)
        domPos.setAttribute("pm-size", child.nodeSize)
      } else {
        let rendered = serialize(child, offset, serializer)
        dom.insertBefore(rendered, domPos)
        reuseDOM = false
      }

      if (reuseDOM) {
        // Text nodes might be split into smaller segments
        if (child.isText) {
          for (let off = offset, end = off + child.nodeSize; off < end;) {
            if (offset != oPrev)
              domPos.setAttribute("pm-offset", off)
            off += +domPos.getAttribute("pm-size")
            domPos = domPos.nextSibling
          }
        } else {
          if (offset != oPrev)
            domPos.setAttribute("pm-offset", offset)
          domPos = domPos.nextSibling
        }
        oPrev += pChild.nodeSize
        pChild = prev.maybeChild(++iPrev)
      }
      offset += child.nodeSize
    }

    while (domPos) domPos = movePast(domPos, view, onUnmountDOM)

    if (node.isTextblock) adjustTrailingHacks(serializer, dom, node)

    if (browser.ios) iosHacks(dom)
  }
  scan(view.content, newState.doc, oldState.doc, 0)
}
exports.redraw = redraw

function iosHacks(dom) {
  if (dom.nodeName == "UL" || dom.nodeName == "OL") {
    let oldCSS = dom.style.cssText
    dom.style.cssText = oldCSS + "; list-style: square !important"
    window.getComputedStyle(dom).listStyle
    dom.style.cssText = oldCSS
  }
}
