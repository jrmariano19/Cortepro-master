const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(fetch) {
  const elements = {};
  for(const id of ['urlInput','downloadBtn','statusBox','tabDownload','tabSplitter','downloadSection','splitterSection']) {
    elements[id] = { value:'https://www.instagram.com/reel/example/', style:{}, appendChild(node){this.child = node;} };
  }
  const ctx = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, fetch,
    document:{getElementById(id){return elements[id]},createElement(){return {}}}});
  vm.runInContext(script,ctx);
  return {ctx,elements};
}
(async()=> {
  const blocked = harness(async()=>({ok:false,headers:{get:()=> 'application/json'},json:async()=>({success:false,error:'A rede social exigiu login.'})}));
  const original = blocked.elements.urlInput.value;
  await vm.runInContext('processVideo()',blocked.ctx);
  assert.equal(blocked.elements.statusBox.textContent,'A rede social exigiu login.');
  assert.equal(blocked.elements.urlInput.value,original);
  assert.equal(blocked.elements.downloadBtn.disabled,false);
  const success = harness(async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({success:true,downloadUrl:'https://cdn.example.com/test.mp4',filename:'video.mp4'})}));
  await vm.runInContext('processVideo()',success.ctx);
  assert.equal(success.elements.statusBox.child.href,'https://cdn.example.com/test.mp4');
  assert.equal(success.elements.statusBox.child.download,'video.mp4');
  vm.runInContext("switchTab('splitter')",success.ctx);
  assert.equal(success.elements.splitterSection.style.display,'block');
  assert.throws(()=>vm.runInContext("safeDownloadUrl('javascript:alert(1)')",success.ctx));
  console.log('Frontend regression checks: passed (errors, retained input, download link, tabs, unsafe URL)');
})().catch(e=>{console.error(e);process.exit(1)});
