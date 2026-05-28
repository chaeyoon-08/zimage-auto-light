// ───────── API helpers ─────────
async function j(u){const r=await fetch(u);if(!r.ok)throw new Error(r.status);return r.json();}
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const d=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,data:d};}

// ───────── 상태 ─────────
let TAB='gen', galFilter='all', selRep=null, MODEL={name:'Z-Image-Turbo',dtype:'uint4'};
let REPS=[], REPS_RAW=[], IMAGES=[], RES=null, CONDS=[], selectedConfig=null;
let curImg=null, mPromptVal='', mSeedVal='', mReplicaVal='', rdReplica=null, rdRange='live';
let cond={status:'all',sort:'name'};

// ───────── 탭 ─────────
function show(v){TAB=v;document.getElementById('vGen').hidden=v!=='gen';document.getElementById('vDash').hidden=v!=='dash';
  document.getElementById('tGen').classList.toggle('on',v==='gen');document.getElementById('tDash').classList.toggle('on',v==='dash');
  if(v==='dash')reloadReplicas();}

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
async function doGenerate(){
  const bad=validate();
  if(bad.length){formMsg('err','입력 내용을 확인해주세요.');return;}
  const on=document.getElementById('useFile').checked;
  const ct=+document.getElementById('count').value;
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
    return;
  }
  formMsg('warn','생성을 시작했습니다.');
  setTimeout(()=>{formMsg('','');document.getElementById('formMsg').className='form-msg';},2500);
  poll();
}

// ───────── 잡 제어 ─────────
async function jobCtrl(a){await post('/api/job/'+a,{});poll();}

// ───────── 폴링 ─────────
async function poll(){
  try{const s=await j('/api/status');renderJob(s);}catch(e){}
  try{RES=await j('/api/resources');renderResources();}catch(e){}
  try{IMAGES=await j('/api/images?source='+(galFilter==='all'?'':galFilter)+(selRep?('&replica='+encodeURIComponent(selRep)):''));renderGallery();}catch(e){}
  try{const r=await j('/api/replicas');REPS=r.replicas||[];renderReplist();}catch(e){}
}
function renderJob(s){
  const map={running:'RUNNING',paused:'PAUSED',done:'DONE',idle:'IDLE',cancelled:'CANCELLED',error:'ERROR'};
  const cls={running:'s-running',paused:'s-paused',done:'s-done',idle:'s-idle',cancelled:'s-done',error:'s-error'};
  document.getElementById('jstate').textContent=map[s.state]||s.state.toUpperCase();
  document.getElementById('jstate').className='state-chip '+(cls[s.state]||'s-idle');
  document.getElementById('jc').textContent=s.total?`${s.completed} / ${s.total}`:'–';
  document.getElementById('jbar').style.width=(s.total?Math.round(s.completed/s.total*100):0)+'%';
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
function renderReplist(){
  const q=(document.getElementById('rq').value||'').toLowerCase();
  const list=REPS.filter(r=>(r.replica||'').toLowerCase().includes(q));
  document.getElementById('replist').innerHTML=list.length?list.map(r=>{
    const sel=selRep===r.replica;
    return `<div class="repitem ${sel?'sel':''}" onclick="selReplica('${r.replica}')">
      <span class="rid">${r.replica}</span>
      <span class="meta"><span class="dot ${r._stale?'dead':''}"></span>${r.job_completed||0}/${r.job_total||0} · ${r.util??'–'}%</span></div>`;
  }).join(''):'<div style="color:var(--text-dim);font-size:12px;padding:10px">검색 결과 없음</div>';
}
function selReplica(id){selRep=id;document.getElementById('repAll').classList.toggle('on',id===null);
  document.getElementById('galFilt').textContent=id?('▸ '+id.slice(-5)):'';poll();}
function setGalFilter(f,btn){galFilter=f;[...document.getElementById('galSeg').children].forEach(b=>b.classList.remove('on'));btn.classList.add('on');poll();}
function renderGallery(){
  const el=document.getElementById('gallery');
  if(!IMAGES.length){el.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:30px">이미지 없음</div>';return;}
  el.innerHTML=IMAGES.map((m,i)=>`<div class="thumb" onclick="openImg(${i})">
    <img class="imgph" style="aspect-ratio:1;object-fit:cover;width:100%;display:block" loading="lazy" src="/api/images/${encodeURIComponent(m.id)}/file" alt="">
    <div class="cap"><span class="src">${(m.replica||'').slice(-5).toUpperCase()}</span><span class="mtag">${(m.png_sub||m.source||'').toUpperCase()}</span></div></div>`).join('');
}

// ───────── 이미지 모달 ─────────
function openImg(i){const m=IMAGES[i];if(!m)return;curImg=m;
  document.getElementById('mImg').src='/api/images/'+encodeURIComponent(m.id)+'/file';
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
  document.getElementById('mRun').textContent=m.run_id||'–';
  document.getElementById('mReplica').textContent=m.replica||'–';mReplicaVal=m.replica||'';
  document.getElementById('mDate').textContent=(m.created||'').replace('T',' ');
  document.getElementById('mFile').textContent=m.id+'.png';
  const sz=m.size_bytes?(m.size_bytes/1024/1024).toFixed(1)+'MB':'–';
  document.getElementById('mPath').textContent=`/outputs/${m.png_sub||'?'} · ${sz}`;
  document.getElementById('imgModal').classList.add('on');
}
function closeImg(){document.getElementById('imgModal').classList.remove('on');}
function copyText(t){navigator.clipboard?.writeText(t);}
function downloadImg(){if(!curImg)return;const a=document.createElement('a');a.href='/api/images/'+encodeURIComponent(curImg.id)+'/file';a.download=curImg.id+'.png';a.click();}
function viewReplica(id){closeImg();openReplicaModal(id);}

// ───────── ⓘ 툴팁 ─────────
const TIPS={type:'<b>AUTO</b> : 자동화 대량 생성\n<b>MANUAL</b> : UI 테스트 생성',
  run:'배포 시 RUN_ID로 지정한 실행 이름.\n같은 RUN_ID끼리 결과를 공유.'};
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
  document.getElementById('summary').innerHTML=`
    <div class="sum"><div class="k">레플리카</div><div class="v">${s.replicas} <small>개</small></div></div>
    <div class="sum"><div class="k">총 생성 이미지</div><div class="v">${s.total_generated}</div></div>
    <div class="sum"><div class="k">진행 중</div><div class="v">${s.running} <small>개</small></div></div>
    <div class="sum"><div class="k">평균 GPU Util</div><div class="v">${s.avg_util??'–'} <small>%</small></div></div>`;
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
  document.getElementById('cards').innerHTML=list.length?list.map(r=>{
    const over=lim&&r.vram_used_gb!=null&&r.vram_used_gb>lim;
    const vt=r.vram_total_gb||32;const vp=Math.min(100,(r.vram_used_gb||0)/vt*100);
    const dead=r._stale;
    return `<div class="rcard ${over?'over':''}" onclick="openReplicaModal('${r.replica}')">
      <div class="top"><span class="rid">${r.replica}</span><span class="chip ${dead?'c-done':(cmap[r.job_state]||'c-done')}">${dead?'DEAD':(r.job_state||'').toUpperCase()}</span></div>
      <div class="rrow"><span class="lbl">GPU VRAM</span><span class="val ${over?'over':''}">${r.vram_used_gb??'–'} <span style="color:var(--text-dim);font-size:11px">/ ${r.vram_total_gb??'–'} GB</span></span></div>
      <div class="rbar2"><i class="${over?'over':''}" style="width:${vp}%"></i></div>
      <div class="rrow"><span class="lbl">GPU Util</span><span class="val">${r.util??'–'} %</span></div>
      <div class="rrow"><span class="lbl">생성</span><span class="val">${r.job_completed||0} / ${r.job_total||0}</span></div>
      <div class="rbar2"><i style="width:${r.job_total?(r.job_completed/r.job_total*100):0}%"></i></div></div>`;
  }).join(''):'<div style="grid-column:1/-1;text-align:center;color:var(--text-dim);padding:40px">검색 결과 없음</div>';
}

// ───────── limit 적용 (생성탭) ─────────
function applyLimits(){renderResources();}

// ───────── 레플리카 상세 모달 ─────────
async function openReplicaModal(id){
  rdReplica=id;rdRange='live';
  let r=REPS_RAW.find(x=>x.replica===id)||REPS.find(x=>x.replica===id);
  if(!r){try{const d=await j('/api/replicas_all');r=(d.replicas||[]).find(x=>x.replica===id);}catch(e){}}
  if(!r)return;
  document.getElementById('rdId').textContent=id;
  const dead=r._stale;
  document.getElementById('rdChip').textContent=dead?'DEAD':(r.job_state||'').toUpperCase();
  document.getElementById('rdChip').className='chip '+(dead?'c-done':({running:'c-running',paused:'c-paused'}[r.job_state]||'c-done'));
  document.getElementById('rdDot').className='dot '+(dead?'dead':'');
  document.getElementById('rdAge').textContent=r._age_s!=null?`${Math.round(r._age_s)}초 전 갱신`:'';
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
  document.getElementById('rdProgStats').innerHTML=`
    <div class="ps"><div class="k">평균 생성</div><div class="v">${f(r.avg_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최단</div><div class="v">${f(r.min_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">최장</div><div class="v">${f(r.max_gen_s)}<small>s</small></div></div>
    <div class="ps"><div class="k">VRAM 평균</div><div class="v">${f(r.vram_avg_gb)}<small>GB</small></div></div>
    <div class="ps"><div class="k">VRAM peak</div><div class="v">${f(r.vram_peak_gb)}<small>GB</small></div></div>`;
  document.getElementById('rdModal').classList.add('on');
  loadHistory();loadMini();
}
function limitDashVal(){return +document.getElementById('limitDash').value||null;}
function closeRd(){document.getElementById('rdModal').classList.remove('on');}
function setRange(r,btn){rdRange=r;[...document.getElementById('tsToolbar').children].forEach(b=>b.classList.remove('on'));btn.classList.add('on');loadHistory();}
async function loadHistory(){
  try{const d=await j('/api/replica/'+encodeURIComponent(rdReplica)+'/history?range='+rdRange);
    document.getElementById('tsChart').innerHTML=sparkline(d.points||[]);}catch(e){document.getElementById('tsChart').innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">데이터 없음</div>';}
}
async function loadMini(){
  try{const imgs=await j('/api/images?replica='+encodeURIComponent(rdReplica)+'&limit=12');
    document.getElementById('rdMini').innerHTML=imgs.length?imgs.map(m=>`<img class="imgph" style="aspect-ratio:1;object-fit:cover;width:100%;border-radius:8px" loading="lazy" src="/api/images/${encodeURIComponent(m.id)}/file">`).join(''):'<div style="color:var(--text-dim);font-size:12px;padding:10px">이미지 없음</div>';
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
