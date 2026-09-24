// Runs the real SQL and transaction boundaries on SQLite; no SQL string mocks.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export class SQLiteD1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../../migrations/backend-v1/0001_sync_foundation.sql',import.meta.url),'utf8'));
    this.beforeBatch=null; this.failAfter=null;
  }
  prepare(sql) {
    const database=this;
    const statement={sql,args:[],bind(...args){this.args=args;return this;},
      execute(){const prepared=database.sqlite.prepare(sql);const result=prepared.all(...this.args);return {success:true,results:result};},
      async all(){return this.execute();},async first(){return this.execute().results[0]??null;},async run(){return this.execute();}};
    return statement;
  }
  async batch(statements) {
    if (this.beforeBatch) { const hook=this.beforeBatch;this.beforeBatch=null;await hook(statements); }
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results=statements.map((s,i)=>{if(this.failAfter===i){this.failAfter=null;throw new Error('Injected storage failure');}return s.execute();});
      this.sqlite.exec('COMMIT');return results;
    } catch(error) {this.sqlite.exec('ROLLBACK');throw error;}
  }
  close(){this.sqlite.close();}
}

export class MemoryKV {
  constructor(seed={}){this.values=new Map(Object.entries(seed));}
  async get(key){return this.values.get(key)??null;}
  async put(key,value){this.values.set(key,String(value));}
  async delete(key){this.values.delete(key);}
}
