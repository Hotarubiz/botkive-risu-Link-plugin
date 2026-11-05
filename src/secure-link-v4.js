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
