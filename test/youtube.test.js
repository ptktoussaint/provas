const test = require('node:test');
const assert = require('node:assert/strict');
const { extractYoutubeId } = require('../lib/youtube');

test('extractYoutubeId aceita um ID puro', () => {
  assert.equal(extractYoutubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId extrai de watch?v=', () => {
  assert.equal(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId extrai de youtu.be', () => {
  assert.equal(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId extrai de /embed/ e /shorts/', () => {
  assert.equal(extractYoutubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYoutubeId ignora espaços em volta', () => {
  assert.equal(extractYoutubeId('  dQw4w9WgXcQ  '), 'dQw4w9WgXcQ');
});

test('extractYoutubeId retorna null para vazio', () => {
  assert.equal(extractYoutubeId(''), null);
  assert.equal(extractYoutubeId(null), null);
  assert.equal(extractYoutubeId(undefined), null);
});
