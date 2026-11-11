const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve(__dirname, '../public');
fs.mkdirSync(out, {recursive:true});
fs.copyFileSync(path.resolve(__dirname, '../index.html'), path.join(out,'index.html'));
fs.cpSync(path.resolve(__dirname,'../assets'), path.join(out,'assets'), {recursive:true});
for (const [pkg, files, destination] of [
  ['@ffmpeg/ffmpeg', ['ffmpeg.js','814.ffmpeg.js'], 'ffmpeg'],
  ['@ffmpeg/core', ['ffmpeg-core.js','ffmpeg-core.wasm'], 'ffmpeg-core']
]) {
 const base = path.resolve(__dirname,'../node_modules',pkg,'dist/umd');
 const dest = path.join(out,'assets/vendor',destination);
 fs.mkdirSync(dest,{recursive:true});
 for (const file of files) fs.copyFileSync(path.join(base,file),path.join(dest,file));
}
console.log('Static app and pinned FFmpeg assets built in public/');
