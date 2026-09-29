import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { WorkflowState } from '../src/contracts/workflow';
import { backToControl, expandAgents, openAccess, openCard, pane, readiness, showSurface } from './ui';
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
/** Direct input admits the exact terminal; selecting it still grants nothing. */
async function chooseKeyboard(page:Page,name:string) {
  if(name==='Nobody (observe only)') {await (await openAccess(page)).getByRole('button',{name:'Stop typing here',exact:true}).click();return;}
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name,exact:true}).click();await showSurface(page,'Terminal');
  const entry=page.getByRole('region',{name:`${name} terminal`,exact:true}).getByRole('textbox',{name:`${name} terminal input`,exact:true});
  await expect(entry).toBeEnabled();await entry.press('ArrowRight');
}
async function takeKeyboard(page:Page,name='Codex') {await chooseKeyboard(page,name);await expect(badge(page.getByRole('region',{name:`${name} terminal`,exact:true}),'Typing enabled')).toBeVisible();}
async function expectKeyboard(page:Page,_name:string) {
  await expect(page.locator('.page-heading').getByRole('img',{name:'Input: 1 active · automation held',exact:true})).toBeVisible();
}
/** A terminal card's status badge: an emoji whose accessible name states the badge. */
const badge=(card:Locator,name:string)=>card.getByRole('img',{name,exact:true});
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
test('terminal status is informational and first input enables a writer without a claim',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const status=page.locator('.page-heading').getByRole('img',{name:'Input: 0 active',exact:true});
  await expect(status).toBeVisible();await status.click();expect((await state(request)).manualSessions??[]).toHaveLength(0);
  const terminal=page.getByRole('region',{name:'Codex terminal',exact:true});
  const entry=terminal.getByRole('textbox',{name:'Codex terminal input',exact:true});
  await expect(entry).toBeEnabled();await entry.focus();expect((await state(request)).manualSessions??[]).toHaveLength(0);
  await expect(page.getByRole('button',{name:'Claim keyboard',exact:true})).toHaveCount(0);
  await entry.press('x');await expect(badge(terminal,'Typing enabled')).toBeVisible();
  await expectKeyboard(page,'Codex');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.bytes).toBe(1);
  const access=await openAccess(page);await expect(access).toContainText('1 active input connection');
  await page.screenshot({path:info.outputPath('direct-terminal-input.png'),fullPage:true});
});
test('text typed in the entry once admitted is the same writer’s input, never a second admission',async({page,request})=>{
  const terminal=await openKeyboard(page),entry=terminal.getByRole('textbox',{name:'Codex terminal input',exact:true,includeHidden:true});
  await expect(entry).toBeHidden();
  const before=(await state(request)).manualSessions![0]!.bytes;
  // Focus leaves the entry only after the writer render hides it; reproduce typing in that window.
  await entry.evaluate(element=>{(element as HTMLTextAreaElement).hidden=false;});await entry.focus();await page.keyboard.type('yz');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.bytes).toBe(before+2);
  await expect(badge(terminal,'Typing enabled')).toBeVisible();
  const manual=(await state(request)).manualSessions![0]!;
  expect(manual.writers.filter(w=>w.live)).toHaveLength(1);expect(manual.recoveryRequired).toBe(false);
});
async function prepareKeyboardSend(page:Page,recipient='Codex') {
  await page.route('**/api/v1/workspaces',async route=>{
    const response=await route.fetch(),body=await response.json();
    for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,stageRelay:{eligible:false,reason:'A task branch uses committed handoffs.'},taskBase:workspace.git.head});
    await route.fulfill({response,json:body});
  });
  const terminal=await openKeyboard(page);
  // Control replaces the terminals in the frame; the writer's terminal stays mounted and connected for the handoff.
  await openCard(page,recipient);
  const control=page.getByRole('region',{name:'Control',exact:true});
  const draft=control.getByLabel(`Instruction for ${recipient}`);
  await draft.fill('Implement the checked keyboard handoff.');
  await control.getByRole('region',{name:`Actions for ${recipient}`,exact:true}).getByLabel('After send').selectOption('commit');
  await expect(await openAccess(page)).toContainText(`releases the Codex keyboard, verifies settlement, then sends to ${recipient}`);
  await (await readiness(page)).check();
  const send=control.getByRole('button',{name:`Send & commit ${recipient}`,exact:true});
  await expect(send).toBeEnabled();
  return {terminal,control,draft,send};
}
test('Send & commit hands this browser keyboard to a different control recipient exactly once',async({page,request})=>{
  const {terminal,draft,send}=await prepareKeyboardSend(page,'Claude');
  const starts:unknown[]=[];
  await page.route('**/api/v1/implementation',async route=>{
    expect((await state(request)).manualSessions).toEqual([]);
    starts.push(route.request().postDataJSON());await route.fulfill({json:{status:'delivered',error:null}});
  });
  await send.click();
  await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({agentId:'claude',kind:'work',text:'Implement the checked keyboard handoff.',keyboardSettlement:{manualSessionId:expect.any(String),revision:expect.any(Number)}});
  await backToControl(page);await expect(draft).toHaveValue('');
  await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
  expect((await state(request)).manualSessions).toEqual([]);
});
test('Send & commit retains the draft and barrier when settlement fails',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  // Perform a real release but simulate a refused settlement; a successful HTTP response alone cannot authorize dispatch.
  await page.route('**/api/v1/terminals/stop',async route=>{
    const body=route.request().postDataJSON();delete body.handoffRequestId;delete body.confirmReady;
    const response=await route.fetch({postData:body}),result=await response.json();
    await route.fulfill({response,json:{...result,reason:'Released; barrier retained. Agent is still working.'}});
  });
  await send.click();
  await expect(control.getByRole('alert')).toContainText('Agent is still working');
  await expect(draft).toHaveValue('Implement the checked keyboard handoff.');
  expect(starts).toEqual([]);
  expect((await state(request)).manualSessions?.[0]?.reconciliationRequired).toBe(true);
});
for(const change of ['draft','restored draft','target','view','activity'] as const)test(`Send & commit cancels dispatch when the ${change} changes during release`,async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/stop',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
  try {
    await send.click();await captured;
    if(change==='draft'||change==='restored draft') {
      await draft.fill('A newer draft must survive.');
      if(change==='restored draft')await draft.fill('Implement the checked keyboard handoff.');
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
    await expect(draft).toHaveValue(change==='draft'?'A newer draft must survive.':'Implement the checked keyboard handoff.');
    expect(starts).toEqual([]);expect((await state(request)).manualSessions).toEqual([]);
  } finally {release();await done;}
});
test('Send & commit refuses pending native input without releasing or dispatching',async({page,request})=>{
  const {terminal,control,draft,send}=await prepareKeyboardSend(page);
  let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/*/input',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
  try {
    // Typing needs the terminal shown; Control and the terminals share one frame, and switching revokes the earlier Ready.
    await showSurface(page,'Terminal');
    await terminal.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('x');await captured;
    // The admitted byte revises the manual-input record. Once the page observes it, confirming again is safe; confirming before
    // that observation would race the next state poll, which revokes a fresh confirmation too.
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(4);
    await openCard(page,'Codex');await expect((await readiness(page))).not.toBeChecked();
    await page.getByRole('button',{name:'Recheck',exact:true}).first().click();
    await (await readiness(page)).check();await send.click();
    await expect(control.getByRole('alert')).toContainText('Input is still being sent in Codex');
    expect((await state(request)).manualSessions?.[0]?.live).toBe(true);
    await expect(draft).toHaveValue('Implement the checked keyboard handoff.');expect(starts).toEqual([]);
  } finally {release();await done;}
});
test('Send & commit refuses native input arriving after confirmation even before polling sees it',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/stop',async route=>{
    const m=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
    // This frame was admitted after the readiness snapshot, before the checked release reached the server.
    await post(request,`terminals/${m.connectionId}/input`,{generation:m.generation,seq:2,encoding:'utf8',data:'x'});
    const response=await route.fetch();await route.fulfill({response});
  });
  await send.click();
  await expect(control.getByRole('alert')).toContainText('writer set or input changed');
  await expect(draft).toHaveValue('Implement the checked keyboard handoff.');
  expect(starts).toEqual([]);expect((await state(request)).manualSessions?.[0]?.reconciliationRequired).toBe(true);
});
test('Send & commit never dispatches or retries an uncertain release response',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];let releases=0;
  page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/stop',async route=>{releases++;await route.fetch();await route.abort('failed');});
  await send.click();
  await expect(control.getByRole('alert')).toBeVisible();
  await expect(draft).toHaveValue('Implement the checked keyboard handoff.');
  await expect(page.getByRole('button',{name:'Recheck',exact:true}).first()).toBeEnabled();
  expect(starts).toEqual([]);expect(releases).toBe(1);expect((await state(request)).manualSessions).toEqual([]);
});
test('another browser keyboard still blocks Send & commit',async({page})=>{
  await prepareKeyboardSend(page);
  const other=await page.context().newPage();
  try {
    await other.route('**/api/v1/workspaces',async route=>{
      const response=await route.fetch(),body=await response.json();
      for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,stageRelay:{eligible:false,reason:'A task branch uses committed handoffs.'},taskBase:workspace.git.head});
      await route.fulfill({response,json:body});
    });
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    await openCard(other,'Codex');const control=other.getByRole('region',{name:'Control',exact:true});
    await control.getByLabel('Instruction for Codex').fill('Do not take another browser keyboard.');
    await control.getByRole('region',{name:'Actions for Codex',exact:true}).getByLabel('After send').selectOption('commit');
    await expect(control.getByRole('button',{name:'Send & commit Codex',exact:true})).toBeDisabled();
    await expect(control.getByRole('region',{name:'Actions for Codex',exact:true}).getByRole('status')).toContainText('Send & commit Codex is disabled. Manual terminal input holds dispatch across this server. Release and reconcile it in Control access first.');
    await expect((await readiness(other))).toBeDisabled();
    await expect(control).toContainText('Release and reconcile it in Control access first');
  } finally {await other.close();}
});
test('Stage relay after Send keeps the native keyboard barrier and requires explicit release',async({page,request})=>{
  const terminal=await openKeyboard(page);
  const codex=await openCard(page,'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Stage the reviewed changes on main.');
  await codex.getByLabel('After send').selectOption('stage_relay');
  const send=codex.getByRole('button',{name:'Send Codex & stage-relay to Claude',exact:true});
  await expect(send).toBeDisabled();
  await expect(codex.getByRole('status')).toContainText('Release and reconcile it in Control access first');
  const ready=await readiness(page);await expect(ready).toBeDisabled();
  await expect((await openAccess(page)).getByRole('group',{name:'Readiness for Codex'})).not.toContainText('This action releases');
  await showSurface(page,'Terminal');await expect(badge(terminal,'Typing enabled')).toBeVisible();
  expect((await state(request)).manualSessions?.[0]?.live).toBe(true);
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
  await expect(badge(card,'Typing enabled')).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]!.writers.find(w=>w.live)!.generation).toBe(owner);
  expect(closes).toEqual([]);
  copyMode=false;
  await expect(pane.getByText(/Tmux copy mode/)).toHaveCount(0);
  await expect(badge(card,'Typing enabled')).toBeVisible();
  expect(closes).toEqual([]);
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
  const entry=card.getByRole('textbox',{name:'Codex terminal input',exact:true});await entry.focus();
  expect((await state(request)).manualSessions).toEqual([]);
  await page.keyboard.insertText('é次');await expect(badge(card,'Typing enabled')).toBeVisible();
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
  await expect(page.getByRole('button',{name:'Control access · you',exact:true})).toBeVisible();
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
for(const failed of [false,true])test(`a delayed ${failed?'failed':'successful'} input response cannot stall or revoke a newer keyboard generation`,async({page,request})=>{
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
    await chooseKeyboard(page,'Nobody (observe only)');
    await expect(page.getByRole('region',{name:'Confirm keyboard'})).toHaveCount(0);
    await takeKeyboard(page);
    await expect(badge(card,'Typing enabled')).toBeVisible();
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

test('moving focus while admission is pending discards unsent input without stealing focus',async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>entered=r);
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{entered();await gate;await route.continue();},{times:1});
  try {
    await chooseKeyboard(page,'Codex');await received;
    const elsewhere=page.getByRole('button',{name:'Recheck',exact:true});await elsewhere.focus();release();
    await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.live).toBe(false);
    expect((await state(request)).manualSessions![0]!.bytes).toBe(0);await expect(elsewhere).toBeFocused();
    await expect(badge(card,'Typing enabled')).toHaveCount(0);
  } finally {release();}
});

test('a native keyboard hold keeps the Plan brief editable but blocks Start Plan',async({page,request})=>{
  await openKeyboard(page);
  await page.getByRole('group',{name:'Phase'}).getByRole('button',{name:'Plan',exact:true}).click();
  const brief=page.getByLabel('Shared task brief');
  await expect(brief).toBeEditable();await brief.fill('Drafted while the keyboard is held.');
  await expect(brief).toHaveValue('Drafted while the keyboard is held.');
  await expect(page.getByRole('button',{name:'Start Plan',exact:true})).toBeDisabled();
  await expect(page.getByText('Manual terminal input holds dispatch across this server. Release and reconcile it in Control access first.').filter({visible:true}).first()).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(3);
});

test('local terminals retain independent writers and one batch stop ends exactly this browser set',async({page,request})=>{
  const card=await openKeyboard(page),original=(await state(request)).manualSessions![0]!.writers.find(w=>w.live)!;
  await takeKeyboard(page,'Claude');
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.writers.filter(w=>w.live).length).toBe(2);
  expect((await state(request)).manualSessions![0]!.writers.find(w=>w.connectionId===original.connectionId)!.generation).toBe(original.generation);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Codex',exact:true}).click();await expect(badge(card,'Typing enabled')).toBeVisible();
  await showSurface(page,'Control');const access=await openAccess(page);
  await access.getByRole('button',{name:'Show Claude',exact:true}).click();
  await expect(badge(page.getByRole('region',{name:'Claude terminal',exact:true}),'Typing enabled')).toBeVisible();
  await access.getByRole('button',{name:'Stop typing in this browser',exact:true}).click();
  await expect.poll(async()=>(await state(request)).manualSessions?.[0]?.live).toBe(false);
  expect((await state(request)).manualSessions![0]!.reconciliationRequired).toBe(true);
});

test('a terminal still connecting accepts no input and creates no authority',async({page,request})=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  await page.route('**/api/v1/terminals',async route=>{await gate;await route.continue();});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    const entry=page.getByRole('textbox',{name:'Codex terminal input',exact:true});await expect(entry).toBeDisabled();
    expect((await state(request)).manualSessions??[]).toEqual([]);release();await expect(entry).toBeEnabled();
    expect((await state(request)).manualSessions??[]).toEqual([]);
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

for(const delayed of ['response','writer frame'] as const)test(`first input waits for the ${delayed} and forwards Unicode once`,async({page,request})=>{
  let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),captured=new Promise<void>(r=>arrived=r);
  if(delayed==='response')await page.route('**/api/v1/terminals/*/keyboard',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});},{times:1});
  else await page.routeWebSocket('**/api/v1/terminals/socket',socket=>{const server=socket.connectToServer();server.onMessage(async message=>{const frame=JSON.parse(String(message));if(frame.type==='keyboard'&&frame.writer){arrived();await gate;}socket.send(message);});});
  try {
    await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'project'});
    const terminal=page.getByRole('region',{name:'Codex terminal',exact:true}),entry=terminal.getByRole('textbox',{name:'Codex terminal input',exact:true});
    await expect(entry).toBeEnabled();await entry.focus();await page.keyboard.insertText('é');await captured;await page.keyboard.insertText('次');
    expect((await state(request)).manualSessions![0]!.bytes).toBe(0);await expect(badge(terminal,'Typing enabled')).toHaveCount(0);
    release();await expect.poll(async()=>(await state(request)).manualSessions![0]!.bytes).toBe(5);await expect(badge(terminal,'Typing enabled')).toBeVisible();
  } finally {release();}
});
test('cancelled first multiline paste creates no manual period; a soft key admits direct input',async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
    await page.getByRole('combobox',{name:'Switch project'}).selectOption({label:'project'});
  const terminal=page.getByRole('region',{name:'Codex terminal',exact:true});await expect(terminal.getByRole('textbox',{name:'Codex terminal input',exact:true})).toBeEnabled();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=> 'first\nsecond'}}));
  page.once('dialog',dialog=>dialog.dismiss());await terminal.getByRole('button',{name:'Paste text',exact:true}).click();
  expect((await state(request)).manualSessions??[]).toEqual([]);await terminal.getByRole('button',{name:'↑',exact:true}).click();
  await expect.poll(async()=>(await state(request)).manualSessions![0]!.bytes).toBe(3);await expect(badge(terminal,'Typing enabled')).toBeVisible();
});

test('mouse reporting admits an intentional protocol click, while its focus-only click grants nothing',async({page,request})=>{
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
  const card=page.getByRole('region',{name:'Codex terminal',exact:true}),entry=card.getByRole('textbox',{name:'Codex terminal input',exact:true}),surface=card.locator('.xterm-screen');
  await expect(entry).toBeEnabled();await surface.click({position:{x:20,y:20}});await expect(entry).toBeFocused();
  expect((await state(request)).manualSessions??[]).toEqual([]);
  const frames:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();frames.push(Buffer.from(b.data,'base64').toString());}});
  await surface.click({position:{x:20,y:20}});await expect(badge(card,'Typing enabled')).toBeVisible();
  await expect.poll(()=>frames.join('')).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/);
});
