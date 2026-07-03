// ═══════════════════════════════════════════════════════════════
// MagiPortal — Electricks Remote Configurator  |  app.js v2.5.0
// ═══════════════════════════════════════════════════════════════
const SERVICE_UUID   = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHAR_FFE1_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
const CHAR_FFE2_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb';

// ─── Binary protocol command bytes ─────────────────────────────
const CMD_UPLOAD       = 0x01; // upload chunk
const CMD_FINALIZE     = 0x02; // compile
const CMD_PERSIST      = 0x03; // save to flash
const CMD_KILL         = 0x04; // stop running script
const CMD_DIR          = 0x05; // list saved scripts → streams back via FFE1
const CMD_LOAD         = 0x06; // load (run) script by name

// ─── Portal Application State ──────────────────────────────────
const state = {
    buttons: Array.from({ length: 12 }, (_, i) => ({
        id: i,
        action: 'number',
        value: i + 1,
        word: '',
        systemKey: '#ENTER'
    })),
    sumDelay: 30,
    ledColor: 'w',
    vibePattern: '.',
    autoSubmit: true,
    selectedButtonId: 0,
    activeTab: 'tabCode',

    // ─ Connection ─
    connectionType: null,  // 'ble' | 'serial' | null
    bleDevice: null,
    bleServer: null,
    bleService: null,
    charFFE1: null,
    charFFE2: null,
    serialPort: null,
    serialReader: null,
    serialWriter: null,
    serialReadActive: false,

    // ─ Custom uploaded .js file (overrides the generated script when set) ─
    customScriptCode: null,
    customScriptName: null
};

// ─── Simulator State ───────────────────────────────────────────
const simState = {
    runningTotal: 0,
    timer: null,
    isTimerRunning: false
};

// ─── Diagnostic State ─────────────────────────────────────────
const diagState = {
    phase: 0,           // 0 = idle, 1 = listing, 2 = code, 3 = analysis, 4 = save
    scriptList: [],
    currentScript: null, // { name, code }
    analysisText: '',
    geminiKey: '',
    // FFE1 accumulation buffer during extract operations
    extractBuffer: '',
    extractResolve: null,
    extractTimeout: null,
    extracting: false
};

// ─── Presets stored in localStorage ──────────────────────────
const PRESETS_KEY = 'magiportal_presets';

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    buildKeypadGrid();
    setupEventListeners();
    updateButtonEditorView();
    updateCodePreview();
    renderPresetsLibrary();
});

// ══════════════════════════════════════════════════════════════
//  KEYPAD GRID
// ══════════════════════════════════════════════════════════════
function buildKeypadGrid() {
    const grid = document.getElementById('keypadGrid');
    grid.innerHTML = '';
    for (let i = 0; i < 12; i++) {
        const btn = document.createElement('div');
        btn.className = 'hw-button' + (i === state.selectedButtonId ? ' selected' : '');
        btn.dataset.id = i;

        const spanId  = document.createElement('span'); spanId.className  = 'btn-id';  spanId.textContent  = i;
        const spanVal = document.createElement('span'); spanVal.className = 'btn-val'; spanVal.textContent = 'Val: ' + (i + 1);

        btn.appendChild(spanId);
        btn.appendChild(spanVal);
        btn.addEventListener('click', () => { selectButton(i); triggerSimulatorPress(i); });
        grid.appendChild(btn);
    }
}

function selectButton(id) {
    state.selectedButtonId = id;
    document.querySelectorAll('.hw-button').forEach(b =>
        b.classList.toggle('selected', parseInt(b.dataset.id) === id));
    updateButtonEditorView();
}

function updateButtonEditorView() {
    const btn = state.buttons[state.selectedButtonId];
    document.getElementById('txtSelectedButtonTitle').textContent = `Configure Button ${btn.id}`;
    document.getElementById('selButtonAction').value = btn.action;
    document.getElementById('numKeyValue').value   = btn.value;
    document.getElementById('lblKeyValue').textContent = btn.value;
    document.getElementById('txtKeyWord').value    = btn.word;
    document.getElementById('selSystemKey').value  = btn.systemKey;

    document.querySelectorAll('.action-ctx').forEach(el => el.classList.add('hidden'));
    if (btn.action === 'number')      document.getElementById('ctxActionNumber').classList.remove('hidden');
    else if (btn.action === 'word')   document.getElementById('ctxActionWord').classList.remove('hidden');
    else if (btn.action === 'key')    document.getElementById('ctxActionKey').classList.remove('hidden');
}

function updateButtonDisplayLabels() {
    document.querySelectorAll('.hw-button').forEach(el => {
        const id  = parseInt(el.dataset.id);
        const btn = state.buttons[id];
        const valEl = el.querySelector('.btn-val');
        if (btn.action === 'number')    valEl.textContent = `Val: ${btn.value}`;
        else if (btn.action === 'word') valEl.textContent = btn.word.length > 5 ? btn.word.substring(0, 4) + '..' : (btn.word || 'Word');
        else if (btn.action === 'key')  valEl.textContent = btn.systemKey.replace('#', '');
        else                            valEl.textContent = 'None';
    });
}

// ══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════
function setupEventListeners() {
    // Connection
    document.getElementById('btnConnectBle').addEventListener('click', () => connectBle(false));
    document.getElementById('btnConnectBleAll').addEventListener('click', () => connectBle(true));
    document.getElementById('btnConnectSerial').addEventListener('click', connectSerial);
    document.getElementById('btnDisconnect').addEventListener('click', disconnectDevice);
    document.getElementById('btnBurn').addEventListener('click', burnScript);
    document.getElementById('btnDownload').addEventListener('click', downloadScript);
    document.getElementById('btnRestoreDefaults').addEventListener('click', restoreDefaults);

    // ★ Upload JS ★
    document.getElementById('btnUploadJs').addEventListener('click', () => {
        document.getElementById('fileUploadJs').click();
    });
    document.getElementById('fileUploadJs').addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        handleUploadJsFile(file);
    });
    document.getElementById('btnRevertGenerated').addEventListener('click', revertToGeneratedScript);

    // ★ Diagnostic modal triggers ★
    document.getElementById('btnDiagnostic').addEventListener('click', openDiagnosticModal);
    document.getElementById('btnCloseDiagModal').addEventListener('click', closeDiagnosticModal);
    document.getElementById('diagnosticModal').addEventListener('click', e => {
        if (e.target === document.getElementById('diagnosticModal')) closeDiagnosticModal();
    });
    document.getElementById('btnRunDiagnostic').addEventListener('click', runDiagnosticPhase1);
    document.getElementById('btnAnalyseCode').addEventListener('click', runDiagnosticPhase3);
    document.getElementById('btnSkipAnalysis').addEventListener('click', goToDiagnosticPhase4);
    document.getElementById('btnProceedToSave').addEventListener('click', goToDiagnosticPhase4);
    document.getElementById('btnSavePreset').addEventListener('click', savePresetFromDiag);
    document.getElementById('btnDownloadPresetTxt').addEventListener('click', downloadPresetTxt);

    // Button editor
    document.getElementById('selButtonAction').addEventListener('change', e => {
        state.buttons[state.selectedButtonId].action = e.target.value;
        updateButtonEditorView(); updateButtonDisplayLabels(); updateCodePreview();
    });
    document.getElementById('numKeyValue').addEventListener('input', e => {
        state.buttons[state.selectedButtonId].value = parseInt(e.target.value);
        document.getElementById('lblKeyValue').textContent = e.target.value;
        updateButtonDisplayLabels(); updateCodePreview();
    });
    document.getElementById('txtKeyWord').addEventListener('input', e => {
        state.buttons[state.selectedButtonId].word = e.target.value;
        updateButtonDisplayLabels(); updateCodePreview();
    });
    document.getElementById('selSystemKey').addEventListener('change', e => {
        state.buttons[state.selectedButtonId].systemKey = e.target.value;
        updateButtonDisplayLabels(); updateCodePreview();
    });

    // Global settings
    document.getElementById('numDelay').addEventListener('input', e => {
        state.sumDelay = parseInt(e.target.value);
        document.getElementById('lblDelayValue').textContent = (state.sumDelay / 10).toFixed(1) + 's';
        updateCodePreview();
    });
    document.getElementById('selLedColor').addEventListener('change', e => { state.ledColor = e.target.value; updateCodePreview(); });
    document.getElementById('selVibePattern').addEventListener('change', e => { state.vibePattern = e.target.value; updateCodePreview(); });
    document.getElementById('chkAutoSubmit').addEventListener('change', e => { state.autoSubmit = e.target.checked; updateCodePreview(); });

    // Sandbox
    document.getElementById('btnClearSandbox').addEventListener('click', () => {
        document.getElementById('txtSandbox').value = '';
        simState.runningTotal = 0;
        document.getElementById('simRunningTotal').textContent = '0';
        clearSimulatorTimer();
    });

    // Console
    document.getElementById('btnClearConsole').addEventListener('click', () => {
        document.getElementById('consoleLog').innerHTML = '<div class="log-line system-msg">[System] Console cleared.</div>';
    });

    // Code copy
    document.getElementById('btnCopyCode').addEventListener('click', () => {
        navigator.clipboard.writeText(document.getElementById('codeBlock').textContent).then(() => {
            const b = document.getElementById('btnCopyCode');
            b.innerHTML = '<i class="ph ph-check"></i> Copied!';
            setTimeout(() => { b.innerHTML = '<i class="ph ph-copy"></i> Copy'; }, 2000);
        });
    });

    // Tabs
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            state.activeTab = btn.dataset.tab;
        });
    });
}

// ══════════════════════════════════════════════════════════════
//  CODE GENERATOR
// ══════════════════════════════════════════════════════════════
function generateMagiScript() {
    const mapping = state.buttons.map(b => {
        if (b.action === 'number') return `'${b.value}'`;
        if (b.action === 'word')   return `'${b.word.replace(/'/g, "\\'")}'`;
        if (b.action === 'key')    return `'${b.systemKey}'`;
        return 'null';
    });
    const led  = state.ledColor   !== 'off' ? `atom.led('${state.ledColor}=');`      : '';
    const vibe = state.vibePattern !== 'off' ? `atom.vibrate('${state.vibePattern}');` : '';

    return `// ==========================================
// Electricks Custom 12-Button Keypad App
// Generated by MagiPortal v2.5.0
// ==========================================

const KEY_MAPPING = [
    ${mapping.join(', ')}
];

const DELAY_TIMEOUT = ${state.sumDelay * 100}; // ${(state.sumDelay / 10).toFixed(1)}s
const AUTO_SUBMIT   = ${state.autoSubmit};

let accumulatedTotal = 0;
let timerHandle = undefined;

function main() {
    accumulatedTotal = 0;
    timerHandle = undefined;
    console.log("Custom Keypad started");
    ${vibe}
}

function sendAccumulatedTotal() {
    console.log("Sum complete: " + accumulatedTotal);
    keyboard.type(accumulatedTotal);
    if (AUTO_SUBMIT) { keyboard.tap('return'); }
    accumulatedTotal = 0;
    timerHandle = undefined;
    ${vibe ? "atom.vibrate('-');" : ""}
}

function onEvent(event) {
    if (event.source !== 'atom:button' || event.type !== 'click') return;
    let id = parseInt(event.value);
    if (id < 0 || id > 11) return;

    let actionValue = KEY_MAPPING[id];
    if (actionValue === null) return;

    console.log("Button " + id + " → " + actionValue);
    ${led}
    ${vibe}

    let num = parseInt(actionValue);
    if (!isNaN(num)) {
        keyboard.type(num);
        accumulatedTotal += num;
        if (timerHandle !== undefined) clearTimeout(timerHandle);
        timerHandle = setTimeout(sendAccumulatedTotal, DELAY_TIMEOUT);
    } else if (strCharAt(actionValue, 0) === '#') {
        keyboard.send(actionValue);
    } else {
        keyboard.type(actionValue);
    }
}
`;
}

/** Returns whichever code should actually be sent to the device / downloaded:
 *  a manually uploaded .js file if one is loaded, otherwise the UI-generated script. */
function getActiveScriptCode() {
    return state.customScriptCode !== null ? state.customScriptCode : generateMagiScript();
}

function updateCodePreview() {
    const code = getActiveScriptCode();
    const block = document.getElementById('codeBlock');
    block.textContent = code;
    if (window.Prism) Prism.highlightElement(block);

    const label = document.getElementById('codeTitleLabel');
    if (state.customScriptCode !== null) {
        label.innerHTML = `Custom App: <code>${escHtml(state.customScriptName || 'uploaded.js')}</code>`;
    } else {
        label.innerHTML = 'Generated App: <code>remote_keypad.js</code>';
    }
}

// ══════════════════════════════════════════════════════════════
//  CONSOLE LOGGER
// ══════════════════════════════════════════════════════════════
function logToConsole(message, type = 'info') {
    const log = document.getElementById('consoleLog');
    const div = document.createElement('div');
    const now = new Date();
    const ts  = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;
    div.className = `log-line ${type}-msg`;
    div.textContent = `${ts} ${message}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// ══════════════════════════════════════════════════════════════
//  MISC ACTIONS
// ══════════════════════════════════════════════════════════════
function restoreDefaults() {
    state.buttons.forEach((b, i) => { b.action = 'number'; b.value = i + 1; b.word = ''; b.systemKey = '#ENTER'; });
    state.sumDelay = 30; state.ledColor = 'w'; state.vibePattern = '.'; state.autoSubmit = true;
    document.getElementById('numDelay').value = 30;
    document.getElementById('lblDelayValue').textContent = '3.0s';
    document.getElementById('selLedColor').value    = 'w';
    document.getElementById('selVibePattern').value = '.';
    document.getElementById('chkAutoSubmit').checked = true;
    updateButtonDisplayLabels(); updateButtonEditorView(); updateCodePreview();
    logToConsole("Configuration reset to defaults.");
}

function downloadScript() {
    const code     = getActiveScriptCode();
    const filename = state.customScriptCode !== null ? (state.customScriptName || 'uploaded.js') : 'remote_keypad.js';
    const blob = new Blob([code], { type: 'text/javascript' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    logToConsole(`Downloaded: ${filename}`);
}

// ══════════════════════════════════════════════════════════════
//  UPLOAD JS (load a local .js file to program the remote)
// ══════════════════════════════════════════════════════════════
const MAX_UPLOAD_JS_SIZE = 200 * 1024; // 200 KB safety cap

function handleUploadJsFile(file) {
    if (!file) return;

    if (!/\.js$/i.test(file.name)) {
        logToConsole(`[Upload JS] "${file.name}" is not a .js file.`, "error");
        return;
    }
    if (file.size > MAX_UPLOAD_JS_SIZE) {
        logToConsole(`[Upload JS] "${file.name}" is too large (${file.size} bytes, max ${MAX_UPLOAD_JS_SIZE}).`, "error");
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        state.customScriptCode = reader.result;
        state.customScriptName = file.name;

        document.getElementById('customScriptFilename').textContent = file.name;
        document.getElementById('customScriptBanner').classList.remove('hidden');
        document.getElementById('btnRevertGenerated').classList.remove('hidden');

        updateCodePreview();

        // Jump to the code tab so the loaded file is immediately visible
        document.getElementById('tabBtnCode').click();

        logToConsole(`[Upload JS] Loaded "${file.name}" (${file.size} bytes). This file will be sent when you click "Upload & Program Remote".`, "success");
    };
    reader.onerror = () => {
        logToConsole(`[Upload JS] Failed to read "${file.name}": ${reader.error}`, "error");
    };
    reader.readAsText(file);
}

function revertToGeneratedScript() {
    if (state.customScriptCode === null) return;
    const name = state.customScriptName;
    state.customScriptCode = null;
    state.customScriptName = null;

    document.getElementById('customScriptBanner').classList.add('hidden');
    document.getElementById('btnRevertGenerated').classList.add('hidden');
    document.getElementById('fileUploadJs').value = '';

    updateCodePreview();
    logToConsole(`[Upload JS] Reverted — "${name}" discarded, showing the UI-generated script again.`);
}

// ══════════════════════════════════════════════════════════════
//  SIMULATOR
// ══════════════════════════════════════════════════════════════
function triggerSimulatorPress(buttonId) {
    const btn    = state.buttons[buttonId];
    const btnEl  = document.querySelector(`.hw-button[data-id="${buttonId}"]`);
    btnEl.classList.add('simulating-press');
    setTimeout(() => btnEl.classList.remove('simulating-press'), 100);

    if (state.ledColor !== 'off') {
        const led = document.getElementById('hardwareLed');
        led.className = `hardware-led led-${getLedColor(state.ledColor)}`;
        setTimeout(() => { led.className = 'hardware-led'; }, 200);
    }
    if (state.vibePattern !== 'off') {
        const remote = document.querySelector('.hardware-remote');
        remote.classList.add('vibrating');
        setTimeout(() => remote.classList.remove('vibrating'), state.vibePattern === '-' ? 350 : 150);
    }

    const sandbox = document.getElementById('txtSandbox');
    logToConsole(`[Sim] Button ${buttonId} (action: ${btn.action})`);

    if (btn.action === 'none') return;
    if (btn.action === 'number') {
        sandbox.value += btn.value;
        simState.runningTotal += btn.value;
        document.getElementById('simRunningTotal').textContent = simState.runningTotal;
        resetSimulatorTimer();
    } else if (btn.action === 'word') {
        sandbox.value += btn.word;
    } else if (btn.action === 'key') {
        const kmap = { '#ENTER': '\n', '#BACKSPACE': '\b', '#TAB': '\t', '#SPACE': ' ' };
        sandbox.value += kmap[btn.systemKey] ?? `[${btn.systemKey.replace('#','')}]`;
    }
}

function getLedColor(c) {
    return { r:'red', g:'green', b:'blue', y:'yellow', c:'cyan', p:'purple', o:'orange', w:'white' }[c] || 'white';
}

function resetSimulatorTimer() {
    clearSimulatorTimer();
    document.getElementById('simTimerStatus').className   = 'value badge badge-connecting';
    document.getElementById('simTimerStatus').textContent = 'Counting...';
    simState.isTimerRunning = true;

    simState.timer = setTimeout(() => {
        const sandbox = document.getElementById('txtSandbox');
        logToConsole(`[Sim] Delay expired. Sum: ${simState.runningTotal}`, 'success');
        sandbox.value += ` [Sum: ${simState.runningTotal}]`;
        if (state.autoSubmit) sandbox.value += '\n';
        simState.runningTotal = 0;
        document.getElementById('simRunningTotal').textContent = '0';
        document.getElementById('simTimerStatus').className   = 'value badge badge-neutral';
        document.getElementById('simTimerStatus').textContent = 'Idle';
        simState.isTimerRunning = false;
        if (state.vibePattern !== 'off') {
            const remote = document.querySelector('.hardware-remote');
            remote.classList.add('vibrating');
            setTimeout(() => remote.classList.remove('vibrating'), 400);
        }
    }, state.sumDelay * 100);
}

function clearSimulatorTimer() {
    if (simState.timer) clearTimeout(simState.timer);
    document.getElementById('simTimerStatus').className   = 'value badge badge-neutral';
    document.getElementById('simTimerStatus').textContent = 'Idle';
    simState.isTimerRunning = false;
}

// ══════════════════════════════════════════════════════════════
//  WEB BLUETOOTH  (with granular diagnostics)
// ══════════════════════════════════════════════════════════════

/** Check prerequisites and log useful guidance before connecting */
function checkBlePrerequisites() {
    if (!navigator.bluetooth) {
        logToConsole("❌ Web Bluetooth API not available.", "error");
        logToConsole("   → Use Chrome or Edge on desktop. Safari does NOT support Web Bluetooth.", "system");
        return false;
    }
    logToConsole("✓ Web Bluetooth API available.", "success");
    return true;
}

async function connectBle(useAcceptAll = false) {
    if (!checkBlePrerequisites()) return;

    logToConsole("──────────────────────────────────────", "system");
    logToConsole(useAcceptAll
        ? "Scan mode: ALL nearby devices (no filter)"
        : "Scan mode: devices named 'Atom...'", "in");
    logToConsole("→ A browser picker dialog should appear now.", "system");

    let requestOptions;
    if (useAcceptAll) {
        requestOptions = {
            acceptAllDevices: true,
            optionalServices: [SERVICE_UUID]
        };
    } else {
        requestOptions = {
            filters: [
                { namePrefix: 'Atom' },
                { namePrefix: 'atom' },
                { namePrefix: 'ATOM' }
            ],
            optionalServices: [SERVICE_UUID]
        };
    }

    // ── Step 1: Device picker ──────────────────────────────────
    try {
        logToConsole("[1/5] Showing device picker…");
        state.bleDevice = await navigator.bluetooth.requestDevice(requestOptions);
        logToConsole(`[1/5] ✓ Selected: "${state.bleDevice.name}" (id: ${state.bleDevice.id})`, "success");
    } catch (err) {
        if (err.name === 'NotFoundError' || err.message.includes('cancelled')) {
            logToConsole("[1/5] Picker cancelled by user.", "system");
        } else {
            logToConsole(`[1/5] ✗ Picker error: ${err.name}: ${err.message}`, "error");
            logBleGuidance();
        }
        setStatus('disconnected');
        return;
    }

    setStatus('connecting');
    state.bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);

    // ── Step 2: GATT connect (with retry) ─────────────────────
    let retries = 3;
    while (retries-- > 0) {
        try {
            logToConsole(`[2/5] Connecting to GATT server… (attempts left: ${retries + 1})`);
            state.bleServer = await state.bleDevice.gatt.connect();
            logToConsole("[2/5] ✓ GATT server connected.", "success");
            break;
        } catch (err) {
            logToConsole(`[2/5] GATT connect error: ${err.name}: ${err.message}`, "error");
            if (retries === 0) {
                logToConsole("[2/5] ✗ All GATT connect attempts failed.", "error");
                logBleGuidance();
                setStatus('disconnected');
                return;
            }
            logToConsole(`[2/5] Retrying in 1s…`, "system");
            await delay(1000);
        }
    }

    // ── Step 3: Get primary service ───────────────────────────
    try {
        logToConsole(`[3/5] Looking for service: ${SERVICE_UUID}…`);
        state.bleService = await state.bleServer.getPrimaryService(SERVICE_UUID);
        logToConsole("[3/5] ✓ Service FFE0 found.", "success");
    } catch (err) {
        logToConsole(`[3/5] ✗ Service lookup error: ${err.name}: ${err.message}`, "error");

        // Fallback: enumerate all services to help debugging
        try {
            logToConsole("[3/5] Enumerating all advertised services for diagnostics…", "system");
            const allServices = await state.bleServer.getPrimaryServices();
            if (allServices.length === 0) {
                logToConsole("   No GATT services found on this device.", "error");
                logToConsole("   → Confirm this is the correct Electricks Atom device.", "system");
            } else {
                allServices.forEach(s => logToConsole(`   Found service: ${s.uuid}`, "system"));
                logToConsole("   → If none match FFE0, the device firmware may be different.", "system");
            }
        } catch (e2) {
            logToConsole(`   Could not enumerate services: ${e2.message}`, "error");
        }

        logBleGuidance();
        setStatus('disconnected');
        return;
    }

    // ── Step 4: Get characteristics ───────────────────────────
    try {
        logToConsole("[4/5] Getting characteristics FFE1 and FFE2…");
        state.charFFE1 = await state.bleService.getCharacteristic(CHAR_FFE1_UUID);
        logToConsole("      ✓ FFE1 (logs/text) found.", "success");
        state.charFFE2 = await state.bleService.getCharacteristic(CHAR_FFE2_UUID);
        logToConsole("      ✓ FFE2 (binary/upload) found.", "success");
    } catch (err) {
        logToConsole(`[4/5] ✗ Characteristic error: ${err.name}: ${err.message}`, "error");
        setStatus('disconnected');
        return;
    }

    // ── Step 5: Subscribe to notifications ────────────────────
    try {
        logToConsole("[5/5] Subscribing to FFE1 notifications…");
        await state.charFFE1.startNotifications();
        state.charFFE1.addEventListener('characteristicvaluechanged', handleBleNotification);
        logToConsole("[5/5] ✓ Subscribed to device log stream.", "success");
    } catch (err) {
        logToConsole(`[5/5] ✗ Notification error: ${err.name}: ${err.message}`, "error");
        // Non-fatal — continue without live logs
        logToConsole("      → Continuing without live device logs.", "system");
    }

    // ── Connected ─────────────────────────────────────────────
    state.connectionType = 'ble';
    setStatus('ble', state.bleDevice.name);
    logToConsole("──────────────────────────────────────", "system");
    logToConsole(`✅ BLE connected to ${state.bleDevice.name}!`, "success");
    logToConsole("──────────────────────────────────────", "system");

    setTimeout(() => queryDevice('f'), 100);
    setTimeout(() => queryDevice('b'), 300);
    setTimeout(() => queryDevice('l'), 500);
}

/** Log macOS-specific troubleshooting guidance to the console */
function logBleGuidance() {
    logToConsole("──────────────────────────────────────", "system");
    logToConsole("🔧 Troubleshooting (macOS + Chrome):", "system");
    logToConsole("  1. macOS Bluetooth permission:", "system");
    logToConsole("     System Settings → Privacy & Security → Bluetooth", "system");
    logToConsole("     → Make sure Google Chrome is listed and enabled.", "system");
    logToConsole("  2. Enable Web Bluetooth experimental flag:", "system");
    logToConsole("     chrome://flags/#enable-web-bluetooth-new-permissions-backend", "system");
    logToConsole("     → Set to Enabled, then restart Chrome.", "system");
    logToConsole("  3. Device already paired via macOS System BT?", "system");
    logToConsole("     Forget it in System Settings → Bluetooth first.", "system");
    logToConsole("  4. Try 'Scan All Devices' button if name filter fails.", "system");
    logToConsole("──────────────────────────────────────", "system");
}

function handleBleNotification(event) {
    const text = new TextDecoder().decode(event.target.value);
    processDeviceLog(text);
}

function onBleDisconnected() {
    logToConsole("BLE disconnected (GATT server dropped).", "error");
    cleanConnectionState();
}


// ══════════════════════════════════════════════════════════════
//  WEB SERIAL
// ══════════════════════════════════════════════════════════════
async function connectSerial() {
    logToConsole("Opening serial port picker...", "in");
    try {
        state.serialPort = await navigator.serial.requestPort();
        await state.serialPort.open({ baudRate: 115200 });
        state.serialWriter = state.serialPort.writable.getWriter();
        state.connectionType = 'serial';
        setStatus('serial', 'USB Device');
        logToConsole("Serial connected!", "success");
        readSerialStream();
        setTimeout(() => queryDevice('f'), 150);
        setTimeout(() => queryDevice('b'), 350);
        setTimeout(() => queryDevice('l'), 550);
    } catch (err) {
        logToConsole(`Serial failed: ${err.message}`, "error");
        setStatus('disconnected');
    }
}

async function readSerialStream() {
    state.serialReadActive = true;
    const decoder = new TextDecoder();
    while (state.serialPort && state.serialPort.readable && state.serialReadActive) {
        try {
            state.serialReader = state.serialPort.readable.getReader();
            while (state.serialReadActive) {
                const { value, done } = await state.serialReader.read();
                if (done) break;
                if (value) processDeviceLog(decoder.decode(value));
            }
        } catch (err) {
            logToConsole(`Serial read error: ${err.message}`, "error");
            break;
        } finally {
            if (state.serialReader) { state.serialReader.releaseLock(); state.serialReader = null; }
        }
    }
    if (state.connectionType === 'serial') disconnectDevice();
}

// ══════════════════════════════════════════════════════════════
//  DEVICE LOG PROCESSOR  (shared BLE + Serial)
// ══════════════════════════════════════════════════════════════
function processDeviceLog(text) {
    const lines = text.split(/[\r\n]+/);
    lines.forEach(line => {
        const t = line.trim();
        if (!t) return;
        logToConsole(`[Device] ${t}`, "out");

        // Quick telemetry parsing
        if (t.startsWith('ib')) document.getElementById('txtBattery').innerHTML = `<i class="ph-bold ph-battery-medium"></i> ${t.substring(2)}%`;
        if (t.startsWith('if')) document.getElementById('txtFirmware').textContent = `v${t.substring(2)}`;
        if (t.startsWith('il') && t.substring(2) === '1') document.getElementById('txtBattery').innerHTML = '<i class="ph-bold ph-lightning"></i> Charging';

        // Live button highlight on real click events
        if (t.startsWith('click ')) {
            const id = parseInt(t.substring(6));
            if (!isNaN(id)) {
                const el = document.querySelector(`.hw-button[data-id="${id}"]`);
                if (el) { el.classList.add('simulating-press'); setTimeout(() => el.classList.remove('simulating-press'), 150); }
            }
        }

        // ★ Diagnostic: accumulate FFE1 responses for script listing / extraction ★
        if (diagState.extracting) {
            diagState.extractBuffer += t + '\n';
            // Reset the idle-end timer on every new chunk
            if (diagState.extractTimeout) clearTimeout(diagState.extractTimeout);
            diagState.extractTimeout = setTimeout(() => {
                diagState.extracting = false;
                if (diagState.extractResolve) {
                    diagState.extractResolve(diagState.extractBuffer);
                    diagState.extractResolve = null;
                }
            }, 600); // 600ms silence = transfer complete
        }
    });
}

// ══════════════════════════════════════════════════════════════
//  COMMUNICATION HELPERS
// ══════════════════════════════════════════════════════════════
async function queryDevice(param) {
    const data = new TextEncoder().encode(`/?${param}\n`);
    await sendRaw(data);
}

async function sendRaw(data) {
    try {
        if (state.connectionType === 'ble' && state.charFFE1) {
            await state.charFFE1.writeValueWithoutResponse(data);
        } else if (state.connectionType === 'serial' && state.serialWriter) {
            await state.serialWriter.write(data);
        }
    } catch (e) { logToConsole(`Send error: ${e.message}`, "error"); }
}

async function sendBinary(data) {
    try {
        if (state.connectionType === 'ble' && state.charFFE2) {
            await state.charFFE2.writeValueWithoutResponse(data);
        } else if (state.connectionType === 'serial' && state.serialWriter) {
            await state.serialWriter.write(data);
        }
    } catch (e) { logToConsole(`Binary send error: ${e.message}`, "error"); }
}

// Wait for next batch of FFE1 data for `ms` milliseconds of silence
function waitForDeviceResponse(ms = 800) {
    diagState.extractBuffer  = '';
    diagState.extracting     = true;
    diagState.extractTimeout = null;
    return new Promise(resolve => {
        diagState.extractResolve = resolve;
        // Absolute fallback: stop after 5 s regardless
        setTimeout(() => {
            if (diagState.extracting) {
                diagState.extracting = false;
                resolve(diagState.extractBuffer);
            }
        }, 5000);
    });
}

async function disconnectDevice() {
    logToConsole("Disconnecting...");
    state.serialReadActive = false;
    if (state.serialReader)  { try { await state.serialReader.cancel(); } catch (e) {} }
    if (state.serialWriter)  { try { state.serialWriter.releaseLock(); }  catch (e) {} state.serialWriter = null; }
    if (state.serialPort)    { try { await state.serialPort.close(); }    catch (e) {} state.serialPort   = null; }
    if (state.bleDevice && state.bleDevice.gatt.connected) state.bleDevice.gatt.disconnect();
    cleanConnectionState();
}

function cleanConnectionState() {
    state.connectionType = null; state.bleDevice = null; state.bleServer = null;
    state.bleService = null; state.charFFE1 = null; state.charFFE2 = null;
    setStatus('disconnected');
    document.getElementById('btnConnectBle').classList.remove('hidden');
    document.getElementById('btnConnectSerial').classList.remove('hidden');
    document.getElementById('btnDisconnect').classList.add('hidden');
    document.getElementById('btnBurn').classList.add('disabled');
    document.getElementById('btnDiagnostic').classList.add('disabled');
    logToConsole("Disconnected.");
}

function setStatus(type, deviceName = '-') {
    const ind = document.getElementById('statusIndicator');
    const dn  = document.getElementById('txtDeviceName');
    if (type === 'disconnected') {
        ind.className = 'value badge badge-disconnected'; ind.textContent = 'Disconnected';
        dn.textContent = '-';
        document.getElementById('txtBattery').innerHTML  = '<i class="ph ph-battery-warning"></i> -';
        document.getElementById('txtFirmware').textContent = '-';
        document.getElementById('btnConnectBle').classList.remove('hidden');
        document.getElementById('btnConnectBleAll').classList.remove('hidden');
        document.getElementById('btnConnectSerial').classList.remove('hidden');
        document.getElementById('btnDisconnect').classList.add('hidden');
        document.getElementById('btnBurn').classList.add('disabled');
        document.getElementById('btnDiagnostic').classList.add('disabled');
    } else if (type === 'connecting') {
        ind.className = 'value badge badge-connecting'; ind.textContent = 'Connecting...';
    } else if (type === 'ble') {
        ind.className = 'value badge badge-connected-ble'; ind.textContent = 'Connected (BLE)';
        dn.textContent = deviceName;
        document.getElementById('btnConnectBle').classList.add('hidden');
        document.getElementById('btnConnectBleAll').classList.add('hidden');
        document.getElementById('btnConnectSerial').classList.add('hidden');
        document.getElementById('btnDisconnect').classList.remove('hidden');
        document.getElementById('btnBurn').classList.remove('disabled');
        document.getElementById('btnDiagnostic').classList.remove('disabled');
    } else if (type === 'serial') {
        ind.className = 'value badge badge-connected-usb'; ind.textContent = 'Connected (USB)';
        dn.textContent = deviceName;
        document.getElementById('btnConnectBle').classList.add('hidden');
        document.getElementById('btnConnectBleAll').classList.add('hidden');
        document.getElementById('btnConnectSerial').classList.add('hidden');
        document.getElementById('btnDisconnect').classList.remove('hidden');
        document.getElementById('btnBurn').classList.remove('disabled');
        document.getElementById('btnDiagnostic').classList.remove('disabled');
    }
}

// ══════════════════════════════════════════════════════════════
//  FIRMWARE UPLOAD (BURN)
// ══════════════════════════════════════════════════════════════
async function burnScript() {
    if (document.getElementById('btnBurn').classList.contains('disabled')) return;
    const code     = getActiveScriptCode();
    const bytes    = new TextEncoder().encode(code);
    const burnBtn  = document.getElementById('btnBurn');
    const source   = state.customScriptCode !== null ? `uploaded file "${state.customScriptName}"` : 'generated script';
    logToConsole(`[Burn] Starting — ${bytes.length} bytes (${source})`, 'in');
    burnBtn.classList.add('disabled');
    burnBtn.innerHTML = '<i class="ph ph-hourglass-high"></i> Uploading...';

    try {
        const chunkSize = 256;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const chunk  = bytes.subarray(offset, offset + chunkSize);
            const packet = new Uint8Array(3 + chunk.length);
            packet[0] = CMD_UPLOAD; packet[1] = offset & 0xFF; packet[2] = (offset >> 8) & 0xFF;
            packet.set(chunk, 3);
            await sendBinary(packet);
            const pct = Math.min(100, Math.round(((offset + chunk.length) / bytes.length) * 100));
            burnBtn.innerHTML = `<i class="ph ph-hourglass-high"></i> Uploading ${pct}%`;
            await delay(20);
        }
        await sendBinary(new Uint8Array([CMD_FINALIZE]));
        await delay(200);
        const persistName   = state.customScriptCode !== null
            ? state.customScriptName.replace(/\.js$/i, '')
            : 'remote_keypad';
        const filenameBytes = new TextEncoder().encode(persistName);
        const persistPkt    = new Uint8Array(1 + filenameBytes.length);
        persistPkt[0] = CMD_PERSIST; persistPkt.set(filenameBytes, 1);
        await sendBinary(persistPkt);
        logToConsole(`[Burn] Done! '${persistName}' saved to flash.`, "success");
        const led = document.getElementById('hardwareLed');
        led.className = 'hardware-led led-green';
        setTimeout(() => { led.className = 'hardware-led'; }, 800);
    } catch (e) {
        logToConsole(`[Burn] Error: ${e.message}`, "error");
    } finally {
        burnBtn.classList.remove('disabled');
        burnBtn.innerHTML = '<i class="ph-bold ph-lightning-fill"></i> Upload & Program Remote';
    }
}

// ══════════════════════════════════════════════════════════════
//  ★ DIAGNOSTIC FEATURE ★
// ══════════════════════════════════════════════════════════════

/** Open the diagnostic modal and reset to phase 0. */
function openDiagnosticModal() {
    if (document.getElementById('btnDiagnostic').classList.contains('disabled')) return;
    diagState.phase = 0;
    diagState.scriptList   = [];
    diagState.currentScript = null;
    diagState.analysisText  = '';
    diagState.extractBuffer = '';
    diagState.extracting    = false;

    // Show phase 0 UI
    setDiagPhase(0);
    updateDiagStepUI(0);

    // Restore pre-fill of API key if cached in session
    if (diagState.geminiKey) {
        document.getElementById('txtGeminiKey').value = diagState.geminiKey;
    }

    document.getElementById('diagnosticModal').classList.remove('hidden');
}

function closeDiagnosticModal() {
    document.getElementById('diagnosticModal').classList.add('hidden');
    diagState.extracting = false;
    if (diagState.extractTimeout) clearTimeout(diagState.extractTimeout);
}

/** Show only the requested phase panel. */
function setDiagPhase(phase) {
    ['diagPhaseStart', 'diagPhaseList', 'diagPhaseCode', 'diagPhaseAnalysis', 'diagPhaseSave'].forEach((id, i) => {
        document.getElementById(id).classList.toggle('hidden', i !== phase);
    });
    diagState.phase = phase;
}

/** Update the step dots in the progress bar. */
function updateDiagStepUI(activeStep) {
    // 0=idle(no active), 1=list, 2=code, 3=analysis, 4=save
    for (let i = 1; i <= 4; i++) {
        const el   = document.getElementById(`diagStep${i}`);
        const line = el.nextElementSibling; // the .diag-step-line (except last)
        el.classList.remove('active', 'done');
        if (i < activeStep)       { el.classList.add('done'); if (line && line.classList.contains('diag-step-line')) line.classList.add('done'); }
        else if (i === activeStep) { el.classList.add('active'); if (line && line.classList.contains('diag-step-line')) line.classList.remove('done'); }
        else                       { if (line && line.classList.contains('diag-step-line')) line.classList.remove('done'); }
    }
}

// ─── Phase 1: List Scripts ─────────────────────────────────────
async function runDiagnosticPhase1() {
    const keyInput = document.getElementById('txtGeminiKey').value.trim();
    diagState.geminiKey = keyInput; // remember for this session

    setDiagPhase(1);
    updateDiagStepUI(1);
    document.getElementById('diagStatusText').textContent = 'Querying device for saved scripts…';
    document.getElementById('diagScriptList').classList.add('hidden');

    logToConsole("[Diagnostic] Sending MAGISCRIPT_DIR command (0x05)…", "in");

    // Send CMD_DIR to FFE2 and listen for FFE1 response
    const responsePromise = waitForDeviceResponse();
    await sendBinary(new Uint8Array([CMD_DIR]));
    const response = await responsePromise;

    logToConsole(`[Diagnostic] DIR response received (${response.length} chars).`);

    // Parse script names from the response
    // Expected format: one filename per line, possibly with size info like "remote_keypad.js 1234"
    const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
    const scripts = lines
        .filter(l => !l.startsWith('[') && !l.startsWith('#') && l.length > 0)
        .map(l => l.split(/\s+/)[0]) // take first token as filename
        .filter(name => name.length > 0);

    if (scripts.length === 0) {
        // Fallback: if device doesn't respond or DIR isn't supported, allow manual entry
        diagState.scriptList = ['remote_keypad', 'main', 'startup'];
        document.getElementById('diagStatusText').textContent = 'Device did not list scripts. Showing common defaults — select one to extract:';
    } else {
        diagState.scriptList = scripts;
        document.getElementById('diagStatusText').textContent = `Found ${scripts.length} script(s) on device:`;
    }

    // Build script list UI
    const itemsEl = document.getElementById('diagScriptItems');
    itemsEl.innerHTML = '';
    diagState.scriptList.forEach(name => {
        const row = document.createElement('div');
        row.className = 'diag-script-item';
        row.innerHTML = `
            <span class="script-name"><i class="ph ph-file-js" style="color:var(--accent-amber);margin-right:6px"></i>${name}</span>
            <button class="script-extract-btn"><i class="ph-bold ph-download-simple"></i> Extract</button>
        `;
        row.querySelector('.script-extract-btn').addEventListener('click', () => runDiagnosticPhase2(name));
        itemsEl.appendChild(row);
    });

    document.getElementById('diagScriptList').classList.remove('hidden');
    updateDiagStepUI(1);
}

// ─── Phase 2: Extract Script Code ─────────────────────────────
async function runDiagnosticPhase2(scriptName) {
    setDiagPhase(1); // keep phase 1 visible but show status
    document.getElementById('diagScriptList').classList.add('hidden');
    document.getElementById('diagStatusText').textContent = `Extracting "${scriptName}" from device…`;
    updateDiagStepUI(2);

    logToConsole(`[Diagnostic] Sending CMD_LOAD for "${scriptName}" (0x06)…`, "in");

    // Build load packet: [0x06][filename bytes]
    const nameBytes = new TextEncoder().encode(scriptName);
    const loadPkt   = new Uint8Array(1 + nameBytes.length);
    loadPkt[0] = CMD_LOAD; loadPkt.set(nameBytes, 1);

    const responsePromise = waitForDeviceResponse(1000);
    await sendBinary(loadPkt);
    const rawCode = await responsePromise;

    logToConsole(`[Diagnostic] Code received — ${rawCode.length} chars.`, "success");

    // Clean up the code: strip any prefixed protocol lines that start with known markers
    const codeLines = rawCode.split('\n').filter(l => !l.match(/^(OK|ERR|>|#)/)).join('\n').trim();
    const finalCode = codeLines.length > 10
        ? codeLines
        : `// Code could not be fully extracted from device.\n// Raw response (${rawCode.length} bytes):\n${rawCode}`;

    diagState.currentScript = { name: scriptName, code: finalCode };

    // Show Phase 2: Extracted Code
    document.getElementById('diagExtractedFilename').textContent = scriptName;
    const diagBlock = document.getElementById('diagCodeBlock');
    diagBlock.textContent = finalCode;
    if (window.Prism) Prism.highlightElement(diagBlock);

    // Pre-fill preset name
    const humanName = scriptName.replace(/[_-]/g, ' ').replace(/\.js$/i, '').trim();
    document.getElementById('txtPresetName').value = humanName || scriptName;

    // Hide analysis result from a previous run
    document.getElementById('diagAnalysisResult').classList.add('hidden');
    document.getElementById('diagAfterAnalysisActions').style.display = 'none';
    document.getElementById('diagAnalysisStatus').classList.add('hidden');

    setDiagPhase(2);
    updateDiagStepUI(2);
}

// ─── Phase 3: Gemini AI Analysis ──────────────────────────────
async function runDiagnosticPhase3() {
    const apiKey = document.getElementById('txtGeminiKey').value.trim();
    if (!apiKey) {
        alert('Please enter your Gemini API key in the start screen to use AI analysis.');
        return;
    }
    diagState.geminiKey = apiKey;

    setDiagPhase(3);
    updateDiagStepUI(3);
    document.getElementById('diagAnalysisStatus').classList.remove('hidden');
    document.getElementById('diagAnalysisResult').classList.add('hidden');
    document.getElementById('diagAfterAnalysisActions').style.display = 'none';

    const code = diagState.currentScript?.code || '';
    logToConsole("[Diagnostic] Sending code to Gemini for analysis…", "in");

    const prompt = `You are an expert hardware developer and MagiScript analyst for the Electricks Atom 2 programmable remote.

Analyse the following MagiScript code extracted from the remote device and produce a plain-English behaviour report.

Your report must clearly describe:
1. **What the remote does** — its overall purpose and behaviour in 1-2 sentences.
2. **Button mappings** — what each button does (list them clearly).
3. **Timing & accumulation logic** — any delays, sum logic, or timeouts.
4. **Connectivity** — what devices or services it connects to (Bluetooth, keyboard HID, etc.).
5. **Feedback** — any LED colours, vibration patterns, or audio cues.
6. **Notable features or quirks** — anything unusual or worth noting for a developer.

Be concise but complete. Use bullet points where helpful.

--- BEGIN EXTRACTED CODE ---
${code}
--- END EXTRACTED CODE ---`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 1500 }
                })
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const analysis = data?.candidates?.[0]?.content?.parts?.[0]?.text || '(No response from Gemini)';
        diagState.analysisText = analysis;

        document.getElementById('diagAnalysisText').textContent = analysis;
        document.getElementById('diagAnalysisStatus').classList.add('hidden');
        document.getElementById('diagAnalysisResult').classList.remove('hidden');
        document.getElementById('diagAfterAnalysisActions').style.display = 'flex';

        logToConsole("[Diagnostic] Gemini analysis complete.", "success");

        // Pre-fill notes with first 200 chars of analysis
        document.getElementById('txtPresetNotes').value = analysis.substring(0, 200) + (analysis.length > 200 ? '…' : '');

    } catch (err) {
        document.getElementById('diagAnalysisStatus').innerHTML =
            `<i class="ph ph-warning" style="color:var(--accent-danger);font-size:20px"></i>
             <span style="color:var(--accent-danger)">Analysis failed: ${err.message}</span>`;
        logToConsole(`[Diagnostic] Gemini error: ${err.message}`, "error");
    }

    updateDiagStepUI(3);
}

// ─── Phase 4: Save Preset ──────────────────────────────────────
function goToDiagnosticPhase4() {
    setDiagPhase(4);
    updateDiagStepUI(4);
}

function savePresetFromDiag() {
    const name  = document.getElementById('txtPresetName').value.trim()   || 'Unnamed Preset';
    const notes = document.getElementById('txtPresetNotes').value.trim();
    const code  = diagState.currentScript?.code || '';
    const analysis = diagState.analysisText;

    const preset = {
        id:        Date.now().toString(),
        name,
        notes,
        code,
        analysis,
        scriptName: diagState.currentScript?.name || 'unknown',
        savedAt:    new Date().toLocaleString()
    };

    const presets = loadPresetsFromStorage();
    presets.unshift(preset);
    savePresetsToStorage(presets);
    renderPresetsLibrary();

    logToConsole(`[Diagnostic] Preset "${name}" saved to library.`, "success");

    // Update step 4 to done and flash feedback
    updateDiagStepUI(5); // 5 = all done
    document.getElementById('btnSavePreset').innerHTML = '<i class="ph ph-check"></i> Saved!';
    setTimeout(() => {
        document.getElementById('btnSavePreset').innerHTML = '<i class="ph-bold ph-floppy-disk"></i> Save to Library';
        closeDiagnosticModal();
    }, 1400);
}

function downloadPresetTxt() {
    const name     = document.getElementById('txtPresetName').value.trim()  || 'preset';
    const notes    = document.getElementById('txtPresetNotes').value.trim();
    const code     = diagState.currentScript?.code || '';
    const analysis = diagState.analysisText;
    const device   = document.getElementById('txtDeviceName').textContent || 'Unknown Device';
    const firmware = document.getElementById('txtFirmware').textContent   || 'Unknown';

    const content = [
        `══════════════════════════════════════════════`,
        `  MAGIPORTAL DIAGNOSTIC PRESET`,
        `══════════════════════════════════════════════`,
        `  Preset Name  : ${name}`,
        `  Script Name  : ${diagState.currentScript?.name || 'N/A'}`,
        `  Device       : ${device}`,
        `  Firmware     : ${firmware}`,
        `  Captured At  : ${new Date().toLocaleString()}`,
        `══════════════════════════════════════════════`,
        '',
        '── NOTES / DESCRIPTION ─────────────────────',
        notes || '(none)',
        '',
        '── GEMINI AI BEHAVIOUR ANALYSIS ────────────',
        analysis || '(AI analysis was not performed)',
        '',
        '── EXTRACTED SOURCE CODE ───────────────────',
        code,
        ''
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_preset.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logToConsole(`[Diagnostic] Preset exported: ${a.download}`, "success");
}

// ══════════════════════════════════════════════════════════════
//  PRESETS LIBRARY (localStorage)
// ══════════════════════════════════════════════════════════════
function loadPresetsFromStorage() {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); }
    catch (e) { return []; }
}

function savePresetsToStorage(presets) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function renderPresetsLibrary() {
    const presets = loadPresetsFromStorage();
    const container = document.getElementById('presetsList');

    if (presets.length === 0) {
        container.innerHTML = `<div class="presets-empty"><i class="ph ph-folder-open"></i><span>No presets saved yet. Run a diagnostic to capture a preset.</span></div>`;
        return;
    }

    container.innerHTML = '';
    presets.forEach(preset => {
        const card = document.createElement('div');
        card.className = 'preset-card';
        card.innerHTML = `
            <div class="preset-card-header">
                <div class="preset-card-name">
                    <i class="ph ph-bookmark-simple"></i>
                    ${escHtml(preset.name)}
                </div>
                <span class="preset-card-meta">${escHtml(preset.savedAt)}</span>
            </div>
            <div class="preset-card-notes">${escHtml(preset.notes?.substring(0, 120) || '(No notes)')}</div>
            <div class="preset-card-actions">
                <button class="btn-preset-action" data-action="view" data-id="${preset.id}">
                    <i class="ph ph-eye"></i> View Code
                </button>
                <button class="btn-preset-action" data-action="download" data-id="${preset.id}">
                    <i class="ph ph-download"></i> Export .txt
                </button>
                <button class="btn-preset-action danger" data-action="delete" data-id="${preset.id}">
                    <i class="ph ph-trash"></i> Delete
                </button>
            </div>
        `;
        card.querySelectorAll('.btn-preset-action').forEach(btn => {
            btn.addEventListener('click', () => handlePresetAction(btn.dataset.action, btn.dataset.id));
        });
        container.appendChild(card);
    });
}

function handlePresetAction(action, id) {
    const presets = loadPresetsFromStorage();
    const preset  = presets.find(p => p.id === id);
    if (!preset) return;

    if (action === 'view') {
        // Load the saved code into the code preview tab
        const block = document.getElementById('codeBlock');
        block.textContent = preset.code;
        if (window.Prism) Prism.highlightElement(block);
        // Switch to the Code tab
        document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById('tabBtnCode').classList.add('active');
        document.getElementById('tabCode').classList.add('active');
        logToConsole(`[Library] Loaded preset "${preset.name}" into code preview.`);
    } else if (action === 'download') {
        // Temporarily populate diagState for download reuse
        const prev = diagState.currentScript;
        const prevAnalysis = diagState.analysisText;
        diagState.currentScript = { name: preset.scriptName, code: preset.code };
        diagState.analysisText  = preset.analysis || '';
        document.getElementById('txtPresetName').value  = preset.name;
        document.getElementById('txtPresetNotes').value = preset.notes;
        downloadPresetTxt();
        diagState.currentScript = prev;
        diagState.analysisText  = prevAnalysis;
    } else if (action === 'delete') {
        if (!confirm(`Delete preset "${preset.name}"?`)) return;
        savePresetsToStorage(presets.filter(p => p.id !== id));
        renderPresetsLibrary();
        logToConsole(`[Library] Preset "${preset.name}" deleted.`);
    }
}

function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ──────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
