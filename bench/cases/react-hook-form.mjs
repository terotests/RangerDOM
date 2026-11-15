// SPDX-License-Identifier: MIT
const css = [
  "body{margin:0;font:14px Arial;color:#222}",
  "form{padding:12px 16px;width:760px}",
  ".row{display:flex;align-items:center;gap:10px;min-height:36px}.row.tall{min-height:70px}",
  ".row>label:first-child,.lbl{width:90px;flex:none;color:#555}",
  "input:not([type=radio]):not([type=checkbox]),select,textarea{font:inherit;width:260px;height:30px;padding:4px 8px;border:1px solid #9a9a9a;border-radius:4px;box-sizing:border-box;background:#fff}",
  "textarea{height:56px;resize:none}",
  "input:focus,select:focus,textarea:focus{outline:2px solid rgb(37,99,235);outline-offset:1px}",
  "[aria-invalid=true]{border-color:rgb(220,38,38)!important;background:rgb(254,242,242)!important}",
  ".err{color:rgb(220,38,38);font-size:13px}",
  ".opt{display:inline-flex;align-items:center;gap:4px;margin-right:12px}",
  "#tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.tag{display:inline-flex;gap:2px}.tagin{width:110px!important}",
  "button{font:inherit;height:30px;padding:0 14px;border:1px solid #2563eb;border-radius:4px;background:#2563eb;color:#fff}",
  "button[type=button]{background:#fff;color:#2563eb}.rm{padding:0 8px}",
  "#count{color:#666;font-size:12px}#state{margin-top:8px;color:#444;font:12px monospace}#out{font:12px monospace;white-space:pre-wrap;color:#064}",
].join("\n");
export default {
  area: "Form library (React)",
  lib: "react-hook-form 7.66.0 + React 19",
  about: "React Hook Form: registered inputs with built-in rules (required, minLength, pattern, min, valueAsNumber), select, radios, checkbox, a textarea with a watched counter, a field array (add, type, remove). Errors on submit, focus moved to the first invalid field, re-validation as the user types, submit, reset. Typed with keydown + execCommand('insertText') + keyup, so React's onChange comes from the browser's input events. The picture check looks at every field's text, centring, caret and outline.",
  page: (ctx) => ({ css, body: '<div id="app"></div>', scripts: [ctx.bundle("react-hook-form", ctx.file("pages/react-hook-form.jsx"), { jsx: true })] }),
};
