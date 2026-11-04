const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('music.js', 'utf8');
function harness(available = true) {
  const elements = {};
  for (const id of ['musicBtn','musicFile','musicStatus','musicSave','musicResult','musicPreview']) {
    elements[id] = {files: [], addEventListener(event, callback) {this[event] = callback;}, removeAttribute(){}, load(){}};
  }
  const requests = [];
  const ctx = vm.createContext({URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => {
      requests.push(url);
      return {ok: available, headers:{get:()=> 'application/json'}, json:async()=>available
        ? {serviceUrl:'https://audio.example.com',token:'token'} : {error:'Serviço não configurado.'}};
    }, document: {getElementById: id => elements[id]}});
  vm.runInContext(source, ctx);
  return {elements, requests};
}
(async () => {
  const h = harness();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.musicBtn.disabled, false);
  await h.elements.musicBtn.click();
  assert.match(h.elements.musicStatus.textContent, /Selecione um vídeo/);
  h.elements.musicFile.files = [{size: 201 * 1024 * 1024}];
  await h.elements.musicBtn.click();
  assert.match(h.elements.musicStatus.textContent, /200 MB/);
  assert.deepEqual(h.requests, ['/api/music']);
  const unavailable = harness(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unavailable.elements.musicStatus.textContent, 'Serviço não configurado.');
  assert.equal(unavailable.elements.musicBtn.disabled, false);
  assert(!source.includes('/api/extract'));
  console.log('Music UI checks passed (availability, missing/oversized input, isolated requests)');
})().catch(error => {console.error(error); process.exit(1);});
