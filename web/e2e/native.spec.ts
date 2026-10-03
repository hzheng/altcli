import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { WorkflowState } from '../src/contracts/workflow';
import { backToControl, expand, expandAgents, expandWorktree, takeControl, openAccess, openCard, pane, readiness, showSurface } from './ui';
const headers={Authorization:`Bearer ${'a'.repeat(64)}`};
async function state(request:APIRequestContext):Promise<WorkflowState>{return (await request.get('/api/v1/state',{headers})).json();}
async function post(request:APIRequestContext,path:string,data:unknown){const r=await request.post(`/api/v1/${path}`,{headers,data});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function reconcileFixtureKeyboard(request:APIRequestContext) {
  for(const m of (await state(request)).manualSessions??[]) {
    for(const w of m.writers.filter(w=>w.live))await post(request,'terminals/revoke',{clientInstanceId:w.clientInstanceId});
    const fresh=(await state(request)).manualSessions?.find(x=>x.id===m.id);
    if(fresh)await post(request,'terminals/reconcile',{requestId:crypto.randomUUID(),manualSessionId:m.id,expectedRevision:fresh.revision,confirmReady:true});
  }
}
/** The Terminal toggle admits the exact terminal; selecting or focusing it still grants nothing. */
async function toggleTerminal(page:Page,name:string) {
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name,exact:true}).click();await showSurface(page,'Terminal');
  const terminal=page.getByRole('region',{name:`${name} terminal`,exact:true});
  const toggle=terminal.getByRole('button',{name:'Terminal mode',exact:true});await expect(toggle).toBeEnabled();await toggle.click();
  return terminal;
}
const totalBytes=async(page:Page)=>((await state(page.request)).manualSessions??[]).reduce((n,m)=>n+m.bytes,0);
/** Starts input with the toggle, then types one arrow key: the same input evidence the earlier first-keystroke admission left. */
async function chooseKeyboard(page:Page,name:string) {
  if(name==='Nobody (observe only)') {
    // Each terminal's own Display toggle stops its typing; there is no separate keyboard list.
    const typing=page.getByRole('button',{name:'Terminal mode',exact:true,pressed:true});
    for(const toggle of await typing.all())await toggle.click();
    await expect(typing).toHaveCount(0);return;
  }
  const before=await totalBytes(page),terminal=await toggleTerminal(page,name);
  await expect(badge(terminal,'Typing enabled')).toBeVisible();
  await terminal.locator('.xterm-helper-textarea').focus();await page.keyboard.press('ArrowRight');
  await expect.poll(()=>totalBytes(page)).toBe(before+3);
}
async function takeKeyboard(page:Page,name='Codex') {await chooseKeyboard(page,name);await expect(badge(page.getByRole('region',{name:`${name} terminal`,exact:true}),'Typing enabled')).toBeVisible();}
async function expectKeyboard(page:Page,_name:string) {
  await expect(page.locator('.page-heading').getByRole('img',{name:'Input: 1 active · automation held',exact:true})).toBeVisible();
}
/** A terminal card's state. Typing and plain viewing are shown by the mode toggle alone; other states by a status badge. */
const badge=(card:Locator,name:string)=>name==='Typing enabled'||name==='Observing'
  ?card.getByRole('button',{name:'Terminal mode',exact:true,pressed:name==='Typing enabled'}):card.getByRole('img',{name,exact:true});
async function openKeyboard(page:Page) {
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await takeKeyboard(page);
  await expect(badge(card,'Typing enabled')).toBeVisible();await expectKeyboard(page,'Codex');return card;
}
test.beforeEach(async({request})=>{
  const s=await state(request);for(const r of s.runs.filter(r=>['running','waiting','paused'].includes(r.status)))await post(request,'runs',{runId:r.id,action:'takeover',confirmReady:true});
  await reconcileFixtureKeyboard(request);
  await post(request,'workspaces/reset',{repository:'/demo/project',confirmReady:true});await post(request,'sessions',{paneId:'%0',label:'Codex'});await post(request,'sessions',{paneId:'%1',label:'Claude'});
});
// Finish intercepted polling requests before Playwright closes the page, then clear keyboard records.
test.afterEach(async({page,request})=>{await page.unrouteAll({behavior:'wait'});await reconcileFixtureKeyboard(request);});
test('a worktree hold stays visible in status but does not enter another workspace acknowledgement',async({page,request})=>{
  const other=await post(request,'sessions',{paneId:'%3',label:'Other Codex'});
  try {
    await openKeyboard(page);const original=(await state(request)).manualSessions![0]!;
    await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
    await page.getByRole('button',{name:'Project other',exact:true}).click();await expandWorktree(page,'other');
    await page.getByRole('button',{name:'Open other',exact:true}).click();
    await expect(page.locator('.context-bar')).toContainText('/demo/other');
    await expect(page.locator('.page-heading').getByRole('img',{name:'Input: 0 active',exact:true})).toBeVisible();
    await takeKeyboard(page,'Other Codex');
    await expect.poll(async()=>((await state(request)).manualSessions??[]).length).toBe(2);
    await chooseKeyboard(page,'Nobody (observe only)');
    await openAccess(page);await takeControl(page);
    await expect.poll(async()=>((await state(request)).manualSessions??[]).map(m=>m.id)).toEqual([original.id]);
  } finally {
    await reconcileFixtureKeyboard(request);
    const removed=await request.delete(`/api/v1/sessions/${other.session.id}`,{headers});
    expect(removed.ok(),await removed.text()).toBe(true);
  }
});
test('terminal status is informational; focus and keys in Display admit nothing, and the Terminal toggle starts a writer',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const status=page.locator('.page-heading').getByRole('img',{name:'Input: 0 active',exact:true});
  await expect(status).toBeVisible();await status.click();expect((await state(request)).manualSessions??[]).toHaveLength(0);
  const terminal=page.getByRole('region',{name:'Codex terminal',exact:true}),toggle=terminal.getByRole('button',{name:'Terminal mode',exact:true});
  await expect(terminal.getByRole('textbox',{name:'Codex terminal input'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Claim keyboard',exact:true})).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed','false');await expect(terminal.getByRole('group',{name:'Terminal keys'})).toHaveCount(0);
  await terminal.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('x');await page.keyboard.press('Enter');
  await page.waitForTimeout(300);expect((await state(request)).manualSessions??[]).toHaveLength(0);
  await toggle.click();await expect(badge(terminal,'Typing enabled')).toBeVisible();await expect(toggle).toHaveAttribute('aria-pressed','true');
  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused();await page.keyboard.insertText('x');
  await expectKeyboard(page,'Codex');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.bytes).toBe(1);
  // Control access no longer lists keyboards: each terminal's toggle shows and stops its own typing.
  await expect((await openAccess(page)).getByRole('region',{name:'Keyboard',exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('direct-terminal-input.png'),fullPage:true});
});
test('Display stops input, Terminal starts it again, and a toggle on a failed or refused connection reconnects first',async({page,request})=>{
  const terminal=await openKeyboard(page),toggle=terminal.getByRole('button',{name:'Terminal mode',exact:true});
  const live=async()=>((await state(request)).manualSessions??[]).flatMap(m=>m.writers.filter(w=>w.live));
  await toggle.click();await expect(badge(terminal,'Observing · manual input unresolved')).toBeVisible();
  await expect.poll(async()=>(await live()).length).toBe(0);expect((await state(request)).manualSessions![0]!.reconciliationRequired).toBe(true);
  await toggle.click();await expect(badge(terminal,'Typing enabled')).toBeVisible();
  const first=(await live())[0]!;
  // The connection fails server-side; the next toggle replaces it before asking for input, and the new writer joins the held period.
  await post(request,`terminals/${first.connectionId}/close`,{});await expect(badge(terminal,'Disconnected')).toBeVisible();
  let opens=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/terminals')opens++;});
  await toggle.click();await expect(badge(terminal,'Typing enabled')).toBeVisible();expect(opens).toBe(1);
  const second=(await live())[0]!;expect(second.connectionId).not.toBe(first.connectionId);
  expect((await state(request)).manualSessions![0]!.recoveryRequired).toBe(true);
  // A refused request leaves Display; toggling again resets the connection and succeeds.
  await toggle.click();await expect(badge(terminal,'Observing · manual input unresolved')).toBeVisible();
  await page.route('**/api/v1/terminals/*/keyboard',route=>route.fulfill({status:409,json:{error:{code:'INPUT_BUSY',message:'Fixture operation in flight.'}}}),{times:1});
  await toggle.click();await expect(terminal.getByRole('status')).toContainText('Toggle Terminal again to reset the connection');
  await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
  await toggle.click();await expect(badge(terminal,'Typing enabled')).toBeVisible();expect(opens).toBe(2);
  const before=await totalBytes(page);await page.keyboard.insertText('y');await expect.poll(()=>totalBytes(page)).toBe(before+1);
});
async function prepareKeyboardSend(page:Page,recipient='Codex') {
  await page.route('**/api/v1/workspaces',async route=>{
    const response=await route.fetch(),body=await response.json();
    for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,stageRelay:{eligible:false,reason:'A task branch uses committed handoffs.'},taskBase:workspace.git.head});
    await route.fulfill({response,json:body});
  });
  const terminal=await openKeyboard(page);
  // Control replaces the terminals in the frame; the writer's terminal stays mounted and connected.
  await openCard(page,recipient);
  const control=page.getByRole('region',{name:'Control',exact:true});
  const draft=control.getByLabel(`Instruction for ${recipient}`);
  await draft.fill('Implement the acknowledged handoff.');
  await control.getByRole('region',{name:`Actions for ${recipient}`,exact:true}).getByLabel('After send').selectOption('commit');
  const send=control.getByRole('button',{name:`Send & commit ${recipient}`,exact:true});
  await expect(send).toBeDisabled();
  // One check beside the action lists every consequence; Control access is not needed.
  const consequences=control.getByRole('list',{name:'Consequences of proceeding'});
  await expect(consequences).toContainText('Typing stops in Codex (this browser)');await expect(consequences).toContainText('3 bytes');await expect(consequences).toContainText('recorded as accepted');
  await expect(page.getByRole('region',{name:'Control access',exact:true})).toBeHidden();
  await (await readiness(page)).check();
  await expect(send).toBeEnabled();
  return {terminal,control,draft,send};
}
test('Send & commit with the acknowledgement stops typing, records manual input and sends exactly once',async({page,request})=>{
  const {terminal,draft,send}=await prepareKeyboardSend(page,'Claude');
  const starts:Record<string,unknown>[]=[],decisions:string[]=[];
  page.on('request',r=>{if(r.url().endsWith('/terminals/reconcile'))decisions.push(r.postDataJSON().note);});
  await page.route('**/api/v1/implementation',async route=>{
    expect((await state(request)).manualSessions).toEqual([]);
    starts.push(route.request().postDataJSON());await route.fulfill({json:{status:'delivered',error:null}});
  });
  await send.click();
  await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({agentId:'claude',kind:'work',text:'Implement the acknowledged handoff.'});expect(starts[0]!.keyboardSettlement).toBeUndefined();
  expect(decisions).toEqual(['Acknowledged the listed consequences at an action and chose to proceed.']);
  await backToControl(page);await expect(draft).toHaveValue('');
  await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
  expect((await state(request)).manualSessions).toEqual([]);
});
for(const change of ['draft','restored draft','target','view','activity'] as const)test(`Send & commit cancels dispatch when the ${change} changes while holds are cleared`,async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/stop',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
  try {
    await send.click();await captured;
    if(change==='draft'||change==='restored draft') {
      await draft.fill('A newer draft must survive.');
      if(change==='restored draft')await draft.fill('Implement the acknowledged handoff.');
    } else if(change==='activity') {
      await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
        body.activities=body.activities.map((a:{agentId:string})=>a.agentId==='codex'?{...a,state:'working',detail:'New external work after settlement.'}:a);
        await route.fulfill({response,json:body});
      });
      await expect(pane(page,'Codex')).toContainText('New external work after settlement.');
    } else if(change==='target')await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Claude',exact:true}).click();
    else await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
    release();await done;
    if(change==='view')await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
    await expect(page.getByRole('button',{name:'Recheck',exact:true}).first()).toBeEnabled();
    if(change!=='target')await expect(control.getByRole('alert')).toContainText('nothing was sent');
    else await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Codex',exact:true}).click();
    await expect(draft).toHaveValue(change==='draft'?'A newer draft must survive.':'Implement the acknowledged handoff.');
    // The acknowledged holds were cleared (that was consented to); only the send was cancelled.
    expect(starts).toEqual([]);expect((await state(request)).manualSessions).toEqual([]);
  } finally {release();await done;}
});
test('a draft edited while an acknowledged send is in flight survives its accepted response',async({page})=>{
  const {draft,send}=await prepareKeyboardSend(page,'Claude');
  let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>arrived=r);
  const starts:Record<string,unknown>[]=[];
  await page.route('**/api/v1/implementation',async route=>{starts.push(route.request().postDataJSON());arrived();await gate;await route.fulfill({json:{status:'delivered',error:null}});});
  try {
    await send.click();await received;
    await draft.fill('A newer draft must survive.');release();
    await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({text:'Implement the acknowledged handoff.'});
    await backToControl(page);await expect(draft).toHaveValue('A newer draft must survive.');
  } finally {release();}
});
test('a replaced writer revokes the acknowledgement even when its consequences read the same',async({page})=>{
  const {control,send}=await prepareKeyboardSend(page);
  const consequences=control.getByRole('list',{name:'Consequences of proceeding'}),before=await consequences.textContent();
  // Only the displayed writer generation is simulated: the same terminal, bytes and wording, but another grant.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.manualSessions=body.manualSessions.map((m:{writers:{live:boolean;generation:string}[]})=>({...m,writers:m.writers.map(w=>w.live?{...w,generation:'replacement-generation'}:w)}));
    await route.fulfill({response,json:body});
  });
  await expect(await readiness(page)).not.toBeChecked();await expect(send).toBeDisabled();
  expect(await consequences.textContent()).toBe(before);
});
test('a refused acknowledgement step keeps the draft and the hold and sends nothing',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/reconcile',route=>route.fulfill({status:409,json:{error:{code:'MANUAL_CHANGED',message:'Fixture input changed.'}}}));
  await send.click();
  const alert=control.getByRole('alert');
  await expect(alert).toContainText('Stopped: Fixture input changed.');await expect(alert).toContainText('Already done: stopped 1 typing connection');await expect(alert).toContainText('nothing was retried');
  await expect(draft).toHaveValue('Implement the acknowledged handoff.');expect(starts).toEqual([]);
  const manual=(await state(request)).manualSessions![0]!;expect(manual.live).toBe(false);expect(manual.reconciliationRequired).toBe(true);
});
test('an uncertain acknowledgement step is never retried and sends nothing',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];let stops=0;
  page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/stop',async route=>{stops++;await route.fetch();await route.abort('failed');});
  await send.click();
  await expect(control.getByRole('alert')).toContainText('The last step’s result is unknown');
  await expect(draft).toHaveValue('Implement the acknowledged handoff.');
  await expect(page.getByRole('button',{name:'Recheck',exact:true}).first()).toBeEnabled();
  expect(starts).toEqual([]);expect(stops).toBe(1);
});
test('input arriving after the acknowledgement revokes it before anything is sent',async({page,request})=>{
  const {send}=await prepareKeyboardSend(page);
  const writer=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
  // Another client types through this writer's connection after the check; the listed consequence changes, so the check is cleared.
  await post(request,`terminals/${writer.connectionId}/input`,{generation:writer.generation,seq:2,encoding:'utf8',data:'x'});
  await expect(await readiness(page)).not.toBeChecked();await expect(send).toBeDisabled();
  await expect(page.getByRole('region',{name:'Control',exact:true}).getByRole('list',{name:'Consequences of proceeding'})).toContainText('4 bytes');
});
test('another browser’s typing is listed and stopped by the acknowledgement',async({page,request})=>{
  const {terminal}=await prepareKeyboardSend(page);
  const other=await page.context().newPage();
  try {
    await other.route('**/api/v1/workspaces',async route=>{
      const response=await route.fetch(),body=await response.json();
      for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,stageRelay:{eligible:false,reason:'A task branch uses committed handoffs.'},taskBase:workspace.git.head});
      await route.fulfill({response,json:body});
    });
    const starts:string[]=[];await other.route('**/api/v1/implementation',async route=>{starts.push(route.request().url());await route.fulfill({json:{status:'delivered',error:null}});});
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    await openCard(other,'Codex');const control=other.getByRole('region',{name:'Control',exact:true});
    await control.getByLabel('Instruction for Codex').fill('Send even though another browser is typing.');
    await control.getByRole('region',{name:'Actions for Codex',exact:true}).getByLabel('After send').selectOption('commit');
    await expect(control.getByRole('list',{name:'Consequences of proceeding'})).toContainText('Typing stops in Codex (another browser or tab)');
    await (await readiness(other)).check();await control.getByRole('button',{name:'Send & commit Codex',exact:true}).click();
    await expect.poll(()=>starts.length).toBe(1);
    await showSurface(page,'Terminal');await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
    expect((await state(request)).manualSessions).toEqual([]);
  } finally {await other.close();}
});
test('Stage relay after Send lists active typing in its check and clears it when sent',async({page,request})=>{
  const terminal=await openKeyboard(page);
  const codex=await openCard(page,'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Stage the reviewed changes on main.');
  await codex.getByLabel('After send').selectOption('stage_relay');
  const send=codex.getByRole('button',{name:'Send Codex & stage-relay to Claude',exact:true});
  await expect(send).toBeDisabled();
  await expect(codex.getByRole('list',{name:'Consequences of proceeding'})).toContainText('Typing stops in Codex (this browser)');
  // openKeyboard observed the bytes through the API; readiness must wait for the page's next state poll too.
  await expect(codex.getByRole('list',{name:'Consequences of proceeding'})).toContainText('Manual terminal input (3 bytes)');
  const commands:Record<string,unknown>[]=[];
  await page.route('**/api/v1/commands',async route=>{expect((await state(request)).manualSessions).toEqual([]);commands.push(route.request().postDataJSON());await route.fulfill({json:{status:'delivered',error:null}});});
  await (await readiness(page)).check();await send.click();
  await expect.poll(()=>commands.length).toBe(1);
  await showSurface(page,'Terminal');await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
});
test('copy mode keeps the native terminal mounted and its keyboard generation intact',async({page,request})=>{
  const card=await openKeyboard(page);
  const owner=((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation;
  const closes:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/close$/.test(r.url()))closes.push(r.url());});
  let copyMode=true;
  // Only tmux's mode flag is simulated; terminal attachment and keyboard authority use the mock API.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%0'?{...p,inMode:copyMode}:p);
    await route.fulfill({response,json:body});
  });
  const pane=page.getByRole('article',{name:'Codex pane',exact:true});
  await expect(pane.getByText(/Tmux copy mode/)).toBeVisible();
  await expect(pane.getByRole('button',{name:'Clear context…',exact:true})).toBeDisabled();
  await expect(pane.getByRole('button',{name:'Clear context…',exact:true})).toHaveAttribute('title',/Tmux copy mode/);
  await expect(badge(card,'Typing enabled')).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation).toBe(owner);
  expect(closes).toEqual([]);
  copyMode=false;
  await expect(pane.getByText(/Tmux copy mode/)).toHaveCount(0);
  await expect(badge(card,'Typing enabled')).toBeVisible();
  expect(closes).toEqual([]);
});
test('Clear context lists this checkout’s typing, stops and reconciles it, then keeps its receipt',async({page,request})=>{
  const card=await openKeyboard(page),pane=page.getByRole('article',{name:'Codex pane',exact:true});
  const sent=async()=>(await state(request)).commands.filter(c=>c.agentId==='codex'&&c.text==='/clear').length,before=await sent();
  await pane.getByRole('button',{name:'Clear context…',exact:true}).click();
  const confirmation=pane.getByRole('region',{name:'Clear context for Codex',exact:true});
  await expect(confirmation.getByRole('list',{name:'Consequences of clearing context',exact:true})).toContainText('Typing stops in Codex (this browser)');
  await confirmation.getByRole('button',{name:'Clear Codex context',exact:true}).click();
  const receipt=pane.getByRole('status').filter({hasText:'/clear sent to Codex'});
  await expect(receipt).toBeVisible();await expect(badge(card,'Typing enabled')).toHaveCount(0);
  await expect.poll(async()=>((await state(request)).manualSessions??[]).length).toBe(0);
  // The refreshed view no longer lists any hold; the receipt of this click stays.
  await expect(page.locator('.page-heading').getByRole('img',{name:'Input: 0 active',exact:true})).toBeVisible();
  await expect(receipt).toBeVisible();expect(await sent()).toBe(before+1);
});
test('a copy-mode peer stays visible and blocks automated input without discarding the draft',async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  await openCard(page,'Codex');const draft=page.getByRole('textbox',{name:'Instruction for Codex',exact:true});
  await draft.fill('Keep this draft while the peer scrolls.');
  let copyMode=true;
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%1'?{...p,inMode:copyMode}:p);
    await route.fulfill({response,json:body});
  });
  const control=page.getByRole('region',{name:'Control',exact:true});
  await expect(control).toContainText('Tmux copy mode');
  await expect(control.getByRole('button',{name:'Send Codex',exact:true})).toBeDisabled();
  // Selecting the peer shows its terminal and addresses it; returning to Codex restores Codex's draft.
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Claude',exact:true}).click();
  await showSurface(page,'Terminal');await expect(page.getByRole('region',{name:'Claude terminal',exact:true})).toBeVisible();
  await showSurface(page,'Control');await expect(control).toContainText('Tmux copy mode');
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Codex',exact:true}).click();
  await expect(draft).toHaveValue('Keep this draft while the peer scrolls.');
  copyMode=false;
  await expect(control).not.toContainText('Tmux copy mode');
  await expect(draft).toHaveValue('Keep this draft while the peer scrolls.');
});
test('a copy-mode agent without a saved registration still shows its input blocker',async({page})=>{
  // A discovered, unsaved agent is listed in sessions, but its pane carries no registeredAs.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%0'?{...p,inMode:true,registeredAs:null}:p);
    await route.fulfill({response,json:body});
  });
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  await expect(page.getByRole('article',{name:'Codex pane',exact:true}).getByText(/Tmux copy mode/)).toBeVisible();
  await showSurface(page,'Control');await expect(page.getByRole('region',{name:'Control',exact:true})).toContainText('Tmux copy mode');
});
for(const phase of ['implementation','planning'] as const)for(const mode of ['inMode','synchronized'] as const)test(`${phase} readiness is revoked when ${mode} enters and clears between workspace polls`,async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const control=page.getByRole('region',{name:'Control',exact:true});
  if(phase==='planning') {
    await page.getByRole('group',{name:'Phase'}).getByRole('button',{name:'Plan',exact:true}).click();await page.getByLabel('Shared task brief').fill('Plan this task.');
  } else {
    await openCard(page,'Codex');await control.getByLabel('Instruction for Codex').fill('Keep readiness tied to pane state.');await control.getByRole('region',{name:'Actions for Codex',exact:true}).getByLabel('After send').selectOption('nothing');
  }
  const ready=await readiness(page,`Ready for ${phase}`);
  const send=control.getByRole('button',{name:phase==='planning'?'Start Plan':'Send Codex',exact:true});
  await ready.check();await expect(send).toBeEnabled();
  let blocked=true;
  // Workspace discovery is unchanged: mode changes arrive only through the faster state poll.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%1'?{...p,[mode]:blocked}:p);
    await route.fulfill({response,json:body});
  });
  const reason=mode==='inMode'?'Tmux copy mode':'synchronized';
  await expect(control).toContainText(reason);await expect(ready).not.toBeChecked();await expect(send).toBeDisabled();
  blocked=false;
  await expect(control).not.toContainText(reason);await expect(ready).not.toBeChecked();await expect(send).toBeDisabled();
  await ready.check();await expect(send).toBeEnabled();
});
test('observation is automatic; direct input, stop and Lock preserve manual authority',async({page,request},info)=>{
  const bytes:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();bytes.push(Buffer.from(b.data,b.encoding==='binary'?'base64':'utf8').toString());}});
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});await expect(badge(card,'Observing')).toBeVisible();
  expect((await state(request)).manualSessions).toEqual([]);
  await card.locator('.xterm-helper-textarea').focus();
  expect((await state(request)).manualSessions).toEqual([]);
  await card.getByRole('button',{name:'Terminal mode',exact:true}).click();await expect(badge(card,'Typing enabled')).toBeVisible();
  await page.keyboard.insertText('é次');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.bytes).toBe(5);
  const ctrl=card.getByRole('button',{name:'Ctrl next key'}),alt=card.getByRole('button',{name:'Alt next key'});
  await ctrl.click();await page.keyboard.insertText('c');await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await alt.click();await page.keyboard.insertText('x');await expect(alt).toHaveAttribute('aria-pressed','false');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.bytes).toBe(8);
  expect(bytes.join('')).toBe('é次\x03\x1bx');
  await page.screenshot({path:info.outputPath('native-direct-input.png'),fullPage:true});
  await chooseKeyboard(page,'Nobody (observe only)');await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.live).toBe(false);
  const stopped=(await state(request)).manualSessions![0]!;expect(stopped.reconciliationRequired).toBe(true);
  await post(request,'terminals/reconcile',{requestId:crypto.randomUUID(),manualSessionId:stopped.id,expectedRevision:stopped.revision,confirmReady:true});
  await takeKeyboard(page);await page.getByRole('button',{name:'Lock',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open console'})).toBeVisible();
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.live).toBe(false);
  expect((await state(request)).manualSessions![0]!.recoveryRequired).toBe(true);
});

test('repository entry, literal profile editor, preview and explicit duplicate-profile launch use the real mock API',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const sections=page.getByRole('navigation',{name:'Sections'});await sections.getByRole('button',{name:'Settings',exact:true}).click();
  const profiles=page.getByRole('region',{name:'Launch profiles'});await profiles.getByRole('button',{name:'New',exact:true}).click();await profiles.getByRole('menuitem',{name:'Codex preset'}).click();
  await expect(profiles.getByLabel('Argument 1',{exact:true})).toHaveValue('--no-daemon');
  const label=`Fixture ${info.project.name}`;await profiles.getByLabel('Profile label',{exact:true}).fill(label);await profiles.getByRole('button',{name:'Add argument',exact:true}).click();await profiles.getByLabel('Argument 2',{exact:true}).fill('literal ;');await profiles.getByRole('button',{name:'Save profile'}).click();
  const revisionOf=async()=>((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {label:string;revision:number}[]).find(p=>p.label===label)?.revision;
  // Saved profiles sit in one row by label; the revision stays internal but still guards every save.
  await expect(profiles.getByRole('group',{name:'Saved profiles'}).getByRole('button',{name:label,exact:true})).toBeVisible();await expect(profiles).not.toContainText('revision');expect(await revisionOf()).toBe(1);
  await profiles.getByRole('button',{name:label,exact:true}).click();await profiles.getByRole('button',{name:'Save profile'}).click();
  await expect.poll(revisionOf).toBe(2);
  await expect(profiles.getByLabel('Argument 1',{exact:true})).toHaveValue('--no-daemon');
  await sections.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Main/default starting checkout').fill(`/demo/native-${info.project.name}`);await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:`Project native-${info.project.name}`,exact:true}).click();
  const trees=page.getByRole('region',{name:`Project worktrees native-${info.project.name}`});await expandAgents(page,`native-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
  const add=trees.getByRole('button',{name:'Add agent',exact:true});
  await add.click();await expect(trees.getByRole('combobox')).toHaveCount(1);await expect(trees.getByRole('spinbutton')).toHaveCount(0);
  const saved=await (await request.get('/api/v1/launch-profiles',{headers})).json();const profile=saved.find((p:{label:string})=>p.label===label);
  await trees.getByLabel('Agent 1 profile').selectOption(profile.id);await trees.getByRole('button',{name:'Preview launch'}).click();
  await expect(trees.getByRole('table').locator('tbody tr')).toHaveCount(1);
  await add.click();await expect(trees.getByRole('combobox')).toHaveCount(2);await expect(trees.getByRole('table')).toHaveCount(0);
  await trees.getByLabel('Agent 2 profile').selectOption(profile.id);
  await trees.getByLabel('Agent 1 profile').selectOption('');await expect(trees.getByRole('button',{name:'Preview launch'})).toBeDisabled();
  await trees.getByRole('button',{name:'Remove agent 1',exact:true}).click();await expect(trees.getByRole('combobox')).toHaveCount(1);
  await expect(trees.getByLabel('Agent 1 profile')).toHaveValue(profile.id);
  await add.click();await trees.getByLabel('Agent 2 profile').selectOption(profile.id);await trees.getByRole('button',{name:'Preview launch'}).click();
  await expect(trees.getByRole('table')).toContainText('literal ;');
  await expect(trees.getByRole('table')).toContainText('--no-daemon');
  // Short session names: profile and branch, numbered only when taken, never a random UUID fragment. Exact allocation is covered
  // by the server and private-tmux tests; other tests on this server may have moved the mock branch.
  const names=await trees.getByRole('table').locator('tbody tr td:first-child').allTextContents();
  expect(names).toHaveLength(2);expect(new Set(names).size).toBe(2);
  for(const name of names){expect(name.startsWith(`Fixture-${info.project.name}-`)).toBe(true);expect(name).not.toMatch(/-[0-9a-f]{8}$/);}
  await trees.getByRole('button',{name:'Launch 2 sessions',exact:true}).click();await expect(trees.getByText('Simulated launch; no program executed.',{exact:true})).toHaveCount(2);
  await expect(trees.getByRole('button',{name:'Open terminal',exact:true})).toHaveCount(0);
  await expect(trees.locator('.native-terminal')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('explicit-launch.png'),fullPage:true});
  await trees.getByRole('button',{name:`Open native-${info.project.name}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:'Agent console',exact:true})).toBeVisible();
  for(const name of names)await expect(page.locator(`article[aria-label="${name} pane"]`)).toHaveCount(1);
  await sections.getByRole('button',{name:'Settings',exact:true}).click();await profiles.getByRole('button',{name:label,exact:true}).click();await profiles.getByRole('button',{name:'Delete profile'}).click();
  await expect(profiles.getByRole('button',{name:label,exact:true})).toHaveCount(0);
  const batches=await (await request.get('/api/v1/launches',{headers})).json();expect(batches.flatMap((b:{items:{profile:{id:string}}[]})=>b.items).filter((i:{profile:{id:string}})=>i.profile.id===profile.id)).toHaveLength(2);
});
test('manual recovery stays visible without agents and needs only explicit acknowledgement',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await takeKeyboard(page);
  await expect(badge(card,'Typing enabled')).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.live).toBe(false);
  // Only the empty-agent display is simulated. The durable barrier and decision use the mock server API.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,sessions:[]}});});
  await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
  await expect(page.getByRole('button',{name:/^Control access · you · manual input unresolved/})).toBeVisible();
  // The note says what earlier manual input may have done; taking control is one confirmation, with no checkbox or typed note.
  const access=await openAccess(page);await expect(access.getByRole('list',{name:'What to notice'})).toContainText('may have run commands');
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No eligible agents here yet'})).toBeVisible();
  await expect(access.getByRole('checkbox')).toHaveCount(0);await expect(access.getByRole('textbox')).toHaveCount(0);
  await access.getByRole('button',{name:'Take control…',exact:true}).click();
  const confirm=access.getByRole('region',{name:'Confirm take control'});await expect(confirm).toContainText('earlier manual input');
  await page.screenshot({path:info.outputPath('manual-recovery.png'),fullPage:true});
  const decision=page.waitForResponse(r=>r.url().endsWith('/terminals/reconcile')&&r.request().method()==='POST');
  await confirm.getByRole('button',{name:'Take control now',exact:true}).click();
  const response=await decision;expect(response.ok()).toBe(true);
  expect((await response.json()).humanDecision.note).toBe('I inspected the host and acknowledge possible prior and background effects.');
  await expect.poll(async()=>(await state(request)).manualSessions?.length).toBe(0);
  await expect(page.getByRole('button',{name:'Take control…',exact:true})).toHaveCount(0);
});

for(const fault of [null,'takeover refused','takeover unknown','reconcile refused','reconcile unknown'] as const)
test(`one Take control confirmation ends the controller run, then records the decision on earlier manual input${fault?` — ${fault}`:''}`,async({page,request})=>{
  // A modern (standalone) run started from Control, then a keyboard claim that holds it, then Lock: two holds for one confirmation.
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const codex=await openCard(page,'Codex');await codex.getByLabel('Instruction for Codex').fill('Fixture work');
  await (await readiness(page)).check();await codex.getByRole('button',{name:'Send Codex',exact:true}).click();
  await expect.poll(async()=>(await state(request)).runs.find(r=>r.status==='running'&&!!r.standalone)?.id).toBeTruthy();
  const id=(await state(request)).runs.find(r=>r.status==='running'&&!!r.standalone)!.id;
  await takeKeyboard(page);await expect(badge(page.getByRole('region',{name:'Codex terminal',exact:true}),'Typing enabled')).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.live).toBe(false);
  await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  if(fault)await page.route(`**/api/v1/${fault.startsWith('takeover')?'runs':'terminals/reconcile'}`,async route=>{
    if(fault.endsWith('refused'))await route.fulfill({status:409,json:{error:{message:'Fixture decision changed.'}}});
    else {
      // The real mock-host mutation succeeds, but its reply is lost: the UI cannot claim nothing changed.
      const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);await route.abort('failed');
    }
  });
  const sent:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&/\/api\/v1\/(runs|terminals\/reconcile)$/.test(r.url()))sent.push(new URL(r.url()).pathname);});
  const access=await openAccess(page);
  const notes=access.getByRole('list',{name:'What to notice'});
  await expect(notes).toContainText('may still be working');await expect(notes).toContainText('may have run commands');
  await expect(access.getByRole('checkbox')).toHaveCount(0);
  await access.getByRole('button',{name:'Take control…',exact:true}).click();
  const confirm=access.getByRole('region',{name:'Confirm take control'});
  await expect(confirm.getByRole('listitem')).toHaveCount(2);expect(sent).toEqual([]);
  await confirm.getByRole('button',{name:'Take control now',exact:true}).click();
  if(fault) {
    const feedback=page.locator('.feedback[role="status"]:visible');
    await expect(feedback).toContainText(fault.endsWith('unknown')?'The last step’s result is unknown':'Stopped');
    await expect(feedback).toContainText('Nothing was retried');
    if(fault.endsWith('unknown')) {
      await expect(feedback).toContainText('The last step may have completed');
      await expect(feedback).not.toContainText('Nothing else changed');
    }
    if(fault.startsWith('reconcile'))await expect(feedback).toContainText("Already done: ended the controller's run");
    // A subsequent read neither repeats the decision nor sends later steps after a refusal or an unknown result.
    await page.getByRole('button',{name:'Recheck',exact:true}).click();
    await expect(page.getByRole('button',{name:'Recheck',exact:true})).toBeEnabled();
    expect(sent).toEqual(fault.startsWith('takeover')?['/api/v1/runs']:['/api/v1/runs','/api/v1/terminals/reconcile']);
    const after=await state(request);
    expect(after.runs.find(r=>r.id===id)?.status).toBe(fault==='takeover refused'?'running':'stopped');
    expect(after.manualSessions??[]).toHaveLength(fault==='reconcile unknown'?0:1);
    // Settle the intentionally refused run before the shared manual-record cleanup.
    if(fault==='takeover refused')await post(request,'runs',{runId:id,action:'takeover',confirmReady:true});
    return;
  }
  await expect.poll(()=>sent).toEqual(['/api/v1/runs','/api/v1/terminals/reconcile']);
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('You have control');
  const after=await state(request);
  expect(after.runs.find(r=>r.id===id)?.status).toBe('stopped');expect(after.manualSessions??[]).toEqual([]);
});
for(const failed of [false,true])test(`a delayed ${failed?'failed':'successful'} input response cannot stall or revoke a newer keyboard generation on the same connection`,async({page,request})=>{
  const card=await openKeyboard(page);
  let release!:()=>void, received!:()=>void, finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  await page.route('**/api/v1/terminals/*/input',async route=>{
    const response=await route.fetch();received();await gate;
    try {if(failed)await route.fulfill({status:503,json:{error:{message:'Fixture lost input response.'}}});else await route.fulfill({response});}
    finally {finished();}
  },{times:1});
  try {
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('a');await captured;
    // Stop server-side while the response is delayed in the browser. Keep the terminal mounted so the late callback shares its connection.
    const manual=(await state(request)).manualSessions![0]!,writer=manual.writers.find(w=>w.live)!;
    await post(request,'terminals/stop',{requestId:crypto.randomUUID(),expectedBootId:manual.bootId,manualSessionId:manual.id,expectedRevision:manual.revision,
      writers:[{connectionId:writer.connectionId,generation:writer.generation,revision:writer.revision}]});
    await expect(badge(card,'Observing')).toBeVisible();
    await expect(page.getByRole('region',{name:'Confirm keyboard'})).toHaveCount(0);
    await takeKeyboard(page);
    await expect(badge(card,'Typing enabled')).toBeVisible();
    const next=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
    expect(next.connectionId).toBe(writer.connectionId);expect(next.generation).not.toBe(writer.generation);
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('b');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(8);
    release();await done;
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('c');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(9);
    await expect(badge(card,'Typing enabled')).toBeVisible();
  } finally {release();await done;}
});

test('a terminal hidden behind Control admits no new input and keeps its keyboard generation',async({page,request})=>{
  // By attribute: the hidden terminal leaves the accessibility tree but stays in the page.
  const card=await openKeyboard(page),textarea=pane(page,'Codex').locator('.xterm-helper-textarea');
  const owner=((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation;
  const bytes=async()=>((await state(request)).manualSessions??[])[0]?.bytes;
  const paste=async(text:string)=>textarea.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
  await paste('a');await expect.poll(bytes).toBe(4);
  // Control replaces the terminals; the writer stays mounted and connected, but an input event reaching it is not admitted.
  await showSurface(page,'Control');await paste('b');await page.waitForTimeout(500);
  expect(await bytes()).toBe(4);
  await showSurface(page,'Terminal');await expect(badge(card,'Typing enabled')).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation).toBe(owner);
  await paste('c');await expect.poll(bytes).toBe(5);
});
test('native paste warns before unbracketed multiline input; Ctrl+Shift+Escape leaves terminal focus without input',async({page,request})=>{
  const card=await openKeyboard(page),textarea=card.locator('.xterm-helper-textarea');
  const height=(await card.getByLabel('Codex native output').boundingBox())!.height;
  const owner=((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation;
  await card.getByRole('button',{name:'Expand terminal',exact:true}).click();
  await expect.poll(async()=>(await card.getByLabel('Codex native output').boundingBox())!.height).toBeGreaterThan(height);
  await card.getByRole('button',{name:'Collapse terminal',exact:true}).click();
  expect(((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation).toBe(owner);
  const paste=async(text:string)=>textarea.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
  await textarea.focus();
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('execute');await dialog.dismiss();});
  await paste('first\nsecond');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(3);
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('execute');await dialog.accept();});
  await paste('first\nsecond');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(15);
  await paste('x');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(16);
  await card.getByRole('button',{name:'Screen reader mode',exact:true}).click();await expect(card.locator('.xterm-accessibility')).toHaveCount(1);
  await textarea.focus();await page.keyboard.press('z');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(17);
  await card.getByRole('button',{name:'Screen reader mode',exact:true}).click();await expect(card.locator('.xterm-accessibility')).toHaveCount(0);
  await textarea.focus();await page.keyboard.insertText('🙂');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(21);
  await expect(card.getByText(/Snapshot captured at/)).toHaveCount(0);
  await card.getByRole('button',{name:'Captured text',exact:true}).click();await expect(card.getByText(/Snapshot captured at/)).toBeVisible();
  await card.getByRole('button',{name:'Show terminal',exact:true}).click();
  await expect(card.getByRole('button',{name:'Focus AltCLI control'})).toHaveCount(0);
  await textarea.focus();await expect(card.getByRole('status')).toContainText('Ctrl+Shift+Esc: leave terminal focus');
  await page.keyboard.press('Control+Shift+Escape');
  await expect(page.getByRole('group',{name:'Terminal or Control'}).getByRole('button',{name:'Terminal',exact:true})).toBeFocused();
  await (await openCard(page,'Codex')).getByLabel('Instruction for Codex').fill('A control draft never becomes terminal input.');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(21);
});

test('leaving the terminal drops queued text without replaying it when an admitted input response arrives',async({page,request})=>{
  const card=await openKeyboard(page);let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  await page.route('**/api/v1/terminals/*/input',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
  try {
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('a');await captured;
    await page.keyboard.insertText('queued');
    await page.keyboard.press('Control+Shift+Escape');release();await done;
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('b');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(5);
  } finally {release();await done;}
});

test('leaving the terminal finishes a partly sent paste but drops later unsent input',async({page,request})=>{
  const card=await openKeyboard(page),textarea=card.locator('.xterm-helper-textarea');
  const sent:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();sent.push(Buffer.from(b.data,b.encoding==='binary'?'base64':'utf8').toString());}});
  let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  // Keep interception active as the paste drains: removing a one-shot route can race the next chunk's request.
  let first=true;
  await page.route('**/api/v1/terminals/*/input',async route=>{
    if(!first){await route.continue();return;}first=false;
    const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}
  });
  try {
    // One 10,000-byte paste event becomes three 4 KiB input frames; hold the first in flight while focus leaves.
    const text=`${'p'.repeat(9999)}!`;
    await textarea.focus();
    await textarea.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
    await captured;await page.keyboard.insertText('Z');
    await page.keyboard.press('Control+Shift+Escape');release();await done;
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(10003);
    await textarea.focus();await page.keyboard.insertText('Q');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(10004);
    expect(sent.join('')).toBe(`${text}Q`);
  } finally {release();await done;}
});

test('Paste text uses the current lease and refuses a delayed clipboard result after typing',async({page,request})=>{
  const card=await openKeyboard(page);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=> 'clipboard'}}));
  await card.getByRole('button',{name:'Paste text',exact:true}).click();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(12);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>new Promise<string>(resolve=>{Object.assign(window,{completeClipboard:()=>resolve('must not type')});})}}));
  await card.getByRole('button',{name:'Paste text',exact:true}).click();await expect(card.getByRole('button',{name:'Paste text',exact:true})).toHaveAttribute('aria-busy','true');
  await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('x');
  await page.evaluate(()=>(window as unknown as {completeClipboard:()=>void}).completeClipboard());
  await expect(card.getByRole('status')).toContainText('Clipboard text was not pasted');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(13);
});

test('several browsers can type independently while unresolved input and replaced CLIs remain visible',async({page,request})=>{
  const card=await openKeyboard(page),other=await page.context().newPage();
  try {
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    const remote=other.getByRole('region',{name:'Codex terminal',exact:true});
    await takeKeyboard(other);await expect(badge(card,'Typing enabled')).toBeVisible();
    await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.writers.filter(w=>w.live).length).toBe(2);
    await chooseKeyboard(page,'Nobody (observe only)');await expect(badge(remote,'Typing enabled')).toBeVisible();
    await chooseKeyboard(other,'Nobody (observe only)');
    await expect(badge(remote,'Observing · manual input unresolved')).toBeVisible();
    await other.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
      await route.fulfill({response,json:{...body,instances:body.instances.map((i:{agentId:string})=>i.agentId==='codex'?{...i,status:'replaced'}:i)}});});
    await expect(badge(remote,'Manual CLI/shell')).toBeVisible();
  } finally {await other.close();}
});

test('moving focus while input is starting keeps the writer but never steals focus',async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>entered=r);
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{entered();await gate;await route.continue();},{times:1});
  try {
    await toggleTerminal(page,'Codex');await received;
    const elsewhere=page.getByRole('button',{name:'Recheck',exact:true});await elsewhere.focus();release();
    await expect(badge(card,'Typing enabled')).toBeVisible();await expect(elsewhere).toBeFocused();
    expect((await state(request)).manualSessions![0]!.bytes).toBe(0);expect((await state(request)).manualSessions![0]!.live).toBe(true);
  } finally {release();}
});

test('a Terminal toggle that reconnects first keeps focus where the user moved it',async({page,request})=>{
  const card=await openKeyboard(page),toggle=card.getByRole('button',{name:'Terminal mode',exact:true});
  const writer=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
  await post(request,`terminals/${writer.connectionId}/close`,{});await expect(badge(card,'Disconnected')).toBeVisible();
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),opening=new Promise<void>(r=>entered=r);
  await page.route('**/api/v1/terminals',async route=>{entered();await gate;await route.continue();},{times:1});
  try {
    await toggle.click();await opening;
    const elsewhere=page.getByRole('button',{name:'Recheck',exact:true});await elsewhere.focus();release();
    await expect(badge(card,'Typing enabled')).toBeVisible();await expect(elsewhere).toBeFocused();
  } finally {release();}
});
for(const leave of ['Lock','another workspace'] as const)for(const purpose of ['update','literal answer'] as const)test(`a pending owned-run ${purpose} is never sent after ${leave} unmounts its composer while holds clear`,async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const codex=await openCard(page,'Codex');await codex.getByLabel('Instruction for Codex').fill('Fixture work');
  await (await readiness(page)).check();await codex.getByRole('button',{name:'Send Codex',exact:true}).click();
  await expect.poll(async()=>(await state(request)).runs.find(r=>r.status==='running'&&!!r.standalone)?.id).toBeTruthy();
  const s=await state(request),run=s.runs.find(r=>r.status==='running'&&!!r.standalone)!;
  const turn=s.executions.find(e=>e.commandId===run.currentCommandId)!,agent=run.participants.find(p=>p.id===turn.agentId)!;
  // The real mock-API run acknowledges its native start, so literal input is otherwise deliverable.
  await post(request,'events',{commandId:turn.commandId,source:agent.agentType,paneId:agent.identity.paneId,socketPath:agent.identity.socketPath,identity:agent.identity,
    sessionId:`fixture-input-${crypto.randomUUID()}`,sourceTurnId:`fixture-turn-${crypto.randomUUID()}`,prompt:turn.wireText,settled:true,backgroundState:'clear',event:'turn_started'});
  await takeKeyboard(page);await showSurface(page,'Control');
  const update=page.getByRole('region',{name:'Input for Codex',exact:true});
  if(purpose==='update')await update.getByLabel('Add detail for Codex').fill('Must never arrive.');
  else {await expand(update,'Terminal controls');await update.getByLabel('Literal answer for Codex').fill('1');}
  const check=update.getByRole('checkbox',{name:/I inspected Codex/});await expect(check).toBeEnabled({timeout:8000});
  await expect(update.getByRole('list',{name:'Consequences of proceeding'})).toContainText('Typing stops in Codex');await check.check();
  let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>arrived=r);
  await page.route('**/api/v1/terminals/reconcile',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});},{times:1});
  const sent:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/interactions')sent.push(r.url());});
  try {
    await update.getByRole('button',{name:purpose==='update'?'Send update to Codex':'Send answer',exact:true}).click();await received;
    if(leave==='Lock'){await page.getByRole('button',{name:'Lock',exact:true}).click();await expect(page.getByRole('button',{name:'Open console'})).toBeVisible();}
    else {await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'other'});await expect(update).toHaveCount(0);}
    release();
    // The acknowledged decision on manual input stands; only the pending input is dropped.
    await expect.poll(async()=>((await state(request)).manualSessions??[]).length).toBe(0);await page.waitForTimeout(500);
    expect(sent).toEqual([]);expect(((await state(request)).interactions??[]).filter(r=>r.input.runId===run.id)).toEqual([]);
  } finally {release();}
});
test('a native keyboard hold keeps the Plan brief editable; Start Plan waits for the acknowledgement that lists it',async({page,request})=>{
  await openKeyboard(page);
  await page.getByRole('group',{name:'Phase'}).getByRole('button',{name:'Plan',exact:true}).click();
  const brief=page.getByLabel('Shared task brief');
  await expect(brief).toBeEditable();await brief.fill('Drafted while the keyboard is held.');
  await expect(brief).toHaveValue('Drafted while the keyboard is held.');
  const start=page.getByRole('button',{name:'Start Plan',exact:true});await expect(start).toBeDisabled();
  await expect(page.getByRole('group',{name:'Readiness for Plan'}).getByRole('list',{name:'Consequences of proceeding'})).toContainText('Typing stops in Codex (this browser)');
  await (await readiness(page,'Ready for planning')).check();await expect(start).toBeEnabled();
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(3);
});

test('local terminals retain independent writers and each Display toggle stops only its own',async({page,request})=>{
  const card=await openKeyboard(page),original=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
  await takeKeyboard(page,'Claude');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.writers.filter(w=>w.live).length).toBe(2);
  expect((await state(request)).manualSessions![0]!.writers.find(w=>w.connectionId===original.connectionId)!.generation).toBe(original.generation);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Codex',exact:true}).click();await expect(badge(card,'Typing enabled')).toBeVisible();
  await badge(card,'Typing enabled').click();
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.writers.filter(w=>w.live).length).toBe(1);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Claude',exact:true}).click();
  await badge(page.getByRole('region',{name:'Claude terminal',exact:true}),'Typing enabled').click();
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.live).toBe(false);
  expect((await state(request)).manualSessions![0]!.reconciliationRequired).toBe(true);
});

test('a terminal still connecting creates no authority; Terminal chosen meanwhile starts once connected',async({page,request})=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let opens=0;
  await page.route('**/api/v1/terminals',async route=>{opens++;await gate;await route.continue();});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const card=page.getByRole('region',{name:'Codex terminal',exact:true});await expect(badge(card,'Disconnected')).toBeVisible();
    await card.getByRole('button',{name:'Terminal mode',exact:true}).click();await expect(card.getByRole('status')).toContainText('Connecting, then starting input');
    // Focus moved elsewhere while the connection opened: the later grant must not take it back.
    const elsewhere=page.getByRole('button',{name:'Recheck',exact:true});await elsewhere.focus();
    expect((await state(request)).manualSessions??[]).toEqual([]);release();
    await expect(badge(card,'Typing enabled')).toBeVisible();await expect(elsewhere).toBeFocused();
    expect(((await state(request)).manualSessions??[]).flatMap(m=>m.writers.filter(w=>w.live))).toHaveLength(1);
    expect(opens).toBe(2); // one connection per terminal card; waiting never opened another
  } finally {release();}
});

test('a Codex profile without --no-daemon is flagged in the row, the editor and the launch preview, and one click restores the flag',async({page,request},info)=>{
  const label=`No daemon ${info.project.name}`;
  const created=await post(request,'launch-profiles',{label,executable:'codex',args:['--model','fixture'],adapterHint:'codex',enabled:true});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const sections=page.getByRole('navigation',{name:'Sections'});
    // The launch preview warns before any session starts; nothing is launched here.
    await sections.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Main/default starting checkout').fill(`/demo/nodaemon-${info.project.name}`);await page.getByRole('button',{name:'Add project',exact:true}).click();
    await page.getByRole('button',{name:`Project nodaemon-${info.project.name}`,exact:true}).click();
    const trees=page.getByRole('region',{name:`Project worktrees nodaemon-${info.project.name}`});await expandAgents(page,`nodaemon-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
    await trees.getByRole('button',{name:'Add agent',exact:true}).click();await trees.getByLabel('Agent 1 profile').selectOption(created.id);await trees.getByRole('button',{name:'Preview launch'}).click();
    await expect(trees.getByRole('status').filter({hasText:`Profile ${label} runs Codex without --no-daemon`})).toBeVisible();
    await sections.getByRole('button',{name:'Settings',exact:true}).click();
    const profiles=page.getByRole('region',{name:'Launch profiles'});
    await profiles.getByRole('button',{name:`${label} · needs --no-daemon`,exact:true}).click();
    const warning=profiles.getByRole('status').filter({hasText:'lacks --no-daemon'});
    await expect(warning).toBeVisible();await warning.getByRole('button',{name:'Add --no-daemon',exact:true}).click();
    await expect(profiles.getByLabel('Argument 1',{exact:true})).toHaveValue('--no-daemon');await expect(profiles.getByLabel('Argument 2',{exact:true})).toHaveValue('--model');
    await expect(warning).toHaveCount(0);
    await profiles.getByRole('button',{name:'Save profile'}).click();
    await expect(profiles.getByRole('button',{name:label,exact:true})).toBeVisible();
  } finally {
    const current=((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;revision:number}[]).find(p=>p.id===created.id);
    if(current)await request.delete(`/api/v1/launch-profiles/${created.id}`,{headers,data:{expectedRevision:current.revision}});
  }
});
test('a Codex-hinted shell profile keeps its arguments and offers manual verification',async({page,request},info)=>{
  const label=`Codex shell ${info.project.name}`,args=['-lc','exec codex --no-daemon'] as const;
  const created=await post(request,'launch-profiles',{label,executable:'/bin/zsh',args,adapterHint:'codex',enabled:true});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const sections=page.getByRole('navigation',{name:'Sections'});
    await sections.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Main/default starting checkout').fill(`/demo/codex-shell-${info.project.name}`);await page.getByRole('button',{name:'Add project',exact:true}).click();
    await page.getByRole('button',{name:`Project codex-shell-${info.project.name}`,exact:true}).click();
    const trees=page.getByRole('region',{name:`Project worktrees codex-shell-${info.project.name}`});await expandAgents(page,`codex-shell-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
    await trees.getByRole('button',{name:'Add agent',exact:true}).click();await trees.getByLabel('Agent 1 profile').selectOption(created.id);await trees.getByRole('button',{name:'Preview launch'}).click();
    await expect(trees.getByRole('status').filter({hasText:`Profile ${label} uses a shell or wrapper`})).toBeVisible();
    await expect(trees.getByText('runs Codex without --no-daemon',{exact:false})).toHaveCount(0);
    await sections.getByRole('button',{name:'Settings',exact:true}).click();
    const profiles=page.getByRole('region',{name:'Launch profiles'});
    await profiles.getByRole('button',{name:label,exact:true}).click();
    await expect(profiles.getByText('For a shell or wrapper, check that its Codex command includes',{exact:false})).toBeVisible();
    await expect(profiles.getByRole('button',{name:'Add --no-daemon',exact:true})).toHaveCount(0);
    await expect(profiles.getByLabel('Argument 1',{exact:true})).toHaveValue(args[0]);await expect(profiles.getByLabel('Argument 2',{exact:true})).toHaveValue(args[1]);
    const saved=page.waitForResponse(r=>r.url().endsWith(`/launch-profiles/${created.id}`)&&r.request().method()==='PATCH');
    await profiles.getByRole('button',{name:'Save profile'}).click();const response=await saved;expect(response.ok()).toBe(true);expect((await response.json()).args).toEqual(args);
  } finally {
    const current=((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;revision:number}[]).find(p=>p.id===created.id);
    if(current)await request.delete(`/api/v1/launch-profiles/${created.id}`,{headers,data:{expectedRevision:current.revision}});
  }
});
test('Helper → Settings saves the model as the only launchable profile Chat preselects; Chat and Launch profiles link to it; nothing launches',async({page,request})=>{
  const list=async()=>((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;label:string;revision:number;args:string[]}[]);
  const wrapper=await post(request,'launch-profiles',{label:'Wrapped Codex',executable:'/bin/zsh',args:['-lc','codex'],adapterHint:'codex',enabled:true});
  try {
    const posts:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/global-ai'))posts.push(r.url());});
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const sections=page.getByRole('navigation',{name:'Sections',exact:true});await sections.getByRole('button',{name:'Helper',exact:true}).click();
    // Helper uses Console's token. Worktree recovery stays in Console; with no conversation yet Chat is the start flow.
    await expect(page.getByRole('heading',{name:'Helper',level:1})).toBeVisible();await expect(page.getByLabel('AltCLI access token')).toHaveCount(0);
    const parts=page.getByRole('navigation',{name:'Helper sections'});
    await expect(parts.getByRole('button')).toHaveText(['Chat','Session','Settings','Evidence','Guide']);
    await expect(parts.getByRole('button',{name:'Chat',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('.page-heading').getByRole('button',{name:/^Control access/})).toHaveCount(0);
    // Without a profile, Chat leads to Settings.
    const start=page.getByRole('region',{name:'Start Helper'});
    await expect(start.getByText('No profile can launch Helper yet',{exact:false})).toBeVisible();
    await start.getByRole('button',{name:'Settings',exact:true}).first().click();
    await expect(parts.getByRole('button',{name:'Settings',exact:true})).toHaveAttribute('aria-pressed','true');
    const settings=page.getByRole('region',{name:'Helper settings'});
    // The mock host is not tmux: the missing requirement is named before anything could start.
    await expect(settings.getByRole('status').filter({hasText:'ALTCLI_ADAPTER=tmux'})).toBeVisible();
    // The wrapper cannot launch Helper, so it is not listed; the first new profile is named Helper.
    await expect(settings.getByText('No Helper profiles yet',{exact:false})).toBeVisible();
    await expect(settings.getByLabel('Name',{exact:true})).toHaveValue('Helper');
    const create=settings.getByRole('button',{name:'Create Helper profile'});
    await settings.getByLabel('Model',{exact:true}).fill('bad model');await expect(create).toBeDisabled();
    await settings.getByLabel('Model',{exact:true}).fill('gpt-test');await settings.getByLabel('Reasoning effort').selectOption('high');
    await expect(settings.getByLabel('Helper command preview')).toContainText('"model_reasoning_effort=high"');
    await create.click();await expect(settings.getByRole('status').filter({hasText:'nothing was launched'})).toBeVisible();
    const saved=(await list()).find(p=>p.label==='Helper')!;
    expect(saved.args).toEqual(['--no-daemon','-m','gpt-test','-c','model_reasoning_effort=high']);
    // Chat lists only profiles Helper can launch, preselects the saved one and shares every project.
    await parts.getByRole('button',{name:'Chat',exact:true}).click();await expect(settings).toBeHidden();
    const select=page.getByLabel('Helper launch profile');
    await expect(select).toHaveValue(saved.id);await expect(select.locator('option',{hasText:'Wrapped Codex'})).toHaveCount(0);
    await expect(page.getByText('for every project on this host',{exact:false})).toBeVisible();
    // Settings no longer has a Helper section, and its Launch profiles hold only agent profiles. It links back, where the saved values read back.
    await sections.getByRole('button',{name:'Settings',exact:true}).click();
    await expect(page.getByRole('navigation',{name:'Settings sections'}).getByRole('button')).toHaveText(['Console preferences','Host configuration']);
    const agentProfiles=page.getByRole('region',{name:'Launch profiles'}).getByRole('group',{name:'Saved profiles'});
    await expect(agentProfiles.getByRole('button',{name:'Wrapped Codex',exact:true})).toBeVisible();await expect(agentProfiles.getByRole('button',{name:'Helper',exact:true})).toHaveCount(0);
    await page.getByRole('region',{name:'Console preferences'}).getByRole('button',{name:'Helper → Settings'}).click();
    await expect(sections.getByRole('button',{name:'Helper',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(settings.getByLabel('Model',{exact:true})).toHaveValue('gpt-test');await expect(settings.getByLabel('Reasoning effort')).toHaveValue('high');
    await expect(settings.getByRole('button',{name:'Save Helper profile'})).toBeVisible();
    await expect(settings.getByRole('group',{name:'Helper profiles'}).getByRole('button')).toHaveText(['Helper']);
    // Session has nothing to manage without a conversation and leads back to Chat; Evidence reads work without one.
    await parts.getByRole('button',{name:'Session',exact:true}).click();await expect(select).toBeHidden();await expect(settings).toBeHidden();
    await page.getByRole('region',{name:'Helper session'}).getByRole('button',{name:'Start one in Chat'}).click();await expect(select).toHaveValue(saved.id);
    await parts.getByRole('button',{name:'Evidence',exact:true}).click();await expect(page.getByRole('heading',{name:'Evidence, not another prompt'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Inspect runs',exact:true})).toBeVisible();
    await expect(page.locator('.page-heading').getByRole('button',{name:/^Control access/})).toHaveCount(0);
    // With a profile, Chat still links to Settings.
    await parts.getByRole('button',{name:'Chat',exact:true}).click();
    await start.getByRole('button',{name:'Settings',exact:true}).first().click();
    await expect(settings).toBeVisible();await parts.getByRole('button',{name:'Chat',exact:true}).click();await expect(select).toHaveValue(saved.id);
    // Guide has no worktree recovery controls; Helper reopens on the section chosen earlier on this page.
    await parts.getByRole('button',{name:'Guide',exact:true}).click();await expect(select).toBeHidden();
    await expect(page.getByRole('button',{name:/^Control access/})).toHaveCount(0);
    await sections.getByRole('button',{name:'Console',exact:true}).click();await expect(page.getByRole('region',{name:'How this works'})).toBeHidden();
    await sections.getByRole('button',{name:'Helper',exact:true}).click();await expect(page.getByRole('region',{name:'How this works'})).toBeVisible();
    expect(posts).toEqual([]);
    // /global-ai opens Console on Helper → Chat.
    await page.goto('/global-ai');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await expect(sections.getByRole('button',{name:'Helper',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(parts.getByRole('button',{name:'Chat',exact:true})).toHaveAttribute('aria-pressed','true');await expect(select).toHaveValue(saved.id);
  } finally {
    for(const p of (await list()).filter(p=>p.label==='Helper'||p.id===wrapper.id))await request.delete(`/api/v1/launch-profiles/${p.id}`,{headers,data:{expectedRevision:p.revision}});
  }
});
test('a profile saved under the earlier Global AI label is still preselected, and saving it in Helper → Settings keeps its name',async({page,request})=>{
  const list=async()=>((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;label:string;revision:number}[]);
  const legacy=await post(request,'launch-profiles',{label:'Global AI',executable:'codex',args:['--no-daemon','-m','gpt-old'],adapterHint:'codex',enabled:true,purpose:'helper'});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const sections=page.getByRole('navigation',{name:'Sections',exact:true});
    await sections.getByRole('button',{name:'Helper',exact:true}).click();await expect(page.getByLabel('Helper launch profile')).toHaveValue(legacy.id);
    await page.getByRole('navigation',{name:'Helper sections'}).getByRole('button',{name:'Settings',exact:true}).click();
    const settings=page.getByRole('region',{name:'Helper settings'});
    await expect(settings.getByLabel('Model',{exact:true})).toHaveValue('gpt-old');await expect(settings.getByLabel('Name',{exact:true})).toHaveValue('Global AI');
    // Profiles are named by the owner now: saving never renames one.
    await settings.getByLabel('Model',{exact:true}).fill('gpt-new');
    await settings.getByRole('button',{name:'Save Helper profile'}).click();await expect(settings.getByRole('status').filter({hasText:'nothing was launched'})).toBeVisible();
    expect((await list()).find(p=>p.id===legacy.id)!.label).toBe('Global AI');
  } finally {
    const current=(await list()).find(p=>p.id===legacy.id);
    if(current)await request.delete(`/api/v1/launch-profiles/${legacy.id}`,{headers,data:{expectedRevision:current.revision}});
  }
});
test('Helper → Settings switches its profile to Claude Code, which Chat then lists; until saved, Codex keeps its values',async({page,request})=>{
  const list=async()=>((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;label:string;revision:number;executable:string;args:string[];adapterHint:string}[]);
  const codex=await post(request,'launch-profiles',{label:'Helper',executable:'codex',args:['--no-daemon','-m','gpt-old','-c','model_reasoning_effort=high'],adapterHint:'codex',enabled:true,purpose:'helper'});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const sections=page.getByRole('navigation',{name:'Sections',exact:true});await sections.getByRole('button',{name:'Helper',exact:true}).click();
    const parts=page.getByRole('navigation',{name:'Helper sections'});await parts.getByRole('button',{name:'Settings',exact:true}).click();
    const settings=page.getByRole('region',{name:'Helper settings'}),cli=settings.getByRole('combobox',{name:'CLI',exact:true}),model=settings.getByLabel('Model',{exact:true});
    await expect(cli).toHaveValue('codex');await expect(model).toHaveValue('gpt-old');
    await expect(settings.getByText('--sandbox read-only',{exact:false})).toBeVisible();
    // Another CLI starts from its own defaults and states how it is held to read-only; switching back restores the saved values.
    await cli.selectOption('claude');await expect(model).toHaveValue('');await expect(model).toHaveAttribute('placeholder',"Claude Code's configured default");
    await expect(settings.getByText('manual permission mode',{exact:false})).toBeVisible();
    await cli.selectOption('codex');await expect(model).toHaveValue('gpt-old');await expect(settings.getByLabel('Reasoning effort')).toHaveValue('high');
    await cli.selectOption('claude');await model.fill('sonnet');await settings.getByLabel('Reasoning effort').selectOption('max');
    await expect(settings.getByLabel('Helper command preview')).toHaveText(JSON.stringify(['claude','--model','sonnet','--effort','max'],null,2));
    expect((await list()).find(p=>p.id===codex.id)!.adapterHint).toBe('codex');
    await settings.getByRole('button',{name:'Save Helper profile'}).click();await expect(settings.getByRole('status').filter({hasText:'nothing was launched'})).toBeVisible();
    const saved=(await list()).find(p=>p.id===codex.id)!;
    expect([saved.label,saved.adapterHint,saved.executable,saved.args]).toEqual(['Helper','claude','claude',['--model','sonnet','--effort','max']]);
    await parts.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Helper launch profile')).toHaveValue(saved.id);
  } finally {
    const current=(await list()).find(p=>p.id===codex.id);
    if(current)await request.delete(`/api/v1/launch-profiles/${codex.id}`,{headers,data:{expectedRevision:current.revision}});
  }
});
test('Helper → Settings keeps several named profiles that Chat offers; deleting one asks first and stops nothing',async({page,request})=>{
  const list=async()=>((await (await request.get('/api/v1/launch-profiles',{headers})).json()) as {id:string;label:string;revision:number;adapterHint:string;args:string[]}[]);
  const first=await post(request,'launch-profiles',{label:'Helper',executable:'codex',args:['--no-daemon','-m','gpt-old'],adapterHint:'codex',enabled:true,purpose:'helper'});
  // An agent profile Helper could otherwise launch stays out of Helper.
  const agent=await post(request,'launch-profiles',{label:'Agent Codex',executable:'codex',args:['--no-daemon'],adapterHint:'codex',enabled:true});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('navigation',{name:'Sections',exact:true}).getByRole('button',{name:'Helper',exact:true}).click();
    const parts=page.getByRole('navigation',{name:'Helper sections'});await parts.getByRole('button',{name:'Settings',exact:true}).click();
    const settings=page.getByRole('region',{name:'Helper settings'}),names=settings.getByRole('group',{name:'Helper profiles'}).getByRole('button');
    const name=settings.getByLabel('Name',{exact:true}),create=settings.getByRole('button',{name:'Create Helper profile'});
    await expect(names).toHaveText(['Helper']);await expect(names.first()).toHaveAttribute('aria-pressed','true');
    // A new profile needs its own name; Cancel returns to the saved one without writing.
    await settings.getByRole('button',{name:'New profile'}).click();await expect(settings.getByRole('heading',{name:'New profile'})).toBeVisible();
    await expect(name).toHaveValue('');await expect(create).toBeDisabled();
    await settings.getByRole('button',{name:'Cancel'}).click();await expect(name).toHaveValue('Helper');
    await settings.getByRole('button',{name:'New profile'}).click();
    await name.fill('Claude Opus max');await settings.getByRole('combobox',{name:'CLI',exact:true}).selectOption('claude');
    await settings.getByLabel('Model',{exact:true}).fill('opus');await settings.getByLabel('Reasoning effort').selectOption('max');
    // Visiting another top-level tab keeps the unsaved profile draft, just as the other settings editors do.
    const sections=page.getByRole('navigation',{name:'Sections',exact:true});
    await sections.getByRole('button',{name:'Settings',exact:true}).click();await expect(settings).toBeHidden();
    await sections.getByRole('button',{name:'Helper',exact:true}).click();
    await expect(name).toHaveValue('Claude Opus max');await expect(settings.getByRole('combobox',{name:'CLI',exact:true})).toHaveValue('claude');
    await expect(settings.getByLabel('Model',{exact:true})).toHaveValue('opus');await expect(settings.getByLabel('Reasoning effort')).toHaveValue('max');
    await create.click();await expect(settings.getByRole('status').filter({hasText:'Saved “Claude Opus max”'})).toBeVisible();
    await expect(names).toHaveText(['Helper','Claude Opus max']);await expect(names.nth(1)).toHaveAttribute('aria-pressed','true');
    const second=(await list()).find(p=>p.label==='Claude Opus max')!;
    expect([second.adapterHint,second.args]).toEqual(['claude',['--model','opus','--effort','max']]);
    // Chat offers both and still preselects the one named Helper.
    await parts.getByRole('button',{name:'Chat',exact:true}).click();
    const select=page.getByLabel('Helper launch profile');await expect(select).toHaveValue(first.id);
    await expect(select.locator('option')).toHaveText(['Choose a launch profile','Helper','Claude Opus max']);
    // Deleting asks first and removes only it.
    await parts.getByRole('button',{name:'Settings',exact:true}).click();await names.nth(1).click();
    let asked='';page.once('dialog',d=>{asked=d.message();void d.accept();});
    await settings.getByRole('button',{name:'Delete Helper profile'}).click();
    await expect(settings.getByRole('status').filter({hasText:'Deleted “Claude Opus max”'})).toBeVisible();
    expect(asked).toContain('A running Helper conversation keeps going');
    await expect(names).toHaveText(['Helper']);expect((await list()).some(p=>p.id===second.id)).toBe(false);
    await parts.getByRole('button',{name:'Chat',exact:true}).click();await expect(select.locator('option')).toHaveText(['Choose a launch profile','Helper']);
  } finally {
    for(const p of (await list()).filter(p=>p.label==='Helper'||p.label==='Claude Opus max'||p.id===agent.id))await request.delete(`/api/v1/launch-profiles/${p.id}`,{headers,data:{expectedRevision:p.revision}});
  }
});
test('launch status refresh shows checking, unchanged results, changes and failures beside the clicked agent',async({page,request},info)=>{
  const name=`inspect-${info.project.name}`;
  const project=await post(request,'projects',{path:`/demo/${name}`});
  const discovery=await (await request.get('/api/v1/workspaces',{headers})).json();
  const tree=discovery.projects.find((p:{id:string})=>p.id===project.id).worktrees[0];
  const profile=await post(request,'launch-profiles',{label:'Inspect fixture',executable:'codex',args:['--no-daemon'],adapterHint:'codex',enabled:true});
  const preview=await post(request,'launches/preview',{projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:2}]});
  const batch=await post(request,'launches',{requestId:preview.requestId,previewDigest:preview.digest,confirm:true});
  const [item,other]=batch.items;let inspections=0,release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/api/v1/launches',route=>route.fulfill({json:[batch]}));
  // Simulated inspection responses; the launch and project setup use the real mock API.
  await page.route(`**/api/v1/launches/${item.id}/inspect`,async route=>{
    inspections++;
    if(inspections===1)await gate;
    if(inspections===3)return route.fulfill({status:503,json:{error:{message:'Host inspection unavailable.'}}});
    if(inspections===2)Object.assign(item,{status:'exited',message:'The launched process has exited.'});
    await route.fulfill({json:item});
  });
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
    await page.getByRole('button',{name:`Project ${name}`,exact:true}).click();
    await expandAgents(page,name);
    const card=page.getByRole('group',{name:`Launch ${item.sessionName}`,exact:true});
    const sibling=page.getByRole('group',{name:`Launch ${other.sessionName}`,exact:true});
    const check=card.getByRole('button',{name:'Refresh launch status',exact:true});
    await expect(check).toBeVisible();
    const statuses=page.getByRole('region',{name:`Agent status in ${tree.path}`,exact:true});
    const statusBox=(await statuses.boundingBox())!;
    const controls=page.getByRole('button',{name:`Open ${name}`,exact:true});
    const controlsBox=(await controls.boundingBox())!;expect(controlsBox.y+controlsBox.height).toBeLessThanOrEqual(statusBox.y);
    const agents=page.getByRole('tab',{name:'Agents',exact:true}).filter({visible:true});
    const agentsBox=(await agents.boundingBox())!;expect(agentsBox.y+agentsBox.height).toBeLessThanOrEqual(statusBox.y);
    const checkBox=(await check.boundingBox())!,cleanupBox=(await card.getByRole('button',{name:'Clean up…',exact:true}).boundingBox())!;
    expect(Math.abs(checkBox.y+checkBox.height/2-cleanupBox.y-cleanupBox.height/2)).toBeLessThanOrEqual(1);
    expect(cleanupBox.x).toBeGreaterThanOrEqual(checkBox.x+checkBox.width);
    await card.scrollIntoViewIfNeeded();await check.click();await expect(card.getByRole('status')).toHaveText('Checking launch status…');
    await expect(card.getByRole('button',{name:'Checking…',exact:true})).toBeDisabled();await expect(sibling.getByRole('status')).toHaveCount(0);
    release();await expect(card.getByRole('status')).toContainText('running (unchanged)');
    await expect(card.getByRole('status')).toContainText('Checked at');await expect(card.getByRole('status')).toContainText(item.message);
    await expect(card.getByRole('status')).toBeInViewport();
    await page.screenshot({path:info.outputPath('launch-status-result.png'),fullPage:true});
    await check.click();await expect(card.getByRole('status')).toContainText('exited');await expect(card.getByRole('status')).toContainText('The launched process has exited.');
    await expect(card.locator('strong').first()).toContainText('last observed: exited');
    await check.click();await expect(card.getByRole('alert')).toContainText('Host inspection unavailable.');
    await expect(card.getByRole('status')).toHaveCount(0);await expect(sibling.getByRole('alert')).toHaveCount(0);expect(inspections).toBe(3);
    await check.click();await expect(card.getByRole('alert')).toHaveCount(0);await expect(card.getByRole('status')).toContainText('exited (unchanged)');
    // Inline renames propagate to the already-mounted launch card and its actions without changing membership or tmux identity.
    const before=await state(request),agent=before.sessions.find(s=>s.identity.paneId===item.identity.paneId)!;
    const group=before.groups.find(g=>g.repository===tree.path)!;
    await expandAgents(page,name);
    const label=`Renamed ${info.project.name}`;
    const nameInput=page.getByLabel(`Name for Codex ${item.identity.paneId}`,{exact:true});
    await nameInput.fill(label);await nameInput.press('Enter');
    const renamed=page.getByRole('group',{name:`Launch ${label}`,exact:true});
    await expect(renamed.locator('strong').first()).toHaveText(`${label} · last observed: exited`);
    await expect(renamed).toContainText(`tmux session: ${item.sessionName}`);
    await expect(page.getByLabel('Workspace group members')).toContainText(label);
    await renamed.getByRole('button',{name:'Refresh launch status',exact:true}).click();
    await expect(page.locator('.feedback[role="status"]:visible')).toContainText(`${label}: Checked at`);
    const after=await state(request);
    expect(after.sessions.find(s=>s.id===agent.id)).toEqual({...agent,label});
    expect(after.groups.find(g=>g.id===group.id)).toMatchObject({id:group.id,revision:group.revision,members:group.members});
    await expect(sibling.locator('strong').first()).toContainText(other.sessionName);
  } finally {release();}
});
for(const scenario of ['dead','missing','live','lost'] as const)test(`launch cleanup: ${scenario} session requires explicit acknowledgement and preserves other sessions`,async({page,request},info)=>{
  const name=`cleanup-${scenario}-${info.project.name}`;
  const project=await post(request,'projects',{path:`/demo/${name}`});
  const discovery=await (await request.get('/api/v1/workspaces',{headers})).json();
  const tree=discovery.projects.find((p:{id:string})=>p.id===project.id).worktrees[0];
  const profile=await post(request,'launch-profiles',{label:`Cleanup ${scenario}`,executable:'codex',args:['--no-daemon'],adapterHint:'codex',enabled:true});
  const launch=await post(request,'launches/preview',{projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:2}]});
  const batch=await post(request,'launches',{requestId:launch.requestId,previewDigest:launch.digest,confirm:true});
  const item=batch.items[0],other=batch.items[1];let confirms=0,inspections=0;
  const sessions=(await state(request)).sessions;
  const rename=async(paneId:string,label:string)=>{
    const session=sessions.find(s=>s.identity.paneId===paneId)!;
    const response=await request.patch(`/api/v1/sessions/${session.id}`,{headers,data:{label,expectedLabel:session.label,expectedRegistrationId:session.registrationId}});
    expect(response.ok(),await response.text()).toBe(true);return response.json();
  };
  const removed=await rename(item.identity.paneId,`Remove ${name}`),kept=await rename(other.identity.paneId,`Keep ${name}`);
  // Cleanup effects and their read model are fixtures here. Server regressions exercise the real
  // registration projection; native tests exercise actual removal on private tmux servers.
  await page.route('**/api/v1/state',async route=>{
    const response=await route.fetch(),body=await response.json() as WorkflowState;
    if(item.closed){body.sessions=body.sessions.filter(s=>s.id!==removed.id);body.groups=body.groups.map(g=>({...g,members:g.members.filter(id=>id!==removed.id)}));}
    await route.fulfill({response,json:body});
  });
  await page.route('**/api/v1/workspaces',async route=>{
    const response=await route.fetch(),body=await response.json();
    if(item.closed)for(const workspace of body.workspaces)workspace.agents=workspace.agents.filter((a:{identity:{paneId:string}})=>a.identity.paneId!==item.identity.paneId);
    await route.fulfill({response,json:body});
  });
  await page.route('**/api/v1/launches',route=>route.fulfill({json:[batch]}));
  await page.route(`**/api/v1/launches/${item.id}/cleanup/preview`,route=>route.fulfill({json:{requestId:crypto.randomUUID(),digest:'fixture',expiresAt:new Date(Date.now()+120000).toISOString(),launchId:item.id,sessionName:item.sessionName,state:scenario==='live'?'live':scenario==='missing'?'missing':'dead',blockers:[]}}));
  await page.route(`**/api/v1/launches/${item.id}/cleanup`,async route=>{
    confirms++;expect(route.request().postDataJSON()).toMatchObject({confirmInspected:true,digest:'fixture'});
    expect(route.request().postDataJSON().confirmStop).toBe(scenario==='live'?true:undefined);
    item.closed={cleanupId:route.request().postDataJSON().requestId,at:new Date().toISOString()};
    if(scenario==='lost')await route.abort('failed');else await route.fulfill({json:item});
  });
  await page.route(`**/api/v1/launches/${item.id}/inspect`,route=>{inspections++;return route.fulfill({json:item});});
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
  await page.getByRole('button',{name:`Project ${name}`,exact:true}).click();
  await expandAgents(page, name); await page.getByRole('button',{name:`Open ${name}`,exact:true}).click();
  const removedPane=page.locator(`article[aria-label="${removed.label} pane"]`),keptPane=page.locator(`article[aria-label="${kept.label} pane"]`);
  await expect(removedPane).toHaveCount(1);await expect(keptPane).toHaveCount(1);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:removed.label,exact:true}).click();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
  const card=page.getByRole('group',{name:`Launch ${removed.label}`,exact:true});
  await expect(card.locator('strong').first()).toHaveText(`${removed.label} · last observed: running`);
  await expect(card).toContainText(`tmux session: ${item.sessionName}`);
  await card.getByRole('button',{name:'Clean up…',exact:true}).click();
  const panel=card.getByRole('region',{name:`Clean up ${removed.label}`});
  const remove=panel.getByRole('button',{name:scenario==='live'?'Close agent':scenario==='missing'?'Remove launch card':'Remove dead session',exact:true});
  await expect(remove).toBeDisabled();expect(confirms).toBe(0);
  if(scenario==='live')await expect(panel).toContainText('interrupts any work');
  await panel.getByRole('button',{name:'Cancel cleanup'}).click();await expect(panel).toHaveCount(0);expect(confirms).toBe(0);
  await card.getByRole('button',{name:'Clean up…',exact:true}).click();
  await panel.getByRole('checkbox').check();await remove.click();
  if(scenario==='lost'){await expect(card).toContainText('response was lost');expect(confirms).toBe(1);await card.getByRole('button',{name:'Inspect cleanup result'}).click();expect(inspections).toBe(1);}
  await expect(card).toHaveCount(0);expect(confirms).toBe(1);
  await expect(page.getByRole('group',{name:`Launch ${kept.label}`,exact:true})).toBeVisible();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
  await expect(keptPane).toHaveCount(1);
  await expect(removedPane).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Agent identity changed'})).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:kept.label,exact:true})).toHaveAttribute('aria-pressed','true');
});

for(const delayed of ['response','writer frame'] as const)test(`the Terminal toggle waits for the ${delayed} before typing, then forwards Unicode once`,async({page,request})=>{
  let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),captured=new Promise<void>(r=>arrived=r);
  if(delayed==='response')await page.route('**/api/v1/terminals/*/keyboard',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});},{times:1});
  else await page.routeWebSocket('**/api/v1/terminals/socket',socket=>{const server=socket.connectToServer();server.onMessage(async message=>{const frame=JSON.parse(String(message));if(frame.type==='keyboard'&&frame.writer){arrived();await gate;}socket.send(message);});});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'project'});
    const terminal=page.getByRole('region',{name:'Codex terminal',exact:true});
    await terminal.getByRole('button',{name:'Terminal mode',exact:true}).click();await captured;
    // Keys before the writer is ready reach nothing: xterm stays read-only until both the response and the writer frame arrive.
    await terminal.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('z');
    expect((await state(request)).manualSessions![0]!.bytes).toBe(0);await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
    release();await expect(badge(terminal,'Typing enabled')).toBeVisible();
    await page.keyboard.insertText('é次');await expect.poll(async()=>(await state(request)).manualSessions![0]!.bytes).toBe(5);
  } finally {release();}
});
test('Display mode offers no paste or soft keys and admits nothing; in Terminal mode a soft key types',async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'project'});
  const terminal=page.getByRole('region',{name:'Codex terminal',exact:true});await expect(badge(terminal,'Observing')).toBeVisible();
  await expect(terminal.getByRole('button',{name:'Paste text',exact:true})).toHaveCount(0);await expect(terminal.getByRole('button',{name:'↑',exact:true})).toHaveCount(0);
  const textarea=terminal.locator('.xterm-helper-textarea');
  await textarea.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','first\nsecond');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await page.waitForTimeout(300);expect((await state(request)).manualSessions??[]).toEqual([]);
  await terminal.getByRole('button',{name:'Terminal mode',exact:true}).click();await expect(badge(terminal,'Typing enabled')).toBeVisible();
  await terminal.getByRole('button',{name:'↑',exact:true}).click();
  await expect.poll(async()=>(await state(request)).manualSessions![0]!.bytes).toBe(3);
});

test('with mouse reporting, a click in Display grants nothing and a click in Terminal mode is reported',async({page,request})=>{
  // Give the mock terminal a mouse-reporting application. Keep the real broker's
  // output-credit accounting exact after adding the fixture's application modes.
  await page.routeWebSocket('**/api/v1/terminals/socket',socket=>{
    const server=socket.connectToServer(),extra=new Map<string,number>();
    server.onMessage(message=>{const f=JSON.parse(String(message));
      if(f.type==='reset')extra.set(f.generation,0);
      if(f.type==='out'&&!extra.get(f.generation)){const bytes=Buffer.concat([Buffer.from(f.data,'base64'),Buffer.from('\x1b[?1000h\x1b[?1006h')]);extra.set(f.generation,bytes.length-f.bytes);f.bytes=bytes.length;f.data=bytes.toString('base64');}
      socket.send(JSON.stringify(f));
    });
    socket.onMessage(message=>{const f=JSON.parse(String(message));if(f.type==='processed')f.processedBytes-=extra.get(f.generation)??0;server.send(JSON.stringify(f));});
  });
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'project'});
  const card=page.getByRole('region',{name:'Codex terminal',exact:true}),surface=card.locator('.xterm-screen');
  await expect(badge(card,'Observing')).toBeVisible();await surface.click({position:{x:20,y:20}});await surface.click({position:{x:20,y:20}});
  await page.waitForTimeout(300);expect((await state(request)).manualSessions??[]).toEqual([]);
  const frames:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();frames.push(Buffer.from(b.data,'base64').toString());}});
  await card.getByRole('button',{name:'Terminal mode',exact:true}).click();await expect(badge(card,'Typing enabled')).toBeVisible();
  await surface.click({position:{x:20,y:20}});
  await expect.poll(()=>frames.join('')).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/);
});
