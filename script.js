// ========== CONFIGURATION ==========
let GITHUB_USER = "";
let GITHUB_REPO = "";
let GITHUB_TOKEN = "";
const BRANCH = "session";
let API_BASE = "";
let POLL_INTERVAL_MS = 10000;  // 10 seconds – much gentler
// ===================================

let lastScreenshotEtag = null;
let lastUrlEtag = null;
let lastClipboardText = "";
let pendingCommand = false;

// Rate limit display (now rarely changes)
function updateTokenCounter(remaining) {
    if (remaining !== undefined) {
        document.getElementById('tokenCounter').innerText = `API: ${remaining}/5000`;
    }
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { Authorization: `token ${GITHUB_TOKEN}`, ...options.headers }
    });
    const remaining = response.headers.get('X-RateLimit-Remaining');
    updateTokenCounter(parseInt(remaining));
    if (response.status === 403 && remaining === '0') {
        log("⚠️ Rate limit exceeded, waiting 60 seconds...");
        await new Promise(resolve => setTimeout(resolve, 60000));
        return apiFetch(url, options);
    }
    return response;
}

function log(msg) {
    const logDiv = document.getElementById('log');
    const timestamp = new Date().toLocaleTimeString();
    logDiv.innerHTML = `[${timestamp}] ${msg}\n` + logDiv.innerHTML;
    if (logDiv.children.length > 200) logDiv.innerHTML = logDiv.innerHTML.slice(0, 5000);
}

async function loadConfig() {
    try {
        const resp = await fetch('config.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const cfg = await resp.json();
        GITHUB_USER = cfg.github_user;
        GITHUB_REPO = cfg.github_repo;
        GITHUB_TOKEN = cfg.github_token;
        API_BASE = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}`;
        log(`✅ Config loaded – ${GITHUB_USER}/${GITHUB_REPO}`);
        return true;
    } catch (err) {
        log(`❌ Missing config.json: ${err.message}`);
        document.getElementById('status').innerHTML = '⚠️ Missing config.json';
        return false;
    }
}

// Fetch a raw file from GitHub, returning { blob, notModified } using ETag
async function fetchRawWithEtag(filePath, etagRef) {
    const url = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/${filePath}`;
    const headers = {};
    if (etagRef.value) headers['If-None-Match'] = etagRef.value;
    const resp = await fetch(url, { headers });
    if (resp.status === 304) {
        return { notModified: true };
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const newEtag = resp.headers.get('etag');
    if (newEtag) etagRef.value = newEtag;
    const blob = await resp.blob();
    return { blob, notModified: false };
}

// State polling – no API calls when nothing changed
async function pollState() {
    if (!GITHUB_USER || pendingCommand) return;
    try {
        // Screenshot
        const screenshotRef = { value: lastScreenshotEtag };
        const screenRes = await fetchRawWithEtag('screenshot.png', screenshotRef);
        lastScreenshotEtag = screenshotRef.value;
        if (!screenRes.notModified && screenRes.blob) {
            const url = URL.createObjectURL(screenRes.blob);
            document.getElementById('screenshot').src = url;
            document.getElementById('status').innerHTML = '✅ Connected';
            log('📸 Screenshot updated');
        }

        // Current URL
        const urlRef = { value: lastUrlEtag };
        const urlRes = await fetchRawWithEtag('current_url.txt', urlRef);
        lastUrlEtag = urlRef.value;
        if (!urlRes.notModified && urlRes.blob) {
            const text = await urlRes.blob.text();
            document.getElementById('remoteUrlDisplay').value = text;
            log(`🌐 Remote URL: ${text}`);
        }

        // Clipboard (optional – rarely changes, but no API cost)
        try {
            const clipResp = await fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/clipboard.txt`);
            if (clipResp.ok) {
                const clipText = await clipResp.text();
                if (clipText !== lastClipboardText) {
                    lastClipboardText = clipText;
                    document.getElementById('linkDisplay').innerText = clipText.substring(0, 70) || '(empty)';
                    document.getElementById('linkDisplay').href = clipText.startsWith('http') ? clipText : '#';
                    log(`📋 Clipboard: ${clipText.substring(0, 100)}`);
                }
            }
        } catch (e) { /* ignore */ }

    } catch (err) {
        console.error('State poll error:', err);
    }
}

function generateCommandId() {
    return Date.now() + '-' + Math.random().toString(36).substring(2, 10);
}

async function sendCommand(command) {
    if (!API_BASE) return;
    const commandWithId = { ...command, id: generateCommandId() };
    log(`📤 Sending command: ${commandWithId.action} (id: ${commandWithId.id})`);
    document.getElementById('status').innerHTML = '⏳ Sending...';
    pendingCommand = true;

    try {
        const refRes = await apiFetch(`${API_BASE}/git/ref/heads/${BRANCH}`);
        const refData = await refRes.json();
        const baseSha = refData.object.sha;

        const cmdContent = JSON.stringify(commandWithId, null, 2);
        const blobRes = await apiFetch(`${API_BASE}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content: btoa(cmdContent), encoding: 'base64' })
        });
        const blobData = await blobRes.json();

        const treeRes = await apiFetch(`${API_BASE}/git/trees`, {
            method: 'POST',
            body: JSON.stringify({
                base_tree: baseSha,
                tree: [{ path: 'command.json', mode: '100644', type: 'blob', sha: blobData.sha }]
            })
        });
        const newTree = await treeRes.json();

        const commitRes = await apiFetch(`${API_BASE}/git/commits`, {
            method: 'POST',
            body: JSON.stringify({
                message: `Cmd: ${command.action}`,
                tree: newTree.sha,
                parents: [baseSha]
            })
        });
        const newCommit = await commitRes.json();

        await apiFetch(`${API_BASE}/git/refs/heads/${BRANCH}`, {
            method: 'PATCH',
            body: JSON.stringify({ sha: newCommit.sha, force: true })
        });

        document.getElementById('status').innerHTML = '🔄 Waiting for remote...';
        log('Command pushed, waiting for execution...');

        // Wait for the runner to process by polling the branch SHA
        const startSha = newCommit.sha;
        let attempts = 0;
        const maxAttempts = 40;   // ~2 minutes at 3s intervals
        const waitInterval = 3000;
        await new Promise((resolve, reject) => {
            const interval = setInterval(async () => {
                attempts++;
                try {
                    const checkRef = await apiFetch(`${API_BASE}/git/ref/heads/${BRANCH}`);
                    const checkData = await checkRef.json();
                    if (checkData.object.sha !== startSha) {
                        clearInterval(interval);
                        resolve();
                    } else if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        reject(new Error('Timeout'));
                    }
                } catch (e) {
                    log(`Check error: ${e.message}`);
                }
            }, waitInterval);
        });

        pendingCommand = false;
        document.getElementById('status').innerHTML = '✅ Done';
        log('Remote acknowledged command');
        // Immediately refresh the screenshot and URL
        lastScreenshotEtag = null;   // force re-download
        lastUrlEtag = null;
        await pollState();

    } catch (err) {
        log(`❌ Send error: ${err.message}`);
        document.getElementById('status').innerHTML = '❌ Failed';
        pendingCommand = false;
    }
}

function initEventListeners() {
    const screenshot = document.getElementById('screenshot');
    screenshot.addEventListener('click', (e) => {
        const rect = e.target.getBoundingClientRect();
        const scaleX = e.target.naturalWidth / rect.width;
        const scaleY = e.target.naturalHeight / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        sendCommand({ action: 'click-coordinates', x: Math.round(x), y: Math.round(y) });
    });

    screenshot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const rect = e.target.getBoundingClientRect();
        const scaleX = e.target.naturalWidth / rect.width;
        const scaleY = e.target.naturalHeight / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        sendCommand({ action: 'rightclick-coordinates', x: Math.round(x), y: Math.round(y) });
    });

    document.getElementById('goBtn').onclick = () => {
        let url = document.getElementById('navUrlInput').value.trim();
        if (!url) return;
        if (!url.startsWith('http://') && !url.startsWith('https://'))
            url = 'https://' + url;
        sendCommand({ action: 'goto', url: url });
    };
    document.getElementById('manualScreenshotBtn').onclick = () => sendCommand({ action: 'screenshot' });
    document.getElementById('typeBtn').onclick = () => {
        const text = document.getElementById('typeText').value;
        if (text) sendCommand({ action: 'type', text: text });
    };
    document.getElementById('enterBtn').onclick = () => sendCommand({ action: 'press', key: 'Enter' });
    document.getElementById('scrollUpBtn').onclick = () => sendCommand({ action: 'scroll', text: '-200' });
    document.getElementById('scrollDownBtn').onclick = () => sendCommand({ action: 'scroll', text: '200' });
    document.getElementById('copyRemoteClipboardBtn').onclick = () => sendCommand({ action: 'get-clipboard' });
    document.getElementById('setRemoteClipboardBtn').onclick = () => {
        const txt = prompt('Enter text to copy to remote clipboard:');
        if (txt !== null) sendCommand({ action: 'set-clipboard', text: txt });
    };
    document.getElementById('stopBrowserBtn').onclick = () => {
        if (confirm('Stop the remote browser?')) sendCommand({ action: 'stop' });
    };
    document.getElementById('copyLinkBtn').onclick = () => {
        const link = document.getElementById('linkDisplay').href;
        if (link && link !== '#') navigator.clipboard.writeText(link);
    };
    document.getElementById('refreshBtn').onclick = () => {
        lastScreenshotEtag = null;
        lastUrlEtag = null;
        pollState();
    };
    document.getElementById('sendManualBtn').onclick = () => {
        try {
            const cmd = JSON.parse(document.getElementById('manualCommand').value);
            sendCommand(cmd);
        } catch(e) { alert('Invalid JSON: ' + e.message); }
    };
}

// Start
(async function start() {
    if (await loadConfig()) {
        initEventListeners();
        // Poll state every 10 seconds (no API burn)
        setInterval(pollState, POLL_INTERVAL_MS);
        await pollState();
        log(`✅ Viewer started. Polling every ${POLL_INTERVAL_MS/1000}s (ETags – no API).`);
    } else {
        log('❌ Cannot start – create config.json');
    }
})();