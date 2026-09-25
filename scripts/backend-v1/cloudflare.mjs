// Administrative client. Never include Cloudflare bodies, SQL or token values in errors.
export class RehearsalError extends Error {
  constructor(code){super(code);this.code=code;}
}
export function check(condition,code){if(!condition)throw new RehearsalError(code);}
export class Cloudflare {
  constructor(account,token,fetcher=fetch){check(/^[a-f0-9]{32}$/i.test(account),'invalid_account');check(!!token,'missing_api_token');this.account=account;this.token=token;this.fetcher=fetcher;}
  async request(path,{method='GET',body,raw=false,retry=true}={}){
    for(let attempt=0;attempt<4;attempt++){
      let response;
      try{response=await this.fetcher('https://api.cloudflare.com/client/v4/accounts/'+this.account+path,{method,headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(60000)});}
      catch{if(retry&&attempt<3){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw new RehearsalError('cloudflare_network_error');}
      if(retry&&(response.status===429||response.status>=500)&&attempt<3){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}
      check(response.ok,response.status===401||response.status===403?'cloudflare_token_permissions':response.status===429?'cloudflare_rate_limit':'cloudflare_request_failed');
      if(raw)return response.text();
      let data;try{data=await response.json();}catch{throw new RehearsalError('invalid_cloudflare_response');}
      check(data.success===true,'cloudflare_api_error');return data;
    }
  }
}
export class RemoteD1 {
  constructor(api,databaseId){check(/^[a-f0-9-]{36}$/i.test(databaseId),'invalid_database_id');this.api=api;this.databaseId=databaseId;}
  prepare(sql){const db=this;return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return (await db.batch([this]))[0];},async first(){return (await this.all()).results[0]??null;},async run(){return this.all();}};}
  async batch(statements){
    const result=await this.api.request('/d1/database/'+this.databaseId+'/query',{method:'POST',body:{batch:statements.map(s=>({sql:s.sql,params:s.args}))},retry:false});
    check(Array.isArray(result.result)&&result.result.length===statements.length&&result.result.every(r=>r.success),'d1_query_failed');return result.result;
  }
}
