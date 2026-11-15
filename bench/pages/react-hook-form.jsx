// SPDX-License-Identifier: MIT
// React Hook Form 7 on React 19: registered (uncontrolled) inputs with
// built-in rules, a number as valueAsNumber, a select, radios, a checkbox,
// a textarea with a watched counter, a field array (add, type, remove),
// errors shown on submit and re-validated on change, focus moved to the
// first invalid field, submit and reset. Text is typed as test tools type
// it: keydown, document.execCommand('insertText'), keyup, so React sees the
// browser's own input events.
import { createRoot } from 'react-dom/client';
import { useForm, useFieldArray } from 'react-hook-form';

let api = {};
function App() {
  const { register, handleSubmit, watch, reset, control, formState: { errors, isDirty, isValid, submitCount, isSubmitSuccessful } } = useForm({
    mode: 'onTouched', reValidateMode: 'onChange',
    defaultValues: { name: '', email: '', age: '', country: '', plan: 'basic', bio: '', terms: false, tags: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'tags' });
  const bio = watch('bio') || '';
  api = { reset, append, remove };
  const onSubmit = (data) => { document.getElementById('out').textContent = JSON.stringify(data); };
  const err = (k) => errors[k] ? <span className="err" id={'err-' + k}>{errors[k].message}</span> : null;
  return <form id="rhf" onSubmit={handleSubmit(onSubmit)} noValidate>
    <div className="row"><label htmlFor="name">Name</label><input id="name" placeholder="Your name" aria-invalid={errors.name ? 'true' : 'false'} {...register('name', { required: 'Name is required', minLength: { value: 2, message: 'At least 2 characters' } })} />{err('name')}</div>
    <div className="row"><label htmlFor="email">E-mail</label><input id="email" type="email" placeholder="name@example.com" aria-invalid={errors.email ? 'true' : 'false'} {...register('email', { required: 'E-mail is required', pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: 'Not an e-mail address' } })} />{err('email')}</div>
    <div className="row"><label htmlFor="age">Age</label><input id="age" type="number" aria-invalid={errors.age ? 'true' : 'false'} {...register('age', { required: 'Age is required', valueAsNumber: true, min: { value: 18, message: 'Must be 18 or older' } })} />{err('age')}</div>
    <div className="row"><label htmlFor="country">Country</label><select id="country" aria-invalid={errors.country ? 'true' : 'false'} {...register('country', { required: 'Choose a country' })}><option value="">Choose…</option><option value="fi">Finland</option><option value="se">Sweden</option><option value="no">Norway</option></select>{err('country')}</div>
    <div className="row"><span className="lbl">Plan</span><label className="opt"><input type="radio" value="basic" {...register('plan')} /> Basic</label><label className="opt"><input type="radio" value="pro" id="plan-pro" {...register('plan')} /> Pro</label></div>
    <div className="row tall"><label htmlFor="bio">Bio</label><textarea id="bio" maxLength={120} {...register('bio', { maxLength: 120 })} /><span id="count">{bio.length} / 120</span></div>
    <div className="row"><span className="lbl"></span><label className="opt"><input id="terms" type="checkbox" {...register('terms', { required: 'Accept the terms' })} /> I accept the terms</label>{err('terms')}</div>
    <div className="row tags"><span className="lbl">Tags</span><div id="tags">{fields.map((f, i) => <span className="tag" key={f.id}><input className="tagin" placeholder={'Tag ' + (i + 1)} {...register(`tags.${i}.value`, { required: 'Empty tag' })} /><button type="button" className="rm" onClick={() => remove(i)}>×</button></span>)}<button type="button" id="add" onClick={() => append({ value: '' })}>Add tag</button></div></div>
    <div className="row"><span className="lbl"></span><button id="submit" type="submit">Submit</button><button id="clear" type="button" onClick={() => reset()}>Reset</button></div>
    <div id="state">{`dirty=${isDirty} valid=${isValid} submits=${submitCount} ok=${isSubmitSuccessful}`}</div>
    <pre id="out"></pre>
  </form>;
}

const $ = (s) => document.querySelector(s);
function key(el, type, k) { el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, composed: true })); }
function type(text) {
  const el = document.activeElement;
  for (const ch of text) { key(el, 'keydown', ch); document.execCommand('insertText', false, ch); key(el, 'keyup', ch); }
}
const settle = () => window.__bench.sleep(30).then(() => window.__bench.frames(2));
const focusType = (sel, text) => { $(sel).focus(); type(text); return settle(); };
window.__benchCase = {
  setup() { createRoot($('#app')).render(<App />); return settle(); },
  steps: [
    { name: 'submit the empty form (errors, focus to the first)', run: () => { $('#submit').click(); return settle(); } },
    { name: 'type "A" in the focused name (too short)', run: () => { type('A'); return settle(); } },
    { name: 'type "nna" (name valid)', run: () => { type('nna'); return settle(); } },
    { name: 'e-mail: type an incomplete address', run: () => focusType('#email', 'ann@') },
    { name: 'e-mail: complete it', run: () => { type('example.com'); return settle(); } },
    { name: 'age: 17 (too young)', run: () => focusType('#age', '17') },
    { name: 'age: select all, type 30', run: () => { $('#age').select(); type('30'); return settle(); } },
    { name: 'country, plan and terms', run: () => {
      const c = $('#country');
      c.focus(); c.value = 'se'; c.dispatchEvent(new Event('change', { bubbles: true }));
      $('#plan-pro').click(); $('#terms').click();
      return settle();
    } },
    { name: 'bio: type, the counter follows', run: () => focusType('#bio', 'Hello from the form test') },
    { name: 'add two tags', run: () => { $('#add').click(); return settle().then(() => { $('#add').click(); return settle(); }); } },
    { name: 'type in both tags', run: () => { const t = document.querySelectorAll('.tagin'); t[0].focus(); type('red'); t[1].focus(); type('blue'); return settle(); } },
    { name: 'remove the first tag', run: () => { document.querySelector('.rm').click(); return settle(); } },
    { name: 'submit (valid)', run: () => { $('#submit').click(); return settle(); } },
    { name: 'reset', run: () => { $('#clear').click(); return settle(); } },
    { name: 'focus the name again', run: () => { $('#name').focus(); return settle(); } },
  ],
  probe() {
    const vals = {};
    document.querySelectorAll('#rhf [name]').forEach((e) => { vals[e.name + (e.type === 'radio' ? ':' + e.value : '')] = e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value; });
    return {
      values: vals,
      errors: [...document.querySelectorAll('.err')].map((e) => e.id + '=' + e.textContent),
      invalid: [...document.querySelectorAll('[aria-invalid=true]')].map((e) => e.id),
      active: document.activeElement ? document.activeElement.id || document.activeElement.name || document.activeElement.localName : null,
      count: ($('#count') || {}).textContent,
      state: ($('#state') || {}).textContent,
      out: ($('#out') || {}).textContent,
    };
  },
};
