/* SPDX-License-Identifier: GPL-3.0-only */
// 캐릭터 읽기·카드 변환·수신함 업로드(prepare). core.js에서 그대로 옮겼어요(Phase 17).
// 전송 방식(요청 함수)은 호출자가 넘겨요. 이 파일에는 주소·토큰·저장소·네트워크 코드가 없어요.
(function (root) {
  'use strict';
  const protocol = 'botkive-inbox/2';
  const READ_AHEAD = 4;  // 에셋을 동시에 읽는 수. 큰 파일이 겹쳐도 메모리가 크게 늘지 않게 작게 둬요
  const MAX_READ_ASSETS = 16384;  // 읽기를 멈추는 안전선. 실제 한도(6144개)는 봇카이브가 hello로 알려요
  const texts = ['name','creator','desc','personality','scenario','firstMessage','exampleMessage','creatorNotes','systemPrompt','postHistoryInstructions','replaceGlobalNote','characterVersion'];
  const loreFields = {key:'string',secondkey:'string',insertorder:'number',comment:'string',content:'string',mode:'string',alwaysActive:'boolean',selective:'boolean',activationPercent:'number',useRegex:'boolean',bookVersion:'number',id:'string',folder:'string'};
  const regexFields = {comment:'string',in:'string',out:'string',type:'string',flag:'string',ableFlag:'boolean'};
  function check(ok, message) { if (!ok) throw new Error(message); }
  // PocketRisu는 이런 칸을 고치지 않고 저장하고, 쓸 때 값이 있는지 보거나 숫자로 계산해요. 그 동작과 같은 값으로 맞춰요.
  // 읽을 수 없는 값이면 undefined예요.
  function fit(value, type) {
    if (type === 'boolean') return !!value;
    if (type === 'string') return value === null ? undefined : String(value);
    const number = value === null || (typeof value === 'string' && !value.trim()) ? NaN : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  // fix가 있으면 형식이 다른 값을 맞춰서 보내고 fix.changed에 칸 이름을 남겨요. 없으면 지금처럼 멈춰요.
  // fix.blank: 읽을 수 없는 값을 빈 값(''·0)으로 둬요. 아니면 그 칸을 보내지 않아요.
  function project(value, schema, nullable=[], fix=null) {
    check(value && typeof value === 'object' && !Array.isArray(value), '지원하지 않는 데이터 형식이에요');
    const out = {};
    for (const [key,type] of Object.entries(schema)) if (value[key] !== undefined) {
      const item = value[key];
      if(item===null && nullable.includes(key)){out[key]=null;continue;}
      if(typeof item === type && (type !== 'number' || Number.isFinite(item))){out[key]=item;continue;}
      // 목록·객체는 무슨 값인지 알 수 없어서 맞추지 않아요.
      check(fix && (item===null || typeof item!=='object'), `필드 형식이 바뀌었어요: ${key}`);
      fix.changed.add(key);
      const fitted = fit(item,type);
      if(fitted!==undefined) out[key]=fitted;
      else if(nullable.includes(key)) out[key]=null;
      else if(fix.blank) out[key]=type==='string'?'':0;
    }
    return out;
  }
  function array(value) { check(Array.isArray(value), '목록 형식이 바뀌었어요'); return value; }
  const EXT = /^[a-zA-Z0-9]{1,10}$/;
  // 확장자 자리에 파일 이름(그림.png)이 저장된 카드가 있어요. 찾지 못하면 PocketRisu처럼 unknown이에요.
  function assetExt(given, path) {
    for (const text of [given,path]) {
      const ext = typeof text==='string' ? text.trim().split('.').pop() : '';
      if (EXT.test(ext)) return ext;
    }
    return 'unknown';
  }
  function assetPath(path) {
    check(typeof path==='string' && /^assets\/[A-Za-z0-9_.-]+$/.test(path) && !['.','..'].includes(path.slice(7)), '외부·불명확한 에셋 경로는 전송할 수 없어요');
    return path;
  }
  async function folders(api) {
    check(typeof api.getDatabase==='function','폴더 읽기 공식 API가 없어요');
    const db=await api.getDatabase(['characterOrder']);
    check(db && typeof db==='object' && !Array.isArray(db),'폴더 읽기 권한 또는 API 형식을 확인해 주세요');
    const entries=array(db.characterOrder);check(entries.length<=10000,'폴더 목록 한도를 넘었어요');
    const byCharacter=new Map(), ids=new Set();
    for(const entry of entries) {
      if(typeof entry==='string') {check(entry.length>0,'빈 캐릭터 ID예요');continue;}
      check(entry && typeof entry==='object' && !Array.isArray(entry),'폴더 형식이 바뀌었어요');
      check(typeof entry.id==='string' && entry.id.length>0 && entry.id.length<=200 && typeof entry.name==='string' && entry.name.length>0 && entry.name.length<=200 && !ids.has(entry.id),'폴더 ID 또는 이름이 잘못됐어요');
      ids.add(entry.id);
      const members=array(entry.data);check(members.length<=10000,'폴더 구성원 한도를 넘었어요');
      const seen=new Set();
      for(const id of members) {
        check(typeof id==='string' && id && !seen.has(id),'폴더 소속 정보가 손상됐어요');seen.add(id);
        if(!byCharacter.has(id)) byCharacter.set(id,[]);
        byCharacter.get(id).push({id:entry.id,name:entry.name});
      }
    }
    return byCharacter;
  }
  function projectLore(value, changed=new Set()) {
    const fix={changed,blank:true};
    const out=project(value,loreFields,['activationPercent','alwaysActive','selective','useRegex','secondkey','comment','mode','id','folder','bookVersion'],fix);
    if(value.extentions!==undefined)out.extentions=value.extentions===null?null:project(value.extentions,{risu_case_sensitive:'boolean'},['risu_case_sensitive'],fix);
    if(value.loreCache!==undefined) {
      if(value.loreCache===null)out.loreCache=null;
      else {out.loreCache=project(value.loreCache,{key:'string'});out.loreCache.data=array(value.loreCache.data).map(x=>{check(typeof x==='string','로어 캐시 형식이 바뀌었어요');return x;});}
    }
    return out;
  }
  function extract(c) {
    check(c && typeof c.chaId === 'string' && c.chaId && typeof c.name === 'string', '캐릭터 식별 정보가 없어요');
    check(!c.type || c.type === 'character', '개별 캐릭터만 지원해요');
    check(!c.additionalAssetManifest, '에셋 목록을 완전히 읽지 못했어요');
    const character = project(c, Object.fromEntries(texts.map(k=>[k,'string'])));
    for (const key of ['alternateGreetings','tags']) character[key] = array(c[key] ?? []).map(x=>{check(typeof x==='string','문자열 목록이 아니에요'); return x;});
    const fixed={lore:new Set(),regex:new Set(),settings:new Set()};
    character.globalLore = array(c.globalLore ?? []).map(x=>projectLore(x,fixed.lore));
    character.customscript = array(c.customscript ?? []).map(x=>project(x,regexFields,[],{changed:fixed.regex,blank:true}));
    character.loreSettings = project(c.loreSettings ?? {}, {scanDepth:'number',tokenBudget:'number',recursiveScanning:'boolean',fullWordMatching:'boolean'}, [], {changed:fixed.settings,blank:false});
    const warnings = ['선택한 필드만 보관해요. 동적 리소스·모듈 의존성과 기타 추가 설정은 완전 보존을 보장하지 않아요.'];
    if (c.triggerscript?.length) warnings.push('트리거 스크립트는 이번 버전에서 제외해요.');
    if (c.gptSoVitsConfig || c.ttsMode || c.backgroundHTML || c.backgroundCSS) warnings.push('음성 설정과 배경의 추가 리소스는 지원 범위 밖이에요.');
    if(c.globalLore?.some(x=>x.bookVersion!==undefined))warnings.push('bookVersion은 보존용 정보에만 남아요. 재가져오기 시 PocketRisu의 확률·본문 마이그레이션이 적용될 수 있어요.');
    if(c.loreExt || c.globalLore?.some(x=>x.extentions && Object.keys(x.extentions).some(k=>k!=='risu_case_sensitive')))warnings.push('로어북의 미지원 확장 설정은 제외해요. 대소문자·확률·캐시·폴더는 보존해요.');
    const omitted=['bias','sdData','newGenData','defaultVariables','customModuleToggle','moduleNamespace','lowLevelAccess','utilityBot','additionalText','backgroundHTML','backgroundCSS'].filter(k=>c[k]!==undefined && c[k]!==null);
    if(omitted.length)warnings.push('이번 보관에서 제외하는 추가 설정: '+omitted.join(', '));
    const assets = [], seen = new Set();
    let fixedAssets = 0;
    function add(path,rawName,kind,given) {
      assetPath(path);
      // 이름은 표시용이라 비어 있으면 파일 이름을 써요. 목록·객체는 알 수 없어서 멈춰요.
      check(rawName===null || rawName===undefined || typeof rawName!=='object', '에셋 이름 또는 확장자를 확인해 주세요');
      const name=typeof rawName==='string'?rawName:rawName===null||rawName===undefined?path.slice(7).replace(/\.[^.]*$/,''):String(rawName);
      // 경로를 벗어나려는 값은 멈춰요. 나머지는 적힌 값, '.' 뒤의 글자, 파일 경로의 확장자 순서로 찾아요.
      check(typeof given!=='string' || !/(^|[/\\])\.\.([/\\]|$)/.test(given), '에셋 이름 또는 확장자를 확인해 주세요');
      const ext=assetExt(given,path);
      const fixedExt=given!==null && given!==undefined && given!=='' && !EXT.test(given);
      // PocketRisu는 같은 이름에 파일 여러 개를 둘 수 있어요(이름 그대로 보내요). 완전히 같은 항목만 한 번 보내요.
      const key=JSON.stringify([kind,name,path]);
      if(seen.has(key)) return;
      seen.add(key);
      if(fixedExt || typeof rawName!=='string') fixedAssets++;
      assets.push({path,name,kind,ext:ext.toLowerCase()});
    }
    if (c.image) add(assetPath(c.image),'main','icon',c.image.split('.').pop());
    for (const t of array(c.emotionImages ?? [])) { check(Array.isArray(t)&&t.length===2,'표정 목록 형식이 바뀌었어요'); add(assetPath(t[1]),t[0],'emotion',t[1].split('.').pop()); }
    for (const t of array(c.additionalAssets ?? [])) { check(Array.isArray(t)&&t.length===3,'추가 에셋 형식이 바뀌었어요'); add(assetPath(t[1]),t[0],'x-risu-asset',t[2] || t[1].split('.').pop()); }
    for (const a of array(c.ccAssets ?? [])) {
      check(a && typeof a==='object' && !Array.isArray(a),'카드 에셋 형식이 바뀌었어요');
      if (a.uri==='ccdefault:' && c.image) continue;
      check(['icon','emotion','x-risu-asset','image','audio','video'].includes(a.type),'지원하지 않는 카드 에셋 종류예요');
      add(a.uri,a.name,a.type,a.ext);
    }
    check(assets.length<=MAX_READ_ASSETS,`에셋이 ${MAX_READ_ASSETS}개를 넘어 읽지 않았어요`);  // 실제 한도는 봇카이브가 hello로 알려요
    const names=(label,set)=>set.size?[`${label} ${[...set].join(', ')}`]:[];
    const fixedFields=[...names('로어북',fixed.lore),...names('정규식',fixed.regex),...names('로어북 설정',fixed.settings)];
    if(fixedFields.length)warnings.push('형식을 맞춰서 보낸 칸: '+fixedFields.join(' / '));
    if(fixedAssets)warnings.push(`이름이나 확장자를 맞춰서 보낸 에셋: ${fixedAssets}개`);
    return {protocol,sourceCharacterId:c.chaId,character,assets,warnings};
  }
  async function sha(bytes) { return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join(''); }
  function b64(bytes) { let s=''; for(let i=0;i<bytes.length;i+=8192) s+=String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(s); }
  function cancelled(signal) { check(!signal?.aborted,'사용자가 전송을 중단했어요'); }
  async function safeFolders(api) {
    try { return await folders(api); } catch { return null; }
  }
  // 요청 구현은 호출자가 제공해요. 로컬 통합 경로에는 주소·토큰·nativeFetch가 없어요.
  const MB=n=>Math.ceil(n/1048576);
  // 봇카이브가 알려 준 한도를 따라요. 예전 봇카이브는 한도 칸이 없어 예전 값(128MB·128개·256KB 조각)을 써요.
  // pieces: 먼저 보낼 조각 크기부터 차례로(막히면 다음 크기로 줄여요).
  function limitsOf(hello) {
    const int=(v,lo,hi)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi;
    check(hello && hello.chunkBytes===256*1024 && int(hello.maxAssetBytes,1,256*1048576),'수신 한도가 달라요');
    const maxTotalBytes=hello.maxTotalBytes ?? 128*1048576, maxAssets=hello.maxAssets ?? 128;
    check(int(maxTotalBytes,hello.maxAssetBytes,4096*1048576) && int(maxAssets,1,MAX_READ_ASSETS),'수신 한도가 달라요');
    const most=hello.maxChunkBytes ?? hello.chunkBytes;
    check(int(most,hello.chunkBytes,64*1048576),'수신 한도가 달라요');
    const pieces=[most,...[8,4,1].map(n=>n*1048576).filter(n=>n<most && n>hello.chunkBytes)];
    if(most>hello.chunkBytes)pieces.push(hello.chunkBytes);
    // 묶음 요청(chunks)은 새 봇카이브만 받아요. 예전 봇카이브는 한 요청에 조각 하나예요.
    const maxBatchItems=hello.maxBatchItems ?? 1;
    check(int(maxBatchItems,1,MAX_READ_ASSETS),'수신 한도가 달라요');
    return {maxAssetBytes:hello.maxAssetBytes,maxTotalBytes,maxAssets,chunkBytes:hello.chunkBytes,pieces,maxBatchItems};
  }
  // 조각이 커서 막힌 것 같은 실패인지 봐요. 413(프록시·중계의 거절)이나 응답을 받지 못한 경우예요.
  // 봇카이브가 봉인해 보낸 거절(400·409·507 등)과 인증 거절(401·403)은 크기와 상관없어요.
  function pieceTooBig(error) {
    if(error?.status===413 || error?.httpStatus===413) return true;
    return error?.status===0 && error?.uncertain===true && ![401,403].includes(error?.httpStatus);
  }
  // 에셋을 앞서 읽어 두고 순서대로 꺼내요. 쓰지 않게 된 읽기가 실패해도 처리 안 된 오류로 남지 않게 해요.
  function reader(api,assets) {
    const started=new Map();let next=0;
    return index=>{
      while(next<assets.length && next<index+READ_AHEAD) {
        const {path}=assets[next];
        const read=Promise.resolve().then(()=>api.readImage(path));
        read.catch(()=>{});
        started.set(next++,read);
      }
      const read=started.get(index);started.delete(index);
      return read;
    };
  }
  // 받은 에셋을 모아 요청 하나에 담아 보내요. 파일이 작으면 여러 개가, 크면 잘린 조각이 한 요청에 들어가요.
  // 줄여 다시 보내도 안전해요: 봇카이브는 이미 받은 자리의 조각을 비교만 하고 이어 받아요.
  // pace.piece에 줄인 크기를 기억해서 다음 에셋·다음 캐릭터는 처음부터 그 크기로 보내요.
  function sender(request,session,hello,pace,signal,onSent) {
    const queue=[];let queued=0;
    const limit=()=>Math.min(pace.piece ?? Infinity,hello.pieces[0]);
    const flush=async()=>{
      cancelled(signal);
      const budget=limit(),parts=[];let used=0;
      for(const entry of queue) {
        if(used>=budget || parts.length>=hello.maxBatchItems) break;
        const part=entry.bytes.subarray(entry.offset,entry.offset+budget-used);
        parts.push({entry,part});used+=part.length;
      }
      const wire=parts.map(({entry,part})=>({index:entry.index,offset:entry.offset,size:entry.bytes.length,sha256:entry.hash,data:b64(part)}));
      try {
        if(hello.maxBatchItems>1) await request('chunks',{session,items:wire});
        else await request('chunk',{session,...wire[0]});
      } catch(error) {
        const smaller=pieceTooBig(error) && hello.pieces.find(n=>n<used);
        if(!smaller) throw error;
        pace.piece=smaller;
        return;
      }
      for(const {entry,part} of parts) {entry.offset+=part.length;queued-=part.length;}
      while(queue.length && queue[0].offset>=queue[0].bytes.length) {queue.shift();onSent();}
    };
    return {
      async add(index,bytes,hash) {
        queue.push({index,bytes,hash,offset:0});queued+=bytes.length;
        while(queue.length && (queued>=limit() || queue.length>=hello.maxBatchItems)) await flush();
      },
      async finish() { while(queue.length) await flush(); },
    };
  }
  async function prepare(api,row,request,acknowledge,onProgress,options) {
    const signal=options.signal, pace=options.pace ?? {};
    cancelled(signal);
    const hello=limitsOf(await request('hello'));
    check(/^[a-zA-Z0-9_-]{16,80}$/.test(options.sourceId),'출처 연결 ID가 필요해요');
    cancelled(signal);
    let c=await api.getCharacterFromIndex(row.index);
    check(c?.chaId===row.id,'목록이 바뀌었어요. 다시 조회해 주세요');
    const snapshot=extract(c);c=null;
    // 개수는 보내기 전에 알 수 있어요. 넘으면 이 캐릭터만 건너뛰고 다음으로 가요.
    check(snapshot.assets.length<=hello.maxAssets,`에셋이 ${snapshot.assets.length}개라 한도(${hello.maxAssets}개)를 넘어요`);
    // skipFolders: 사용자가 폴더 정보를 보내지 않기로 했어요(getDatabase를 부르지 않음).
    const membership=options.skipFolders?null:options.optionalFolders?await safeFolders(api):await folders(api);
    const operationId=options.operationId ?? root.crypto.randomUUID();
    check(/^[a-zA-Z0-9_-]{16,80}$/.test(operationId),'작업 ID 형식이 달라요');
    const warnings=membership?[...snapshot.warnings]:[...snapshot.warnings,options.skipFolders?'폴더 분류 정보는 보내지 않았어요. 봇카이브의 받은 봇 폴더에 들어가요.':'폴더 분류 정보를 읽지 못해 봇카이브의 받은 봇 폴더에 들어가요.'];
    const wire={...snapshot,warnings,sourceId:options.sourceId,operationId,folders:membership?.get(row.id) ?? [],assets:snapshot.assets.map(({path,...a})=>a)};
    const comparison=await request('compare',wire);
    cancelled(signal);
    check(await acknowledge(snapshot.warnings,{name:snapshot.character.name,assets:snapshot.assets.length,comparison}),'부분 보관 안내를 확인하지 않았어요');
    cancelled(signal);
    // 사전 크기 조회 API가 없어 기본값은 에셋 읽기 중단이에요.
    check(snapshot.assets.length===0 || options.allowUnboundedRead===true,'사전 크기를 알 수 없는 에셋 읽기는 기본 차단돼요. 확인된 소형 시험 자료만 별도로 허용하세요');
    const session=await sha(new TextEncoder().encode(JSON.stringify([options.sourceId,operationId])));
    const expectedSession=session.slice(0,32);
    let begun=false;
    try {
      begun=true;
      const started=await request('begin',wire);
      check(started.session===expectedSession,'수신 세션 형식이 달라요');
      if(started.state==='complete') return started;
      cancelled(signal);
      const hashes=[];let totalBytes=0,sent=0;
      const read=reader(api,snapshot.assets);
      const out=sender(request,expectedSession,hello,pace,signal,()=>onProgress(++sent,snapshot.assets.length));
      for(let index=0;index<snapshot.assets.length;index++) {
        cancelled(signal);
        const label=`${index+1}번째 에셋(${String(snapshot.assets[index].name).slice(0,40)})`;
        let bytes=await read(index);
        cancelled(signal);
        // 어떤 실행 문맥에서 만든 바이트든 이 문맥의 Uint8Array 보기로 바꿔요(크기 검사는 아래 그대로).
        if(Object.prototype.toString.call(bytes)==='[object ArrayBuffer]')bytes=new Uint8Array(bytes);
        else if(ArrayBuffer.isView(bytes))bytes=new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        check(bytes instanceof Uint8Array && bytes.length>0,`${label}을 PocketRisu에서 읽지 못했어요(파일이 없거나 비어 있어요)`);
        check(bytes.length<=hello.maxAssetBytes,`${label}이 ${MB(bytes.length)}MB라 파일 한도(${MB(hello.maxAssetBytes)}MB)를 넘어요`);
        totalBytes+=bytes.length;check(totalBytes<=hello.maxTotalBytes,`에셋 합계가 ${MB(hello.maxTotalBytes)}MB를 넘어 캐릭터 용량 한도를 넘었어요`);
        const hash=await sha(bytes);hashes.push(hash);
        await out.add(index,bytes,hash);
        bytes=null;
      }
      await out.finish();
      cancelled(signal);
      return await request('finish',{session:expectedSession,hashes});
    } catch(error) {
      if(begun) {
        try {await request('abort',{session:expectedSession});}
        catch {throw new Error('전송 실패: 취소 요청도 확인하지 못했어요. 수신함에서 확인해 주세요');}
      }
      throw error;
    }
  }
  const card = {protocol, check, project, array, assetPath, folders, projectLore, extract, sha, b64, cancelled, safeFolders, prepare, limitsOf};
  root.BotkiveCard = card;
  if (typeof module !== 'undefined') module.exports = card;
})(globalThis);
