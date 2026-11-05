//@name botkive-link-mvp
//@display-name 봇카이브 등록
//@api 3.0
/* SPDX-License-Identifier: GPL-3.0-only */
(function(root) {
  'use strict';
  // 완료된 서재 등록만 받는 읽기 전용 계약. 수신함 영수증은 이 계약에 해당하지 않아요.
  function registeredIds(snapshot, scope) {
    if (snapshot == null) return null;
    if (!scope?.sourceId || !scope.botkiveId || snapshot.sourceId !== scope.sourceId ||
        snapshot.botkiveId !== scope.botkiveId || snapshot.complete !== true ||
        !Array.isArray(snapshot.registrations) || (snapshot.unresolved !== undefined &&
        (!Array.isArray(snapshot.unresolved) || snapshot.unresolved.length))) throw Error('등록 기준표를 확인하세요');
    const ids = new Set(), targets = new Set();
    for (const row of snapshot.registrations) {
      if (!row || typeof row.chaId !== 'string' || !row.chaId || !Number.isSafeInteger(row.botId) ||
          row.botId < 1 || ids.has(row.chaId) || targets.has(row.botId)) throw Error('등록 매핑이 모호해요');
      ids.add(row.chaId); targets.add(row.botId);
    }
    return ids;
  }

  async function inspect(api, {snapshot, scope, cancelled=()=>false, progress=()=>{}}={}) {
    const known=registeredIds(snapshot,scope), seen=new Set(), rows=[];
    const counts={candidate:0, skipped:0, unknown:0, failed:0};
    for (let index=0; index<10000; index++) {
      if (cancelled()) return {state:'cancelled', rows:[], counts};
      // 한 번에 한 캐릭터만 조회하고 표시용 ID·이름만 남겨요.
      let c;
      try { c=await api.getCharacterFromIndex(index); }
      catch { throw Error('목록 조회가 중단됐어요. 다시 조회하세요'); }
      if (cancelled()) return {state:'cancelled', rows:[], counts};
      if (c===null) return {state:'complete',rows,counts};
      if (c?.type && c.type!=='character') continue;
      if (typeof c?.chaId!=='string' || !c.chaId || typeof c.name!=='string') {
        counts.failed++;
      } else {
        if (seen.has(c.chaId)) throw Error('중복 원본 ID가 있어 판별을 중단했어요');
        seen.add(c.chaId);
        const state=known===null?'unknown':known.has(c.chaId)?'skipped':'candidate';
        counts[state]++;
        rows.push({index,id:c.chaId,name:c.name,state});
      }
      progress(index+1);
    }
    throw Error('목록 조회 한도를 넘었어요');
  }
  const preview={inspect};
  if(typeof module!=='undefined') module.exports=preview;
  else root.BotkivePreview=preview;
})(globalThis);

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

/* SPDX-License-Identifier: GPL-3.0-only */
// botkive-link/4 클라이언트(시험용). 설치 번들(build.js)에 넣지 않아요.
// v3의 자체 키스트림+HMAC 대신 Web Crypto 표준 AES-256-GCM을 써요. 재시도·상태 처리는 v3(Phase 14.1)와 같아요.
// - 페어링 코드는 bkl4_로 시작해요. v3 코드(bkl3_)는 받지 않아요.
// - 방향별 AES 키(요청·응답)는 내보낼 수 없는 CryptoKey로만 들고 있어요.
// - 요청마다 새 96비트 nonce. 이 클라이언트가 만든 nonce는 기억해 두고 겹치면 보내지 않아요.
// - AAD는 필드마다 4바이트 길이를 붙여 이어요. 판·방향·메서드·공개 출처·경로·kid·rid·nonce·시각을 묶어요.
(function (root) {
  'use strict';
  const VERSION = 'botkive-link/4';
  const PREFIX = '/api/link/v4/';
  const NONCE = 12, TAG = 16;
  // 불러올 때는 아무 전역도 쓰지 않아요(설치본 시작 시 부작용 없음). 처음 봉인할 때 만들어요.
  const enc = {encode: text => new TextEncoder().encode(text)}, dec = {decode: bytes => new TextDecoder().decode(bytes)};

  function check(ok, message) { if (!ok) throw new Error(message); }
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function u32(n) { return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
  function b64e(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(text) {
    check(typeof text === 'string' && /^[A-Za-z0-9_-]*$/.test(text) && text.length % 4 !== 1, '봉투 형식 오류');
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function aad(...fields) {
    return concat(...[VERSION, ...fields].map(f => { const b = enc.encode(String(f)); return concat(u32(b.length), b); }));
  }

  async function hkdf(subtle, ikm, salt, info, length) {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, key, length * 8));
  }

  // extractable=true는 교차 언어 시험 벡터용이에요. 실제 클라이언트는 기본값(false)만 써요.
  async function deriveKeys(code, subtle = root.crypto?.subtle, {usages = 'client', extractable = false} = {}) {
    check(subtle, '이 화면에서는 암호화 기능을 쓸 수 없어요(HTTPS 필요)');
    check(typeof code === 'string' && /^bkl4_[A-Za-z0-9_-]{43}$/.test(code), '페어링 코드 형식 오류');
    const secret = b64d(code.slice(5));
    check(secret.length === 32, '페어링 코드 형식 오류');
    const salt = enc.encode(VERSION);
    const aes = async (info, use) => subtle.importKey('raw', await hkdf(subtle, secret, salt, enc.encode(info), 32),
      {name: 'AES-GCM'}, extractable, use);
    const both = usages === 'both';
    return {subtle, kid: b64e(await hkdf(subtle, secret, salt, enc.encode('bkl4/kid'), 12)),
      req: await aes('bkl4/req/aes-256-gcm', both ? ['encrypt', 'decrypt'] : ['encrypt']),
      res: await aes('bkl4/res/aes-256-gcm', both ? ['encrypt', 'decrypt'] : ['decrypt'])};
  }

  async function sealBox(subtle, key, nonce, plain, header) {
    return new Uint8Array(await subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128}, key, plain));
  }
  // 태그가 맞을 때만 평문을 돌려줘요. 틀리면 null이고 평문은 만들어지지 않아요.
  async function openBox(subtle, key, nonce, ciphertext, header) {
    if (nonce.length !== NONCE || ciphertext.length < TAG) return null;
    try {
      return new Uint8Array(await subtle.decrypt({name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128}, key, ciphertext));
    } catch { return null; }
  }

  function destination(base) {
    check(typeof base === 'string', 'Botkive 주소가 필요해요');
    const url = new URL(base);
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    check((url.protocol === 'https:' || local) && !url.username && !url.password && url.origin === base.replace(/\/$/, ''),
      'Botkive 주소는 경로 없는 HTTPS 출처여야 해요');
    return url.origin;
  }

  const STAGE = {snapshot: '기준표 확인', register: '서재 등록', 'inbox/hello': '연결 확인', 'inbox/compare': '비교',
    'inbox/begin': '전송 시작', 'inbox/chunk': '에셋 보내기', 'inbox/chunks': '에셋 보내기', 'inbox/finish': '마무리 확인', 'inbox/abort': '취소'};
  // 어느 단계에서 왜 거절됐는지 문구에 넣어요. 이유는 봉인을 확인한 응답에서만 읽고, 예전 봇카이브는 이유가 없어요.
  function refusal(route, result) {
    const why = typeof result.value?.reason === 'string' ? result.value.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) : '';
    return '요청이 거절됐어요(' + (STAGE[route] || route) + ' 단계, 코드 ' + result.status + ')' + (why ? ': ' + why : '');
  }

  function failure(message, status, uncertain) {
    const error = new Error(message);
    error.status = status;
    error.uncertain = uncertain;
    return error;
  }

  // 같은 rid로 다시 보내면 서버가 저장된 결과를 돌려줘요. 응답이 유실되거나 대체 경로가 재전송해도 한 번만 실행돼요.
  function client(api, {base, code, clock = () => Date.now(), random = n => root.crypto.getRandomValues(new Uint8Array(n)),
      attempts = 3, wait = ms => new Promise(r => setTimeout(r, ms))} = {}) {
    check(typeof api?.nativeFetch === 'function', '공식 네트워크 API가 없어요');
    const origin = destination(base);
    const ready = deriveKeys(code);
    const used = new Set();
    const fresh = () => {
      const nonce = random(NONCE);
      check(nonce instanceof Uint8Array && nonce.length === NONCE, '난수 생성 실패');
      const n = b64e(nonce);
      check(!used.has(n), '난수가 겹쳤어요. 전송을 멈췄어요');
      used.add(n);
      return [nonce, n];
    };
    return async function request(route, body = {}) {
      check(/^(snapshot|register|inbox\/(hello|compare|begin|chunk|chunks|finish|abort))$/.test(route), '알 수 없는 요청');
      const keys = await ready, {subtle} = keys;
      const path = PREFIX + route, plain = enc.encode(JSON.stringify(body)), rid = b64e(random(16));
      let last = '응답을 확인하지 못했어요', lastHttp = 0;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt) await wait(200 * attempt);
        const [nonce, n] = fresh(), ts = clock();
        const ciphertext = await sealBox(subtle, keys.req, nonce, plain, aad('req', 'POST', origin, path, keys.kid, rid, n, ts));
        let text, httpStatus = 0;
        try {
          const response = await api.nativeFetch(origin + path, {method: 'POST', redirect: 'error',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({v: 4, kid: keys.kid, rid, n, ts, c: b64e(ciphertext)})});
          httpStatus = Number.isInteger(response?.status) ? response.status : 0;
          text = await response.text();
        } catch { last = '통신 실패예요'; lastHttp = 0; continue; }
        const result = await openReply(keys, origin, path, rid, n, text);
        // 봉인 확인이 안 되는 응답은 리디렉션 대상이나 중간 서버가 보낸 것일 수 있어 믿지 않아요.
        // 봉인 없는 응답의 HTTP 번호만 기억해요(본문은 믿지 않아요). 401이면 봇카이브의 인증 전 거절,
        // 5xx 등이면 PocketRisu 중계나 프록시가 봇카이브에 닿지 못한 경우예요.
        if (!result) { last = '확인되지 않은 응답이에요'; lastHttp = httpStatus; continue; }
        if (result.status === 409 && result.value?.error === 'pending') { last = '처리 중이에요'; continue; }
        // 오류에 상태 코드와 '결과 불확실' 표시를 붙여요(본문·비밀은 넣지 않아요). 호출자가 재시도 여부를 정할 때 써요.
        if (result.status === 409 && ['uncertain', 'result_expired'].includes(result.value?.error))
          throw failure(result.value.error === 'uncertain'
            ? '이전 요청의 완료 여부를 확인할 수 없어요. 자동 재실행을 멈췄어요. 서재와 수신함 상태를 먼저 확인해 주세요'
            : '이전 요청의 응답 보관 기간이 지났어요. 서재와 수신함 상태를 먼저 확인해 주세요', 409, true);
        if (result.status !== 200) throw failure(refusal(route, result), result.status, false);
        return result.value;
      }
      const error = failure(last, 0, true);
      if (lastHttp) error.httpStatus = lastHttp;
      throw error;
    };
  }

  async function openReply(keys, origin, path, rid, n, text) {
    let reply;
    try { reply = JSON.parse(text); } catch { return null; }
    if (!reply || typeof reply !== 'object' || Object.keys(reply).sort().join() !== 'c,n,rid,s,v' || reply.v !== 4 ||
        reply.rid !== rid || !Number.isInteger(reply.s) || typeof reply.n !== 'string' || typeof reply.c !== 'string') return null;
    try {
      const plain = await openBox(keys.subtle, keys.res, b64d(reply.n), b64d(reply.c),
        aad('res', 'POST', origin, path, keys.kid, rid, n, reply.n, reply.s));
      if (!plain) return null;
      return {status: reply.s, value: JSON.parse(dec.decode(plain))};
    } catch { return null; }
  }

  // createBatch(api, scope, port)가 쓰는 port 모양. 서재·출처는 페어링 키에 묶여 있어요.
  function securePort(api, options) {
    const request = client(api, options);
    return {snapshot: () => request('snapshot', {}), inbox: (action, body = {}) => request('inbox/' + action, body),
      register: (cha, session) => request('register', {cha, session})};
  }

  const api = {VERSION, PREFIX, deriveKeys, client, securePort, destination,
    internals: {aad, sealBox, openBox, b64e, b64d, hkdf, NONCE, TAG}};
  if (typeof module !== 'undefined') module.exports = api;
  else root.BotkiveSecureLinkV4 = api;
})(globalThis);

/* SPDX-License-Identifier: GPL-3.0-only */
// 등록 작업 순서기. port({snapshot, inbox, register})는 서재·출처에 묶인 전송 객체예요(설치본은 botkive-link/4).
// 사용자가 고른 캐릭터(only)만 처리하고, 결과를 캐릭터마다 남겨요. 이 함수는 버튼 처리기에서만 불러요.
// 불확실한 쓰기(등록 요청 뒤 응답을 못 받음)는 새 요청으로 다시 보내지 않고 멈춰요(Phase 14.1 정책).
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined';
  const {inspect} = node ? require('./preview') : root.BotkivePreview;
  const {prepare} = node ? require('./card') : root.BotkiveCard;

  // 오류 이유는 분류만 남겨요(캐릭터 본문·경로를 화면에 되풀이하지 않게).
  function reason(error) {
    const status = error?.status;
    if (status === 401) return 'auth';
    if (status === 403) return 'permission';
    if (status === 413 || error?.httpStatus === 413) return 'too-large';
    if (status === 409) return 'conflict';
    if (status === 507) return 'storage';
    if (status >= 500) return 'server';
    if (status === 400) return 'rejected';  // 봇카이브가 거절했어요. 단계와 이유는 자세한 문구에 있어요
    const text = String(error?.message || '');
    if (/에셋|파일 한도|용량/.test(text)) return 'asset';
    if (/목록이 바뀌었어요/.test(text)) return 'changed';
    if (/통신 실패|확인되지 않은 응답/.test(text)) return 'network';
    return 'other';
  }

  function createBatch(api, scope, port) {
    let active = false;
    return async function run({signal, onProgress = () => {}, allowSmallFixtureAssets = false, allowAssets = false,
      only = null, folders = true} = {}) {
      if (active) throw Error('이미 등록 작업이 진행 중이에요');
      active = true;
      try {
        const snapshot = await port.snapshot();
        if (!snapshot) throw Error('완료 등록 기준표가 필요해요');
        const plan = await inspect(api, {scope, snapshot, cancelled: () => signal?.aborted,
          progress: count => onProgress({stage: 'scan', count})});
        const selected = only ? new Set(only) : null;
        const result = {registered: 0, skipped: selected ? 0 : plan.counts.skipped, failed: selected ? 0 : plan.counts.failed,
          cancelled: plan.state === 'cancelled', refreshRequired: false, storageFull: false, items: []};
        let rows = plan.rows;
        if (selected) {
          const byId = new Map(plan.rows.map(row => [row.id, row]));
          // 고른 뒤 PocketRisu 목록에서 사라진 캐릭터는 보내지 않아요.
          for (const id of selected) if (!byId.has(id)) { result.failed++; result.items.push({id, state: 'missing'}); }
          rows = plan.rows.filter(row => selected.has(row.id));
          for (const row of rows) if (row.state === 'skipped') {
            result.skipped++;
            result.items.push({id: row.id, name: row.name, state: 'already'});
          }
        }
        const todo = rows.filter(row => row.state === 'candidate');
        const pace = {};  // 조각이 막혀 줄였으면 남은 캐릭터도 그 크기로 보내요(처음부터 다시 부딪히지 않게).
        const notSent = from => { for (const row of todo.slice(from)) result.items.push({id: row.id, name: row.name, state: 'not-sent'}); };
        for (let position = 0; position < todo.length; position++) {
          const row = todo[position];
          if (signal?.aborted) { result.cancelled = true; notSent(position); break; }
          let awaitingReceipt = false, sent = null;
          onProgress({stage: 'item', id: row.id, name: row.name, position: position + 1, total: todo.length});
          try {
            onProgress({stage: 'prepare', id: row.id});
            const file = await prepare(api, row, port.inbox, async () => true,
              (done, total) => { sent = {done, total}; onProgress({stage: 'assets', id: row.id, done, total}); },
              {sourceId: scope.sourceId, signal, allowUnboundedRead: allowAssets || allowSmallFixtureAssets,
                optionalFolders: true, skipFolders: !folders, pace});
            if (signal?.aborted) {
              // 수신함에 올렸지만 서재 등록 전이에요. 다음 등록 때 같은 내용이면 그대로 써요.
              result.cancelled = true;
              result.items.push({id: row.id, name: row.name, state: 'cancelled'});
              notSent(position + 1);
              break;
            }
            const session = file.state === 'identical' ? file.duplicateOf : file.session;
            if (!['complete', 'identical'].includes(file.state) || !/^[0-9a-f]{32}$/.test(session)) throw Error('수신본 확인 실패');
            awaitingReceipt = true;
            const receipt = await port.register(row.id, session);
            if (!['registered', 'skipped'].includes(receipt?.state) || !Number.isSafeInteger(receipt.botId) || receipt.botId < 1)
              throw Error('서재 등록 확인 실패');
            result[receipt.state]++;
            result.items.push({id: row.id, name: row.name, ...receipt});
          } catch (error) {
            if (signal?.aborted && !awaitingReceipt) {
              result.cancelled = true;
              result.items.push({id: row.id, name: row.name, state: 'cancelled'});
              notSent(position + 1);
              break;
            }
            result.failed++;
            const status = error?.status;
            // 등록 요청을 보낸 뒤의 실패는 결과를 모를 수 있어요. 거절(401·403·409)이 확실하면 그 캐릭터만 실패로 둬요.
            const definite = awaitingReceipt && [401, 403, 409].includes(status) && error.uncertain !== true;
            // 자세한 이유(어느 에셋이 몇 MB인지 등)도 같이 보여 줘요. 플러그인이 만든 문구라 비밀은 들어 있지 않아요.
            // 어디까지 보냈는지도 남겨요(자리를 비운 사이에 실패해도 나중에 볼 수 있게요).
            const detail = String(error?.message || '').slice(0, 200) + (sent ? ' · 에셋 ' + sent.done + '/' + sent.total + '개 보낸 뒤' : '');
            result.items.push({id: row.id, name: row.name, state: awaitingReceipt && !definite ? 'unconfirmed' : 'failed', reason: reason(error),
              ...(detail ? {detail} : {})});
            if (awaitingReceipt) {
              if (!definite) result.refreshRequired = true;
              notSent(position + 1);
              break;
            }
            if (status === 401 || status === 403) { notSent(position + 1); break; }  // 키·권한 문제는 다음 캐릭터도 같아요.
            // 봇카이브 저장 공간이 모자라면 다음 캐릭터도 같아요. 다 올려 보고 실패하지 않게 멈춰요.
            if (status === 507) { result.storageFull = true; notSent(position + 1); break; }
            // 그 밖의 실패(에셋 한도·읽기 실패 등)는 이 캐릭터만 실패로 두고 다음 캐릭터로 넘어가요.
          }
          onProgress({stage: 'result', id: row.id, position: position + 1, total: todo.length,
            registered: result.registered, failed: result.failed, skipped: result.skipped});
        }
        return result;
      } finally { active = false; }
    };
  }

  function localControls(runLocalBatch) {
    return ui => {
      const {register, scan, cancel, names, status} = ui;
      register.disabled = !runLocalBatch;
      if (!runLocalBatch) register.title = '실제 전송 경로가 닫혀 있어요.';
      register.onclick = async () => {
        if (ui.busy || !runLocalBatch) return;
        ui.busy = true; ui.stopped = false; register.disabled = true; scan.disabled = true; cancel.disabled = false;
        names.textContent = '';
        try {
          const result = await runLocalBatch({signal: {get aborted() { return ui.stopped; }},
            onProgress: event => { status.textContent = event.stage === 'scan' ? '목록 조회 ' + event.count : '순차 처리 중 · ' + event.id; }});
          status.textContent = (result.refreshRequired ? '기준표 재조회 필요 · ' : result.cancelled ? '중단 · ' : '') + '등록 ' + result.registered + '개 / 건너뛰기 ' + result.skipped + '개 / 실패·미확인 ' + result.failed + '개';
          names.textContent = result.items.filter(item => item.state === 'unconfirmed').map(item => item.id).join('\n');
          return result;
        } catch { status.textContent = '등록 기준을 확인할 수 없어 중단했어요.'; }
        finally { ui.busy = false; register.disabled = false; scan.disabled = false; cancel.disabled = true; }
      };
    };
  }

  const batch = {createBatch, localControls, reason};
  root.BotkiveBatch = batch;
  if (node) module.exports = batch;
})(globalThis);

/* SPDX-License-Identifier: GPL-3.0-only */
(function() {
const CSS = `
:root{color-scheme:dark}
html,body{margin:0;height:100%;background:transparent}
.bkl-root{
  --bkl-bg:#282a36;--bkl-bg-deep:#21222c;--bkl-line:#4b5563;--bkl-line-soft:#3a3f51;
  --bkl-text:#f5f5f5;--bkl-muted:#b9bdd3;--bkl-disabled:#8d93ab;
  --bkl-accent:#8c96ff;--bkl-accent-hover:#a3abff;--bkl-on-accent:#101223;
  --bkl-btn:#374151;--bkl-btn-hover:#434f63;
  --bkl-info-bg:#2c3150;--bkl-info-line:#4a5391;--bkl-info-text:#c9d1ff;
  --bkl-err-bg:#3f2431;--bkl-err-line:#7a3b4f;--bkl-err-text:#ffb8b8;
  position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
  background:rgba(12,13,20,.76);color:var(--bkl-text);-webkit-text-size-adjust:100%;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',system-ui,sans-serif}
.bkl-root *,.bkl-root *::before,.bkl-root *::after{box-sizing:border-box}
.bkl-panel{display:flex;flex-direction:column;width:min(640px,100%);max-height:100%;overflow:hidden;
  background:var(--bkl-bg);border:1px solid var(--bkl-line);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55)}
.bkl-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 12px 12px 20px;background:var(--bkl-bg-deep);border-bottom:1px solid var(--bkl-line)}
.bkl-titlebox{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}
.bkl-title{margin:0;font-size:17px;font-weight:700;line-height:1.35;overflow-wrap:anywhere}
.bkl-pill{padding:2px 9px;border-radius:999px;border:1px solid var(--bkl-info-line);background:var(--bkl-info-bg);
  color:var(--bkl-info-text);font-size:12px;font-weight:600;white-space:nowrap}
.bkl-head-btns{flex:none;display:flex;gap:4px}
.bkl-x,.bkl-min{flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;
  border:1px solid transparent;border-radius:10px;background:transparent;color:var(--bkl-text);
  font:inherit;font-size:24px;line-height:1;cursor:pointer}
.bkl-x:hover,.bkl-min:hover{background:var(--bkl-btn);border-color:var(--bkl-line)}
.bkl-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:16px 20px}
.bkl-lead{margin:0;font-size:14.5px}
.bkl-note{margin:0;font-size:13px;color:var(--bkl-muted)}
.bkl-toolbar{display:flex;flex-wrap:wrap;gap:8px}
.bkl-btn{appearance:none;min-height:40px;padding:8px 16px;border:1px solid var(--bkl-line);border-radius:10px;
  background:var(--bkl-btn);color:var(--bkl-text);font:inherit;font-weight:600;cursor:pointer}
.bkl-btn:hover:not(:disabled){background:var(--bkl-btn-hover)}
.bkl-btn:active:not(:disabled){transform:translateY(1px)}
.bkl-btn:disabled{background:transparent;border-style:dashed;color:var(--bkl-disabled);cursor:not-allowed}
.bkl-btn--primary{background:var(--bkl-accent);border-color:var(--bkl-accent);color:var(--bkl-on-accent)}
.bkl-btn--primary:hover:not(:disabled){background:var(--bkl-accent-hover);border-color:var(--bkl-accent-hover)}
.bkl-btn--primary:disabled{background:transparent;border-color:var(--bkl-line)}
.bkl-btn:focus-visible,.bkl-x:focus-visible,.bkl-min:focus-visible{outline:2px solid var(--bkl-accent);outline-offset:2px}
.bkl-status{margin:0;padding:10px 12px;border:1px solid var(--bkl-info-line);border-radius:10px;
  background:var(--bkl-info-bg);color:var(--bkl-info-text);overflow-wrap:anywhere}
.bkl-status:empty{display:none}
.bkl-root[data-state='error'] .bkl-status{border-color:var(--bkl-err-line);background:var(--bkl-err-bg);color:var(--bkl-err-text)}
.bkl-progress{display:none;height:4px;overflow:hidden;border-radius:999px;background:var(--bkl-line-soft)}
.bkl-progress::before{content:'';display:block;width:35%;height:100%;border-radius:inherit;background:var(--bkl-accent);
  animation:bkl-slide 1.1s ease-in-out infinite}
.bkl-root[data-state='loading'] .bkl-progress{display:block}
@keyframes bkl-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.bkl-listhead{display:none;align-items:baseline;justify-content:space-between;gap:8px;color:var(--bkl-muted);font-size:13px}
.bkl-root[data-state='done'] .bkl-listhead{display:flex}
.bkl-list{flex:1 1 340px;min-height:120px;margin:0;padding:0;overflow:auto;list-style:none;white-space:pre-wrap;
  counter-reset:bkl-n;background:var(--bkl-bg-deep);border:1px solid var(--bkl-line);border-radius:10px}
.bkl-list:empty{display:none}
.bkl-row{display:flex;align-items:baseline;gap:4px 10px;padding:10px 14px;white-space:normal;border-top:1px solid var(--bkl-line-soft);counter-increment:bkl-n}
.bkl-row:first-child{border-top:0}
.bkl-row::before{content:counter(bkl-n);flex:none;min-width:2.4em;text-align:right;color:var(--bkl-muted);
  font-size:12px;font-variant-numeric:tabular-nums}
.bkl-name{font-weight:600;overflow-wrap:anywhere}
.bkl-sep{color:var(--bkl-muted)}
.bkl-id{color:var(--bkl-muted);font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.bkl-empty{display:none;margin:0;padding:22px 14px;text-align:center;color:var(--bkl-muted);
  border:1px dashed var(--bkl-line);border-radius:10px}
.bkl-root[data-state='idle'] .bkl-empty,.bkl-root[data-state='empty'] .bkl-empty,.bkl-root[data-state='cancelled'] .bkl-empty{display:block}
.bkl-foot{flex:none;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 20px;background:var(--bkl-bg-deep);border-top:1px solid var(--bkl-line)}
.bkl-foot-main{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.bkl-hint{margin:0;font-size:12px;color:var(--bkl-muted)}
.bkl-root [hidden]{display:none!important}
.bkl-pick{flex:none;width:20px;height:20px;margin:0;accent-color:var(--bkl-accent)}
.bkl-badge{flex:none;padding:1px 8px;border-radius:999px;border:1px solid var(--bkl-line);color:var(--bkl-muted);font-size:12px}
.bkl-selbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bkl-sheet{display:flex;flex-direction:column;gap:10px}
.bkl-sheet h3{margin:0;font-size:15.5px}
.bkl-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0}
.bkl-dl dt{color:var(--bkl-muted)}
.bkl-dl dd{margin:0;overflow-wrap:anywhere;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bkl-mini{margin:0;padding:8px 12px 8px 30px;max-height:160px;overflow:auto;background:var(--bkl-bg-deep);border:1px solid var(--bkl-line);border-radius:8px}
.bkl-mini li{overflow-wrap:anywhere}
.bkl-warn{margin:0;padding:8px 10px;border:1px solid var(--bkl-err-line);border-radius:8px;background:var(--bkl-err-bg);color:var(--bkl-err-text)}
.bkl-ack{display:flex;gap:8px;align-items:flex-start;font-weight:600}
.bkl-ack input{flex:none;width:20px;height:20px;margin:2px 0 0;accent-color:var(--bkl-accent)}
.bkl-counts{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;font-variant-numeric:tabular-nums}
.bkl-pair{flex:none;border:1px solid var(--bkl-line);border-radius:10px;background:var(--bkl-bg-deep)}
.bkl-pair-sum{display:flex;align-items:center;min-height:44px;padding:8px 14px;font-weight:600;cursor:pointer;list-style-position:inside}
.bkl-pair-sum:focus-visible{outline:2px solid var(--bkl-accent);outline-offset:2px;border-radius:10px}
.bkl-pair-body{display:flex;flex-direction:column;gap:10px;padding:4px 14px 14px}
.bkl-pair-bar{display:flex;flex-wrap:wrap;gap:8px}
.bkl-field{display:flex;flex-direction:column;gap:4px;font-weight:600}
.bkl-field-row{display:flex;flex-wrap:wrap;gap:8px}
.bkl-input{flex:none;width:100%;min-width:0;min-height:40px;padding:8px 10px;border:1px solid var(--bkl-line);border-radius:8px;
  background:var(--bkl-bg);color:var(--bkl-text);font:inherit;font-weight:400}
.bkl-field-row .bkl-input{flex:1 1 220px;width:auto}
.bkl-input--code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bkl-input:focus-visible{outline:2px solid var(--bkl-accent);outline-offset:1px}
.bkl-pair-status{margin:0;padding:8px 10px;border:1px solid var(--bkl-info-line);border-radius:8px;background:var(--bkl-info-bg);color:var(--bkl-info-text);overflow-wrap:anywhere}
.bkl-pair-status[data-pair-state='invalid'],.bkl-pair-status[data-pair-state='auth-failed'],.bkl-pair-status[data-pair-state='error']{
  border-color:var(--bkl-err-line);background:var(--bkl-err-bg);color:var(--bkl-err-text)}
@media (max-width:560px){
  .bkl-root{padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
  .bkl-head{padding:8px 8px 8px 16px}
  .bkl-body{padding:14px 16px}
  .bkl-toolbar .bkl-btn{flex:1 1 auto}
  .bkl-row{flex-wrap:wrap}
  .bkl-sep{display:none}
  .bkl-id{flex-basis:100%;padding-left:calc(2.4em + 10px)}
  .bkl-foot{flex-direction:column;align-items:stretch;padding:12px 16px}
  .bkl-foot-main{align-items:stretch}
  .bkl-foot .bkl-btn{width:100%}
}
@media (max-height:640px){
  .bkl-list{flex:none;overflow:visible}
}
@media (prefers-reduced-motion:reduce){
  .bkl-progress::before{animation:none;width:100%;opacity:.6}
}
@media (forced-colors:active){
  .bkl-panel,.bkl-btn,.bkl-status,.bkl-list{border:1px solid CanvasText}
  .bkl-btn:disabled{color:GrayText}
}
`;

const CHUNK = 500;
// ---- 페어링 입력 ----
// 페어링 코드는 기본으로 이 iframe의 메모리(아래 pairing 변수)에만 둬요. 쿠키·PocketRisu 설정·주소·로그에는 쓰지 않아요.
// 사용자가 '기억하기'를 켠 경우에만, 인증에 성공한 코드를 이 기기의 safeLocalStorage에 저장해요(PocketRisu 백업에는 안 들어가요).
// 이 저장소는 다른 플러그인도 읽을 수 있어서 기본은 꺼짐이고, 화면에 그 위험을 적어 둬요.
// 연결 확인은 사용자가 '연결 확인'을 누를 때, 그리고 기억한 코드를 불러온 직후에 해요:
// 등록 기록표(snapshot) 읽기 1회 + 등록 준비 권한 확인(빈 hello) 1회.
// 캐릭터 자료는 보내지 않아요. null이면 실제 봇카이브로 확인해요.
const VERIFY = null;
let lastRun = null;   // 화면을 닫은 동안 끝난 등록의 요약(다시 열면 한 번 보여 줘요)
// 실제 연결 확인: botkive-link/4(AES-256-GCM) 봉투, PocketRisu 공식 nativeFetch만 써요.
async function realVerify(api, {base, code}) {
  const L = globalThis.BotkiveSecureLinkV4;
  if (!L || typeof api.nativeFetch !== 'function') return {state: 'error'};
  const request = L.client({nativeFetch: (url, init) => api.nativeFetch(url, init)}, {base, code, attempts: 2});
  try {
    const snapshot = await request('snapshot', {});
    if (!snapshot || !/^[0-9a-f]{32}$/.test(snapshot.botkiveId || '') || typeof snapshot.sourceId !== 'string' ||
        !Array.isArray(snapshot.registrations)) return {state: 'error'};
    let canPrepare = true;
    try { await request('inbox/hello', {}); } catch (error) { if (error.status === 403) canPrepare = false; else throw error; }
    return {state: 'verified', snapshot, canPrepare};
  } catch (error) {
    // 봉인을 확인할 수 없는 응답(틀린 코드·폐기된 키·다른 서버)은 인증 실패, 통신이 안 되면 연결 오류예요.
    if (error.status === 401 || error.status === 403) return {state: 'auth-failed'};
    if (/확인되지 않은 응답/.test(error.message || ''))
      return error.httpStatus === 401 ? {state: 'auth-failed'} : {state: 'error', relay: error.httpStatus || 0};
    return {state: 'error'};
  }
}
let pairing = null;   // {base, code, state} — 화면을 닫았다 열어도 iframe이 살아 있는 동안만 남아요.
const PAIR_TEXT = {
  unset: '아직 연결 정보를 넣지 않았어요.',
  address: '주소 형식을 확인했어요. 페어링 코드를 넣어 주세요.',
  format: '주소와 코드 형식이 맞아요. 아직 봇카이브 서버에 인증을 확인하지 않았어요.',
  checking: '봇카이브 서버에 인증을 확인하는 중이에요…',
  verified: '봇카이브 서버가 이 코드를 인증했어요. 이제 캐릭터 목록을 조회하고 등록할 캐릭터를 골라 주세요.',
  'auth-failed': '인증에 실패했어요. 코드가 폐기됐거나 이 서버의 코드가 아닐 수 있어요.',
  relay: '봇카이브가 아닌 곳에서 응답이 왔어요. PocketRisu 서버(중계)가 봇카이브 주소에 닿지 못했거나, 프록시·방화벽이 막았을 수 있어요.',
  error: '봇카이브에 연결하지 못했어요. 주소와 네트워크를 확인해 주세요.',
  reset: '연결 정보를 지웠어요. 쓰려면 주소와 코드를 다시 넣어 주세요.',
};
// 'botkive.example.com'만 넣어도 https://를 붙여 읽어요(서버 BOTKIVE_LINK_ORIGIN과 같은 규칙). http://는 붙여 주지 않아요.
function checkAddress(text) {
  let url, value = String(text).trim();
  if (value && !value.includes('://')) value = 'https://' + value;
  try { url = new URL(value); } catch { return {message: '주소 형식이 아니에요. 예: botkive.example.com'}; }
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) return {message: 'HTTPS 주소만 쓸 수 있어요.'};
  if (url.username || url.password) return {message: '주소에 아이디·비밀번호를 넣지 마세요.'};
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return {message: '경로 없이 봇카이브 주소만 넣어 주세요.'};
  return {base: url.origin};
}
// 공개 키 식별자(kid): 봇카이브 연결 관리 목록과 같은 값이라, 어떤 연결의 코드를 넣었는지 비교할 수 있어요.
// 이 화면 안에서만 계산하고(네트워크 없음) 비밀이 아니에요. HKDF-SHA256(salt=botkive-link/4, info=bkl4/kid), 12바이트.
async function kidOf(code) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const raw = atob(code.slice(5).replace(/-/g, '+').replace(/_/g, '/') + '=');
  const secret = Uint8Array.from(raw, c => c.charCodeAt(0));
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: enc.encode('botkive-link/4'),
    info: enc.encode('bkl4/kid')}, key, 96));
  return btoa(String.fromCharCode(...bits)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function checkCode(text) {
  const code = String(text).trim();
  if (/^bkl3_/.test(code)) return {message: '이전 방식(v3) 코드예요. 봇카이브 연결 관리에서 새 v4 코드(bkl4_)를 만들어 주세요.'};
  if (!/^bkl4_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(code)) return {message: '페어링 코드 형식이 아니에요. bkl4_로 시작하는 48자 코드를 그대로 붙여 넣어 주세요.'};
  return {code};
}
const REMEMBER_KEY = 'botkive-link-pairing';
const remembered = {
  async load(api) {
    try {
      const saved = JSON.parse(await api.safeLocalStorage.getItem(REMEMBER_KEY) || 'null');
      const where = checkAddress(saved?.base), what = checkCode(saved?.code);
      return where.base && what.code ? {base: where.base, code: what.code} : null;
    } catch { return null; }
  },
  async save(api, {base, code}) {
    try { await api.safeLocalStorage.setItem(REMEMBER_KEY, JSON.stringify({base, code})); return true; } catch { return false; }
  },
  async forget(api) {
    try { await api.safeLocalStorage.removeItem(REMEMBER_KEY); return true; } catch { return false; }
  },
};
// 진행 중인 조회(없으면 null). 화면을 닫았다 다시 열어도 목록 읽기가 겹치지 않게 순서를 맞춰요.
let scanning = null;
// 지금 열려 있는 화면. 다시 열 때 이전 화면의 조회와 이벤트를 먼저 정리해요.
let current = null;

function node(document, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function createView(api, document, bindLocal, options = {}) {
  const view = {busy: false, stopped: false, closed: false, minimized: false, listeners: [], closing: null};
  const on = (target, type, handler) => {
    target.addEventListener(type, handler);
    view.listeners.push([target, type, handler]);
  };

  const root = node(document, 'div', 'bkl-root');
  root.setAttribute('data-state', 'idle');
  const panel = node(document, 'section', 'bkl-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'bkl-title');
  panel.setAttribute('aria-describedby', 'bkl-lead');

  const head = node(document, 'header', 'bkl-head');
  const titleBox = node(document, 'div', 'bkl-titlebox');
  const title = node(document, 'h2', 'bkl-title', '봇카이브 캐릭터 등록');
  title.id = 'bkl-title';
  const pill = node(document, 'span', 'bkl-pill', '미연결');
  const x = node(document, 'button', 'bkl-x', '×');
  x.setAttribute('type', 'button');
  x.setAttribute('aria-label', '닫기');
  x.title = '닫기';
  titleBox.append(title, pill);
  const shrink = node(document, 'button', 'bkl-min', '－');
  shrink.setAttribute('type', 'button');
  shrink.setAttribute('aria-label', '최소화');
  shrink.title = '최소화 (보내는 중이면 계속 보내요)';
  const headBtns = node(document, 'div', 'bkl-head-btns');
  headBtns.append(shrink, x);
  head.append(titleBox, headBtns);

  const lead = node(document, 'p', 'bkl-lead', '캐릭터 목록 조회를 누르면 이 화면에 이름과 원본 ID만 표시해요. 등록은 직접 고르고 확인한 캐릭터만 해요.');
  lead.id = 'bkl-lead';
  const note = node(document, 'p', 'bkl-note', '등록하려면 아래 “봇카이브 연결”에서 연결을 확인한 뒤 목록을 조회해 주세요. 목록 조회만으로는 아무것도 보내지 않아요.');
  const scan = node(document, 'button', 'bkl-btn bkl-btn--primary', '캐릭터 목록 조회');
  const cancel = node(document, 'button', 'bkl-btn', '조회 취소');
  scan.setAttribute('type', 'button');
  cancel.setAttribute('type', 'button');
  cancel.disabled = true;
  const toolbar = node(document, 'div', 'bkl-toolbar');
  toolbar.append(scan, cancel);

  const status = node(document, 'p', 'bkl-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const progress = node(document, 'div', 'bkl-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '목록 조회 진행 중');
  const count = node(document, 'span', 'bkl-count');
  const listHead = node(document, 'div', 'bkl-listhead');
  listHead.append(node(document, 'span', '', '조회된 캐릭터'), count);
  const names = node(document, 'ol', 'bkl-list');
  names.setAttribute('aria-label', '조회된 캐릭터 목록');
  const empty = node(document, 'p', 'bkl-empty');

  const pair = node(document, 'details', 'bkl-pair');
  const pairSum = node(document, 'summary', 'bkl-pair-sum', '봇카이브 연결 (페어링 코드)');
  const pairBody = node(document, 'div', 'bkl-pair-body');
  const pairNote = node(document, 'p', 'bkl-note', '기본으로 코드는 이 화면 메모리에만 있어요. PocketRisu를 새로 고치면 다시 넣어야 해요.');
  const field = (labelText, input) => {
    const label = node(document, 'label', 'bkl-field', labelText);
    input.id = 'bkl-' + Math.random().toString(36).slice(2);
    label.setAttribute('for', input.id);
    return label;
  };
  const address = node(document, 'input', 'bkl-input');
  address.value = '';
  address.setAttribute('type', 'url');
  address.setAttribute('autocomplete', 'off');
  address.setAttribute('spellcheck', 'false');
  address.setAttribute('placeholder', '봇카이브 주소 (예: botkive.example.com)');
  const codeInput = node(document, 'input', 'bkl-input bkl-input--code');
  codeInput.value = '';
  codeInput.setAttribute('type', 'password');
  codeInput.setAttribute('autocomplete', 'off');
  codeInput.setAttribute('spellcheck', 'false');
  codeInput.setAttribute('placeholder', 'bkl4_…');
  const reveal = node(document, 'button', 'bkl-btn', '보이기');
  reveal.setAttribute('type', 'button');
  reveal.setAttribute('aria-pressed', 'false');
  const codeRow = node(document, 'div', 'bkl-field-row');
  codeRow.append(codeInput, reveal);
  const formatBtn = node(document, 'button', 'bkl-btn', '형식 확인');
  const verifyBtn = node(document, 'button', 'bkl-btn', '연결 확인');
  const resetBtn = node(document, 'button', 'bkl-btn', '연결 초기화');
  for (const b of [formatBtn, verifyBtn, resetBtn]) b.setAttribute('type', 'button');
  const pairBar = node(document, 'div', 'bkl-pair-bar');
  pairBar.append(formatBtn, verifyBtn, resetBtn);
  const pairStatus = node(document, 'p', 'bkl-pair-status');
  pairStatus.setAttribute('role', 'status');
  pairStatus.setAttribute('aria-live', 'polite');
  const verifyHint = node(document, 'p', 'bkl-hint', '이 설치본은 서버 연결 확인을 하지 않아요. 형식만 확인해요.');
  const kidLine = node(document, 'p', 'bkl-hint bkl-kid');
  kidLine.hidden = true;
  const keepLabel = node(document, 'label', 'bkl-ack', '');
  const keepBox = node(document, 'input', '');
  keepBox.setAttribute('type', 'checkbox');
  keepBox.checked = false;
  keepLabel.append(keepBox, ' 이 브라우저에 코드 기억하기 (다음에 자동으로 연결해요. 다른 플러그인도 읽을 수 있으니 믿는 플러그인만 쓸 때 켜세요)');
  const forgetBtn = node(document, 'button', 'bkl-btn', '기억한 코드 지우기');
  forgetBtn.setAttribute('type', 'button');
  forgetBtn.hidden = true;
  pairBody.append(pairNote, field('봇카이브 HTTPS 주소', address), address, field('페어링 코드', codeInput), codeRow,
    pairBar, keepLabel, forgetBtn, pairStatus, kidLine, verifyHint);
  pair.append(pairSum, pairBody);

  const selBar = node(document, 'div', 'bkl-selbar');
  const pickAll = node(document, 'button', 'bkl-btn', '전체 선택'), pickNone = node(document, 'button', 'bkl-btn', '선택 해제');
  for (const b of [pickAll, pickNone]) b.setAttribute('type', 'button');
  const picked = node(document, 'span', 'bkl-note', '');
  selBar.append(pickAll, pickNone, picked);
  selBar.hidden = true;

  const sheet = node(document, 'section', 'bkl-sheet');   // 등록 전 확인
  sheet.setAttribute('aria-labelledby', 'bkl-sheet-title');
  sheet.hidden = true;
  const runBox = node(document, 'section', 'bkl-sheet');  // 진행·결과
  runBox.setAttribute('aria-live', 'polite');
  runBox.hidden = true;

  const body = node(document, 'div', 'bkl-body');
  body.append(lead, note, toolbar, status, progress, listHead, selBar, names, empty, pair, sheet, runBox);

  const register = node(document, 'button', 'bkl-btn', '선택한 캐릭터 등록…');
  register.setAttribute('type', 'button');
  register.disabled = true;
  register.setAttribute('aria-describedby', 'bkl-hint');
  const hint = node(document, 'p', 'bkl-hint', '먼저 봇카이브 연결을 확인해 주세요.');
  hint.id = 'bkl-hint';
  const close = node(document, 'button', 'bkl-btn', '닫기');
  close.setAttribute('type', 'button');
  const footMain = node(document, 'div', 'bkl-foot-main');
  footMain.append(register, hint);
  const foot = node(document, 'footer', 'bkl-foot');
  foot.append(footMain, close);

  panel.append(head, body, foot);
  root.append(panel);

  const setState = (state, emptyText = '') => {
    root.setAttribute('data-state', state);
    empty.textContent = emptyText;
    body.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  };
  setState('idle', '아직 조회한 목록이 없어요. “캐릭터 목록 조회”를 눌러 주세요.');

  let listed = [], listFor = null;          // 마지막 조회 결과와 그때의 연결(연결이 바뀌면 고르기를 막아요)
  const selection = new Set();
  const pickBoxes = new Map();
  let updateRegister = () => {};
  const row = ({name, id, state}) => {
    const li = node(document, 'li', 'bkl-row');
    if (state === 'candidate' || state === 'skipped') {
      const box = node(document, 'input', 'bkl-pick');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('aria-label', (name || '(이름 없음)') + ' 고르기');
      box.checked = false;
      if (state === 'skipped') { box.disabled = true; box.title = '이미 이 연결로 등록했어요'; }
      box.onchange = () => { if (box.checked) selection.add(id); else selection.delete(id); updateRegister(); };
      pickBoxes.set(id, box);
      li.append(box);
    }
    li.append(node(document, 'span', 'bkl-name', name || '(이름 없음)'),
      node(document, 'span', 'bkl-sep', ' · '), node(document, 'span', 'bkl-id', id));
    if (state === 'skipped') li.append(node(document, 'span', 'bkl-badge', '이미 등록됨'));
    return li;
  };
  const fill = rows => {
    names.replaceChildren();
    pickBoxes.clear();
    selection.clear();
    for (let i = 0; i < rows.length; i += CHUNK) names.append(...rows.slice(i, i + CHUNK).map(row));
    count.textContent = rows.length ? rows.length + '개' : '';
    selBar.hidden = !rows.some(r => r.state === 'candidate');
    updateRegister();
  };
  const connected = () => !!(pairing && pairing.state === 'verified' && pairing.snapshot);

  // 최소화: 화면만 숨겨요. 보내는 중이어도 멈추지 않고, 플로팅 단추나 메뉴로 그대로 다시 열어요.
  view.minimize = () => {
    if (view.closed || view.minimized) return undefined;
    view.minimized = true;
    return Promise.resolve().then(() => api.hideContainer()).then(() => undefined, () => { view.minimized = false; });
  };
  // 종료는 한 곳에서만 해요. 닫기 동작(X·닫기·Esc)은 등록 중이면 멈추지 않고 최소화해요.
  view.dispose = () => {
    if (view.closed) return;
    view.closed = true;
    view.stopped = true;
    view.clearSecrets?.();
    for (const [target, type, handler] of view.listeners.splice(0)) target.removeEventListener(type, handler);
    if (current === view) current = null;
  };
  view.close = () => {
    if (view.closing) return view.closing;
    view.dispose();
    view.closing = Promise.resolve().then(() => api.hideContainer()).then(() => undefined, () => {
      view.closing = null;
      status.textContent = '화면을 닫지 못했어요. 닫기를 다시 눌러 주세요.';
    });
    return view.closing;
  };
  const dismiss = () => (view.isRunning() ? view.minimize() : view.close());
  x.onclick = dismiss;
  close.onclick = dismiss;
  shrink.onclick = () => view.minimize();

  // 바깥 영역은 누르기와 떼기가 모두 바깥일 때만 닫아요. 안에서 시작한 드래그는 닫지 않아요.
  // 등록 중이거나 고른 캐릭터·확인 화면이 있으면 실수로 잃지 않게 바깥을 눌러도 닫지 않아요.
  let pressedOutside = false;
  on(root, 'pointerdown', e => { pressedOutside = e.target === root; });
  on(root, 'click', e => {
    const hit = pressedOutside && e.target === root;
    pressedOutside = false;
    if (hit && !view.isRunning() && !selection.size && sheet.hidden) view.close();
  });
  // 보이는 조작 요소만 순서대로. 닫힌 연결 설정 안쪽(요약 줄 제외)과 숨긴 요소는 건너뛰어요.
  const shown = el => {
    for (let at = el; at && at !== panel; at = at.parentNode) {
      if (at.hidden) return false;
      if (at.tag === 'details' || at.tagName === 'DETAILS') {
        if (!at.hasAttribute('open') && el !== pairSum) return false;
      }
    }
    return true;
  };
  const focusable = () => [...panel.querySelectorAll('button, input, summary')].filter(el => !el.disabled && shown(el));
  on(document, 'keydown', e => {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault?.(); dismiss(); return; }
    if (e.key !== 'Tab') return;
    const items = focusable(), first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !items.includes(active))) { e.preventDefault?.(); last?.focus(); }
    else if (!e.shiftKey && (active === last || !items.includes(active))) { e.preventDefault?.(); first?.focus(); }
  });

  cancel.onclick = () => {
    view.stopped = true;
    cancel.disabled = true;
  };
  const runScan = async previous => {
    try {
      if (previous) await previous;   // null이면 await하지 않아야 조회가 동기적으로 시작돼요
      const link = connected() ? pairing : null;
      const result = await globalThis.BotkivePreview.inspect(api, {cancelled: () => view.stopped,
        snapshot: link ? link.snapshot : undefined, scope: link ? link.scope : undefined,
        progress: n => { if (!view.closed) status.textContent = '조회 중 · ' + n + '번째 항목'; }});
      if (view.closed) return;
      if (result.state === 'cancelled') {
        setState('cancelled', '조회가 취소돼 표시할 목록이 없어요.');
        status.textContent = '조회를 취소했어요.';
        return;
      }
      const {unknown, failed, candidate, skipped} = result.counts;
      listed = result.rows;
      listFor = link;
      status.textContent = link
        ? '조회 성공 ' + (candidate + skipped) + '개 / 조회 실패 ' + failed + '개 · 새로 등록할 수 있는 캐릭터 ' + candidate + '개, 이미 등록됨 ' + skipped + '개. 등록할 캐릭터를 직접 골라 주세요.'
        : '조회 성공 ' + unknown + '개 / 조회 실패 ' + failed + '개 / 실제 등록 0개. 봇카이브에 연결하지 않아 등록 여부는 미확인이에요.';
      fill(result.rows);
      setState(result.rows.length ? 'done' : 'empty', '조회된 캐릭터가 없어요.');
    } catch {
      if (view.closed) return;
      setState('error');
      status.textContent = '조회 실패 · 권한과 원본 ID를 확인한 뒤 다시 조회하세요.';
      listed = []; listFor = null; fill([]);
    } finally {
      view.busy = false;
      if (!view.closed) { scan.disabled = false; cancel.disabled = true; }
    }
  };
  scan.onclick = () => {
    if (view.busy || view.closed) return undefined;
    view.busy = true; view.stopped = false;
    scan.disabled = true; cancel.disabled = false;
    fill([]);
    setState('loading');
    status.textContent = '목록 조회 중';
    const run = runScan(scanning);
    const tracked = run.then(() => undefined, () => undefined).then(() => { if (scanning === tracked) scanning = null; });
    scanning = tracked;
    return run;
  };

  // ---- 페어링 동작 ----
  const verify = typeof options.verify === 'function' ? options.verify : VERIFY ?? (pair => realVerify(api, pair));
  let checking = false, running = false;
  view.isRunning = () => running;
  // 연결이 바뀌면 그 전 연결로 조회한 고르기는 버려요(다른 서재로 보내지 않게).
  const dropSelection = () => {
    if (!listFor) return;
    listFor = null;
    fill(listed.map(r => ({...r, state: 'unknown'})));
  };
  const showKid = async target => {
    kidLine.hidden = true;
    if (!target) return;
    try {
      const kid = target.kid ?? (target.kid = await kidOf(target.code));
      if (!kid || view.closed || pairing !== target) return;
      kidLine.textContent = '키 식별자 ' + kid + ' · 봇카이브 연결 관리 목록의 키 식별자와 같으면 그 연결의 코드예요.';
      kidLine.hidden = false;
    } catch { /* 계산할 수 없는 환경이면 표시하지 않아요 */ }
  };
  const setPair = (state, text) => {
    if (!pairing) kidLine.hidden = true;
    pairStatus.setAttribute('data-pair-state', state);
    pairStatus.textContent = text || PAIR_TEXT[state];
    const ready = pairing && ['format', 'verified', 'auth-failed', 'error'].includes(pairing.state);
    verifyBtn.disabled = checking || !verify || !ready;
    formatBtn.disabled = resetBtn.disabled = address.disabled = codeInput.disabled = reveal.disabled = checking || running;
    if (running) verifyBtn.disabled = true;
    verifyHint.hidden = !!verify;
    pill.textContent = connected() ? (pairing.canPrepare ? '연결됨' : '연결됨 · 읽기 전용') : '미연결';
    updateRegister();
  };
  const hideCode = () => {
    codeInput.setAttribute('type', 'password');
    reveal.textContent = '보이기';
    reveal.setAttribute('aria-pressed', 'false');
  };
  reveal.onclick = () => {
    const hidden = codeInput.getAttribute('type') === 'password';
    codeInput.setAttribute('type', hidden ? 'text' : 'password');
    reveal.textContent = hidden ? '숨기기' : '보이기';
    reveal.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  };
  // 입력을 바꾸면 이전 확인 결과는 버려요. 오류는 '형식 확인'을 누를 때만 보여 줘요.
  const edited = () => {
    if (checking || running) return;
    pairing = null;
    dropSelection();
    setPair(checkAddress(address.value).base && !String(codeInput.value).trim() ? 'address' : 'unset');
  };
  on(address, 'input', edited);
  on(codeInput, 'input', edited);
  formatBtn.onclick = () => {
    if (checking || view.closed) return;
    const where = checkAddress(address.value);
    if (!where.base) { pairing = null; return setPair('invalid', where.message); }
    if (!String(codeInput.value).trim() && pairing?.base === where.base) return setPair(pairing.state);
    if (!String(codeInput.value).trim()) { pairing = null; return setPair('address'); }
    const what = checkCode(codeInput.value);
    if (!what.code) { pairing = null; return setPair('invalid', what.message); }
    pairing = {base: where.base, code: what.code, state: 'format'};
    dropSelection();
    address.value = where.base;
    setPair('format');
    return showKid(pairing);
  };
  verifyBtn.onclick = async () => {
    if (checking || view.closed || !verify || !pairing) return;
    const target = pairing;
    checking = true;
    setPair('checking');
    let reply = 'error';
    try { reply = await verify({base: target.base, code: target.code}); } catch { reply = 'error'; }
    checking = false;
    const info = typeof reply === 'string' ? {state: reply} : reply || {};
    let result = ['verified', 'auth-failed', 'error'].includes(info.state) ? info.state : 'error';
    if (view.closed || pairing !== target) return;
    target.state = result;
    target.snapshot = result === 'verified' ? info.snapshot : null;
    target.scope = target.snapshot ? {botkiveId: target.snapshot.botkiveId, sourceId: target.snapshot.sourceId} : null;
    target.canPrepare = !!info.canPrepare;
    dropSelection();
    if (target.snapshot) {
      if (keepBox.checked && await remembered.save(api, target) && !view.closed) forgetBtn.hidden = false;
      if (view.closed || pairing !== target) return;
      setPair('verified', PAIR_TEXT.verified + ' 서재 ' + target.scope.botkiveId + ' · 출처 ' + target.scope.sourceId +
        ' · 이 연결로 등록한 캐릭터 ' + target.snapshot.registrations.length + '개.' +
        (target.canPrepare ? '' : ' 이 코드에는 등록 준비 권한이 없어 등록할 수 없어요. 연결 관리에서 등록 권한이 있는 코드를 새로 만들어 주세요.'));
      if (listed.length) status.textContent = '연결을 확인했어요. 목록을 다시 조회하면 등록할 캐릭터를 고를 수 있어요.';
    } else setPair(result, result === 'error' && info.relay !== undefined
      ? PAIR_TEXT.relay + (info.relay ? ' (HTTP ' + info.relay + ')' : '') : undefined);
  };
  resetBtn.onclick = () => {
    if (checking || running) return;
    pairing = null;
    dropSelection();
    address.value = '';
    codeInput.value = '';
    hideCode();
    setPair('reset');
    forget();
  };
  // 기억한 코드를 지워요. 메모리의 연결은 그대로라 지금 작업은 계속할 수 있어요.
  const forget = async () => {
    keepBox.checked = false;
    forgetBtn.hidden = true;
    await remembered.forget(api);
  };
  forgetBtn.onclick = forget;
  keepBox.onchange = async () => {
    if (!keepBox.checked) return forget();
    // 인증에 성공한 코드만 저장해요. 아직 확인 전이면 '연결 확인'이 성공할 때 저장돼요.
    if (connected() && await remembered.save(api, pairing)) forgetBtn.hidden = false;
    return undefined;
  };
  // 다시 열면 메모리의 연결 정보를 상태로만 보여 줘요. 코드 원문은 입력칸에 다시 넣지 않아요.
  if (pairing) {
    address.value = pairing.base;
    codeInput.setAttribute('placeholder', '코드가 메모리에 있어요 · 바꾸려면 새로 넣기');
    setPair(pairing.state);
    showKid(pairing);
  } else setPair('unset');
  view.clearSecrets = () => { codeInput.value = ''; hideCode(); };
  // 기억한 코드가 있으면 입력칸에 원문을 넣지 않고 불러온 뒤 연결만 확인해요. 캐릭터 자료는 보내지 않아요.
  view.ready = (async () => {
    const saved = await remembered.load(api);
    if (!saved || view.closed) return;
    keepBox.checked = true;
    forgetBtn.hidden = false;
    if (pairing) return;
    pairing = {base: saved.base, code: saved.code, state: 'format'};
    address.value = saved.base;
    codeInput.setAttribute('placeholder', '기억한 코드를 불러왔어요 · 바꾸려면 새로 넣기');
    setPair('format');
    showKid(pairing);
    await verifyBtn.onclick();
  })();

  // ---- 등록: 고르기 → 등록 전 확인 → 사용자 승인 → 전송 → 결과 ----
  const mainParts = [toolbar, listHead, selBar, names, empty, pair];
  const showMain = on => { for (const e of mainParts) e.hidden = !on; if (on) selBar.hidden = !listed.some(r => r.state === 'candidate') || listFor !== pairing; };
  updateRegister = () => {
    if (bindLocal) return;   // 시험용 연결 경로(bindLocal)가 버튼을 맡아요.
    const n = selection.size;
    picked.textContent = '선택 ' + n + '개';
    let why = '';
    if (running) why = '등록하는 중이에요.';
    else if (!connected()) why = '먼저 봇카이브 연결을 확인해 주세요.';
    else if (!pairing.canPrepare) why = '이 코드에는 등록 준비 권한이 없어요.';
    else if (listFor !== pairing) why = '연결을 확인한 뒤 목록을 다시 조회해 주세요.';
    else if (!n) why = '등록할 캐릭터를 골라 주세요.';
    register.disabled = !!why || !sheet.hidden || !runBox.hidden;
    register.textContent = n ? '선택한 캐릭터 ' + n + '개 등록…' : '선택한 캐릭터 등록…';
    hint.textContent = why || '누르면 보낼 내용을 먼저 보여 줘요. 그 화면에서 한 번 더 확인해야 보내요.';
    for (const b of [pickAll, pickNone]) b.disabled = running;
    for (const box of pickBoxes.values()) if (box.title !== '이미 이 연결로 등록했어요') box.disabled = running;
  };
  pickAll.onclick = () => {
    if (running || listFor !== pairing) return;
    for (const r of listed) if (r.state === 'candidate') { selection.add(r.id); const b = pickBoxes.get(r.id); if (b) b.checked = true; }
    updateRegister();
  };
  pickNone.onclick = () => {
    if (running) return;
    selection.clear();
    for (const b of pickBoxes.values()) b.checked = false;
    updateRegister();
  };
  const SENT = '보내는 것: 이름·설명·성격·시나리오·첫 메시지·예시 대화·제작자 노트·시스템 프롬프트 등 캐릭터 글, 대체 인사말·태그, 로어북과 그 설정, 표시용 정규식, 대표 이미지와 카드에 적힌 에셋(표정·추가 에셋).';
  const NOT_SENT = '보내지 않는 것: 채팅 기록·대화 메시지, 개인 설정·API 키·로그인 정보·쿠키, 다른 캐릭터와 모듈 전체, 카드에 적히지 않은 파일, 트리거 스크립트·음성 설정·배경 HTML 같은 지원하지 않는 설정.';
  const DUP = '중복: 이 연결(출처)로 이미 등록한 캐릭터는 보내지 않거나 서버가 건너뛰어요. 봇카이브에 있던 캐릭터를 덮어쓰거나 지우지 않아요. 다른 출처 식별자로 만든 코드로 같은 캐릭터를 다시 보내면 별도 캐릭터로 한 번 더 생길 수 있어요.';
  const SCOPE = '작업 범위: 한 캐릭터씩 차례로 보내요. 에셋 크기는 읽은 뒤에야 알 수 있어요(봇카이브 한도를 넘으면 그 캐릭터는 실패로 남아요). PocketRisu 원본은 읽기만 하고 바꾸지 않아요.';
  const add = (parent, tag, cls, text) => { const e = node(document, tag, cls, text); parent.append(e); return e; };
  const sample = (list, ids) => {
    const ol = add(list, 'ol', 'bkl-mini');
    const byId = new Map(listed.map(r => [r.id, r]));
    ids.slice(0, 200).forEach(id => add(ol, 'li', '', (byId.get(id)?.name || '(이름 없음)') + ' · ' + id));
    if (ids.length > 200) add(ol, 'li', '', '외 ' + (ids.length - 200) + '개');
  };
  const openSheet = () => {
    if (running || register.disabled) return;
    const ids = [...selection], target = pairing;
    sheet.replaceChildren();
    const h = add(sheet, 'h3', '', '등록 전 확인');
    h.id = 'bkl-sheet-title';
    const dl = add(sheet, 'dl', 'bkl-dl');
    for (const [k, v] of [['봇카이브 주소', target.base], ['서재', target.scope.botkiveId], ['출처 식별자', target.scope.sourceId],
      ['키 식별자', target.kid || '(계산 안 됨)'], ['선택한 캐릭터', ids.length + '개']]) { add(dl, 'dt', '', k); add(dl, 'dd', '', v); }
    sample(sheet, ids);
    for (const text of [SENT, NOT_SENT, DUP, SCOPE]) add(sheet, 'p', 'bkl-note', text);
    const folderLabel = add(sheet, 'label', 'bkl-ack', '');
    const folderBox = node(document, 'input', '');
    folderBox.setAttribute('type', 'checkbox');
    folderBox.checked = false;
    folderLabel.append(folderBox, ' 폴더 분류 정보도 보내기 (PocketRisu가 데이터베이스 읽기 권한을 물을 수 있어요)');
    const ackLabel = add(sheet, 'label', 'bkl-ack', '');
    const ack = node(document, 'input', '');
    ack.setAttribute('type', 'checkbox');
    ack.checked = false;
    ackLabel.append(ack, ' 위 내용을 확인했어요. 고른 ' + ids.length + '개 캐릭터를 이 봇카이브에 등록할게요.');
    const bar = add(sheet, 'div', 'bkl-selbar', '');
    const start = add(bar, 'button', 'bkl-btn bkl-btn--primary', '등록 시작 (' + ids.length + '개)');
    const back = add(bar, 'button', 'bkl-btn', '돌아가기');
    for (const b of [start, back]) b.setAttribute('type', 'button');
    start.disabled = true;
    ack.onchange = () => { start.disabled = !ack.checked; };
    back.onclick = () => { sheet.hidden = true; showMain(true); status.textContent = '등록하지 않았어요. 아무것도 보내지 않았어요.'; updateRegister(); register.focus?.(); };
    start.onclick = () => {
      if (!ack.checked || running || start.disabled) return undefined;
      start.disabled = true;
      return runRegister(target, ids, folderBox.checked);
    };
    showMain(false);
    sheet.hidden = false;
    updateRegister();
    ack.focus?.();
  };
  const LABEL = {registered: '등록했어요', skipped: '서재에 이미 있어 건너뛰었어요', already: '이미 등록됨(보내지 않음)',
    failed: '실패', cancelled: '취소(서재 등록 전)', 'not-sent': '보내지 않음', unconfirmed: '확인 필요', missing: 'PocketRisu 목록에서 사라짐'};
  const REASON = {auth: '인증 실패', permission: '권한 없음', 'too-large': '너무 큼', conflict: '요청 충돌', server: '서버 오류',
    rejected: '봇카이브가 거절', storage: '봇카이브 저장 공간 부족', asset: '에셋 문제', changed: 'PocketRisu 목록이 바뀜', network: '통신 문제', other: '기타 오류'};
  const tally = (result, total) => {
    const n = state => result.items.filter(i => i.state === state).length;
    return {total, registered: result.registered, skipped: n('skipped') + n('already'), failed: n('failed') + n('missing'),
      cancelled: n('cancelled') + n('not-sent'), unconfirmed: n('unconfirmed')};
  };
  const countsText = c => '선택 ' + c.total + ' · 새로 등록 ' + c.registered + ' · 이미 등록됨 ' + c.skipped + ' · 실패 ' + c.failed +
    ' · 취소·보내지 않음 ' + c.cancelled + ' · 확인 필요 ' + c.unconfirmed;
  const runRegister = async (target, ids, withFolders) => {
    const L = globalThis.BotkiveSecureLinkV4, B = globalThis.BotkiveBatch;
    if (!L || !B || typeof api.nativeFetch !== 'function') { status.textContent = '이 화면에서는 등록 기능을 쓸 수 없어요.'; return; }
    running = true;
    let stop = false;
    sheet.hidden = true;
    runBox.replaceChildren();
    runBox.hidden = false;
    add(runBox, 'h3', '', '등록하는 중');
    const now = add(runBox, 'p', 'bkl-note', '준비 중이에요.');
    const live = add(runBox, 'p', 'bkl-counts', '');
    add(runBox, 'p', 'bkl-note', '최소화해도 계속 보내요. 진행 상황은 플로팅 단추에 나오고, 플로팅 단추나 메뉴로 다시 열 수 있어요. PocketRisu를 새로 고치면 멈춰요.');
    add(runBox, 'p', 'bkl-note', '중단을 누르면 아직 보내지 않은 캐릭터는 보내지 않아요. 지금 처리 중인 캐릭터는 서재 등록 전이면 멈추고, 이미 등록 요청을 보냈다면 서버에서 끝날 수 있어요. 이미 서재에 등록된 캐릭터는 지우지 않아요.');
    const stopBtn = add(runBox, 'button', 'bkl-btn', '등록 중단');
    stopBtn.setAttribute('type', 'button');
    stopBtn.onclick = () => { stop = true; stopBtn.disabled = true; now.textContent = '중단하는 중이에요. 지금 단계가 끝나면 멈춰요.'; };
    updateRegister();
    setPair(target.state, pairStatus.textContent);
    scan.disabled = true;
    options.label?.('봇카이브 준비 중');
    const done = {registered: 0, failed: 0};
    let result;
    try {
      const port = L.securePort({nativeFetch: (url, init) => api.nativeFetch(url, init)}, {base: target.base, code: target.code});
      result = await B.createBatch(api, target.scope, port)({signal: {get aborted() { return stop || view.stopped; }},
        only: ids, allowAssets: true, folders: withFolders, onProgress: event => {
          if (view.closed) return;
          if (event.stage === 'item') options.label?.('봇카이브 ' + event.position + '/' + event.total);
          if (event.stage === 'item') now.textContent = event.position + ' / ' + event.total + ' · ' + (event.name || event.id) + ' 보내는 중';
          if (event.stage === 'assets') now.textContent = now.textContent.replace(/ · 에셋.*$/, '') + ' · 에셋 ' + event.done + '/' + event.total;
          if (event.stage === 'result') { done.registered = event.registered; done.failed = event.failed;
            live.textContent = '처리 ' + event.position + ' / ' + event.total + ' · 새로 등록 ' + event.registered + ' · 실패 ' + event.failed; }
        }});
    } catch {
      result = {registered: 0, skipped: 0, failed: ids.length, cancelled: false, refreshRequired: false,
        items: ids.map(id => ({id, state: 'not-sent'})), error: true};
    }
    running = false;
    options.label?.(result.error || stop || result.cancelled ? '봇카이브 등록' : '봇카이브 등록 끝');
    const counts = tally(result, ids.length);
    if (view.closed) { lastRun = '지난 등록 결과(화면을 닫은 동안 끝남): ' + countsText(counts); return result; }
    selection.clear();
    listFor = null;
    runBox.replaceChildren();
    add(runBox, 'h3', '', result.error ? '등록을 시작하지 못했어요' : stop || result.cancelled ? '등록을 중단했어요' : '등록을 마쳤어요');
    add(runBox, 'p', 'bkl-counts', countsText(counts));
    if (result.error) add(runBox, 'p', 'bkl-warn', '연결 상태를 확인하지 못해 아무 캐릭터도 보내지 않았어요. 연결을 다시 확인해 주세요.');
    if (result.storageFull) add(runBox, 'p', 'bkl-warn', '봇카이브(NAS) 저장 공간이 부족해서 멈췄어요. 남은 캐릭터는 보내지 않았어요. NAS 공간을 비운 뒤 다시 등록해 주세요.');
    if (result.refreshRequired) add(runBox, 'p', 'bkl-warn', '마지막 캐릭터의 서재 등록 결과를 확인하지 못했어요. 자동으로 다시 보내지 않아요. 봇카이브 서재에서 그 캐릭터가 있는지 확인한 뒤, 연결 확인과 목록 조회를 다시 해 주세요.');
    const ol = add(runBox, 'ol', 'bkl-mini');
    for (const item of result.items) add(ol, 'li', '', (item.name || '(이름 없음)') + ' · ' + item.id + ' — ' + (LABEL[item.state] || item.state) +
      (item.reason ? ' (' + (REASON[item.reason] || item.reason) + ')' : '') + (item.botId ? ' · 서재 #' + item.botId : '') +
      (item.detail ? ' — ' + item.detail : ''));
    const bar = add(runBox, 'div', 'bkl-selbar', '');
    const rescan = add(bar, 'button', 'bkl-btn bkl-btn--primary', '연결 다시 확인');
    const back = add(bar, 'button', 'bkl-btn', '목록으로 돌아가기');
    for (const b of [rescan, back]) b.setAttribute('type', 'button');
    const leave = () => { runBox.hidden = true; showMain(true); fill(listed.map(r => ({...r, state: 'unknown'}))); updateRegister(); };
    back.onclick = () => { leave(); status.textContent = '등록 결과를 반영하려면 연결 확인 뒤 목록을 다시 조회해 주세요.'; };
    rescan.onclick = () => { leave(); pair.setAttribute('open', ''); verifyBtn.onclick(); };
    status.textContent = '등록 결과 · ' + countsText(counts);
    scan.disabled = false;
    setPair(target.state, pairStatus.textContent);
    updateRegister();
    rescan.focus?.();
    return result;
  };
  if (!bindLocal) register.onclick = openSheet;
  updateRegister();
  if (lastRun) { status.textContent = lastRun; lastRun = null; }

  if (bindLocal) bindLocal({register, scan, cancel, names, status,
    get busy() { return view.busy; }, set busy(value) { view.busy = value; },
    get stopped() { return view.stopped; }, set stopped(value) { view.stopped = value; }});
  view.root = root;
  // 첫 포커스. Chrome 157은 숨겨져 있던 iframe이 막 보이게 된 같은 순간의 focus()를 무시해요(Phase 16 관측).
  // 창 포커스를 먼저 요청하고, 실제로 포커스가 들어왔는지 확인하며 몇 프레임 동안만 다시 시도해요.
  // 끝내 못 받으면(다른 브라우저 제약) 화면을 한 번 누르라는 안내를 보여 줘요. 상위 페이지는 건드리지 않아요.
  const focusHint = node(document, 'p', 'bkl-hint bkl-focus-hint', '키보드(Esc·Tab)로 쓰려면 이 화면을 한 번 눌러 주세요.');
  focusHint.hidden = true;
  body.insertBefore ? body.insertBefore(focusHint, body.firstChild ?? null) : body.append(focusHint);
  const hasFocus = () => (typeof document.hasFocus === 'function' ? document.hasFocus() : true);
  const inside = () => panel.contains?.(document.activeElement) ?? true;
  const nextFrame = () => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
  view.focusFirst = async () => {
    for (let i = 0; i < 10 && !view.closed; i++) {
      try { if (i) globalThis.focus?.(); } catch { /* 창 포커스 요청이 막혀도 계속해요 */ }
      if (!inside()) scan.focus?.();
      if (hasFocus() && inside()) { focusHint.hidden = true; root.setAttribute('data-focus', 'ready'); return true; }
      await nextFrame();
    }
    if (!view.closed) { focusHint.hidden = false; root.setAttribute('data-focus', 'hint'); }
    return false;
  };
  // 사용자가 화면을 누르면 브라우저가 이 iframe에 포커스를 줘요. 그때 안내를 거두고 첫 버튼으로 옮겨요.
  if (typeof globalThis.addEventListener === 'function') on(globalThis, 'focus', () => {
    if (view.closed) return;
    focusHint.hidden = true;
    if (!inside()) scan.focus?.();
    root.setAttribute('data-focus', 'ready');
  });
  return view;
}

async function install(api, document, bindLocal, options = {}) {
  const open = async () => {
    // 최소화한 화면은 그대로 다시 보여 줘요(보내는 중이면 계속 보내는 중이에요).
    if (current && !current.closed && current.minimized) {
      current.minimized = false;
      await api.showContainer('fullscreen');
      if (!current.closed) current.focusFirst();
      return;
    }
    current?.dispose();
    const view = createView(api, document, bindLocal, {...options, label});
    current = view;
    const style = node(document, 'style', '', CSS);
    document.documentElement?.setAttribute?.('lang', 'ko');
    document.body.replaceChildren(style, view.root);
    await api.showContainer('fullscreen');
    if (!view.closed) view.focusFirst();
  };
  // 플로팅 단추(채팅 화면)와 메뉴 항목. 이름에 진행 상황을 보여 줘요. 없는 판의 PocketRisu에서는 설정 메뉴만 써요.
  let shown = null;
  const label = async name => {
    if (name === shown) return;
    shown = name;
    for (const [location, id] of [['action', 'botkive-link-float'], ['hamburger', 'botkive-link-menu']]) {
      try { await api.registerButton({name, icon: '📚', iconType: 'html', location, id}, open); } catch { /* 설정 메뉴로 열 수 있어요 */ }
    }
  };
  await api.registerSetting('봇카이브 등록', open, '', 'none', 'botkive-link-mvp');
  await label('봇카이브 등록');
}
if(typeof module!=='undefined')module.exports={install,CSS,checkAddress,checkCode,realVerify,reset:()=>{pairing=null;}};
else return install(globalThis.risuai,document);
})();
