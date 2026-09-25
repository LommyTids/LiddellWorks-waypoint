import { DatabaseSync } from 'node:sqlite';
export class LocalD1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');}
  prepare(sql){const db=this;return {sql,args:[],bind(...args){this.args=args;return this;},execute(){return {success:true,results:db.sqlite.prepare(sql).all(...this.args)};},async all(){return this.execute();},async first(){return this.execute().results[0]??null;},async run(){return this.execute();}};}
  async batch(statements){this.sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.execute());this.sqlite.exec('COMMIT');return out;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
  close(){this.sqlite.close();}
}
