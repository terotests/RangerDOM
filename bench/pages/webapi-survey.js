// SPDX-License-Identifier: MIT
// Which of the Web APIs UI libraries use are there: globals, and the
// members of the prototypes they reach for. The probe lists the missing.
(function () {
  var G = ['AbortController','AbortSignal','Blob','BroadcastChannel','CSS','CSSStyleSheet','CSSStyleDeclaration','CSSRule','CustomEvent','DOMException','DOMParser','DOMRect','DOMRectReadOnly','DOMMatrix','DOMPoint','DOMTokenList','Document','DocumentFragment','Element','Event','EventTarget','File','FileList','FileReader','FocusEvent','FormData','HTMLElement','HTMLInputElement','HTMLButtonElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','HTMLAnchorElement','HTMLImageElement','HTMLCanvasElement','HTMLDivElement','HTMLSpanElement','HTMLTemplateElement','HTMLSlotElement','HTMLDialogElement','HTMLIFrameElement','HTMLVideoElement','HTMLMediaElement','HTMLOptionElement','HTMLLabelElement','HTMLStyleElement','HTMLScriptElement','HTMLLinkElement','HTMLTableElement','HTMLBodyElement','Headers','History','Image','InputEvent','IntersectionObserver','KeyboardEvent','Location','MediaQueryList','MessageChannel','MessageEvent','MouseEvent','MutationObserver','NamedNodeMap','Navigator','Node','NodeFilter','NodeList','HTMLCollection','Option','Performance','PointerEvent','PopStateEvent','ProgressEvent','Range','Request','ResizeObserver','Response','Selection','ShadowRoot','Storage','StorageEvent','SVGElement','SVGSVGElement','SVGGraphicsElement','Text','Comment','TextDecoder','TextEncoder','TouchEvent','TreeWalker','UIEvent','URL','URLSearchParams','WheelEvent','Worker','XMLHttpRequest','XMLSerializer','Animation','KeyframeEffect','ClipboardEvent','DragEvent','DataTransfer','CompositionEvent','AnimationEvent','TransitionEvent','ErrorEvent','HashChangeEvent','PageTransitionEvent','CharacterData','Attr','AbstractRange','StaticRange','CSSStyleRule','CSSMediaRule','StyleSheet','StyleSheetList','MediaList','VisualViewport','Screen','ElementInternals','CustomElementRegistry','ImageData','Path2D','CanvasRenderingContext2D','OffscreenCanvas','WebSocket','EventSource','Crypto','Intl','structuredClone','queueMicrotask','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','setTimeout','clearTimeout','setInterval','clearInterval','fetch','atob','btoa','getComputedStyle','matchMedia','getSelection','scrollTo','scrollBy','scroll','open','close','focus','blur','postMessage','addEventListener','removeEventListener','dispatchEvent','reportError','createImageBitmap','alert','confirm','prompt','print','crypto','performance','navigator','location','history','localStorage','sessionStorage','screen','visualViewport','devicePixelRatio','innerWidth','innerHeight','outerWidth','outerHeight','scrollX','scrollY','pageXOffset','pageYOffset','screenX','screenY','origin','isSecureContext','customElements','frames','parent','top','self','opener','name','closed','frameElement','indexedDB','caches','speechSynthesis','onerror','onload','onresize','onscroll','onpopstate','onmessage','onunhandledrejection'];
  var P = {
    'Node.prototype': ['appendChild','insertBefore','removeChild','replaceChild','cloneNode','contains','compareDocumentPosition','isEqualNode','isSameNode','getRootNode','hasChildNodes','normalize','lookupNamespaceURI','lookupPrefix','isDefaultNamespace','textContent','nodeValue','childNodes','firstChild','lastChild','previousSibling','nextSibling','parentNode','parentElement','ownerDocument','isConnected','baseURI','nodeName','nodeType'],
    'Element.prototype': ['getAttribute','setAttribute','removeAttribute','hasAttribute','toggleAttribute','getAttributeNames','getAttributeNS','setAttributeNS','removeAttributeNS','hasAttributeNS','getAttributeNode','setAttributeNode','removeAttributeNode','hasAttributes','attributes','closest','matches','webkitMatchesSelector','querySelector','querySelectorAll','getElementsByClassName','getElementsByTagName','getElementsByTagNameNS','getBoundingClientRect','getClientRects','scrollIntoView','scrollTo','scrollBy','scroll','scrollTop','scrollLeft','scrollWidth','scrollHeight','clientTop','clientLeft','clientWidth','clientHeight','attachShadow','shadowRoot','assignedSlot','slot','id','className','classList','part','localName','tagName','namespaceURI','prefix','innerHTML','outerHTML','insertAdjacentHTML','insertAdjacentElement','insertAdjacentText','before','after','replaceWith','remove','prepend','append','replaceChildren','children','childElementCount','firstElementChild','lastElementChild','previousElementSibling','nextElementSibling','setPointerCapture','releasePointerCapture','hasPointerCapture','requestFullscreen','animate','getAnimations','checkVisibility','computedStyleMap','setHTMLUnsafe','getHTML','role','ariaLabel','ariaHidden','ariaExpanded','ariaSelected','ariaChecked','ariaDisabled','ariaPressed','ariaDescription','ariaLive','elementTiming','onclick'],
    'HTMLElement.prototype': ['click','focus','blur','dataset','style','hidden','title','lang','dir','tabIndex','accessKey','draggable','spellcheck','autocapitalize','translate','inert','contentEditable','isContentEditable','enterKeyHint','inputMode','nonce','autofocus','offsetParent','offsetTop','offsetLeft','offsetWidth','offsetHeight','innerText','outerText','attachInternals','popover','showPopover','hidePopover','togglePopover','attributeStyleMap'],
    'HTMLInputElement.prototype': ['value','checked','defaultValue','defaultChecked','indeterminate','type','name','disabled','readOnly','required','placeholder','min','max','step','minLength','maxLength','pattern','multiple','files','form','labels','list','validity','validationMessage','willValidate','checkValidity','reportValidity','setCustomValidity','select','setSelectionRange','setRangeText','selectionStart','selectionEnd','selectionDirection','stepUp','stepDown','valueAsNumber','valueAsDate','showPicker','autocomplete','size','accept'],
    'HTMLFormElement.prototype': ['submit','requestSubmit','reset','checkValidity','reportValidity','elements','length','action','method','enctype','noValidate','target','name'],
    'HTMLSelectElement.prototype': ['options','selectedIndex','selectedOptions','value','add','remove','item','namedItem','length','multiple','size','checkValidity','labels','showPicker'],
    'HTMLDialogElement.prototype': ['show','showModal','close','open','returnValue','requestClose'],
    'Document.prototype': ['createElement','createElementNS','createTextNode','createComment','createDocumentFragment','createEvent','createRange','createTreeWalker','createNodeIterator','createAttribute','importNode','adoptNode','getElementById','getElementsByName','querySelector','querySelectorAll','elementFromPoint','elementsFromPoint','caretRangeFromPoint','caretPositionFromPoint','getSelection','hasFocus','activeElement','body','head','documentElement','title','readyState','cookie','referrer','URL','documentURI','location','defaultView','visibilityState','hidden','fonts','styleSheets','adoptedStyleSheets','forms','images','links','scripts','currentScript','scrollingElement','fullscreenElement','exitFullscreen','pointerLockElement','execCommand','queryCommandSupported','open','write','close','characterSet','contentType','compatMode','doctype','implementation','dir','lastModified','startViewTransition','timeline','getAnimations'],
    'EventTarget.prototype': ['addEventListener','removeEventListener','dispatchEvent'],
    'Event.prototype': ['preventDefault','stopPropagation','stopImmediatePropagation','composedPath','defaultPrevented','bubbles','cancelable','composed','currentTarget','target','srcElement','eventPhase','isTrusted','timeStamp','type','returnValue','cancelBubble','initEvent'],
    'MouseEvent.prototype': ['clientX','clientY','pageX','pageY','screenX','screenY','offsetX','offsetY','movementX','movementY','button','buttons','relatedTarget','altKey','ctrlKey','shiftKey','metaKey','getModifierState','x','y','layerX','layerY','which','detail','view'],
    'KeyboardEvent.prototype': ['key','code','location','repeat','isComposing','altKey','ctrlKey','shiftKey','metaKey','getModifierState','keyCode','charCode','which'],
    'PointerEvent.prototype': ['pointerId','pointerType','isPrimary','width','height','pressure','tangentialPressure','tiltX','tiltY','twist','getCoalescedEvents','getPredictedEvents'],
    'Range.prototype': ['setStart','setEnd','setStartBefore','setStartAfter','setEndBefore','setEndAfter','selectNode','selectNodeContents','collapse','cloneContents','deleteContents','extractContents','insertNode','surroundContents','cloneRange','detach','toString','getBoundingClientRect','getClientRects','createContextualFragment','compareBoundaryPoints','comparePoint','isPointInRange','intersectsNode','commonAncestorContainer','startContainer','startOffset','endContainer','endOffset','collapsed'],
    'Selection.prototype': ['addRange','removeRange','removeAllRanges','getRangeAt','collapse','collapseToStart','collapseToEnd','extend','selectAllChildren','deleteFromDocument','containsNode','toString','setBaseAndExtent','modify','empty','anchorNode','anchorOffset','focusNode','focusOffset','isCollapsed','rangeCount','type'],
    'DOMTokenList.prototype': ['add','remove','toggle','contains','replace','item','supports','forEach','entries','keys','values','length','value'],
    'CSSStyleDeclaration.prototype': ['getPropertyValue','setProperty','removeProperty','getPropertyPriority','item','cssText','length','cssFloat'],
    'CSSStyleSheet.prototype': ['insertRule','deleteRule','replace','replaceSync','cssRules','rules','addRule','removeRule','ownerRule','disabled','media','href','title'],
    'Navigator.prototype': ['userAgent','language','languages','platform','vendor','onLine','cookieEnabled','hardwareConcurrency','maxTouchPoints','clipboard','userAgentData','sendBeacon','vibrate','share','canShare','permissions','mediaDevices','serviceWorker','storage','geolocation','webdriver','pdfViewerEnabled','doNotTrack','appVersion','product'],
    'History.prototype': ['pushState','replaceState','back','forward','go','state','length','scrollRestoration'],
    'Storage.prototype': ['getItem','setItem','removeItem','clear','key','length'],
    'Performance.prototype': ['now','mark','measure','getEntries','getEntriesByName','getEntriesByType','clearMarks','clearMeasures','timeOrigin','toJSON'],
    'MutationObserver.prototype': ['observe','disconnect','takeRecords'],
    'ResizeObserver.prototype': ['observe','unobserve','disconnect'],
    'IntersectionObserver.prototype': ['observe','unobserve','disconnect','takeRecords','root','rootMargin','thresholds'],
    'ShadowRoot.prototype': ['host','mode','delegatesFocus','slotAssignment','innerHTML','activeElement','adoptedStyleSheets','styleSheets','getElementById','elementFromPoint','elementsFromPoint','getSelection','getAnimations','clonable','serializable'],
    'HTMLSlotElement.prototype': ['assignedNodes','assignedElements','assign','name'],
    'CustomElementRegistry.prototype': ['define','get','getName','whenDefined','upgrade'],
    'URL': ['canParse','parse','createObjectURL','revokeObjectURL'],
    'AbortSignal': ['abort','timeout','any'],
    'CSS': ['supports','escape','registerProperty','px','number','percent'],
    'Promise': ['withResolvers','allSettled','any'],
    'Object': ['groupBy','hasOwn','fromEntries'],
    'Array.prototype': ['at','findLast','findLastIndex','toSorted','toReversed','toSpliced','with','flat','flatMap'],
    'String.prototype': ['at','replaceAll','isWellFormed','toWellFormed','padStart','matchAll'],
    'MediaQueryList.prototype': ['matches','media','addListener','removeListener','addEventListener','onchange'],
    'Blob.prototype': ['size','type','slice','text','arrayBuffer','stream','bytes'],
    'FormData.prototype': ['append','delete','get','getAll','has','set','entries','keys','values','forEach'],
    'Headers.prototype': ['append','delete','get','has','set','entries','forEach','getSetCookie'],
    'Response.prototype': ['json','text','blob','arrayBuffer','formData','clone','ok','status','statusText','headers','url','body','bodyUsed','redirected','type'],
    'TreeWalker.prototype': ['nextNode','previousNode','parentNode','firstChild','lastChild','nextSibling','previousSibling','currentNode','root','whatToShow','filter'],
    'Animation.prototype': ['play','pause','cancel','finish','reverse','updatePlaybackRate','persist','commitStyles','currentTime','startTime','playbackRate','playState','pending','finished','ready','effect','timeline','id','onfinish','oncancel'],
    'DOMRect': ['fromRect'],
    'DOMRectReadOnly.prototype': ['x','y','width','height','top','right','bottom','left','toJSON'],
    'Text.prototype': ['splitText','wholeText','data','length','appendData','insertData','deleteData','replaceData','substringData'],
    'SVGGraphicsElement.prototype': ['getBBox','getCTM','getScreenCTM'],
    'SVGSVGElement.prototype': ['createSVGPoint','createSVGMatrix','viewBox','width','height'],
    'HTMLCanvasElement.prototype': ['getContext','toDataURL','toBlob','width','height','transferControlToOffscreen'],
    'CanvasRenderingContext2D.prototype': ['fillRect','clearRect','strokeRect','fillText','strokeText','measureText','beginPath','closePath','moveTo','lineTo','arc','arcTo','bezierCurveTo','quadraticCurveTo','rect','roundRect','ellipse','fill','stroke','clip','save','restore','translate','rotate','scale','transform','setTransform','getTransform','resetTransform','drawImage','createLinearGradient','createRadialGradient','createConicGradient','createPattern','getImageData','putImageData','createImageData','setLineDash','getLineDash','isPointInPath','isPointInStroke','reset'],
    'HTMLImageElement.prototype': ['src','srcset','sizes','alt','width','height','naturalWidth','naturalHeight','complete','decode','loading','decoding','currentSrc','crossOrigin'],
    'HTMLMediaElement.prototype': ['play','pause','load','canPlayType','currentTime','duration','paused','ended','muted','volume','playbackRate','src','readyState','loop','autoplay','controls'],
  };
  function resolve(path) { var o = window; path.split('.').forEach(function (k) { o = o == null ? undefined : o[k]; }); return o; }
  function has(o, k) { if (o == null) return false; try { return k in o; } catch (e) { return false; } }
  var I = {
    'Node.prototype': function () { return document.createElement('div'); }, 'Element.prototype': function () { return document.createElement('div'); }, 'HTMLElement.prototype': function () { return document.createElement('div'); },
    'HTMLInputElement.prototype': function () { return document.createElement('input'); }, 'HTMLFormElement.prototype': function () { return document.createElement('form'); }, 'HTMLSelectElement.prototype': function () { return document.createElement('select'); },
    'HTMLDialogElement.prototype': function () { return document.createElement('dialog'); }, 'Document.prototype': function () { return document; }, 'EventTarget.prototype': function () { return document; },
    'Event.prototype': function () { return new Event('x'); }, 'MouseEvent.prototype': function () { return new MouseEvent('click'); }, 'KeyboardEvent.prototype': function () { return new KeyboardEvent('keydown'); },
    'PointerEvent.prototype': function () { return new PointerEvent('pointerdown'); }, 'Range.prototype': function () { return document.createRange(); }, 'Selection.prototype': function () { return getSelection(); },
    'DOMTokenList.prototype': function () { return document.body.classList; }, 'CSSStyleDeclaration.prototype': function () { return document.body.style; }, 'CSSStyleSheet.prototype': function () { return new CSSStyleSheet(); },
    'Navigator.prototype': function () { return navigator; }, 'History.prototype': function () { return history; }, 'Storage.prototype': function () { return localStorage; }, 'Performance.prototype': function () { return performance; },
    'MutationObserver.prototype': function () { return new MutationObserver(function () {}); }, 'ResizeObserver.prototype': function () { return new ResizeObserver(function () {}); }, 'IntersectionObserver.prototype': function () { return new IntersectionObserver(function () {}); },
    'ShadowRoot.prototype': function () { return document.createElement('div').attachShadow({ mode: 'open' }); }, 'HTMLSlotElement.prototype': function () { return document.createElement('slot'); },
    'CustomElementRegistry.prototype': function () { return customElements; }, 'MediaQueryList.prototype': function () { return matchMedia('(min-width: 1px)'); }, 'Blob.prototype': function () { return new Blob(['x']); },
    'FormData.prototype': function () { return new FormData(); }, 'Headers.prototype': function () { return new Headers(); }, 'Response.prototype': function () { return new Response('x'); },
    'TreeWalker.prototype': function () { return document.createTreeWalker(document.body); }, 'Animation.prototype': function () { var a = document.body.animate([{ opacity: 1 }, { opacity: 1 }], 1); a.cancel(); return a; },
    'DOMRectReadOnly.prototype': function () { return document.body.getBoundingClientRect(); }, 'Text.prototype': function () { return document.createTextNode('x'); },
    'SVGGraphicsElement.prototype': function () { return document.createElementNS('http://www.w3.org/2000/svg', 'rect'); }, 'SVGSVGElement.prototype': function () { return document.createElementNS('http://www.w3.org/2000/svg', 'svg'); },
    'HTMLCanvasElement.prototype': function () { return document.createElement('canvas'); }, 'CanvasRenderingContext2D.prototype': function () { return document.createElement('canvas').getContext('2d'); },
    'HTMLImageElement.prototype': function () { return document.createElement('img'); }, 'HTMLMediaElement.prototype': function () { return document.createElement('video'); },
  };
  // what needs a part of the host RangerDOM does not have (a network
  // socket, threads, a database, speech, CSS Typed OM): left out on
  // purpose, so a page's feature test takes its other path
  var HOST_ONLY = ['Worker', 'WebSocket', 'EventSource', 'createImageBitmap', 'indexedDB', 'caches', 'speechSynthesis', 'Element#computedStyleMap', 'HTMLElement#attributeStyleMap', 'CSS.px', 'CSS.number', 'CSS.percent', 'HTMLCanvasElement#transferControlToOffscreen', 'Navigator#share', 'Navigator#canShare'];
  function survey() {
    var miss = [];
    G.forEach(function (k) { if (!has(window, k)) miss.push(k); });
    Object.keys(P).forEach(function (path) {
      var o = resolve(path);
      if (o == null && !I[path]) { if (G.indexOf(path.split('.')[0]) < 0) miss.push(path); return; }
      var inst = null; try { inst = I[path] ? I[path]() : null; } catch (e) { inst = null; }
      P[path].forEach(function (k) { if (!has(o, k) && !has(inst, k)) miss.push(path.replace('.prototype', '#') + (path.indexOf('.prototype') < 0 ? '.' : '') + k); });
    });
    return miss;
  }
  var r = {};
  window.__benchCase = {
    setup: function () {},
    steps: [{ name: 'API survey', run: function () { r.missing = survey().filter(function (k) { return HOST_ONLY.indexOf(k) < 0; }); } }],
    probe: function () { return r; }
  };
})();
