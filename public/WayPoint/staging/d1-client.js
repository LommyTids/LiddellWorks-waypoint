/* Loaded by D1 Workers before boot.js. The legacy KV Worker does not inject this adapter. */
(function (root) {
  'use strict';
  function canonical(v) { if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']'; if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(function(k){return JSON.stringify(k)+':'+canonical(v[k]);}).join(',')+'}';return JSON.stringify(v); }
  function clone(v){return JSON.parse(JSON.stringify(v));}
  function createClient(schema,request,uuid){
    var baseline=null,versions={},owner=null;
    function key(t,k,r){return t+'|'+k+'|'+r;}
    function pick(data,fields){var out={};fields.forEach(function(f){if(f!=='accountId'&&data[f]!==undefined)out[f]=clone(data[f]);});return out;}
    function flatten(snapshot){var out={};(snapshot.trips||[]).forEach(function(trip){
      var tid=String(trip.tripId);out[key(tid,'trip',tid)]={tripId:tid,kind:'trip',recordId:tid,data:pick(trip,schema.metadata)};
      Object.keys(schema.kinds).forEach(function(kind){var list=schema.kinds[kind];(trip[list]||[]).forEach(function(item){var rid=String(item[kind+'Id']);var data=pick(item,schema.fields[list]);data[kind+'Id']=rid;
        ['destinationId','contactId'].forEach(function(f){if(data[f])data[f]=String(data[f]);});if(data.companions)data.companions=data.companions.map(String);
        var identity=key(tid,kind,rid);if(out[identity])throw Error('Duplicate record identity. Refresh before editing.');out[identity]={tripId:tid,kind:kind,recordId:rid,data:data};
      });});
    });return out;}
    async function load(accountId){
      baseline=null;versions={};owner=accountId;
      for(var attempt=0;attempt<3;attempt++){
        try{
          var cursor=null,entities=[],page;
          for(var n=0;n<1000;n++){page=await request('v1/sync/bootstrap'+(cursor?'?cursor='+encodeURIComponent(cursor):''));entities=entities.concat(page.entities);if(page.complete)break;cursor=page.nextCursor;}
          if(!page.complete)throw Error('Snapshot exceeded the page limit.');
          var decoration=await request('v1/web/presentation?cursor='+encodeURIComponent(page.syncCursor));
          var trips=Object.create(null),revisions={};
          entities.filter(function(e){return e.kind==='trip';}).forEach(function(e){var t=Object.assign({tripId:e.tripId,geocodeCache:{},revision:e.revision,myGrant:e.permission},e.data,decoration[e.tripId]||{});Object.keys(schema.kinds).forEach(function(k){t[schema.kinds[k]]=[];});trips[e.tripId]=t;});
          entities.forEach(function(e){revisions[key(e.tripId,e.kind,e.recordId)]=e.revision;if(e.kind!=='trip'&&trips[e.tripId])trips[e.tripId][schema.kinds[e.kind]].push(e.data);});
          var snapshot={trips:Object.values(trips)};baseline=flatten(snapshot);versions=revisions;return snapshot;
        }catch(e){if(e.code!=='bootstrap_required'||attempt===2)throw e;}
      }
    }
    function plan(snapshot,accountId){
      if(!baseline||owner!==accountId)throw Error('Refresh your trips before saving.');
      var next=flatten(snapshot),changes=[],removedTrips=new Set();
      Object.keys(baseline).forEach(function(k){var old=baseline[k];if(old.kind==='trip'&&!next[k])removedTrips.add(old.tripId);});
      Object.keys(next).forEach(function(k){var entity=next[k],previous=baseline[k];if(previous&&canonical(previous.data)===canonical(entity.data))return;
        var data={};if(!previous)data=entity.data;else new Set(Object.keys(previous.data).concat(Object.keys(entity.data))).forEach(function(f){if(canonical(previous.data[f])!==canonical(entity.data[f]))data[f]=entity.data[f]!==undefined?entity.data[f]:Array.isArray(previous.data[f])?[]:previous.data[f]&&typeof previous.data[f]==='object'?{}:typeof previous.data[f]==='boolean'?false:'';});
        changes.push(Object.assign({},entity,{data:data,mutationId:uuid(),operation:previous?'update':'create',baseRevision:previous?versions[k]:0}));
      });
      Object.keys(baseline).forEach(function(k){var old=baseline[k];if(!next[k]&&(old.kind==='trip'||!removedTrips.has(old.tripId)))changes.push({tripId:old.tripId,kind:old.kind,recordId:old.recordId,operation:'delete',baseRevision:versions[k],mutationId:uuid()});});
      var order={trip:0,companion:1,contact:2,destination:3,activity:4,transport:4,accommodation:4,expense:4};
      changes.sort(function(a,b){var aRank=a.operation==='delete'?20-order[a.kind]:order[a.kind],bRank=b.operation==='delete'?20-order[b.kind]:order[b.kind];return aRank-bRank;});return changes;
    }
    async function save(snapshot,accountId){
      var changes=plan(snapshot,accountId);
      // Stop at the first failed record. A multi-record UI operation can have
      // earlier committed records; the UI reloads instead of claiming rollback.
      for(var change of changes){
        var body={protocolVersion:1,mutations:[change]},response;
        for(var attempt=0;attempt<2;attempt++){try{response=await request('v1/sync/mutations',body);break;}catch(e){if((e.status&&e.status<500&&e.status!==429)||attempt===1)throw e;}}
        var outcome=response.results[0];if(outcome.status!=='applied'){var error=Error(outcome.error?.message||'A change was rejected.');error.code=outcome.error?.code;throw error;}
      }
      // Re-read canonical records and current access. Never keep optimistic
      // values that the server normalized or a revoked account cannot see.
      return load(accountId);
    }
    return {load:load,save:save,plan:plan,revision:function(t,k,r){return versions[key(t,k,r)];},clear:function(){baseline=null;versions={};owner=null;}};
  }
  root.WaypointD1={createClient:createClient};
  if(!root.WAYPOINT_D1_SCHEMA)return;
  var schema=root.WAYPOINT_D1_SCHEMA;
  async function request(path,body){
    var res=await fetch('/WayPoint/api/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{'Accept':'application/json'}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    var data=await res.json();if(!res.ok){var e=Error(typeof data.error==='string'?data.error:data.error?.message||'Request failed.');e.code=data.error?.code;e.status=res.status;throw e;}return data;
  }
  var client=createClient(schema,request,function(){return crypto.randomUUID();});
  var originalEditing=editingAvailable;
  editingAvailable=function(){return originalEditing()&&!saveInFlight;};
  canAddCompanion=function(trip){return canFullyEditTrip(trip);};
  canShareTrip=canLinkCompanion=function(trip){return !!trip&&trip.myGrant?.role==='superuser';};
  loadInitialState=async function(){
    appLoadState='loading';stateIsTrustworthy=false;updateSystemFeedback();
    try{var loaded=await client.load(currentUser.id);stateIsTrustworthy=true;connectionState='online';appLoadState='ready';return loaded;}
    catch(e){client.clear();appLoadState='error';showToastSafe('Could not refresh trips: '+e.message);return {trips:[]};}
    finally{updateSystemFeedback();}
  };
  sendSave=async function(toSave){
    saveInFlight=true;setSaveStatus('saving');updateSystemFeedback();
    try{state=await client.save(clone(toSave),currentUser.id);pendingSaveState=null;stateIsTrustworthy=true;appLoadState='ready';render();setSaveStatus('saved');}
    catch(e){pendingSaveState=null;client.clear();stateIsTrustworthy=false;appLoadState='error';state={trips:[]};closeModal();render();setSaveStatus('error','Refresh required');showToast('Save stopped: '+e.message+' Earlier changes may have saved. Tap Retry now to reload before editing again.','error');}
    finally{saveInFlight=false;updateSystemFeedback();}
  };
  submitCompanionAccess=async function(payload){
    if(saveInFlight)return;
    var form=document.getElementById('companion-link-form')||document.getElementById('add-linked-companion-form');
    saveInFlight=true;updateSystemFeedback();
    try{await request('v1/web/access',{tripId:payload.tripId,companionId:payload.companionId,username:payload.username||'',role:payload.role,baseRevision:client.revision(payload.tripId,'companion',payload.companionId)});closeModal();state=await loadInitialState();render();}
    catch(e){showFormError(form,e.message);}
    finally{saveInFlight=false;updateSystemFeedback();}
  };
  // Refresh other-device changes while idle; never tear down an open form or
  // overwrite a save. The existing web app remains read-only while offline.
  var refreshing=false;
  async function refreshIdle(){
    if(refreshing||saveInFlight||!stateIsTrustworthy||!currentUser||document.hidden||navigator.onLine===false||document.getElementById('modal-root').children.length)return;
    refreshing=true;updateSystemFeedback();var before=canonical(state),accountId=currentUser.id;
    try{var loaded=await client.load(accountId);if(!currentUser||currentUser.id!==accountId)return;if(canonical(loaded)!==before){state=loaded;render();}}
    catch(e){if(!currentUser||currentUser.id!==accountId)return;client.clear();state={trips:[]};stateIsTrustworthy=false;appLoadState='error';render();updateSystemFeedback();}
    finally{refreshing=false;updateSystemFeedback();}
  }
  // Avoid concurrent edits during a background snapshot as its revisions replace
  // the client's baseline. No form is open when this starts.
  var priorEditing=editingAvailable;editingAvailable=function(){return priorEditing()&&!refreshing;};
  setInterval(refreshIdle,30000);window.addEventListener('focus',refreshIdle);
  var originalLogout=doLogout;
  doLogout=async function(){if(saveInFlight){showToast('Wait for the save to finish before signing out.','status');return;}client.clear();return originalLogout();};
})(globalThis);
