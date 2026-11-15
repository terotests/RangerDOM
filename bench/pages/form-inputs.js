// SPDX-License-Identifier: MIT
// Every HTML form control: focus, typing, caret, selection, blur and
// refocus, placeholder, disabled/readonly, constraint validation, value
// APIs. Text is typed as test tools type it in a browser: a keydown the
// page dispatches, document.execCommand('insertText') for the text (the
// browser's own editing: beforeinput, the value, input), then a keyup.
// The probe holds each field's state and every step's own result.
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var r = {};
  var log = [];
  function note(s) { log.push(s); if (log.length > 40) log.shift(); }
  function key(el, type, k) { el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, composed: true })); }
  // typed into the focused element, a character at a time
  function type(text) {
    var el = document.activeElement, ok = true;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      key(el, 'keydown', ch === '\n' ? 'Enter' : ch);
      ok = document.execCommand('insertText', false, ch) && ok;
      key(el, 'keyup', ch === '\n' ? 'Enter' : ch);
    }
    return ok;
  }
  var TEXTS = ['t-text', 't-val', 't-pass', 't-email', 't-num', 't-search', 't-tel', 't-url', 't-req', 't-dis', 't-ro', 't-tall', 't-pad', 't-lh', 't-area', 't-date', 't-time', 't-dtl', 't-month', 't-week', 't-color', 't-range'];
  function sel(el) { try { return el.selectionStart === null ? null : [el.selectionStart, el.selectionEnd]; } catch (e) { return 'n/a'; } }
  function state(el) {
    var s = [];
    if (el.matches(':focus')) s.push('focus');
    if (el.matches(':invalid')) s.push('invalid');
    if (el.matches(':placeholder-shown')) s.push('placeholder');
    if (el.matches(':checked')) s.push('checked');
    if (el.matches(':disabled')) s.push('disabled');
    if (el.matches(':read-only')) s.push('read-only');
    return s.join(' ');
  }
  window.__benchCase = {
    setup: function () {
      ['t-text', 't-email', 't-area', 'ce'].forEach(function (id) {
        var el = document.getElementById(id);
        ['focus', 'blur', 'focusin', 'focusout', 'beforeinput', 'input', 'change', 'select'].forEach(function (t) {
          el.addEventListener(t, function (ev) { note(id + ':' + t + (ev.inputType ? ':' + ev.inputType : '') + (ev.data ? ':' + ev.data : '')); });
        });
      });
      ['t-cb', 't-r2', 't-sel', 't-multi', 't-range', 't-color', 't-num'].forEach(function (id) {
        var el = document.getElementById(id);
        ['input', 'change', 'click'].forEach(function (t) { el.addEventListener(t, function () { note(id + ':' + t); }); });
      });
      $('#f').addEventListener('invalid', function (ev) { note('invalid:' + ev.target.id); }, true);
      $('#f').addEventListener('reset', function () { note('reset'); });
    },
    steps: [
      { name: 'focus the empty text field (placeholder shown)', run: function () { $('#t-text').focus(); } },
      { name: 'type "Hello world"', run: function () { r.typed = type('Hello world'); } },
      { name: 'caret to offset 5 (setSelectionRange)', run: function () { $('#t-text').setSelectionRange(5, 5); } },
      { name: 'select "world"', run: function () { $('#t-text').setSelectionRange(6, 11); } },
      { name: 'select all and type over it', run: function () { $('#t-text').select(); type('Hi there'); } },
      { name: 'blur: focus the email field', run: function () { $('#t-email').focus(); } },
      { name: 'refocus the text field (value and caret kept)', run: function () { $('#t-text').focus(); } },
      { name: 'type an invalid e-mail (:invalid)', run: function () { $('#t-email').focus(); type('not-an-email'); var v = $('#t-email').validity; r.email = { typeMismatch: v.typeMismatch, valid: v.valid, msg: !!$('#t-email').validationMessage }; } },
      { name: 'select all and type a valid e-mail', run: function () { $('#t-email').select(); type('ann@example.com'); r.email2 = $('#t-email').validity.valid; } },
      { name: 'password: type "secret"', run: function () { $('#t-pass').focus(); type('secret'); r.pass = $('#t-pass').value.length; } },
      { name: 'number: stepUp, stepDown, over max', run: function () {
        var n = $('#t-num');
        n.focus();
        n.stepUp(); n.stepUp();
        var a = n.value;
        n.stepDown();
        var b = n.value;
        n.select(); type('60');
        r.number = { a: a, b: b, c: n.value, asNumber: n.valueAsNumber, over: n.validity.rangeOverflow, step: n.validity.stepMismatch };
      } },
      { name: 'search, tel and url fields', run: function () {
        $('#t-search').focus(); type('query');
        $('#t-tel').focus(); type('+358 40 1');
        $('#t-url').focus(); type('not a url');
        r.url = $('#t-url').validity.typeMismatch;
      } },
      { name: 'textarea: type two lines', run: function () { $('#t-area').focus(); type('First line\nSecond line'); r.area = { lines: $('#t-area').value.split('\n').length, len: $('#t-area').textLength }; } },
      { name: 'date and time fields: values', run: function () {
        var d = $('#t-date');
        r.dates = { date: d.valueAsNumber, time: $('#t-time').valueAsNumber, month: $('#t-month').valueAsNumber, week: $('#t-week').valueAsNumber, dtl: $('#t-dtl').valueAsNumber };
        d.value = '2025-12-31';
        r.dates.under = d.validity.rangeUnderflow;
        d.valueAsNumber = Date.UTC(2026, 5, 1);
        r.dates.set = d.value;
        $('#t-time').value = '25:00';
        r.dates.badTime = $('#t-time').value;
        $('#t-time').value = '08:30';
        $('#t-date').focus();
      } },
      { name: 'color and range', run: function () {
        var c = $('#t-color'), g = $('#t-range');
        c.value = '#FF8800';
        r.color = c.value;
        c.value = 'red';
        r.colorBad = c.value;
        c.value = '#ff8800';
        g.stepUp(); g.stepUp(); g.stepUp();
        r.range = { v: g.value, asNumber: g.valueAsNumber };
        g.value = '37';
        r.range.snapped = g.value;
        g.value = '500';
        r.range.clamped = g.value;
        g.value = '70';
        g.dispatchEvent(new Event('input', { bubbles: true }));
      } },
      { name: 'checkbox and radio clicks', run: function () { $('#t-cb').click(); $('#t-cb2').click(); $('#t-r2').click(); r.radio = [$('#t-r1').checked, $('#t-r2').checked, $('#t-r3').checked]; } },
      { name: 'select single and multiple', run: function () {
        var s = $('#t-sel'), m = $('#t-multi');
        s.value = 'c';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        m.options[0].selected = true; m.options[2].selected = true;
        r.select = { single: [s.value, s.selectedIndex, s.selectedOptions.length], multi: Array.prototype.map.call(m.selectedOptions, function (o) { return o.value; }).join(','), mvalue: m.value };
      } },
      { name: 'file input', run: function () { var f = $('#t-file'); r.file = { value: f.value, files: f.files ? f.files.length : null, multiple: f.multiple }; } },
      { name: 'disabled and readonly: focus and type change nothing', run: function () {
        var was = document.activeElement.id;
        $('#t-dis').focus();
        var a = document.activeElement.id;
        $('#t-ro').focus();
        var b = document.activeElement.id;
        var typed = type('xyz');
        r.locked = { was: was, afterDisabled: a, afterReadonly: b, typed: typed, dis: $('#t-dis').value, ro: $('#t-ro').value, willValidate: [$('#t-dis').willValidate, $('#t-ro').willValidate] };
      } },
      { name: 'contenteditable: focus, caret at the end, type', run: function () {
        var ce = $('#ce');
        ce.focus();
        var range = document.createRange();
        range.selectNodeContents(ce);
        range.collapse(false);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
        type(' now');
        r.ce = { text: ce.textContent, html: ce.innerHTML, active: document.activeElement.id, isEditable: ce.isContentEditable };
      } },
      { name: 'type into the 40px tall field', run: function () { var t = $('#t-tall'); t.focus(); t.setSelectionRange(4, 4); type('er'); } },
      { name: 'type into the padded field', run: function () { var t = $('#t-pad'); t.focus(); type('!'); } },
      { name: 'type into the line-height field', run: function () { var t = $('#t-lh'); t.focus(); t.setSelectionRange(0, 4); type('Row'); } },
      { name: 'checkValidity: required field empty', run: function () { r.validity = { form: $('#f').checkValidity(), req: $('#t-req').validity.valueMissing }; } },
      { name: 'form reset', run: function () { $('#f').reset(); r.reset = { text: $('#t-text').value, val: $('#t-val').value, num: $('#t-num').value, cb: $('#t-cb').checked, cb2: $('#t-cb2').checked, sel: $('#t-sel').value, range: $('#t-range').value, color: $('#t-color').value }; } },
      { name: 'focus the text field again', run: function () { $('#t-text').focus(); } },
    ],
    probe: function () {
      var f = {};
      TEXTS.forEach(function (id) { var el = document.getElementById(id); f[id] = [el.value, sel(el), state(el)]; });
      ['t-cb', 't-cb2', 't-r1', 't-r2', 't-r3', 't-sel', 't-multi', 't-file'].forEach(function (id) { f[id] = state(document.getElementById(id)); });
      return { active: document.activeElement ? document.activeElement.id || document.activeElement.localName : null, fields: f, form: state($('#f')), r: r, log: log.join(' ') };
    },
  };
})();
