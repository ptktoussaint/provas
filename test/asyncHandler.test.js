const test = require('node:test');
const assert = require('node:assert/strict');
const { asyncHandler, safeOn } = require('../lib/asyncHandler');

test('asyncHandler encaminha rejeição para next() em vez de virar unhandled rejection', async () => {
  const boom = new Error('boom');
  const handler = asyncHandler(async () => { throw boom; });

  let capturedErr = null;
  const next = (err) => { capturedErr = err; };

  let sawUnhandledRejection = false;
  const onUnhandled = () => { sawUnhandledRejection = true; };
  process.on('unhandledRejection', onUnhandled);

  handler({}, {}, next);
  // dá tempo pro microtask da Promise rejeitada rodar
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  process.off('unhandledRejection', onUnhandled);

  assert.equal(capturedErr, boom);
  assert.equal(sawUnhandledRejection, false);
});

test('asyncHandler não interfere quando o handler resolve normalmente', async () => {
  let called = false;
  const handler = asyncHandler(async (req, res) => { called = true; res.ok = true; });
  const res = {};
  handler({}, res, () => { throw new Error('next não deveria ser chamado'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, true);
  assert.equal(res.ok, true);
});

test('safeOn loga e não propaga quando o handler de socket rejeita', async () => {
  const boom = new Error('socket boom');
  const listeners = {};
  const fakeSocket = { on: (event, fn) => { listeners[event] = fn; } };

  safeOn(fakeSocket, 'algum-evento', async () => { throw boom; });

  let sawUnhandledRejection = false;
  const onUnhandled = () => { sawUnhandledRejection = true; };
  process.on('unhandledRejection', onUnhandled);

  const originalError = console.error;
  let loggedWith = null;
  console.error = (...args) => { loggedWith = args; };

  listeners['algum-evento']();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  console.error = originalError;
  process.off('unhandledRejection', onUnhandled);

  assert.equal(sawUnhandledRejection, false);
  assert.ok(loggedWith && loggedWith.includes(boom));
});
