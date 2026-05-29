// ───────── API helpers ─────────
async function j(u){const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw new Error(r.status);return r.json();}
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const d=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,data:d};}

// ───────── 상태 ─────────
let TAB='gen', galFilter='all', selRep=null, MODEL={name:'Z-Image-Turbo',dtype:'uint4'};
let REPS=[], REPS_RAW=[], IMAGES=[], RES=null, CONDS=[], selectedConfig=null;
let curImg=null, mPromptVal='', mSeedVal='', mReplicaVal='', rdReplica=null, rdRange='live';
let cond={status:'all',sort:'name'};
let recentIds=[], recentMode=false;          // 결과 버튼: 방금 생성한 이미지 id + NEW 배지 모드
let genWatching=false, genBaseline=new Set();// 생성 완료 감지(다량/job)용
let rdTimer=null;                            // 레플리카 모달 자동 갱신 타이머
let IMGTAB=[], imgGridList=[], imgCond={type:'all',sort:'new'}, imgScope='run';  // 이미지 탭 상태 (scope: run=이번 실행 / all=전체)

// ───────── 탭 ─────────
function show(v){TAB=v;
  document.getElementById('vGen').hidden=v!=='gen';
  document.getElementById('vDash').hidden=v!=='dash';
  document.getElementById('vImg').hidden=v!=='img';
  document.getElementById('tGen').classList.toggle('on',v==='gen');
  document.getElementById('tDash').classList.toggle('on',v==='dash');
  document.getElementById('tImg').classList.toggle('on',v==='img');
  if(v==='dash')reloadReplicas();
  if(v==='img')loadImgTab();}

// ───────── MANUAL 접기 (접으면 REPLICAS가 flex로 늘어남) ─────────
function toggleManual(){const b=document.getElementById('manualBody'),t=document.getElementById('manualToggle');
  const open=b.style.display!=='none';b.style.display=open?'none':'block';t.classList.toggle('collapsed',open);}

// ───────── CONFIG 토글 + 검색 ─────────
function toggleFile(){const on=document.getElementById('useFile').checked;
  document.getElementById('prompt').classList.toggle('disabled-soft',on);
  document.getElementById('condSearch').classList.toggle('disabled-soft',!on);
  if(!on){document.getElementById('condDD').classList.remove('on');}}
function filterConds(){const q=document.getElementById('condInput').value.toLowerCase();
  const dd=document.getElementById('condDD');
  const list=CONDS.filter(f=>f.toLowerCase().includes(q));
  dd.innerHTML=list.length?list.map(f=>`<div class="cond-opt" onclick="pickConfig('${f}')">${f}</div>`).join('')
    :'<div class="cond-opt" style="color:var(--text-dim)">파일 없음</div>';
  dd.classList.add('on');}
function pickConfig(f){selectedConfig=f;document.getElementById('condInput').value=f;document.getElementById('condDD').classList.remove('on');}
document.addEventListener('click',e=>{if(!e.target.closest('#condSearch'))document.getElementById('condDD')?.classList.remove('on');});

// ───────── 폼 검증 ─────────
function clearInvalid(){['prompt','w','h','steps','count','condInput'].forEach(id=>document.getElementById(id)?.classList.remove('invalid'));}
function validate(){
  clearInvalid();const bad=[];const on=document.getElementById('useFile').checked;
  const w=+document.getElementById('w').value, h=+document.getElementById('h').value;
  const st=+document.getElementById('steps').value, ct=+document.getElementById('count').value;
  if(on){ if(!selectedConfig){bad.push('condInput');} }
  else{ if(!document.getElementById('prompt').value.trim())bad.push('prompt'); }
  if(!(w>=256&&w<=2048))bad.push('w');
  if(!(h>=256&&h<=2048))bad.push('h');
  if(!(st>=1))bad.push('steps');
  if(!(ct>=1))bad.push('count');
  bad.forEach(id=>document.getElementById(id).classList.add('invalid'));
  return bad;
}
function formMsg(cls,txt){const m=document.getElementById('formMsg');m.className='form-msg '+cls;m.textContent=txt;}

// ───────── 생성 ─────────
let generating=false;
async function captureBaseline(){            // 생성 직전의 MANUAL 이미지 id 집합 (방금 만든 것 추려내기용)
  try{const imgs=await j('/api/images?source=manual&limit=500');return new Set((imgs||[]).map(m=>m.id));}
  catch(e){return new Set();}
}
async function doGenerate(){
  if(generating) return;                       // 연타 방지
  const bad=validate();
  if(bad.length){formMsg('err','입력 내용을 확인해주세요.');return;}
  formMsg('','');document.getElementById('formMsg').className='form-msg';  // 검증 통과 → 이전 안내문구 제거
  const btn=document.getElementById('genBtn');
  const resBtn=document.getElementById('resultBtn');
  generating=true; btn.disabled=true; btn.textContent='생성 중...';
  resBtn.disabled=true; resBtn.classList.remove('ready');   // 새 생성 시작 → 결과 버튼 잠금
  genBaseline=await captureBaseline();
  const on=document.getElementById('useFile').checked;
  const ct=+document.getElementById('count').value;
  try{
    let res;
    if(on){ res=await post('/api/job/start',{count:ct,conditions_file:selectedConfig,random_pick:true}); }
    else{
      const seedv=document.getElementById('seed').value.trim();
      res=await post('/api/generate',{prompt:document.getElementById('prompt').value.trim(),
        width:+document.getElementById('w').value,height:+document.getElementById('h').value,
        num_inference_steps:+document.getElementById('steps').value,guidance_scale:0.0,
        seed:seedv===''?null:+seedv,count:ct});
    }
    if(!res.ok){
      if(res.status===409)formMsg('warn', res.data.detail||'진행 중인 작업이 있습니다. 일시중지 후 취소하신 다음 다시 진행해주세요.');
      else formMsg('err', res.data.detail||'생성 요청 실패');
      endGenerate(); return;
    }
    // 단일(single) = 응답 시점에 이미 완료 / 다량·CONFIG(job) = 백그라운드 → poll이 완료 감지
    if(!on && ct<=1 && res.data && res.data.mode==='single'){
      await finishGenerate();
    } else {
      genWatching=true;            // 생성 버튼은 계속 '생성 중...' 유지, renderJob이 완료 감지
    }
    poll();
  } catch(e){ formMsg('err','생성 요청 실패'); endGenerate(); }
}
function endGenerate(){              // 생성 버튼 원복 (완료/실패 공통)
  generating=false; genWatching=false;
  const btn=document.getElementById('genBtn'); btn.disabled=false; btn.textContent='생성';
}
async function finishGenerate(){    // 완료 처리: 방금 만든 MANUAL id 계산 → 결과 버튼 활성
  let cur=[];
  try{cur=await j('/api/images?source=manual&limit=500');}catch(e){cur=[];}
  recentIds=(cur||[]).filter(m=>!genBaseline.has(m.id)).map(m=>m.id);
  endGenerate();
  const resBtn=document.getElementById('resultBtn');
  if(recentIds.length){ resBtn.disabled=false; resBtn.classList.add('ready'); }
  formMsg('warn','생성이 완료되었습니다.');
  setTimeout(()=>{formMsg('','');document.getElementById('formMsg').className='form-msg';},2500);
  poll();
}
// 결과 버튼: MANUAL 필터로 전환 + 방금 만든 것 NEW 배지
function showResult(){
  if(!recentIds.length) return;
  recentMode=true; selRep=null;
  galFilter='manual';
  [...document.getElementById('galSeg').children].forEach(b=>b.classList.toggle('on', b.dataset.f==='manual'));
  updateGalFilter(); poll();
}

// ───────── 잡 제어 ─────────
async function jobCtrl(a){await post('/api/job/'+a,{});poll();}

// ───────── 폴링 ─────────
let polling=false;
async function poll(){
  if(polling) return;          // 이전 poll이 아직 안 끝났으면 건너뜀 (느린 노드에서 요청 쌓임 방지)
  polling=true;
  try{
    try{const s=await j('/api/status');renderJob(s);}catch(e){}
    try{RES=await j('/api/resources');renderResources();}catch(e){}
    try{IMAGES=await j('/api/images?source='+(galFilter==='all'?'':galFilter)+(selRep?('&replica='+encodeURIComponent(selRep)):''));renderGallery();}catch(e){}
    try{const r=await j('/api/replicas');REPS=r.replicas||[];renderReplist();}catch(e){}
  } finally { polling=false; }
}
function renderJob(s){
  const map={running:'RUNNING',paused:'PAUSED',done:'DONE',idle:'IDLE',cancelled:'CANCELLED',error:'ERROR'};
  const cls={running:'s-running',paused:'s-paused',done:'s-done',idle:'s-idle',cancelled:'s-done',error:'s-error'};
  document.getElementById('jstate').textContent=map[s.state]||s.state.toUpperCase();
  document.getElementById('jstate').className='state-chip '+(cls[s.state]||'s-idle');
  document.getElementById('jc').textContent=s.total?`${s.completed} / ${s.total}`:'–';
  document.getElementById('jbar').style.width=(s.total?Math.round(s.completed/s.total*100):0)+'%';
  // 다량·CONFIG 생성(job) 완료 감지 → 결과 버튼 활성
  if(genWatching && ['done','idle','cancelled','error'].includes(s.state)){ genWatching=false; finishGenerate(); }
}
function renderResources(){
  if(!RES)return;const g=RES.gpu||{};const lim=+document.getElementById('limitGen').value||null;
  const vover=lim&&g.vram_used_gb!=null&&g.vram_used_gb>lim;
  const vp=g.vram_total_gb?Math.min(100,g.vram_used_gb/g.vram_total_gb*100):0;
  const rp=g.ram_total_gb?Math.min(100,g.ram_used_gb/g.ram_total_gb*100):0;
  document.getElementById('resGrid').innerHTML=`
    <div class="res ${vover?'over':''}"><div class="rk">GPU VRAM</div><div class="rv">${g.vram_used_gb??'–'} <small>/ ${g.vram_total_gb??'–'} GB</small></div><div class="rbar"><i style="width:${vp}%"></i></div></div>
    <div class="res"><div class="rk">System RAM</div><div class="rv">${g.ram_used_gb??'–'} <small>/ ${g.ram_total_gb??'–'} GB</small></div><div class="rbar"><i style="width:${rp}%"></i></div></div>
    <div class="res"><div class="rk">GPU Util</div><div class="rv">${g.util??'–'} <small>%</small></div></div>
    <div class="res"><div class="rk">VRAM peak</div><div class="rv">${RES.vram_peak_gb??'–'} <small>GB</small></div></div>`;
  const f=v=>v==null?'–':v;
  document.getElementById('speedGrid').innerHTML=`
    <div class="sp"><div class="k">최근 생성</div><div class="v">${f(RES.last_gen?.seconds)}<small>s</small></div></div>
    <div class="sp"><div class="k">평균</div><div class="v">${f(RES.gen_avg_s)}<small>s</small></div></div>
    <div class="sp"><div class="k">최단</div><div class="v">${f(RES.gen_min_s)}<small>s</small></div></div>
    <div class="sp"><div class="k">최장</div><div class="v">${f(RES.gen_max_s)}<small>s</small></div></div>`;
}
// 상태 → 점 색깔 (#4): 죽음 빨강 / 작업중 초록(기본) / 멈춤 노랑 / 끝남·기타 회색
function dotClass(r){
  if(r._stale) return 'dead';
  return {running:'',paused:'paused',done:'done',idle:'done',cancelled:'done',error:'dead'}[r.job_state]||'';
}
// 키 기반 reconcile (#2): 통째로 다시 그리지 않고 있는 건 갱신·없어진 것만 제거 → 깜빡임 방지
function reconcile(container, items, keyOf, clsOf, htmlOf, onClickOf){
  if(!items.length){ container.innerHTML='<div class="recon-empty" style="color:var(--text-dim);font-size:12px;padding:14px;text-align:center;grid-column:1/-1">검색 결과 없음</div>'; return; }
  const empty=container.querySelector('.recon-empty'); if(empty) container.innerHTML='';
  const esc=s=>String(s).replace(/["\\]/g,c=>'\\'+c);
  const keys=new Set();
  items.forEach(it=>{
    const k=keyOf(it); keys.add(k);
    let el=container.querySelector(':scope > [data-key="'+esc(k)+'"]');
    if(!el){ el=document.createElement('div'); el.dataset.key=k; container.appendChild(el); }
    const cls=clsOf(it); if(el.className!==cls) el.className=cls;
    const html=htmlOf(it); if(el.__html!==html){ el.innerHTML=html; el.__html=html; }
    el.onclick=onClickOf?()=>onClickOf(it):null;
  });
  [...container.children].forEach(c=>{ if(c.dataset.key!==undefined && !keys.has(c.dataset.key)) c.remove(); });
}
function renderReplist(){
  const q=(document.getElementById('rq').value||'').toLowerCase();
  const list=REPS.filter(r=>(r.replica||'').toLowerCase().includes(q));
  reconcile(document.getElementById('replist'), list,
    r=>r.replica,
    r=>'repitem'+(selRep===r.replica?' sel':''),
    r=>`<span class="rid">${r.replica}</span>
      <span class="meta"><span class="dot ${dotClass(r)}"></span>${r.job_completed||0}/${r.job_total||0} · ${r.util??'–'}%</span>`,
    r=>selReplica(r.replica));
}
function selReplica(id){selRep=id;recentMode=false;document.getElementById('repAll').classList.toggle('on',id===null);
  updateGalFilter();poll();}
function setGalFilter(f,btn){galFilter=f;recentMode=false;[...document.getElementById('galSeg').children].forEach(b=>b.classList.remove('on'));btn.classList.add('on');updateGalFilter();poll();}
// 갤러리 상단 필터 라벨 + × (레플리카 선택 / 방금 생성)
function updateGalFilter(){
  const el=document.getElementById('galFilt');
  let label='';
  if(recentMode) label='방금 생성';
  else if(selRep) label=selRep.slice(-5).toUpperCase();
  if(!label){ el.innerHTML=''; return; }
  el.innerHTML='▸ '+label+' <button class="gal-x" onclick="clearGalFilter()">✕</button>';
}
function clearGalFilter(){
  selRep=null; recentMode=false; recentIds=[];   // × → 레플리카/방금생성 해제 + NEW 배지 제거
  document.getElementById('repAll').classList.add('on');
  updateGalFilter(); poll();
}
function renderGallery(){
  const el=document.getElementById('gallery');
  let list=IMAGES;
  if(recentMode){ // 방금 생성 모드: MANUAL을 최신순으로 (recentIds는 NEW 배지로 강조)
    list=[...IMAGES].sort((a,b)=>String(b.finished||b.created||'').localeCompare(String(a.finished||a.created||'')));
  }
  if(!list.length){el.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:30px">이미지 없음</div>';el.__sig=null;return;}
  const sig=list.map(m=>m.id).join('|')+'#'+galFilter+'#'+(selRep||'')+'#'+recentMode+'#'+recentIds.join(',');
  if(el.__sig===sig) return;   // 목록·필터 그대로면 재구축 안 함
  el.__sig=sig;
  el.innerHTML=list.map((m,i)=>{
    const isNew=recentMode&&recentIds.includes(m.id);
    return `<div class="thumb" onclick="openImg(${i})">
      ${isNew?'<span class="new-badge">NEW</span>':''}
      <div class="imgph" data-src="/api/images/${encodeURIComponent(m.id)}/file"></div>
      <div class="cap"><span class="src">${(m.replica||'').slice(-5).toUpperCase()}</span><span class="mtag">${(m.png_sub||m.source||'').toUpperCase()}</span></div></div>`;
  }).join('');
  el.querySelectorAll('.imgph').forEach(b=>loadImgBox(b));
}

// ───────── 이미지 로더 (불러오는 중 → 시간 더 걸림 → 다시 불러오기) ─────────
const LD_SLOW_MS=8000;    // 이 시간 넘게 로딩이면 "시간이 더 걸리고 있습니다"
const LD_FAIL_MS=30000;   // 이 시간 넘게 실패 반복이면 "다시 불러오기"
function loadImgBox(box, fit){
  const src=box.dataset.src; if(!src)return;
  fit=fit||box.dataset.fit||'cover';
  box.innerHTML='<div class="img-load"><span class="ld-msg">불러오는 중</span><span class="ld-dots"></span></div>';
  const t0=Date.now();
  let slow=setTimeout(()=>{const m=box.querySelector('.ld-msg');if(m)m.textContent='시간이 더 걸리고 있습니다';},LD_SLOW_MS);
  const img=new Image();
  img.onload=()=>{ clearTimeout(slow); box.innerHTML='';
    img.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:'+fit+';display:block';
    box.appendChild(img); };
  img.onerror=()=>{
    if(Date.now()-t0<LD_FAIL_MS){ setTimeout(()=>{img.src=src+(src.includes('?')?'&':'?')+'_t='+Date.now();},1500); }
    else{ clearTimeout(slow);
      box.innerHTML='<div class="img-fail" onclick="event.stopPropagation();loadImgBox(this.closest(\'.imgph,.imgph-big\'))">'
        +'<button class="img-reload" onclick="event.stopPropagation();loadImgBox(this.closest(\'.imgph,.imgph-big\'))"><svg class="ico"><use href="#i-reload"/></svg>다시 불러오기</button>'
        +'<div class="img-failsub">이미지를 불러오지 못했습니다. 잠시 후 다시 시도하거나, 네트워크·서비스 상태를 확인해주세요.</div></div>';
    }
  };
  img.src=src+(src.includes('?')?'&':'?')+'_t='+Date.now();
}
// 로딩 점 애니메이션 (.→..→...→ 반복) — 전역 1개 타이머
setInterval(()=>{const d=['.','..','...'][Math.floor(Date.now()/450)%3];
  document.querySelectorAll('.ld-dots').forEach(e=>{e.textContent=d;});},450);

// ───────── 이미지 모달 ─────────
function openImg(i){openImgObj(IMAGES[i]);}      // 갤러리에서 (IMAGES 인덱스)
function openImgObj(m){if(!m)return;curImg=m;
  const box=document.getElementById('mImgBox');
  box.dataset.src='/api/images/'+encodeURIComponent(m.id)+'/file'; box.dataset.fit='contain';
  loadImgBox(box,'contain');
  document.getElementById('mPrompt').textContent=m.prompt||'(없음)';mPromptVal=m.prompt||'';
  document.getElementById('mSeed').textContent=m.seed??'–';mSeedVal=String(m.seed??'');
  document.getElementById('mSize').textContent=`${m.width}×${m.height} · ${m.steps}`;
  document.getElementById('mModel').textContent=`${MODEL.name} ${MODEL.dtype}`;
  const type=(m.png_sub||m.source||'').toUpperCase();
  document.getElementById('mType').textContent=type;
  // CONFIG 줄: AUTO일 때만
  const cl=document.getElementById('mConfigLine');
  if(type==='AUTO'&&m.config_file){cl.style.display='';document.getElementById('mConfig').textContent=m.config_file;}
  else cl.style.display='none';
  // #8 RUN: 자동 생성된 이름(auto- 접두어)이면 표시
  const run=m.run_id||'–';
  document.getElementById('mRun').innerHTML = run + (String(run).startsWith('auto-')?' <span class="def">자동 생성</span>':'');
  document.getElementById('mReplica').textContent=m.replica||'–';mReplicaVal=m.replica||'';
  // #10 시간: 시작 / 종료 / 걸린 시간 (구버전 메타는 created로 폴백)
  const fmt=t=>t?String(t).replace('T',' '):'–';
  document.getElementById('mStarted').textContent=fmt(m.started||m.created);
  document.getElementById('mFinished').textContent=fmt(m.finished||m.created);
  document.getElementById('mElapsed').textContent=(m.elapsed_s!=null)?(Math.round(m.elapsed_s*1000)/1000+'s'):'–';
  document.getElementById('mFile').textContent=m.id+'.png';
  // #9 경로: 컨테이너 경로 + 클라우드 저장소 경로(마운트 원본 위치)
  const cpath=m.png||('/outputs/'+(m.png_sub||'?')+'/'+m.id+'.png');
  const cloud=cpath.replace('/outputs','Z-Image_Outputs').replace('/workspace','Z-Image_Workspace');
  document.getElementById('mPathContainer').textContent=cpath;
  document.getElementById('mPathCloud').textContent=cloud;
  const sz=m.size_bytes?(m.size_bytes/1024/1024).toFixed(1)+'MB':'–';
  document.getElementById('mSizeVal').textContent=sz;
  document.getElementById('imgModal').classList.add('on');
}
function closeImg(){document.getElementById('imgModal').classList.remove('on');}
function copyText(t){navigator.clipboard?.writeText(t);}
function downloadImg(){if(!curImg)return;const a=document.createElement('a');a.href='/api/images/'+encodeURIComponent(curImg.id)+'/file';a.download=curImg.id+'.png';a.click();}
function viewReplica(id){closeImg();openReplicaModal(id);}

// ───────── 이미지 탭 ─────────
async function loadImgTab(){
  try{IMGTAB=await j(`/api/images?scope=${imgScope}&limit=1000`)||[];}catch(e){IMGTAB=[];}
  bindImgSeg('iSegType','type');bindImgSeg('iSegSort','sort');
  renderImgTab();
}
// 보기 범위 토글: 이번 실행(run) / 전체(all) — scope가 바뀌면 서버에서 다시 받아옴
function setImgScope(scope,btn){
  if(imgScope===scope)return;
  imgScope=scope;
  [...document.getElementById('imgScopeSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.s===scope));
  loadImgTab();
}
function bindImgSeg(segId,key){[...document.getElementById(segId).children].forEach(b=>b.onclick=()=>{
  [...document.getElementById(segId).children].forEach(x=>x.classList.remove('on'));b.classList.add('on');
  imgCond[key]=b.dataset.v;renderImgTab();});}
function imgVal(id){return (document.getElementById(id)?.value||'').trim();}
function imgCondBadge(){let n=0;if(imgCond.type!=='all')n++;if(imgCond.sort!=='new')n++;
  ['iqPrompt','iqSeed','iqReplica','iqConfig'].forEach(id=>{if(imgVal(id))n++;});return n;}
function renderImgTab(){
  const q=imgVal('iq').toLowerCase();
  const fP=imgVal('iqPrompt').toLowerCase(), fS=imgVal('iqSeed'),
        fR=imgVal('iqReplica').toLowerCase(), fC=imgVal('iqConfig').toLowerCase();
  const f=m=>({prompt:(m.prompt||'').toLowerCase(),seed:String(m.seed??''),
    replica:(m.replica||'').toLowerCase(),config:(m.config_file||'').toLowerCase()});
  let list=IMGTAB.filter(m=>{
    if(imgCond.type!=='all'&&(m.png_sub||m.source)!==imgCond.type)return false;
    const v=f(m);
    // 검색창: 빠른 자유 검색 (프롬프트·시드·레플리카·CONFIG 중 하나라도 포함)
    if(q&&!(v.prompt.includes(q)||v.seed.includes(q)||v.replica.includes(q)||v.config.includes(q)))return false;
    // 세부 조건: 입력한 것들 모두 만족(AND)
    if(fP&&!v.prompt.includes(fP))return false;
    if(fS&&!v.seed.includes(fS))return false;
    if(fR&&!v.replica.includes(fR))return false;
    if(fC&&!v.config.includes(fC))return false;
    return true;
  });
  const sorters={
    new:(a,b)=>String(b.finished||b.created||'').localeCompare(String(a.finished||a.created||'')),
    old:(a,b)=>String(a.finished||a.created||'').localeCompare(String(b.finished||b.created||'')),
    seed:(a,b)=>(a.seed||0)-(b.seed||0)};
  list.sort(sorters[imgCond.sort]||sorters.new);
  imgGridList=list;
  // 배지
  const n=imgCondBadge();const badge=document.getElementById('imgCondBadge');
  badge.textContent=n;badge.classList.toggle('hide',n===0);
  document.getElementById('imgCount').textContent=`${list.length} / ${IMGTAB.length} 장`;
  const el=document.getElementById('imgGrid');
  if(!list.length){el.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:40px">이미지 없음</div>';return;}
  el.innerHTML=list.map((m,i)=>`<div class="thumb" onclick="openImgObj(imgGridList[${i}])">
    <div class="imgph" data-src="/api/images/${encodeURIComponent(m.id)}/file"></div>
    <div class="cap"><span class="src">${(m.replica||'').slice(-5).toUpperCase()}</span><span class="mtag">${(m.png_sub||m.source||'').toUpperCase()}</span></div></div>`).join('');
  el.querySelectorAll('.imgph').forEach(b=>loadImgBox(b));
}
// 레플리카 모달 "더보기" → 이미지 탭으로 (그 레플리카로 세부 조건 필터)
function goImageTab(replica){
  closeRd();
  show('img');
  ['iq','iqPrompt','iqSeed','iqConfig'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  const r=document.getElementById('iqReplica'); if(r)r.value=replica?replica.slice(-5):'';   // 레플리카 세부 조건에 입력
  imgCond={type:'all',sort:'new'};
  [...document.getElementById('iSegType').children].forEach(b=>b.classList.toggle('on',b.dataset.v==='all'));
  [...document.getElementById('iSegSort').children].forEach(b=>b.classList.toggle('on',b.dataset.v==='new'));
  setTimeout(renderImgTab,50);   // loadImgTab의 fetch 후 렌더 보장
}

// ───────── ⓘ 툴팁 ─────────
const TIPS={type:'<b>AUTO</b> : 자동화 대량 생성\n<b>MANUAL</b> : UI 테스트 생성',
  run:'배포 시 RUN_ID로 지정한 실행 이름.\n같은 RUN_ID끼리 결과를 공유.\n지정 안 하면 자동 생성됨.',
  path:'<b>컨테이너</b> : 워크로드 내부 경로\n<b>클라우드 저장소</b> : 마운트된 원본 위치'};
function tip(e,key){e.stopPropagation();const t=document.getElementById('tip');
  if(t.classList.contains('on')&&t.dataset.key===key){t.classList.remove('on');return;}
  t.innerHTML=TIPS[key];t.dataset.key=key;t.classList.add('on');
  const r=e.target.getBoundingClientRect();t.style.left=Math.min(r.left,window.innerWidth-260)+'px';t.style.top=(r.bottom+6)+'px';}
document.addEventListener('click',e=>{if(!e.target.classList.contains('info-i'))document.getElementById('tip')?.classList.remove('on');});

// ───────── 다시 생성 ─────────
function askRegen(){const busy=document.getElementById('jstate').textContent==='RUNNING'||document.getElementById('jstate').textContent==='PAUSED';
  document.getElementById('confirmText').innerHTML=busy
    ?'현재 진행 중인 작업이 있습니다. 지금 진행하면 <b>현재 작업을 취소</b>하고 이 설정으로 생성을 시작합니다.'
    :'이 설정으로 생성을 시작합니다. 진행 버튼을 누르면 바로 시작됩니다.';
  document.getElementById('confirm').dataset.busy=busy?'1':'';
  document.getElementById('confirm').classList.add('on');}
function closeConfirm(){document.getElementById('confirm').classList.remove('on');}
async function doRegen(){
  const busy=document.getElementById('confirm').dataset.busy==='1';closeConfirm();
  if(!curImg)return;
  // 폼에 채우기 (CONFIG OFF, 직접 프롬프트)
  document.getElementById('useFile').checked=false;toggleFile();
  document.getElementById('prompt').value=curImg.prompt||'';
  document.getElementById('w').value=curImg.width;document.getElementById('h').value=curImg.height;
  document.getElementById('steps').value=curImg.steps;document.getElementById('seed').value=curImg.seed??'';
  document.getElementById('count').value=1;
  closeImg();show('gen');
  if(busy){await post('/api/job/cancel',{});await new Promise(r=>setTimeout(r,1200));}
  doGenerate();
}

// ───────── 대시보드 ─────────
async function reloadReplicas(){
  const stale=document.getElementById('cStale').checked;
  try{const r=await j(stale?'/api/replicas_all':'/api/replicas');
    REPS_RAW=r.replicas||[];renderSummary(r.summary);renderCards();}catch(e){}
}
function renderSummary(s){if(!s)return;
  const alive=REPS_RAW.filter(r=>!r._stale);
  const totTp=Math.round(alive.reduce((a,r)=>a+(r.throughput_hr||0),0));
  const busyVals=alive.map(r=>r.busy_ratio).filter(v=>v!=null);
  const avgBusy=busyVals.length?Math.round(busyVals.reduce((a,b)=>a+b,0)/busyVals.length):null;
  const st=s.states||{running:s.running||0,paused:0,done:0,dead:0};
  const ic=id=>`<svg class="ico sum-ico"><use href="#${id}"/></svg>`;
  // 상태 분포 (running/paused/done/dead) — 아이콘+개수 칩
  const stateCell=(cls,icon,n)=>`<span class="st-pill ${cls}"><svg class="ico"><use href="#${icon}"/></svg>${n}</span>`;
  document.getElementById('summary').innerHTML=`
    <div class="sum"><div class="k">${ic('i-layers')}레플리카</div><div class="v">${s.replicas} <small>개</small></div></div>
    <div class="sum"><div class="k">${ic('i-image')}총 생성 이미지</div><div class="v">${s.total_generated}</div></div>
    <div class="sum sum-wide"><div class="k">${ic('i-activity')}상태</div>
      <div class="st-row">
        ${stateCell('run','i-play',st.running)}
        ${stateCell('pau','i-pause',st.paused)}
        ${stateCell('don','i-check',st.done)}
        ${stateCell('ded','i-x',st.dead)}
      </div></div>
    <div class="sum"><div class="k">${ic('i-zap')}전체 시간당 생성</div><div class="v">${totTp} <small>장/h</small></div></div>
    <div class="sum"><div class="k">${ic('i-gauge')}평균 가동률</div><div class="v">${avgBusy??'–'} <small>%</small></div></div>
    <div class="sum"><div class="k">${ic('i-cpu')}평균 GPU Util</div><div class="v">${s.avg_util??'–'} <small>%</small></div></div>`;
}
function condBadgeCount(){let n=0;if(cond.status!=='all')n++;if(cond.sort!=='name')n++;
  if(document.getElementById('cOver').checked)n++;if(document.getElementById('cStale').checked)n++;return n;}
function toggleCond(){document.getElementById('condPop').classList.toggle('on');}
function bindSeg(segId,key){[...document.getElementById(segId).children].forEach(b=>b.onclick=()=>{
  [...document.getElementById(segId).children].forEach(x=>x.classList.remove('on'));b.classList.add('on');
  cond[key]=b.dataset.v;renderCards();});}
function renderCards(){
  const q=(document.getElementById('dq').value||'').toLowerCase();
  const lim=+document.getElementById('limitDash').value||null;
  const overOnly=document.getElementById('cOver').checked;
  let list=REPS_RAW.filter(r=>(r.replica||'').toLowerCase().includes(q));
  if(cond.status!=='all')list=list.filter(r=>(r.job_state||'')===cond.status);
  if(overOnly&&lim)list=list.filter(r=>r.vram_used_gb!=null&&r.vram_used_gb>lim);
  const sorters={name:(a,b)=>(a.replica||'').localeCompare(b.replica||''),
    gen:(a,b)=>(b.generated||0)-(a.generated||0),
    vram:(a,b)=>(b.vram_used_gb||0)-(a.vram_used_gb||0),
    util:(a,b)=>(b.util||0)-(a.util||0)};
  list.sort(sorters[cond.sort]||sorters.name);
  // 배지
  const n=condBadgeCount();const badge=document.getElementById('condBadge');
  badge.textContent=n;badge.classList.toggle('hide',n===0);
  document.getElementById('dashCount').textContent=`${list.length} / ${REPS_RAW.length} 표시`;
  const cmap={running:'c-running',done:'c-done',paused:'c-paused',idle:'c-done',cancelled:'c-done',error:'c-done'};
  reconcile(document.getElementById('cards'), list,
    r=>r.replica,
    r=>{const over=lim&&r.vram_used_gb!=null&&r.vram_used_gb>lim;return 'rcard'+(over?' over':'');},
    r=>{
      const over=lim&&r.vram_used_gb!=null&&r.vram_used_gb>lim;
      const vt=r.vram_total_gb||32;const vp=Math.min(100,(r.vram_used_gb||0)/vt*100);
      const dead=r._stale;
      return `<div class="top"><span class="rid">${r.replica}</span><span class="chip ${dead?'c-done':(cmap[r.job_state]||'c-done')}">${dead?'DEAD':(r.job_state||'').toUpperCase()}</span></div>
      <div class="rrow"><span class="lbl">GPU VRAM</span><span class="val ${over?'over':''}">${r.vram_used_gb??'–'} <span style="color:var(--text-dim);font-size:11px">/ ${r.vram_total_gb??'–'} GB</span></span></div>
      <div class="rbar2"><i class="${over?'over':''}" style="width:${vp}%"></i></div>
      <div class="rrow"><span class="lbl">GPU Util</span><span class="val">${r.util??'–'} %</span></div>
      <div class="rrow"><span class="lbl">생성</span><span class="val">${r.job_completed||0} / ${r.job_total||0}</span></div>
      <div class="rbar2"><i style="width:${r.job_total?(r.job_completed/r.job_total*100):0}%"></i></div>`;
    },
    r=>openReplicaModal(r.replica));
}

// ───────── limit 적용 (생성탭) ─────────
function applyLimits(){renderResources();}

// ───────── 레플리카 상세 모달 ─────────
// 갱신 상태 색. 원칙: "갱신이 멈춰도 정상인 건 죽은 레플리카·완료된 레플리카뿐."
//   그 외(running·paused·idle 등 살아있고 안 끝난 상태)는 하트비트가 계속 와야 정상 → age로 판단.
//   paused여도 컨테이너는 살아있으므로 갱신은 계속됨. 완료→작업 재개 시 다음 갱신에서 자동으로 초록 복귀.
// 우선순위: 죽음(빨강) > 완료(회색) > 갱신 지연 20~60s(노랑) > 정상(초록)
function ageInfo(r){
  const age=r._age_s!=null?Math.round(r._age_s):null;
  if(r._stale) return {cls:'dead',dot:'dead',txt:age!=null?`갱신 안 됨 · 마지막 ${age}초 전`:'갱신 안 됨'};
  if(['done','cancelled'].includes(r.job_state)) return {cls:'done',dot:'done',txt:'갱신 종료'};
  // 여기부터는 살아있고 안 끝난 상태(paused 포함) → 갱신이 계속 와야 정상
  if(age!=null&&age>=20) return {cls:'warn',dot:'paused',txt:`${age}초 전 갱신`};
  return {cls:'ok',dot:'',txt:age!=null?`${age}초 전 갱신`:''};
}
function paintReplica(r){
  const dead=r._stale;
  document.getElementById('rdId').textContent=r.replica;
  document.getElementById('rdChip').textContent=dead?'DEAD':(r.job_state||'').toUpperCase();
  document.getElementById('rdChip').className='chip '+(dead?'c-done':({running:'c-running',paused:'c-paused'}[r.job_state]||'c-done'));
  const ai=ageInfo(r);
  document.getElementById('rdDot').className='dot '+ai.dot;
  document.getElementById('rdAge').textContent=ai.txt;
  document.getElementById('rdLive').className='live '+ai.cls;
  const vt=r.vram_total_gb||32, rt=r.ram_total_gb||64;
  document.getElementById('gauges').innerHTML=
    gauge('GPU VRAM',r.vram_used_gb||0,vt,'/ '+vt+' GB', limitDashVal()&&r.vram_used_gb>limitDashVal())+
    gauge('System RAM',r.ram_used_gb||0,rt,'/ '+rt+' GB',false)+
    gauge('GPU Util',r.util||0,100,'%',false);
  document.getElementById('rdProgNum').innerHTML=`${r.job_completed||0} <span style="color:var(--text-dim);font-size:15px">/ ${r.job_total||0}</span>`;
  const pct=r.job_total?Math.round(r.job_completed/r.job_total*100):0;
  document.getElementById('rdProgPct').textContent=pct+'%';
  document.getElementById('rdProgBar').style.width=pct+'%';
  const f=v=>v==null?'–':v;
  const r1=v=>v==null?'–':(Math.round(v*10)/10);   // 소수 첫째자리 반올림
  document.getElementById('rdProgStats').innerHTML=`
    <div class="ps"><div class="k">평균 생성</div><div class="v">${r1(r.avg_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최단</div><div class="v">${r1(r.min_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최장</div><div class="v">${r1(r.max_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">VRAM 평균</div><div class="v">${r1(r.vram_avg_gb)}<small>GB</small></div></div>
    <div class="ps"><div class="k">VRAM peak</div><div class="v">${r1(r.vram_peak_gb)}<small>GB</small></div></div>`;
  // 작업 시간 — 시작 ●━[걸린시간]━● 종료 타임라인 하나
  const fdt=t=>t?String(t).replace('T',' '):null;
  const running=!r.job_finished;
  let durTxt='–';
  if(r.job_started){ const end=r.job_finished?new Date(r.job_finished):new Date();
    durTxt=fmtDur(Math.max(0,Math.round((end-new Date(r.job_started))/1000))); }
  document.getElementById('rdJobTime').innerHTML = !r.job_started ? '<div class="jt-empty">작업 기록 없음</div>' : `
    <div class="jt-rail">
      <span class="jt-dot start"></span>
      <span class="jt-line"><span class="jt-dur">${durTxt}</span></span>
      <span class="jt-dot end ${running?'live':''}"></span>
    </div>
    <div class="jt-ends">
      <span class="jt-t">시작 ${fdt(r.job_started)}</span>
      <span class="jt-t">${running?'진행 중':'종료 '+fdt(r.job_finished)}</span>
    </div>`;
  // 성능 분석 — 값 + 계산 근거 병기
  const upMin=r.uptime_s?Math.round(r.uptime_s/60*10)/10:null;     // 가동시간(분)
  const genMin=r.gen_seconds_total!=null?Math.round(r.gen_seconds_total/60*10)/10:null; // 생성에 쓴 시간(분)
  const perf=(k,val,unit,basis)=>`<div class="pl-row"><div class="pl-k">${k}</div>
    <div class="pl-v">${val}<small>${unit}</small></div><div class="pl-basis">${basis}</div></div>`;
  document.getElementById('rdPerf').innerHTML=
    perf('시간당 생성', f(r.throughput_hr), '장/h', (r.generated!=null&&upMin!=null)?`${r.generated}장 ÷ ${upMin}분 × 60`:'데이터 부족')+
    perf('장당 평균', r1(r.avg_gen_s), 's', '최근 생성 표본 평균')+
    perf('가동률', f(r.busy_ratio), '%', (genMin!=null&&upMin!=null)?`생성 ${genMin}분 ÷ 가동 ${upMin}분`:'데이터 부족')+
    perf('이론 최대', f(r.throughput_max_hr), '장/h', r.avg_gen_s?`3600초 ÷ 장당 ${r1(r.avg_gen_s)}s`:'데이터 부족')+
    perf('VRAM 효율', r1(r.vram_eff_gb), 'GB/장', '장당 평균 VRAM peak');
  document.getElementById('rdMore').onclick=()=>goImageTab(r.replica);
}
function fmtDur(s){ if(s<60)return s+'초'; const m=Math.floor(s/60),ss=s%60; if(m<60)return m+'분 '+ss+'초'; const h=Math.floor(m/60); return h+'시간 '+(m%60)+'분'; }
async function openReplicaModal(id){
  rdReplica=id;rdRange='live';
  let r=REPS_RAW.find(x=>x.replica===id)||REPS.find(x=>x.replica===id);
  if(!r){try{const d=await j('/api/replicas_all');r=(d.replicas||[]).find(x=>x.replica===id);}catch(e){}}
  if(!r)return;
  paintReplica(r);
  document.getElementById('rdModal').classList.add('on');
  loadHistory();loadMini();
  if(rdTimer)clearInterval(rdTimer);
  rdTimer=setInterval(refreshReplicaModal,3000);   // 열려있는 동안 자동 갱신
}
async function refreshReplicaModal(){
  if(!rdReplica||!document.getElementById('rdModal').classList.contains('on')){clearInterval(rdTimer);rdTimer=null;return;}
  try{const d=await j('/api/replicas_all');const r=(d.replicas||[]).find(x=>x.replica===rdReplica);
    if(r)paintReplica(r);}catch(e){}
  if(rdRange==='live')loadHistory();   // 실시간 범위면 시계열도 갱신
}
function limitDashVal(){return +document.getElementById('limitDash').value||null;}
function closeRd(){document.getElementById('rdModal').classList.remove('on');if(rdTimer){clearInterval(rdTimer);rdTimer=null;}}
function setRange(r,btn){rdRange=r;[...document.getElementById('tsToolbar').children].forEach(b=>b.classList.remove('on'));btn.classList.add('on');loadHistory();}
async function loadHistory(){
  try{const d=await j('/api/replica/'+encodeURIComponent(rdReplica)+'/history?range='+rdRange);
    document.getElementById('tsChart').innerHTML=sparkline(d.points||[]);}catch(e){document.getElementById('tsChart').innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">데이터 없음</div>';}
}
async function loadMini(){
  try{const imgs=await j('/api/images?replica='+encodeURIComponent(rdReplica)+'&limit=6');
    const mini=document.getElementById('rdMini');
    if(!imgs.length){mini.innerHTML='<div style="color:var(--text-dim);font-size:12px;padding:10px">이미지 없음</div>';}
    else{ mini.innerHTML=imgs.map(m=>`<div class="imgph" data-src="/api/images/${encodeURIComponent(m.id)}/file"></div>`).join('');
      mini.querySelectorAll('.imgph').forEach(b=>loadImgBox(b)); }   // 모달 내 이미지는 클릭 안 됨(더보기로만)
  }catch(e){}
}

// ───────── SVG 게이지 / 시계열 ─────────
function gauge(label,val,max,unit,danger){
  const pct=max?Math.min(100,val/max*100):0,r=34,c=2*Math.PI*r,off=c*(1-pct/100);
  const col=danger?'#ff6b6b':'url(#gg)';
  return `<div class="gauge"><div class="glabel">${label}</div>
    <svg width="86" height="86" viewBox="0 0 86 86">
      <defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9D4EFF"/><stop offset="1" stop-color="#B47AFF"/></linearGradient></defs>
      <circle cx="43" cy="43" r="${r}" stroke="rgba(255,255,255,.08)" stroke-width="7" fill="none"/>
      <circle cx="43" cy="43" r="${r}" stroke="${col}" stroke-width="7" fill="none" stroke-linecap="round"
        stroke-dasharray="${c}" transform="rotate(-90 43 43)"><animate attributeName="stroke-dashoffset" from="${c}" to="${off}" dur="0.9s" fill="freeze"/></circle>
      <text x="43" y="48" text-anchor="middle" font-family="Orbitron" font-size="16" fill="#fff">${Math.round(pct)}%</text>
    </svg><div class="gval" ${danger?'style="color:#ff6b6b"':''}>${val} <small>${unit}</small></div></div>`;
}
function sparkline(points){
  if(!points||!points.length)return '<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">데이터 없음</div>';
  const vals=points.map(p=>p.vram==null?0:p.vram);
  const W=560,H=120,max=Math.max(...vals,1)*1.15;
  const path=vals.map((v,i)=>`${i===0?'M':'L'}${(i/(Math.max(1,vals.length-1)))*W},${H-v/max*H}`).join(' ');
  const area=path+`L${W},${H}L0,${H}Z`;
  const lim=limitDashVal();
  let limLine='';
  if(lim&&lim<max){const y=H-lim/max*H;limLine=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;}
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:130px">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(180,122,255,.35)"/><stop offset="1" stop-color="rgba(180,122,255,0)"/></linearGradient></defs>
    <path d="${area}" fill="url(#ag)"/><path d="${path}" fill="none" stroke="#B47AFF" stroke-width="2"/>${limLine}</svg>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-top:4px"><span>${points[0]?.t?.slice(-8)||''}</span><span>GPU VRAM (GB)</span><span>now</span></div>`;
}

// ───────── 키보드 ─────────
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeImg();closeRd();closeConfirm();}});

// ───────── 초기화 ─────────
async function init(){
  try{MODEL=await j('/api/model');document.getElementById('modelBadge').textContent=MODEL.dtype;}catch(e){}
  try{const c=await j('/api/conditions');CONDS=c.files||[];}catch(e){}
  bindSeg('segStatus','status');bindSeg('segSort','sort');
  poll();setInterval(()=>{if(TAB==='gen')poll();else reloadReplicas();},3000);
}
init();