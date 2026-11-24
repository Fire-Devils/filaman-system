/** Seeded host checks; FILABRAIN_PAGE optionally exercises the frozen real client. */
import assert from 'node:assert/strict'
import {readFile, mkdir} from 'node:fs/promises'
import {chromium} from 'playwright-core'
const base = process.argv[2] || 'http://127.0.0.1:4321'
const clientHtml = process.env.FILABRAIN_PAGE ? await readFile(process.env.FILABRAIN_PAGE, 'utf8') : null
const colors = Array.from({length: 75}, (_, i) => ({id: i + 1, name: `Color ${i + 1}`, hex_code: '#FF000080', usage_count: i ? 0 : 3}))
const writes = []
let superadmin = true
const browser = await chromium.launch({executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true})
try {
 const page = await browser.newPage({viewport: {width: 1440, height: 900}}); page.setDefaultTimeout(8000)
 const errors = []; page.on('pageerror', error => errors.push(error.message))
 await page.addInitScript(() => localStorage.setItem('lang', 'en'))
 await page.route('**/plugin-page/**', route => route.fulfill({contentType:'text/html', body: route.request().url().includes('/filabrain') && clientHtml ? clientHtml : '<!doctype html><title>Tool fixture</title><p>Tool fixture</p>'}))
 await page.route(/\/(?:api\/|auth\/me$)/, async route => {
  const req=route.request(), url=new URL(req.url()), path=url.pathname
  if (path.endsWith('/agent/color-intake')) return route.fulfill({json:{reply:'Review the color.', action:{page:'color'}, proposal:{target:{mode:'create',identity:{}}, suggestions:[],issues:[],color_previews:[{code:'RAL 3020',canonical_name:'Traffic red (RAL 3020)',hex_code:'#AB1519',source:'https://example.invalid/ral',matches:[]}]},evidence:[],notices:[]}})
  if(path.endsWith('/me/label-presets/migrate')) return route.fulfill({json:{migrated:0,skipped:0}})
  if(req.method() !== 'GET') {writes.push({path, body:req.postDataJSON()}); return route.fulfill({json:{...colors[0],...req.postDataJSON()}})}
  let json=[]
  if(path.endsWith('/me')) json={id:1,is_superadmin:superadmin,language:'en',permissions:[],roles:[]}
  else if(path.endsWith('/me/preferences/sidebar')) json={sidebar:null,theme:'light',expanded:false}
  else if(path.endsWith('/events/stream')) return route.fulfill({status:204})
  else if(path.endsWith('/colors')) json={items:colors,total:colors.length}
  else if(path.endsWith('/plugin-ui-launchers')) {
   const surface=url.searchParams.get('surface')
   const tool=(id,label,key='fixture')=>({plugin_key:key,plugin_name:key==='filabrain'?'FilaBrain':'Fixture',launcher_id:id,surface,label,page_url:'/plugin-page/'+key,icon_url:null,legacy:false})
   json=surface==='colors.editor'?[tool('find-color','Find color',clientHtml?'filabrain':'fixture')]:surface==='colors.library'?Array.from({length:5},(_,i)=>tool('library-'+i,'Library tool '+i)):surface==='colors.selection'?[tool('selection','Review selection')]:[]
  } else if(path.endsWith('/status')) json={enabled:true,can_chat:true,can_create:true,can_update:true,can_configure:false}
  else if(path.endsWith('/models')) json={groups:[],default_endpoint_id:null,default_model_id:null}
  return route.fulfill({json})
 })
 const message=(frame,type,payload={})=>frame.evaluate(({type,payload})=>new Promise((resolve,reject)=>{
  const request_id=crypto.randomUUID(), timer=setTimeout(()=>reject(Error('No response: '+type)),5000)
  window.addEventListener('message',function receive(event){if(event.source!==parent||event.origin!==location.origin||event.data?.request_id!==request_id)return;clearTimeout(timer);window.removeEventListener('message',receive);resolve(event.data)})
  parent.postMessage({type,request_id,...payload},location.origin)
 }),{type,payload})
 const refocus = async () => {
  await Promise.all(['colors.library','colors.editor'].map(surface => page.waitForResponse(response => {
   const url = new URL(response.url())
   return url.pathname.endsWith('/plugin-ui-launchers') && url.searchParams.get('surface') === surface
  })).concat(page.evaluate(() => window.dispatchEvent(new Event('focus')))))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
 }
 await page.goto(base+'/filaments/colors')
 const library=page.locator('[data-plugin-ui-launchers="colors.library"]')
 await library.getByRole('button',{name:'Library tool 0 — Fixture',exact:true}).waitFor()
 assert.equal(await library.locator('[data-plugin-hook-actions] > button').count(),3)
 const focusedTool=library.getByRole('button',{name:'Library tool 0 — Fixture',exact:true})
 await focusedTool.focus(); await refocus()
 assert.equal(await focusedTool.evaluate(button => document.activeElement === button),true,'An unchanged focus refresh preserves keyboard focus')
 await library.locator('summary').click(); await library.getByRole('button',{name:'Library tool 4 — Fixture',exact:true}).click()
 let frame=page.frames().find(f=>f.url().includes('launcher_id=library-4'))
 await library.frameLocator('iframe').getByText('Tool fixture').waitFor(); frame=page.frames().find(f=>f.url().includes('launcher_id=library-4'))
 assert.deepEqual((await message(frame,'filaman:launcher-context',{version:1})).context,{entity:'colors'})
 await library.getByRole('button',{name:'Close',exact:true}).click()
 assert.equal(await library.locator('summary').evaluate(element => element === document.activeElement),true,'Overflow tool returns focus to visible summary')
 await library.getByRole('button',{name:'Library tool 0 — Fixture',exact:true}).click()
 await library.frameLocator('iframe').getByText('Tool fixture').waitFor()
 await page.getByRole('button',{name:'Add Color',exact:true}).click()
 const outer=page.locator('#modal-container')
 await page.locator('#color-name').fill('My red'); await page.locator('#color-hex').fill('#FF000080')
 await outer.getByRole('button',{name:clientHtml?'Find color — FilaBrain':'Find color — Fixture',exact:true}).click()
 await page.locator('#fm-confirm-overlay').waitFor({state:'visible'})
 await refocus()
 assert.equal(await page.locator('#fm-confirm-ok').textContent(),'Replace tool')
 await page.locator('#fm-confirm-cancel').click()
 assert.equal(await library.locator('iframe').count(),1)
 assert.equal(await outer.locator('.fm-plugin-drawer iframe').count(),0)
 await outer.getByRole('button',{name:clientHtml?'Find color — FilaBrain':'Find color — Fixture',exact:true}).click()
 await page.locator('#fm-confirm-overlay').waitFor({state:'visible'}); await refocus()
 await page.locator('#fm-confirm-ok').click()
 await library.locator('iframe').waitFor({state:'detached'})
 const assistant=outer.locator('.fm-plugin-drawer')
 if(clientHtml){
  const client=assistant.frameLocator('iframe'), chat=client.locator('[data-view=chat]')
  await chat.getByRole('combobox',{name:'Task',exact:true}).waitFor()
  assert.equal(await chat.getByRole('combobox',{name:'Task',exact:true}).inputValue(),'color')
  await chat.locator('textarea').fill('RAL 3020'); await chat.getByRole('button',{name:'Send message',exact:true}).click()
  await chat.getByText('Traffic red (RAL 3020)',{exact:true}).waitFor()
  assert.equal(writes.length,0,JSON.stringify(writes.map(item=>item.path)))
  await chat.getByRole('button',{name:'Use in color form',exact:true}).click()
  await chat.getByText('Staged in the color form. Review and click Save in FilaMan.',{exact:true}).waitFor()
 }else{
  await assistant.frameLocator('iframe').getByText('Tool fixture').waitFor()
  frame=page.frames().find(f=>f.url().includes('color_host=editor'))
  const draft=await message(frame,'filaman:color-context')
  await message(frame,'filaman:color-stage',{expected:draft.fields,fields:{name:'Traffic red (RAL 3020)',hex_code:'#AB1519'}})
 }
 assert.equal(await page.locator('#color-name').inputValue(),'Traffic red (RAL 3020)')
 assert.equal(await page.locator('#color-hex').inputValue(),'#AB151980')
 assert.equal(writes.length,0,JSON.stringify(writes.map(item=>item.path)))
 assert.equal(await assistant.evaluate(el=>el.matches(':modal')),false)
 if(process.env.SCREENSHOT_DIR){await mkdir(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SCREENSHOT_DIR+'/integrated-color-desktop.png'})}
 await page.locator('#modal-submit').click(); await outer.waitFor({state:'hidden'})
 assert.equal(writes.length,1); assert.equal(writes[0].path,'/api/v1/colors')
 await library.getByRole('button',{name:'Library tool 0 — Fixture',exact:true}).click()
 await library.frameLocator('iframe').getByText('Tool fixture').waitFor()
 superadmin = false
 await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})))
 await library.locator('iframe').waitFor({state:'detached'})
 assert.deepEqual(errors,[])
 console.log('Plugin launchers: overflow, versioned context, native Save and '+(clientHtml?'real FilaBrain client':'fixture color staging')+' passed.')
}finally{await browser.close()}
