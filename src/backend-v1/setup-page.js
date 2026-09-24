export const setupHTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WayPoint · Staging setup</title><style>
:root{font-family:system-ui,sans-serif;color:#17332f;background:#eff5f2}*{box-sizing:border-box}body{margin:0}main{max-width:660px;margin:40px auto;padding:24px}article{background:white;padding:28px;border-radius:20px;box-shadow:0 8px 35px #17332f10;margin-top:24px}h1{font-size:32px;margin:12px 0}h2{margin-top:0}p{line-height:1.6}.badge{font-size:13px;letter-spacing:2px;color:#316e5b}label{display:block;font-weight:600;margin-top:20px}input{display:block;width:100%;padding:14px;border:1px solid #90aaa0;border-radius:8px;font:inherit;margin-top:8px}button{min-height:48px;padding:12px 20px;border:0;border-radius:9px;background:#195c49;color:white;font:inherit;font-weight:600;margin-top:20px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.secondary{background:#e3eee8;color:#17332f}small{display:block;line-height:1.5;margin-top:8px;color:#48665c}[hidden]{display:none!important}#message{white-space:pre-wrap}li{padding:7px 0;line-height:1.4}:focus-visible{outline:3px solid #ce9c24;outline-offset:3px}@media(max-width:500px){main{margin:12px auto;padding:16px}article{padding:20px}}
</style><script src="/WayPoint/staging.js" defer></script></head><body><main><span class="badge">WAYPOINT / STAGING</span><h1>Let’s check your new backend.</h1><p>This separate test space uses dummy trips. Your live WayPoint trips stay where they are.</p><p id="message" role="status" aria-live="polite">Checking account status…</p><button id="refresh" class="secondary" type="button">Check account status</button>
<article id="auth" hidden><h2 id="auth-title">Create your staging account</h2><form id="account-form"><div id="setup-fields"><label for="setup-key">Setup key</label><input id="setup-key" type="password" autocomplete="off"><small>Enter the value saved as WAYPOINT_PASSWORD in the staging Worker. Never enter WAYPOINT_SESSION_SECRET.</small></div><label for="username">Username</label><input id="username" autocomplete="username" required maxlength="100" autocapitalize="none" spellcheck="false"><label for="password">Login password</label><input id="password" type="password" autocomplete="new-password" required minlength="8"><small>Choose at least 8 characters. Save this login in your password manager.</small><button id="account-submit" type="submit">Create staging account</button></form></article>
<article id="tests" hidden><h2>Check saving and sync</h2><p id="signed-in"></p><p>The test creates one dummy trip, saves and edits an activity, retries an edit, checks conflict handling and sync, then deletes that dummy trip. Deleted test records remain as sync history.</p><button id="run" type="button">Run dummy-trip tests</button><ol id="results" aria-live="polite"></ol><button id="logout" class="secondary" type="button">Sign out</button></article></main></body></html>`;

export const setupScript=String.raw`(()=>{
  const $=id=>document.getElementById(id);let setup=false;
  function busy(value){document.querySelectorAll('button').forEach(b=>b.disabled=value);}
  function message(text){$('message').textContent=text;}
  async function api(path,body){
    const response=await fetch('/WayPoint/api/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    let data;try{data=await response.json();}catch{throw Error('The server returned an unexpected response. Check the deployment and try again.');}
    if(!response.ok)throw Error(typeof data.error==='string'?data.error:data.error?.message||'Request failed ('+response.status+').');return data;
  }
  function showAccount(user){
    setup=!!user.setupNeeded;$('auth').hidden=!!user.loggedIn;$('tests').hidden=!user.loggedIn;
    $('setup-fields').hidden=!setup;$('setup-key').required=setup;$('password').autocomplete=setup?'new-password':'current-password';
    $('auth-title').textContent=setup?'Create your staging account':'Sign in to staging';$('account-submit').textContent=setup?'Create staging account':'Sign in';
    $('signed-in').textContent=user.loggedIn?'Signed in as '+user.username+'.':'';
    message(user.loggedIn?'Your staging account is ready.':setup?'Create your first staging account below.':'Sign in with your staging username and password.');
  }
  async function refresh(){busy(true);try{showAccount(await api('whoami'));}catch(e){message(e.message);}finally{busy(false);}}
  $('refresh').onclick=refresh;
  $('account-form').onsubmit=async event=>{event.preventDefault();busy(true);message(setup?'Creating your account…':'Signing in…');
    try{const user=await api(setup?'setup':'login',{username:$('username').value.trim(),password:$('password').value,...(setup?{setupKey:$('setup-key').value}:{})});showAccount({...user,loggedIn:true});}
    catch(e){message(e.message);}finally{$('setup-key').value='';$('password').value='';busy(false);}
  };
  $('logout').onclick=async()=>{busy(true);try{await api('logout',{});$('results').replaceChildren();showAccount(await api('whoami'));}catch(e){message(e.message);}finally{busy(false);}};
  function result(text){const item=document.createElement('li');item.textContent=text;$('results').append(item);}
  function assert(ok,text){if(!ok)throw Error(text);}
  async function bootstrap(){let cursor=null;const entities=[];for(let n=0;n<1000;n++){const page=await api('v1/sync/bootstrap'+(cursor?'?cursor='+encodeURIComponent(cursor):''));entities.push(...page.entities);if(page.complete)return {...page,entities};cursor=page.nextCursor;}throw Error('Too many snapshot pages.');}
  $('run').onclick=async()=>{
    busy(true);$('results').replaceChildren();message('Running tests. Keep this page open.');
    const tripId=crypto.randomUUID(),recordId=crypto.randomUUID();let created=false,passed=false;
    const change=(kind,id,operation,baseRevision,data)=>({mutationId:crypto.randomUUID(),tripId,kind,recordId:id,operation,baseRevision,...(data===undefined?{}:{data})});
    const send=async mutation=>(await api('v1/sync/mutations',{protocolVersion:1,mutations:[mutation]})).results[0];
    try{
      const cap=await api('v1/sync/capabilities');assert(cap.environment==='staging','This is not the staging API.');
      // Retrying this exact create after a lost response is safe: the ID is stable.
      const create=change('trip',tripId,'create',0,{name:'Staging sync test '+tripId.slice(0,8)});
      let saved;try{saved=await api('v1/trips',create);}catch{saved=await api('v1/trips',create);}
      assert(saved.status==='applied','Trip creation failed.');created=true;result('Passed: dummy trip saved.');
      assert((await send(change('activity',recordId,'create',0,{title:'Test activity',companions:[]}))).status==='applied','Activity creation failed.');
      const before=await bootstrap();assert(before.entities.some(e=>e.recordId===recordId),'Saved activity missing from snapshot.');result('Passed: saved activity read from database.');
      const edit=change('activity',recordId,'update',1,{title:'Updated test activity'});
      assert((await send(edit)).revision===2,'Edit failed.');const retry=await send(edit);assert(retry.status==='applied'&&retry.duplicate&&retry.revision===2,'Retry was not recognized.');result('Passed: edit and duplicate retry applied only once.');
      const stale=await send(change('activity',recordId,'update',1,{title:'Stale edit'}));assert(stale.status==='conflict','Stale edit was not blocked.');result('Passed: conflicting edit blocked.');
      let cursor=before.syncCursor,found=false;
      for(let n=0;n<1000;n++){const page=await api('v1/sync/changes?cursor='+encodeURIComponent(cursor));found ||= page.entities.some(e=>e.recordId===recordId&&e.revision===2&&e.data?.title==='Updated test activity');if(!page.hasMore)break;cursor=page.cursor;}
      assert(found,'Updated activity missing from incremental sync.');result('Passed: incremental sync returned the updated activity.');passed=true;
    }catch(e){result('Failed: '+e.message);}
    finally{
      if(created){try{assert((await send(change('trip',tripId,'delete',1))).status==='applied','Delete failed.');const after=await bootstrap();assert(!after.entities.some(e=>e.tripId===tripId),'Deleted trip still visible.');result('Passed: dummy trip deleted and absent from snapshot.');}catch(e){passed=false;result('Cleanup needs attention for test trip '+tripId+': '+e.message);}}
      else if(!passed)result('If a request timed out, a dummy trip may remain with ID '+tripId+'.');
      message(passed?'All tests passed. Send this result back to continue the migration preparation.':'Tests did not finish successfully. Send the results below for diagnosis.');busy(false);
    }
  };
  refresh();
})();`;
export function setupResponse(script=false){return new Response(script?setupScript:setupHTML,{headers:{'Content-Type':script?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});}
