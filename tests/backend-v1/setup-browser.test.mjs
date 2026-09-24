import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import worker from '../../src/backend-v1/worker.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';

test('tablet setup, rejected key, dummy sync checks, cleanup and subsequent sign-in',async t=>{
 const db=new SQLiteD1();t.after(()=>db.close());
 const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(),WAYPOINT_SESSION_SECRET:'test-signing-key',WAYPOINT_PASSWORD:'test-setup-key'};
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:820,height:1180}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://staging.test/**',async route=>{
  const r=route.request();const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),...(r.postData()?{body:r.postData()}: {})}),env,{});
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto('https://staging.test/');
 await page.getByRole('heading',{name:'Create your staging account'}).waitFor();
 await page.getByLabel('Setup key',{exact:true}).fill('wrong');await page.getByLabel('Username',{exact:true}).fill('tester');await page.getByLabel('Login password',{exact:true}).fill('test-password');
 await page.getByRole('button',{name:'Create staging account',exact:true}).click();
 await page.getByText('Incorrect setup key.',{exact:true}).waitFor();assert.equal(await page.locator('#setup-key').inputValue(),'');
 await page.getByLabel('Setup key',{exact:true}).fill('test-setup-key');await page.getByLabel('Login password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Create staging account',exact:true}).click();
 await page.getByRole('button',{name:'Run dummy-trip tests'}).click();
 await page.getByText('All tests passed. Send this result back to continue the migration preparation.',{exact:true}).waitFor();
 assert.equal(await page.locator('#results li').count(),6);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM trips WHERE deleted=0').first()).n,0);
 assert.equal(await page.locator('#password').inputValue(),'');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Sign in to staging'}).waitFor();
 await page.getByLabel('Login password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByText('Your staging account is ready.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 const prod=await worker.fetch(new Request('https://staging.test/'),{...env,WAYPOINT_ENV:'production'},{});assert.equal(prod.status,503);
});
