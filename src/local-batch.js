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
