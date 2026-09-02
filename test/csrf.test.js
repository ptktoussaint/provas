const test = require('node:test');
const assert = require('node:assert/strict');
const { verifySameOrigin } = require('../middleware/csrf');

function makeReq({ method = 'POST', origin, referer, host = 'provas.example.com' }) {
  return {
    method,
    get(header) {
      if (header === 'origin') return origin;
      if (header === 'referer') return referer;
      if (header === 'host') return host;
      return undefined;
    },
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('verifySameOrigin deixa passar métodos seguros sem checar origem', () => {
  const req = makeReq({ method: 'GET', origin: 'https://attacker.example.com' });
  const res = makeRes();
  let called = false;
  verifySameOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('verifySameOrigin deixa passar POST quando a origem bate com o host', () => {
  const req = makeReq({ method: 'POST', origin: 'https://provas.example.com', host: 'provas.example.com' });
  const res = makeRes();
  let called = false;
  verifySameOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('verifySameOrigin bloqueia POST de outra origem', () => {
  const req = makeReq({ method: 'POST', origin: 'https://attacker.example.com', host: 'provas.example.com' });
  const res = makeRes();
  let called = false;
  verifySameOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('verifySameOrigin permite POST sem cabeçalho Origin/Referer (clientes que não enviam)', () => {
  const req = makeReq({ method: 'POST', host: 'provas.example.com' });
  const res = makeRes();
  let called = false;
  verifySameOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});
