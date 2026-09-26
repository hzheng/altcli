import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { WorkflowState } from '../src/contracts/workflow';
import { expandWorktree } from './ui';
const headers={Authorization:`Bearer ${'a'.repeat(64)}`};
async function state(request:APIRequestContext):Promise<WorkflowState>{return (await request.get('/api/v1/state',{headers})).json();}
async function post(request:APIRequestContext,path:string,data:unknown){const r=await request.post(`/api/v1/${path}`,{headers,data});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function reconcileFixtureKeyboard(request:APIRequestContext) {
  for(const m of (await state(request)).manualSessions??[]) {
    if(m.live)await post(request,'terminals/revoke',{clientInstanceId:m.clientInstanceId});
    const fresh=(await state(request)).manualSessions?.find(x=>x.id===m.id);
    if(fresh)await post(request,'terminals/reconcile',{requestId:crypto.randomUUID(),manualSessionId:m.id,expectedRevision:fresh.revision,confirmReady:true});
  }
}
/** The one shared Keyboard selector: radios on wide screens, a single select on phones. Choosing only asks for confirmation. */
async function chooseKeyboard(page:Page,name:string) {
  const radios=page.getByRole('radiogroup',{name:'Keyboard input'}),select=page.getByRole('combobox',{name:'Keyboard input'});
  await expect(radios.or(select)).toBeVisible();
  if(await radios.isVisible())await radios.getByRole('radio',{name,exact:true}).click();else await select.selectOption({label:name});
}
async function takeKeyboard(page:Page,name='Codex') {await chooseKeyboard(page,name);await page.getByRole('region',{name:'Confirm keyboard'}).getByRole('button',{name:'Confirm keyboard'}).click();}
/** The selector's checked pane is always the server-confirmed writer of this browser. */
async function expectKeyboard(page:Page,name:string) {
  const radios=page.getByRole('radiogroup',{name:'Keyboard input'});
  if(await radios.isVisible())await expect(radios.getByRole('radio',{name,exact:true})).toBeChecked();
  else await expect(page.getByRole('combobox',{name:'Keyboard input'}).locator('option:checked')).toHaveText(name);
}
/** A terminal card's status badge: an emoji whose accessible name states the badge. */
const badge=(card:Locator,name:string)=>card.getByRole('img',{name,exact:true});
async function openKeyboard(page:Page) {
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await takeKeyboard(page);
  await expect(badge(card,'Keyboard here')).toBeVisible();await expectKeyboard(page,'Codex');return card;
}
test.beforeEach(async({request})=>{
  const s=await state(request);for(const r of s.runs.filter(r=>['running','waiting','paused'].includes(r.status)))await post(request,'runs',{runId:r.id,action:'takeover',confirmReady:true});
  await reconcileFixtureKeyboard(request);
  await post(request,'workspaces/reset',{repository:'/demo/project',confirmReady:true});await post(request,'sessions',{paneId:'%0',label:'Codex'});await post(request,'sessions',{paneId:'%1',label:'Claude'});
});
// Finish intercepted polling requests before Playwright closes the page, then clear keyboard records.
test.afterEach(async({page,request})=>{await page.unrouteAll({behavior:'wait'});await reconcileFixtureKeyboard(request);});
async function prepareKeyboardSend(page:Page,recipient='Codex') {
  await page.route('**/api/v1/workspaces',async route=>{
    const response=await route.fetch(),body=await response.json();
    for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,taskBase:workspace.git.head});
    await route.fulfill({response,json:body});
  });
  const terminal=await openKeyboard(page);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:recipient,exact:true}).click();
  const control=page.getByRole('region',{name:'Control',exact:true});
  const draft=control.getByLabel(`Instruction for ${recipient}`);
  await draft.fill('Implement the checked keyboard handoff.');
  await control.getByLabel('After send').selectOption('commit');
  await expect(control).toContainText(`releases the Codex keyboard, verifies settlement, then sends to ${recipient}`);
  await control.getByLabel('Ready for implementation').check();
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
  await expect(draft).toHaveValue('');
  await expect(badge(terminal,'Keyboard here')).toHaveCount(0);
  expect((await state(request)).manualSessions).toEqual([]);
});
test('Send & commit retains the draft and barrier when settlement fails',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  // Perform a real release but simulate a refused settlement; a successful HTTP response alone cannot authorize dispatch.
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{
    const body=route.request().postDataJSON();delete body.expectedRevision;delete body.handoffRequestId;body.action='release';
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
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
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
      await expect(page.getByRole('article',{name:'Codex pane',exact:true})).toContainText('New external work after settlement.');
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
    await terminal.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('x');await captured;
    // The admitted byte revises the manual-input record. Once the page observes it, the earlier Ready is revoked; confirming before
    // that observation would race the next state poll, which revokes a fresh confirmation too.
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(1);
    await expect(control.getByLabel('Ready for implementation')).not.toBeChecked();
    await page.getByRole('button',{name:'Recheck',exact:true}).first().click();
    await control.getByLabel('Ready for implementation').check();await send.click();
    await expect(control.getByRole('alert')).toContainText('Terminal input is still pending');
    expect((await state(request)).manualSessions?.[0]?.live).toBe(true);
    await expect(draft).toHaveValue('Implement the checked keyboard handoff.');expect(starts).toEqual([]);
  } finally {release();await done;}
});
test('Send & commit refuses native input arriving after confirmation even before polling sees it',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{
    const m=(await state(request)).manualSessions![0]!;
    // This frame was admitted after the readiness snapshot, before the checked release reached the server.
    await post(request,`terminals/${m.connectionId}/input`,{generation:m.generation,seq:1,encoding:'utf8',data:'x'});
    const response=await route.fetch();await route.fulfill({response});
  });
  await send.click();
  await expect(control.getByRole('alert')).toContainText('Manual input changed');
  await expect(draft).toHaveValue('Implement the checked keyboard handoff.');
  expect(starts).toEqual([]);expect((await state(request)).manualSessions?.[0]?.reconciliationRequired).toBe(true);
});
test('Send & commit never dispatches or retries an uncertain release response',async({page,request})=>{
  const {control,draft,send}=await prepareKeyboardSend(page);
  const starts:string[]=[];let releases=0;
  page.on('request',r=>{if(r.url().endsWith('/implementation'))starts.push(r.url());});
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{releases++;await route.fetch();await route.abort('failed');});
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
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    const control=other.getByRole('region',{name:'Control',exact:true});
    await control.getByLabel('Instruction for Codex').fill('Do not take another browser keyboard.');
    await control.getByLabel('After send').selectOption('commit');
    await expect(control.getByRole('button',{name:'Send & commit Codex',exact:true})).toBeDisabled();
    await expect(control.getByLabel('Ready for implementation')).toBeDisabled();
    await expect(control).toContainText('Release and reconcile it first');
  } finally {await other.close();}
});
test('copy mode keeps the native terminal mounted and its keyboard generation intact',async({page,request})=>{
  const card=await openKeyboard(page);
  const owner=((await state(request)).manualSessions??[])[0]!.generation;
  const closes:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/close$/.test(r.url()))closes.push(r.url());});
  let copyMode=true;
  // Only tmux's mode flag is simulated; terminal attachment and keyboard authority use the mock API.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%0'?{...p,inMode:copyMode}:p);
    await route.fulfill({response,json:body});
  });
  const pane=page.getByRole('article',{name:'Codex pane',exact:true});
  await expect(pane.getByText(/Tmux copy mode/)).toBeVisible();
  await expect(badge(card,'Keyboard here')).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]!.generation).toBe(owner);
  expect(closes).toEqual([]);
  copyMode=false;
  await expect(pane.getByText(/Tmux copy mode/)).toHaveCount(0);
  await expect(badge(card,'Keyboard here')).toBeVisible();
  expect(closes).toEqual([]);
});
test('a copy-mode peer stays visible and blocks automated input without discarding the draft',async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const draft=page.getByRole('textbox',{name:'Instruction for Codex',exact:true});
  await draft.fill('Keep this draft while the peer scrolls.');
  let copyMode=true;
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
    body.panes=body.panes.map((p:{identity:{paneId:string}})=>p.identity.paneId==='%1'?{...p,inMode:copyMode}:p);
    await route.fulfill({response,json:body});
  });
  const control=page.getByRole('region',{name:'Control',exact:true});
  await expect(control).toContainText('Tmux copy mode');
  await expect(control.getByRole('button',{name:/^Send /}).first()).toBeDisabled();
  // Selecting the peer shows its terminal and addresses it; returning to Codex restores Codex's draft.
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Claude',exact:true}).click();
  await expect(page.getByRole('region',{name:'Claude terminal',exact:true})).toBeVisible();
  await expect(control).toContainText('Tmux copy mode');
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
  await expect(page.getByRole('region',{name:'Control',exact:true})).toContainText('Tmux copy mode');
});
for(const phase of ['implementation','planning'] as const)for(const mode of ['inMode','synchronized'] as const)test(`${phase} readiness is revoked when ${mode} enters and clears between workspace polls`,async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const control=page.getByRole('region',{name:'Control',exact:true});
  if(phase==='planning') {
    await page.getByRole('group',{name:'Phase'}).getByRole('button',{name:'Plan',exact:true}).click();await page.getByLabel('Shared task brief').fill('Plan this task.');
  } else {
    await control.getByLabel('Instruction for Codex').fill('Keep readiness tied to pane state.');await control.getByLabel('After send').selectOption('nothing');
  }
  const ready=page.getByLabel(`Ready for ${phase}`);
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
test('native terminal opens only on click; keyboard, input, release and Lock retain explicit authority',async({page,request},info)=>{
  const bytes:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();bytes.push(Buffer.from(b.data,b.encoding==='binary'?'base64':'utf8').toString());}});
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});await expect(card).toBeVisible();
  expect((await state(request)).manualSessions).toEqual([]);
  await card.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(badge(card,'Observing')).toBeVisible();
  // Choosing a pane only asks; cancelling grants nothing.
  await chooseKeyboard(page,'Codex');await page.getByRole('region',{name:'Confirm keyboard'}).getByRole('button',{name:'Cancel',exact:true}).click();
  expect((await state(request)).manualSessions).toEqual([]);
  await takeKeyboard(page);
  await expect(badge(card,'Keyboard here')).toBeVisible();
  await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('é次');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(5);
  const ctrl=card.getByRole('button',{name:'Ctrl next key'}),alt=card.getByRole('button',{name:'Alt next key'});
  await ctrl.click();await expect(ctrl).toHaveAttribute('aria-pressed','true');await page.keyboard.insertText('c');await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await alt.click();await page.keyboard.insertText('x');await expect(alt).toHaveAttribute('aria-pressed','false');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(8);
  expect(bytes.join('')).toBe('é次\x03\x1bx');
  await ctrl.click();
  // Selecting another agent does not transfer the keyboard: the writer is chosen only in the Keyboard selector.
  // On a phone the Codex card is hidden meanwhile, so its state is checked after returning to it.
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Claude',exact:true}).click();
  expect(((await state(request)).manualSessions??[]).map(m=>m.target)).toEqual([expect.objectContaining({agentId:'codex'})]);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:'Codex',exact:true}).click();
  await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await expect(badge(card,'Keyboard here')).toBeVisible();
  await page.screenshot({path:info.outputPath('native-keyboard.png'),fullPage:true});
  await page.getByRole('button',{name:'Release and record settled…'}).click();await page.getByRole('region',{name:'Confirm settled release'}).getByRole('button',{name:'Confirm settled release'}).click();
  await expect.poll(async()=>(await state(request)).manualSessions?.length).toBe(0);
  await takeKeyboard(page);await expect(badge(card,'Keyboard here')).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();await expect(page.getByRole('button',{name:'Open console'})).toBeVisible();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.live).toBe(false);
  expect((await state(request)).manualSessions![0]!.reconciliationRequired).toBe(true);
  const m=(await state(request)).manualSessions![0]!;await post(request,'terminals/reconcile',{requestId:crypto.randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmReady:true});
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
  const trees=page.getByRole('region',{name:`Project worktrees native-${info.project.name}`});await expandWorktree(page,`native-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
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
  await expect(badge(card,'Keyboard here')).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.live).toBe(false);
  // Only the empty-agent display is simulated. The durable barrier and decision use the mock server API.
  await page.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,sessions:[]}});});
  await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const recovery=page.getByRole('region',{name:'Manual input reconciliation'});await expect(recovery).toBeVisible();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No eligible agents here yet'})).toBeVisible();
  await recovery.getByText('Record a human inspection decision…',{exact:true}).click();
  const confirm=recovery.getByRole('button',{name:'Record inspection and release server barrier'});
  await expect(confirm).toBeDisabled();
  await expect(recovery.getByRole('textbox')).toHaveCount(0);
  await recovery.getByRole('checkbox').check();await expect(confirm).toBeEnabled();
  await recovery.getByRole('checkbox').uncheck();await expect(confirm).toBeDisabled();
  await recovery.getByRole('checkbox').check();
  await page.screenshot({path:info.outputPath('manual-recovery.png'),fullPage:true});
  const decision=page.waitForResponse(r=>r.url().endsWith('/terminals/reconcile')&&r.request().method()==='POST');
  await confirm.click();
  const response=await decision;expect(response.ok()).toBe(true);
  expect((await response.json()).humanDecision.note).toBe('I inspected the host and acknowledge possible prior and background effects.');
  await expect.poll(async()=>(await state(request)).manualSessions?.length).toBe(0);
  await expect(recovery).toHaveCount(0);
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
    await expect(badge(card,'Keyboard here')).toBeVisible();
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('b');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(2);
    release();await done;
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('c');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(3);
    await expect(badge(card,'Keyboard here')).toBeVisible();
  } finally {release();await done;}
});

test('native paste warns before unbracketed multiline input; Ctrl+Shift+Escape leaves terminal focus without input',async({page,request})=>{
  const card=await openKeyboard(page),textarea=card.locator('.xterm-helper-textarea');
  const height=(await card.getByLabel('Codex native output').boundingBox())!.height;
  const owner=((await state(request)).manualSessions??[])[0]!.generation;
  await card.getByRole('button',{name:'Expand terminal',exact:true}).click();
  await expect.poll(async()=>(await card.getByLabel('Codex native output').boundingBox())!.height).toBeGreaterThan(height);
  await card.getByRole('button',{name:'Collapse terminal',exact:true}).click();
  expect(((await state(request)).manualSessions??[])[0]!.generation).toBe(owner);
  const paste=async(text:string)=>textarea.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
  await textarea.focus();
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('execute');await dialog.dismiss();});
  await paste('first\nsecond');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(0);
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('execute');await dialog.accept();});
  await paste('first\nsecond');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(12);
  await paste('x');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(13);
  await card.getByRole('button',{name:'Screen reader mode',exact:true}).click();await expect(card.locator('.xterm-accessibility')).toHaveCount(1);
  await textarea.focus();await page.keyboard.press('z');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(14);
  await card.getByRole('button',{name:'Screen reader mode',exact:true}).click();await expect(card.locator('.xterm-accessibility')).toHaveCount(0);
  await textarea.focus();await page.keyboard.insertText('🙂');await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(18);
  await expect(card.getByText(/Snapshot captured at/)).toHaveCount(0);
  await card.getByRole('button',{name:'Captured text',exact:true}).click();await expect(card.getByText(/Snapshot captured at/)).toBeVisible();
  await card.getByRole('button',{name:'Show terminal',exact:true}).click();
  await expect(card.getByRole('button',{name:'Focus AltCLI control'})).toHaveCount(0);
  await textarea.focus();await expect(card.getByRole('status')).toContainText('Ctrl+Shift+Esc: leave terminal focus');
  await page.keyboard.press('Control+Shift+Escape');await expect(page.getByRole('region',{name:'Control',exact:true})).toBeFocused();
  await page.getByRole('textbox',{name:'Instruction for Codex',exact:true}).fill('A control draft never becomes terminal input.');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(18);
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
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(2);
  } finally {release();await done;}
});

test('leaving the terminal finishes a partly sent paste but drops later unsent input',async({page,request})=>{
  const card=await openKeyboard(page),textarea=card.locator('.xterm-helper-textarea');
  const sent:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/input$/.test(r.url())){const b=r.postDataJSON();sent.push(Buffer.from(b.data,b.encoding==='binary'?'base64':'utf8').toString());}});
  let release!:()=>void,received!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),captured=new Promise<void>(r=>{received=r;}),done=new Promise<void>(r=>{finished=r;});
  await page.route('**/api/v1/terminals/*/input',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}finally{finished();}},{times:1});
  try {
    // One 10,000-byte paste event becomes three 4 KiB input frames; hold the first in flight while focus leaves.
    const text=`${'p'.repeat(9999)}!`;
    await textarea.focus();
    await textarea.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
    await captured;await page.keyboard.insertText('Z');
    await page.keyboard.press('Control+Shift+Escape');release();await done;
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(10000);
    await textarea.focus();await page.keyboard.insertText('Q');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(10001);
    expect(sent.join('')).toBe(`${text}Q`);
  } finally {release();await done;}
});

test('Paste text uses the current lease and refuses a delayed clipboard result after typing',async({page,request})=>{
  const card=await openKeyboard(page);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=> 'clipboard'}}));
  await card.getByRole('button',{name:'Paste text',exact:true}).click();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(9);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>new Promise<string>(resolve=>{Object.assign(window,{completeClipboard:()=>resolve('must not type')});})}}));
  await card.getByRole('button',{name:'Paste text',exact:true}).click();await expect(card.getByRole('button',{name:'Paste text',exact:true})).toHaveAttribute('aria-busy','true');
  await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('x');
  await page.evaluate(()=>(window as unknown as {completeClipboard:()=>void}).completeClipboard());
  await expect(card.getByRole('status')).toContainText('Clipboard text was not pasted');
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(10);
});

test('terminal badges distinguish another browser, another terminal, an unresolved record and a replaced CLI',async({page})=>{
  const card=await openKeyboard(page),view=page.getByRole('navigation',{name:'Agent'});
  await expect(card.getByRole('status')).toContainText(/\d+×\d+ window/);
  const other=await page.context().newPage();
  try {
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    const remote=other.getByRole('region',{name:'Codex terminal',exact:true});
    await remote.getByRole('button',{name:'Open terminal',exact:true}).click();
    await expect(badge(remote,'Controlled in another browser')).toBeVisible();
    await expect(other.getByRole('img',{name:'Keyboard held in another browser',exact:true})).toBeVisible();
    await view.getByRole('button',{name:'Claude',exact:true}).click();
    const sibling=page.getByRole('region',{name:'Claude terminal',exact:true});
    await sibling.getByRole('button',{name:'Open terminal',exact:true}).click();
    await expect(badge(sibling,'Keyboard in another terminal')).toBeVisible();
    await view.getByRole('button',{name:'Codex',exact:true}).click();
    await chooseKeyboard(page,'Nobody (observe only)');
    await expect(badge(remote,'Observing · manual input unresolved')).toBeVisible();
    // Only the CLI replacement is simulated; everything else uses the mock server API.
    await other.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
      await route.fulfill({response,json:{...body,instances:body.instances.map((i:{agentId:string})=>i.agentId==='codex'?{...i,status:'replaced'}:i)}});});
    await expect(badge(remote,'Manual CLI/shell')).toBeVisible();
    await other.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Settings',exact:true}).click();
    await other.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Host configuration',exact:true}).click();
    await expect(other.getByRole('cell',{name:'Keyboard scope',exact:true})).toBeVisible();
    await expect(other.getByRole('cell',{name:'Terminal limits',exact:true})).toBeVisible();
  } finally {await other.close();}
});

test('a keyboard granted after focus moved elsewhere reports readiness without stealing focus',async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await card.getByRole('button',{name:'Open terminal',exact:true}).click();
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/api/v1/terminals/*/keyboard',async route=>{await gate;await route.continue();},{times:1});
  try {
    await takeKeyboard(page);
    const draft=page.getByRole('textbox',{name:'Instruction for Codex',exact:true});await draft.focus();
    release();
    await expect(card.getByRole('status')).toContainText('Keyboard ready for Codex');
    await expect(badge(card,'Keyboard here')).toBeVisible();await expect(draft).toBeFocused();
  } finally {release();}
});

test('a native keyboard hold keeps the Plan brief editable but blocks Start Plan',async({page,request})=>{
  await openKeyboard(page);
  await page.getByRole('group',{name:'Phase'}).getByRole('button',{name:'Plan',exact:true}).click();
  const brief=page.getByLabel('Shared task brief');
  await expect(brief).toBeEditable();await brief.fill('Drafted while the keyboard is held.');
  await expect(brief).toHaveValue('Drafted while the keyboard is held.');
  await expect(page.getByRole('button',{name:'Start Plan',exact:true})).toBeDisabled();
  await expect(page.getByText('Manual terminal input holds dispatch across this server. Release and reconcile it first.').filter({visible:true}).first()).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(0);
});

test('the Keyboard selector moves the one writer between panes by one serialized transfer and can show an out-of-view writer',async({page,request})=>{
  const card=await openKeyboard(page);
  const decisions:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/keyboard$/.test(r.url()))decisions.push(r.postDataJSON().action);});
  await chooseKeyboard(page,'Claude');
  const confirm=page.getByRole('region',{name:'Confirm keyboard'});
  await expect(confirm).toContainText('Move the keyboard from Codex to Claude');
  await confirm.getByRole('button',{name:'Confirm keyboard'}).click();
  await expect.poll(async()=>{const live=((await state(request)).manualSessions??[]).find(m=>m.live);return live&&'agentId' in live.target?live.target.agentId:null;}).toBe('claude');
  await expectKeyboard(page,'Claude');
  expect(decisions,'a transfer is one broker decision, never release-then-acquire').toEqual(['acquire']);
  await expect(badge(card,'Keyboard in another terminal')).toBeVisible();
  // On a phone only one pane shows: the selector offers to show the writer without changing authority.
  const show=page.getByRole('button',{name:'Show Claude',exact:true});
  if(await show.isVisible()){await show.click();await expect(badge(page.getByRole('region',{name:'Claude terminal',exact:true}),'Keyboard here')).toBeVisible();}
  await chooseKeyboard(page,'Nobody (observe only)');
  await expect.poll(async()=>((await state(request)).manualSessions??[]).some(m=>m.live)).toBe(false);
  await expectKeyboard(page,'Nobody (observe only)').catch(()=>{}); // an unresolved record may keep the selector on its status
  expect(decisions).toEqual(['acquire','release']);
});
test('cancelling a keyboard request while its terminal is still connecting requests nothing',async({page,request})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const decisions:string[]=[];page.on('request',r=>{if(/\/terminals\/[^/]+\/keyboard$/.test(r.url()))decisions.push(r.url());});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  await page.route('**/api/v1/terminals',async route=>{await gate;await route.continue();},{times:1});
  try {
    await takeKeyboard(page);
    await page.getByRole('button',{name:'Cancel keyboard request',exact:true}).click();
    release();
    await expect(badge(page.getByRole('region',{name:'Codex terminal',exact:true}),'Observing')).toBeVisible();
    await expect(page.getByText(/Nothing was requested/).first()).toBeVisible();
    expect(decisions).toEqual([]);expect((await state(request)).manualSessions).toEqual([]);
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
    const trees=page.getByRole('region',{name:`Project worktrees nodaemon-${info.project.name}`});await expandWorktree(page,`nodaemon-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
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
    const trees=page.getByRole('region',{name:`Project worktrees codex-shell-${info.project.name}`});await expandWorktree(page,`codex-shell-${info.project.name}`);await trees.getByRole('button',{name:'Launch agents…'}).click();
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
    await expandWorktree(page,name);
    const card=page.getByRole('group',{name:`Launch ${item.sessionName}`,exact:true});
    const sibling=page.getByRole('group',{name:`Launch ${other.sessionName}`,exact:true});
    const check=card.getByRole('button',{name:'Refresh launch status',exact:true});
    await expect(check).toBeVisible();
    const checkBox=(await check.boundingBox())!,cleanupBox=(await card.getByRole('button',{name:'Clean up…',exact:true}).boundingBox())!;
    expect(Math.abs(checkBox.y+checkBox.height/2-cleanupBox.y-cleanupBox.height/2)).toBeLessThanOrEqual(1);
    expect(cleanupBox.x).toBeGreaterThanOrEqual(checkBox.x+checkBox.width);
    await check.click();await expect(card.getByRole('status')).toHaveText('Checking launch status…');
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
  await page.route(`**/api/v1/launches/${item.id}/cleanup/preview`,route=>route.fulfill({json:{requestId:crypto.randomUUID(),digest:'fixture',expiresAt:new Date(Date.now()+120000).toISOString(),launchId:item.id,sessionName:item.sessionName,state:scenario==='live'?'blocked':scenario==='missing'?'missing':'dead',blockers:scenario==='live'?['This session is still running. Cleanup cannot stop a live session.']:[]}}));
  await page.route(`**/api/v1/launches/${item.id}/cleanup`,async route=>{
    confirms++;expect(route.request().postDataJSON()).toMatchObject({confirmInspected:true,digest:'fixture'});
    item.closed={cleanupId:route.request().postDataJSON().requestId,at:new Date().toISOString()};
    if(scenario==='lost')await route.abort('failed');else await route.fulfill({json:item});
  });
  await page.route(`**/api/v1/launches/${item.id}/inspect`,route=>{inspections++;return route.fulfill({json:item});});
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
  await page.getByRole('button',{name:`Project ${name}`,exact:true}).click();
  await expandWorktree(page, name); await page.getByRole('button',{name:`Open ${name}`,exact:true}).click();
  const removedPane=page.locator(`article[aria-label="${removed.label} pane"]`),keptPane=page.locator(`article[aria-label="${kept.label} pane"]`);
  await expect(removedPane).toHaveCount(1);await expect(keptPane).toHaveCount(1);
  await page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:removed.label,exact:true}).click();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
  const card=page.getByRole('group',{name:`Launch ${item.sessionName}`,exact:true});
  await card.getByRole('button',{name:'Clean up…',exact:true}).click();
  const panel=card.getByRole('region',{name:`Clean up ${item.sessionName}`});
  const remove=panel.getByRole('button',{name:scenario==='missing'?'Remove launch card':'Remove dead session',exact:true});
  await expect(remove).toBeDisabled();expect(confirms).toBe(0);
  if(scenario==='live') {await expect(panel).toContainText('still running');await expect(panel.getByRole('checkbox')).toHaveCount(0);}
  else {
    await panel.getByRole('button',{name:'Cancel cleanup'}).click();await expect(panel).toHaveCount(0);expect(confirms).toBe(0);
    await card.getByRole('button',{name:'Clean up…',exact:true}).click();
    await panel.getByRole('checkbox').check();await remove.click();
    if(scenario==='lost'){await expect(card).toContainText('response was lost');expect(confirms).toBe(1);await card.getByRole('button',{name:'Inspect cleanup result'}).click();expect(inspections).toBe(1);}
    await expect(card).toHaveCount(0);expect(confirms).toBe(1);
  }
  await expect(page.getByRole('group',{name:`Launch ${other.sessionName}`,exact:true})).toBeVisible();
  await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
  await expect(keptPane).toHaveCount(1);
  await expect(removedPane).toHaveCount(scenario==='live'?1:0);
  await expect(page.getByRole('region',{name:'Agent identity changed'})).toHaveCount(0);
  if(scenario!=='live')await expect(page.getByRole('navigation',{name:'Agent'}).getByRole('button',{name:kept.label,exact:true})).toHaveAttribute('aria-pressed','true');
});
