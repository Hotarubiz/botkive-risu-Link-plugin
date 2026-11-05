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
