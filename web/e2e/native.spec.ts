import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WorkflowState } from '../src/contracts/workflow';
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
async function openKeyboard(page:Page) {
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await card.getByRole('button',{name:'Open terminal',exact:true}).click();await card.getByRole('button',{name:'Take keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();return card;
}
test.beforeEach(async({request})=>{
  const s=await state(request);for(const r of s.runs.filter(r=>['running','waiting','paused'].includes(r.status)))await post(request,'runs',{runId:r.id,action:'takeover',confirmReady:true});
  await reconcileFixtureKeyboard(request);
  await post(request,'workspaces/reset',{repository:'/demo/project',confirmReady:true});await post(request,'sessions',{paneId:'%0',label:'Codex'});await post(request,'sessions',{paneId:'%1',label:'Claude'});
});
test.afterEach(async({request})=>{await reconcileFixtureKeyboard(request);});
async function prepareKeyboardSend(page:Page,recipient='Codex') {
  await page.route('**/api/v1/workspaces',async route=>{
    const response=await route.fetch(),body=await response.json();
    for(const workspace of body.workspaces)Object.assign(workspace.git,{branch:'task/current',integration:false,taskBase:workspace.git.head});
    await route.fulfill({response,json:body});
  });
  const terminal=await openKeyboard(page);
  await page.getByRole('navigation',{name:'Command target'}).getByRole('button',{name:recipient,exact:true}).click();
  const control=page.getByRole('region',{name:'AltCLI control',exact:true});
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
  await expect(terminal.getByText('Keyboard here',{exact:true})).toHaveCount(0);
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
    } else if(change==='target')await page.getByRole('navigation',{name:'Command target'}).getByRole('button',{name:'Claude',exact:true}).click();
    else await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Projects',exact:true}).click();
    release();await done;
    if(change==='view')await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Console',exact:true}).click();
    await expect(page.getByRole('button',{name:'Recheck',exact:true}).first()).toBeEnabled();
    if(change!=='target')await expect(control.getByRole('alert')).toContainText('nothing was sent');
    else await page.getByRole('navigation',{name:'Command target'}).getByRole('button',{name:'Codex',exact:true}).click();
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
    const control=other.getByRole('region',{name:'AltCLI control',exact:true});
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
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]!.generation).toBe(owner);
  expect(closes).toEqual([]);
  copyMode=false;
  await expect(pane.getByText(/Tmux copy mode/)).toHaveCount(0);
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
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
  const control=page.getByRole('region',{name:'AltCLI control',exact:true});
  await expect(control).toContainText('Tmux copy mode');
  await expect(control.getByRole('button',{name:/^Send /}).first()).toBeDisabled();
  await page.getByRole('navigation',{name:'Viewed terminal'}).getByRole('button',{name:'Claude',exact:true}).click();
  await expect(page.getByRole('region',{name:'Claude terminal',exact:true})).toBeVisible();
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
  await expect(page.getByRole('region',{name:'AltCLI control',exact:true})).toContainText('Tmux copy mode');
});
for(const phase of ['implementation','planning'] as const)for(const mode of ['inMode','synchronized'] as const)test(`${phase} readiness is revoked when ${mode} enters and clears between workspace polls`,async({page})=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const control=page.getByRole('region',{name:'AltCLI control',exact:true});
  if(phase==='planning') {
    await page.getByRole('button',{name:'1 · Plan',exact:true}).click();await page.getByLabel('Shared task brief').fill('Plan this task.');
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
  await card.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(card.getByRole('button',{name:'Take keyboard…'})).toBeEnabled();
  await card.getByRole('button',{name:'Take keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
  await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('é次');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(5);
  const ctrl=card.getByRole('button',{name:'Ctrl next key'}),alt=card.getByRole('button',{name:'Alt next key'});
  await ctrl.click();await expect(ctrl).toHaveAttribute('aria-pressed','true');await page.keyboard.insertText('c');await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await alt.click();await page.keyboard.insertText('x');await expect(alt).toHaveAttribute('aria-pressed','false');
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(8);
  expect(bytes.join('')).toBe('é次\x03\x1bx');
  await ctrl.click();
  // Recipient selection does not transfer the keyboard or change which terminal is being observed.
  await page.getByRole('navigation',{name:'Command target'}).getByRole('button',{name:'Claude',exact:true}).click();
  await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('native-keyboard.png'),fullPage:true});
  await card.getByRole('button',{name:'Release and record settled…'}).click();await card.getByRole('button',{name:'Confirm settled release'}).click();
  await expect.poll(async()=>(await state(request)).manualSessions?.length).toBe(0);
  await card.getByRole('button',{name:'Take keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Lock',exact:true}).click();await expect(page.getByRole('button',{name:'Open console'})).toBeVisible();
  await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.live).toBe(false);
  expect((await state(request)).manualSessions![0]!.reconciliationRequired).toBe(true);
  const m=(await state(request)).manualSessions![0]!;await post(request,'terminals/reconcile',{requestId:crypto.randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmReady:true});
});
test('repository entry, literal profile editor, preview and explicit duplicate-profile launch use the real mock API',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const sections=page.getByRole('navigation',{name:'Sections'});await sections.getByRole('button',{name:'Settings',exact:true}).click();
  const profiles=page.getByRole('region',{name:'Launch profiles'});await profiles.getByRole('button',{name:'Use codex preset'}).click();
  const label=`Fixture ${info.project.name}`;await profiles.getByLabel('Profile label',{exact:true}).fill(label);await profiles.getByRole('button',{name:'Add argument',exact:true}).click();await profiles.getByLabel('Argument 1',{exact:true}).fill('literal ;');await profiles.getByRole('button',{name:'Save profile'}).click();
  await expect(profiles.getByRole('button',{name:`${label} · revision 1`})).toBeVisible();
  await profiles.getByRole('button',{name:`${label} · revision 1`}).click();await profiles.getByRole('button',{name:'Save profile'}).click();
  await expect(profiles.getByRole('button',{name:`${label} · revision 2`})).toBeVisible();
  await sections.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Repository directory').fill(`/demo/native-${info.project.name}`);await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:`Project native-${info.project.name}`,exact:true}).click();
  const trees=page.getByRole('region',{name:`Project worktrees native-${info.project.name}`});await trees.getByRole('button',{name:'Launch agents…'}).click();
  await trees.getByRole('button',{name:'Add launch row'}).click();const saved=await (await request.get('/api/v1/launch-profiles',{headers})).json();const profile=saved.find((p:{label:string})=>p.label===label);
  await trees.getByLabel('Launch profile 1').selectOption(profile.id);await trees.getByLabel('Count',{exact:true}).fill('2');await trees.getByRole('button',{name:'Preview launch'}).click();
  await expect(trees.getByRole('table')).toContainText('literal ;');
  await trees.getByRole('button',{name:'Launch 2 sessions',exact:true}).click();await expect(trees.getByText('Simulated launch; no program executed.',{exact:true})).toHaveCount(2);
  await page.screenshot({path:info.outputPath('explicit-launch.png'),fullPage:true});
  await sections.getByRole('button',{name:'Settings',exact:true}).click();await profiles.getByRole('button',{name:`${label} · revision 2`}).click();await profiles.getByRole('button',{name:'Delete profile'}).click();
  await expect(profiles.getByRole('button',{name:`${label} · revision 2`})).toHaveCount(0);
  const batches=await (await request.get('/api/v1/launches',{headers})).json();expect(batches.flatMap((b:{items:{profile:{id:string}}[]})=>b.items).filter((i:{profile:{id:string}})=>i.profile.id===profile.id)).toHaveLength(2);
});
test('manual recovery stays visible without agents and requires a note and explicit acknowledgement',async({page,request},info)=>{
  await page.goto('/');await page.getByLabel('Host access token').fill('a'.repeat(64));await page.getByRole('button',{name:'Open console'}).click();
  const card=page.getByRole('region',{name:'Codex terminal',exact:true});
  await card.getByRole('button',{name:'Open terminal',exact:true}).click();await card.getByRole('button',{name:'Take keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();
  await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
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
  await recovery.getByLabel('Inspection note').fill('Inspected fixture host and possible prior/background effects.');
  await expect(confirm).toBeDisabled();await recovery.getByRole('checkbox').check();await expect(confirm).toBeEnabled();
  await page.screenshot({path:info.outputPath('manual-recovery.png'),fullPage:true});
  await confirm.click();await expect.poll(async()=>(await state(request)).manualSessions?.length).toBe(0);
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
    await card.getByRole('button',{name:'Release keyboard',exact:true}).click();
    await card.getByRole('button',{name:'Transfer / recover keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();
    await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('b');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(2);
    release();await done;
    await card.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('c');
    await expect.poll(async()=>((await state(request)).manualSessions??[])[0]?.bytes).toBe(3);
    await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();
  } finally {release();await done;}
});

test('native paste warns before unbracketed multiline input and exposes a visible accessible focus escape',async({page,request})=>{
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
  await card.getByRole('button',{name:'Focus AltCLI control',exact:true}).click();await expect(page.getByRole('region',{name:'AltCLI control',exact:true})).toBeFocused();
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
    await card.getByRole('button',{name:'Focus AltCLI control',exact:true}).click();release();await done;
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
    await card.getByRole('button',{name:'Focus AltCLI control',exact:true}).click();release();await done;
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
  const card=await openKeyboard(page),view=page.getByRole('navigation',{name:'Viewed terminal'});
  await expect(card.getByRole('status')).toContainText(/\d+×\d+ window/);
  const other=await page.context().newPage();
  try {
    await other.goto('/');await other.getByLabel('Host access token').fill('a'.repeat(64));await other.getByRole('button',{name:'Open console'}).click();
    const remote=other.getByRole('region',{name:'Codex terminal',exact:true});
    await remote.getByRole('button',{name:'Open terminal',exact:true}).click();
    await expect(remote.getByText('Controlled in another browser',{exact:true})).toBeVisible();
    await view.getByRole('button',{name:'Claude',exact:true}).click();
    const sibling=page.getByRole('region',{name:'Claude terminal',exact:true});
    await sibling.getByRole('button',{name:'Open terminal',exact:true}).click();
    await expect(sibling.getByText('Keyboard in another terminal',{exact:true})).toBeVisible();
    await view.getByRole('button',{name:'Codex',exact:true}).click();
    await card.getByRole('button',{name:'Release keyboard',exact:true}).click();
    await expect(remote.getByText('Observing · manual input unresolved',{exact:true})).toBeVisible();
    // Only the CLI replacement is simulated; everything else uses the mock server API.
    await other.route('**/api/v1/state',async route=>{const response=await route.fetch(),body=await response.json();
      await route.fulfill({response,json:{...body,instances:body.instances.map((i:{agentId:string})=>i.agentId==='codex'?{...i,status:'replaced'}:i)}});});
    await expect(remote.getByText('Manual CLI/shell',{exact:true})).toBeVisible();
    await other.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Settings',exact:true}).click();
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
    await card.getByRole('button',{name:'Take keyboard…'}).click();await card.getByRole('button',{name:'Confirm keyboard'}).click();
    const draft=page.getByRole('textbox',{name:'Instruction for Codex',exact:true});await draft.focus();
    release();
    await expect(card.getByRole('status')).toContainText('Keyboard ready for Codex');
    await expect(card.getByText('Keyboard here',{exact:true})).toBeVisible();await expect(draft).toBeFocused();
  } finally {release();}
});

test('a native keyboard hold keeps the Plan brief editable but blocks Start Plan',async({page,request})=>{
  await openKeyboard(page);
  await page.getByRole('button',{name:'1 · Plan',exact:true}).click();
  const brief=page.getByLabel('Shared task brief');
  await expect(brief).toBeEditable();await brief.fill('Drafted while the keyboard is held.');
  await expect(brief).toHaveValue('Drafted while the keyboard is held.');
  await expect(page.getByRole('button',{name:'Start Plan',exact:true})).toBeDisabled();
  await expect(page.getByText('Manual terminal input holds dispatch across this server. Release and reconcile it first.').filter({visible:true}).first()).toBeVisible();
  expect(((await state(request)).manualSessions??[])[0]?.bytes).toBe(0);
});
