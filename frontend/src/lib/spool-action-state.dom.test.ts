// @vitest-environment happy-dom
import { changedNativeFields, createDetailEditSession, setFormFieldValue } from './detail-edit'
import { readFileSync } from 'node:fs';
import { createSourceFile, isFunctionDeclaration, isExpressionStatement, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchSequential } from './cache';
import { prepareExtraFieldUpdate } from './entity-extra-fields';
import * as detail from './spool-detail';
import * as filament from './filament-detail';
import * as reel from './spool-reel';
import { escapeHtml, renderFieldInput } from './extra-fields';
const source = readFileSync('src/pages/spools/[id]/index.astro', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
const parsed = createSourceFile('detail.ts', source, ScriptTarget.Latest, true);
const names = ['loadData', 'getStatusLabel', 'getLocationName', 'safeExternalUrl', 'renderFilamentDetailRow', 'renderSpoolField', 'renderExtraFields', 'bindSpoolContentActions', 'exitEditMode', 'refreshSpoolSnapshot', 'setupInlineEditor', 'renderRemainingSummary', 'renderSpool', 'setupActions', 'showModal', 'refreshRemainingWeight', 'updateSpoolActionState', 'runSpoolAction', 'saveTrayParamsToEntity', 'handleImportTrayToSpool', 'handleImportTrayToSpoolAndFilament'];
const production = parsed.statements.filter(node => isFunctionDeclaration(node) && names.includes(node.name?.text || '') || isExpressionStatement(node) && ["document.getElementById('modal-form')?.addEventListener('submit'", "document.getElementById('rfid-cancel')?.addEventListener", "document.getElementById('rfid-confirm')?.addEventListener"].some(prefix => node.getText(parsed).startsWith(prefix)) || isExpressionStatement(node) && ['.removeRfidTag =', '.openRfidModal ='].some(assignment => node.getText(parsed).includes(assignment))).map(node => node.getText(parsed)).join('\n');
const build = new Function('runtime', `
 const {editSession,changedNativeFields,setFormFieldValue,fetchSequential,buildSpoolDetailSections,buildSpoolUpdatePayload,formatSpoolDate,buildFilamentDetailSections,buildFilamentHeaderName,buildFilamentHeroStyle,formatHeaderId,getFilamentColors,renderFilamentHeaderColors,renderFilamentSpoolImage,formatSpoolMetrics,renderSpoolReel,spoolRemainingWeight,escapeExtraFieldHtml,renderFieldInput,prepareExtraFieldUpdate}=runtime;
 const id='17',t=key=>key,getLang=()=> 'en',getCurrency=()=> 'USD',formatPrice=String,formatRfidUid=String;
 const getAbortSignal=()=>undefined,isAbortError=()=>false,getCsrfToken=()=>'',assignableLocations=items=>items;
 const CACHE_KEYS={LOCATIONS:'locations',FILAMENTS:'filaments'},cachedFetchAllPages=async key=>({items:key==='filaments'?runtime.filaments:[],total:0});
 const invalidateCachePrefix=()=>{},renderDetailExtraFieldRows=()=>'',updateScrollIdentity=()=>{},queueOverviewReload=()=>{},updateSpoolPrintData=()=>{},loadEvents=()=>{},printLabel=()=>{};
 const captureDetailEditPosition=()=>()=>{},checkFilamentDbActive=async()=>false;
 const createEntityExtraFieldEditor=()=>({setSystemFieldKeys(){},setData(){},getSnapshot(){return ''}}),collectExtraFieldPayload=()=>({customFields:{},customFieldDefinitions:{}});
 const initPrinterSetup=()=>({isSaving:()=>false,isDirty:()=>!!runtime.afterNativeSave,setEditing:async()=>{},refresh:async()=>{},save:async fn=>{await fn();await runtime.afterNativeSave?.();},setFilament:async()=>{}});
 let pendingSpoolActions=0, remainingRequest=0;let currentRfidSpoolId=null;let spool=null,statuses=[],locations=[],activeDevices=[],spoolSystemFieldMap={},filamentSystemFieldMap={},editing=false,extraFieldsDialogRequested=false,printerSetup=null,spoolNeedsRefresh=false,spoolDraftObserver=null,spoolProfileLookup=null,updatePrinterSaveState=()=>{},detailActionHandlersBound=false;
 ${transpileModule(production, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}
 return {loadData,refreshRemainingWeight,handleImportTrayToSpool,handleImportTrayToSpoolAndFilament,editing:()=>editing};
`);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
async function setup(override?: (input: string, init?: RequestInit) => Promise<Response> | undefined, afterNativeSave?: () => Promise<void>) {
    vi.stubGlobal('Option', function (text: string, value: string) { const option = document.createElement('option'); option.textContent = text; option.value = value; return option; });
    history.replaceState(null, '', '/spools/17');
    document.body.innerHTML = '<div id="rfid-modal"><div id="rfid-text"></div><div id="rfid-device-select-container"><select id="rfid-device-select"></select></div><div id="rfid-status"></div><div id="rfid-warning"></div><div id="rfid-slot-choice"></div><button id="rfid-confirm"></button><button id="rfid-cancel"></button></div><main><div class="detail-page-toolbar"><div id="spool-page-actions"></div></div><div id="spool-content"></div><div id="actions-section"><button id="btn-measurement"></button><button id="btn-adjustment"></button><button id="btn-status"></button><button id="btn-move"></button><a id="btn-print-label"></a></div><div id="printer-setup"></div><div id="modal-container" class="hidden"><div id="modal-title"></div><form id="modal-form"><div id="modal-fields"></div><div id="modal-error"></div><button id="modal-submit" type="submit"></button><button id="modal-cancel" type="button"></button></form></div><div id="delete-modal"></div><input id="delete-permanent-checkbox" type="checkbox"><div id="delete-permanent-warning"></div><button id="btn-delete-confirm"></button><button id="btn-delete-cancel"></button></main>';
    const f = { id: 3, manufacturer: { name: 'Brand' }, designation: 'Before filament', material_type: 'PLA', diameter_mm: 1.75, colors: [] };
    const saved = { id: 17, filament_id: 3, filament: f, status_id: 1, remaining_weight_g: 500, initial_total_weight_g: 1200, empty_spool_weight_g: 200, spool_core_weight_g: 0, lot_number: 'Saved lot', rfid_uid: 'AABBCCDD', custom_fields: {}, custom_field_definitions: {}, metrics: { remaining_percent: 50, remaining_length_m: 168 } };
    let resolvePost!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
        const intercepted = override?.(input, init);
        if (intercepted)
            return intercepted;
        if (init?.method === 'POST' || init?.method === 'PATCH')
            return new Promise<Response>(resolve => { resolvePost = resolve; });
        const url = new URL(input, 'http://localhost');
        return Promise.resolve(Response.json(url.pathname === '/api/v1/spools/17' ? saved : url.pathname.endsWith('/statuses') ? [{ id: 1, key: 'opened', label: 'Opened' }] : url.pathname.endsWith('/devices/active') ? [{ id: 1, name: 'Fixture RFID' }] : []));
    }));
    const runtime = build({ changedNativeFields, setFormFieldValue, editSession: createDetailEditSession('/api/v1/spools/17?include_metrics=true', () => 'spools.failedLoadSingle'), fetchSequential, ...detail, ...filament, ...reel, escapeExtraFieldHtml: escapeHtml, renderFieldInput, prepareExtraFieldUpdate, afterNativeSave, filaments: [f, { ...f, id: 4, designation: 'After filament' }] });
    await runtime.loadData();
    return { runtime, saved, hasPending: () => !!resolvePost, resolvePost: (response: Response) => resolvePost(response) };
}
it.each(['measurement', 'adjustment', 'status', 'move'])('waits for pending %s and its refresh before entering Edit', async (action) => {
    const fixture = await setup();
    document.getElementById(`btn-${action}`)!.click();
    if (action === 'measurement')
        (document.getElementById('field-weight') as HTMLInputElement).value = '1000';
    if (action === 'adjustment')
        (document.getElementById('field-delta') as HTMLInputElement).value = '-10';
    document.getElementById('modal-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(fixture.hasPending()).toBe(true);
    expect((document.getElementById('modal-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('modal-cancel') as HTMLButtonElement).disabled).toBe(false);
    document.getElementById('modal-cancel')!.click();
    expect(document.getElementById('modal-container')!.classList.contains('hidden')).toBe(true);
    document.getElementById('btn-edit-spool')!.click();
    expect(fixture.runtime.editing()).toBe(false);
    expect(document.querySelector('[name="lot_number"]')).toBeNull();
    fixture.resolvePost(Response.json({ success: true }));
    await vi.waitFor(() => expect((document.getElementById('modal-submit') as HTMLButtonElement).disabled).toBe(false));
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="lot_number"]')).not.toBeNull());
    const draft = document.querySelector<HTMLInputElement>('[name="lot_number"]')!;
    draft.value = 'Later unsaved lot';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fixture.runtime.editing()).toBe(true);
    expect(document.querySelector('[name="lot_number"]')).toBe(draft);
    expect(draft.value).toBe('Later unsaved lot');
});
it('keeps Edit unavailable until RFID removal settles', async () => {
    const fixture = await setup();
    vi.stubGlobal('__fmConfirm', vi.fn(async () => true));
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => { });
    document.querySelector<HTMLButtonElement>('.remove-rfid-tag')!.click();
    await vi.waitFor(() => expect(fixture.hasPending()).toBe(true));
    document.getElementById('btn-edit-spool')!.click();
    expect(fixture.runtime.editing()).toBe(false);
    expect(document.querySelector('[name="lot_number"]')).toBeNull();
    fixture.resolvePost(Response.json({ success: true }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(fixture.runtime.editing()).toBe(true));
});
it('ignores a canceled RFID status response after a newer draft begins', async () => {
    const timers: Array<() => void> = [];
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => delay === 2000 ? (timers.push(callback), 0) : realTimeout(callback, delay, ...args)) as typeof setTimeout);
    let finishStatus!: (response: Response) => void;
    const fixture = await setup((input) => {
        if (input.endsWith('/write-tag'))
            return Promise.resolve(Response.json({ success: true }));
        if (input.endsWith('/write-status'))
            return new Promise<Response>(resolve => { finishStatus = resolve; });
    });
    document.getElementById('btn-rfid')!.click();
    document.getElementById('rfid-confirm')!.click();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers.shift()!();
    expect(finishStatus).toBeDefined();
    document.getElementById('rfid-cancel')!.click();
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="lot_number"]')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('[name="lot_number"]')!;
    input.value = 'Later draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    finishStatus(Response.json({ status: 'success' }));
    await new Promise(resolve => realTimeout(resolve, 0));
    expect(timers).toHaveLength(0);
    expect(document.querySelector('[name="lot_number"]')).toBe(input);
    expect(input.value).toBe('Later draft');
    expect(fixture.runtime.editing()).toBe(true);
});
it('ignores older live-weight responses after a newer full snapshot', async () => {
    let hold = false, finishOld!: (response: Response) => void;
    const fixture = await setup((input, init) => {
        if (hold && !init?.method && new URL(input, 'http://localhost').pathname === '/api/v1/spools/17') {
            hold = false;
            return new Promise<Response>(resolve => { finishOld = resolve; });
        }
    });
    const old = Response.json(fixture.saved);
    hold = true;
    const oldRead = fixture.runtime.refreshRemainingWeight();
    expect(finishOld).toBeDefined();
    fixture.saved.remaining_weight_g = 250;
    fixture.saved.metrics = { remaining_percent: 25, remaining_length_m: 84 };
    await fixture.runtime.loadData();
    expect(document.querySelector('.spool-remaining-grams')!.textContent).toBe('250 g');
    finishOld(old);
    await oldRead;
    expect(document.querySelector('.spool-remaining-grams')!.textContent).toBe('250 g');
    expect(document.querySelector('.spool-remaining-percent')!.textContent).toBe('25%');
    expect(fixture.saved.remaining_weight_g).toBe(250);
});


it('ignores a rejected canceled RFID request after another write session starts', async () => {
    let rejectOld!: (cause: Error) => void;
    let writes = 0;
    await setup((input) => {
        if (input.endsWith('/write-tag')) {
            writes++;
            return writes === 1 ? new Promise<Response>((_resolve, reject) => { rejectOld = reject; }) : new Promise<Response>(() => {});
        }
    });
    document.getElementById('btn-rfid')!.click();
    document.getElementById('rfid-confirm')!.click();
    await vi.waitFor(() => expect(rejectOld).toBeDefined());
    document.getElementById('rfid-cancel')!.click();
    document.getElementById('btn-rfid')!.click();
    document.getElementById('rfid-confirm')!.click();
    expect(writes).toBe(2);
    const status = document.getElementById('rfid-status')!;
    const message = status.innerHTML;
    expect((document.getElementById('rfid-confirm') as HTMLButtonElement).disabled).toBe(true);
    rejectOld(new Error('Old request failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(status.innerHTML).toBe(message);
    expect((document.getElementById('rfid-confirm') as HTMLButtonElement).disabled).toBe(true);
});


it.each(['spool', 'both'] as const)('keeps Edit unavailable through an AMS import to %s', async target => {
    const pending: Array<(response: Response) => void> = [];
    const fixture = await setup((_input, init) => init?.method === 'PUT'
        ? new Promise<Response>(resolve => { pending.push(resolve); }) : undefined);
    const imported = target === 'spool'
        ? fixture.runtime.handleImportTrayToSpool({ nozzle_temp_min: 200, nozzle_temp_max: 220 }, 1)
        : fixture.runtime.handleImportTrayToSpoolAndFilament({ nozzle_temp_min: 200, nozzle_temp_max: 220 }, 1);
    expect(pending).toHaveLength(target === 'spool' ? 1 : 2);
    document.getElementById('btn-edit-spool')!.click();
    expect(fixture.runtime.editing()).toBe(false);
    pending.forEach(resolve => resolve(Response.json([])));
    await imported;
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(fixture.runtime.editing()).toBe(true));
});


it.each([false, true])('preserves device-committed RFID after Cancel and an unrelated Save (commit after Edit: %s)', async afterEdit => {
    let patch: Record<string, unknown> | undefined;
    const fixture = await setup((input, init) => {
        if (input.endsWith('/write-tag')) return new Promise<Response>(() => {});
        if (init?.method === 'PATCH') {
            patch = JSON.parse(String(init.body));
            return new Promise<Response>(() => {});
        }
    });
    document.getElementById('btn-rfid')!.click();
    document.getElementById('rfid-confirm')!.click();
    document.getElementById('rfid-cancel')!.click();
    if (!afterEdit) (fixture.saved as Record<string, unknown>).rfid_uid_2 = '11223344';
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="lot_number"]')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('[name="rfid_uid_2"]')!.value).toBe(afterEdit ? '' : '11223344');
    if (afterEdit) (fixture.saved as Record<string, unknown>).rfid_uid_2 = '11223344';
    const lot = document.querySelector<HTMLInputElement>('[name="lot_number"]')!;
    lot.value = 'Unrelated lot';
    lot.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('spool-inline-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(patch).toBeDefined());
    expect(patch!.lot_number).toBe('Unrelated lot');
    expect(patch).not.toHaveProperty('rfid_uid');
    expect(patch).not.toHaveProperty('rfid_uid_2');
    expect((fixture.saved as Record<string, unknown>).rfid_uid_2).toBe('11223344');
});

it.each(['', 'FFEEDDCC'])('sends an intentional primary RFID edit: %s', async value => {
    let patch: Record<string, unknown> | undefined;
    await setup((_input, init) => {
        if (init?.method === 'PATCH') {
            patch = JSON.parse(String(init.body));
            return new Promise<Response>(() => {});
        }
    });
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="rfid_uid"]')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('[name="rfid_uid"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('spool-inline-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(patch).toBeDefined());
    expect(patch!.rfid_uid).toBe(value || null);
    expect(patch).not.toHaveProperty('rfid_uid_2');
});

it('leaves View intact and releases Edit when refreshing its snapshot fails', async () => {
    let failRead = false;
    const fixture = await setup((input, init) => failRead && !init?.method && input.includes('/spools/17')
        ? Promise.resolve(new Response(null, { status: 503 })) : undefined);
    failRead = true;
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toBe('spools.failedLoadSingle'));
    expect(document.getElementById('spool-edit-error')!.classList.contains('hidden')).toBe(false);
    expect(fixture.runtime.editing()).toBe(false);
    expect(document.querySelector('[name="lot_number"]')).toBeNull();
    expect((document.getElementById('btn-edit-spool') as HTMLButtonElement).disabled).toBe(false);
});

it('keeps a backfilled secondary RFID when retrying after a partial save', async () => {
    const patches: Record<string, unknown>[] = [];
    const afterNativeSave = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Printer rejected')).mockResolvedValue(undefined);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const fixture: Awaited<ReturnType<typeof setup>> = await setup((_input, init) => {
        if (init?.method !== 'PATCH') return;
        patches.push(JSON.parse(String(init.body)));
        // The native API backfills the unchanged secondary after clearing the primary.
        Object.assign(fixture.saved, { rfid_uid: '11223344', rfid_uid_2: null });
        return Promise.resolve(Response.json(fixture.saved));
    }, afterNativeSave);
    Object.assign(fixture.saved, { rfid_uid_2: '11223344' });
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="rfid_uid"]')).not.toBeNull());
    const primary = document.querySelector<HTMLInputElement>('[name="rfid_uid"]')!;
    primary.value = '';
    primary.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.getElementById('spool-inline-form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toBe('Printer rejected'));
    expect(patches[0]).toHaveProperty('rfid_uid', null);
    expect(primary.value).toBe('11223344');
    expect(document.querySelector<HTMLInputElement>('[name="rfid_uid_2"]')!.value).toBe('');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(patches).toHaveLength(2);
    expect(patches[1]).not.toHaveProperty('rfid_uid');
    expect(patches[1]).not.toHaveProperty('rfid_uid_2');
});

it('retains RFID edits made while the native save response was pending', async () => {
    const patches: Record<string, unknown>[] = [];
    let finishPatch!: (response: Response) => void;
    const afterNativeSave = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Printer rejected')).mockResolvedValue(undefined);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const fixture: Awaited<ReturnType<typeof setup>> = await setup((_input, init) => {
        if (init?.method !== 'PATCH') return;
        patches.push(JSON.parse(String(init.body)));
        if (patches.length === 1) return new Promise<Response>(resolve => { finishPatch = resolve; });
        Object.assign(fixture.saved, { rfid_uid: 'FFEEDDCC', rfid_uid_2: '55667788' });
        return Promise.resolve(Response.json(fixture.saved));
    }, afterNativeSave);
    Object.assign(fixture.saved, { rfid_uid_2: '11223344' });
    document.getElementById('btn-edit-spool')!.click();
    await vi.waitFor(() => expect(document.querySelector('[name="rfid_uid"]')).not.toBeNull());
    const primary = document.querySelector<HTMLInputElement>('[name="rfid_uid"]')!;
    const secondary = document.querySelector<HTMLInputElement>('[name="rfid_uid_2"]')!;
    primary.value = '';
    primary.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.getElementById('spool-inline-form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(finishPatch).toBeDefined());
    primary.value = 'FFEEDDCC';
    secondary.value = '55667788';
    primary.dispatchEvent(new Event('input', { bubbles: true }));
    Object.assign(fixture.saved, { rfid_uid: '11223344', rfid_uid_2: null });
    finishPatch(Response.json(fixture.saved));
    await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toBe('Printer rejected'));
    expect(primary.value).toBe('FFEEDDCC');
    expect(secondary.value).toBe('55667788');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(patches[1]).toMatchObject({ rfid_uid: 'FFEEDDCC', rfid_uid_2: '55667788' });
});
