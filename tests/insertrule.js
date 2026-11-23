// rules inserted one by one, anywhere in the sheet, and deleted: the
// cascade reads them in their order each time
(function () {
  var sh = document.getElementById('s').sheet, p = document.querySelector('p'), r = [];
  sh.insertRule('.a{color:red}', 0); r.push(getComputedStyle(p).color);
  sh.insertRule('p.a{color:blue}', 1); r.push(getComputedStyle(p).color);
  sh.insertRule('.a{color:green}', 0); r.push(getComputedStyle(p).color, sh.cssRules.length);
  sh.deleteRule(2); r.push(getComputedStyle(p).color);
  sh.insertRule('p.a{color:rgb(1,2,3) !important}', 0); r.push(getComputedStyle(p).color);
  return r.join(',');
})()
