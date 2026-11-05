// 패키지 설치 없이 설치용 스크립트를 생성해요.
const fs=require('node:fs');
// 체크아웃 줄바꿈(Windows CRLF)과 상관없이 같은 설치본이 나오게 LF로 맞춰요.
function bundle() {
  return '//@name botkive-link-mvp\n//@display-name 봇카이브 등록\n//@api 3.0\n'+
    ['preview.js','card.js','secure-link-v4.js','local-batch.js','manual.js'].map(name=>fs.readFileSync(require('node:path').join(__dirname,'src',name),'utf8').replace(/\r\n/g,'\n')).join('\n');
}
if(require.main===module){
  fs.mkdirSync('dist',{recursive:true});
  fs.writeFileSync('dist/botkive-link.js',bundle());
}
module.exports={bundle};
