// ========== CONFIGURATION - DO NOT HARDCODE SECRETS ==========
let GITHUB_USER = "";
let GITHUB_REPO = "";
let GITHUB_TOKEN = "";
const BRANCH = "session";
let API_BASE = "";
let POLL_INTERVAL_MS = 5000;  // 5 seconds
// =============================================================

let lastScreenshotSha = null;
let lastClipboardText = "";
let lastCommitSha = null;

function log(msg) {
    const logDiv = document.getElementById('log');
    const timestamp = new Date().toLocaleTimeString();
    logDiv.innerHTML = `[${timestamp}] ${msg}\n` + logDiv.innerHTML;
    if (logDiv.children.length > 200) logDiv.innerHTML = logDiv.innerHTML.slice(0, 5000);
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { Authorization: `token ${GITHUB_TOKEN}`, ...options.headers }
    });
    // Update rate limit display from response headers
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    if (remaining !== null && limit !== null) {
        document.getElementById('tokenCounter').innerText = `API: ${remaining}/${limit}`;
    } else {
        // fallback: increment counter manually (less accurate)
        let current = parseInt(document.getElementById('tokenCounter').innerText.split(':')[1]?.split('/')[0]?.trim() || "0");
        document.getElementById('tokenCounter').innerText = `API: ${current+1}/?`;
    }
    if (response.status === 403 && remaining === '0') {
        log("⚠️ API rate limit exceeded! Waiting 60 seconds...");
        await new Promise(resolve => setTimeout(resolve, 60000));
        return apiFetch(url, options);
    }
    return response;
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
        log(`❌ Failed to load config.json: ${err.message}`);
        document.getElementById('status').innerHTML = '⚠️ Missing config.json';
        return false;
    }
}

async function fetchLatestState() {
    if (!API_BASE) return;
    try {
        const refRes = await apiFetch(`${API_BASE}/git/ref/heads/${BRANCH}`);
        if (!refRes.ok) throw new Error(`Branch fetch failed: ${refRes.status}`);
        const refData = await refRes.json();
        const commitSha = refData.object.sha;

        if (commitSha === lastCommitSha) return; // no change
        lastCommitSha = commitSha;

        const treeRes = await apiFetch(`${API_BASE}/git/trees/${commitSha}?recursive=1`);
        const treeData = await treeRes.json();
        const files = treeData.tree;

        const screenshotItem = files.find(f => f.path === 'screenshot.png');
        const clipboardItem = files.find(f => f.path === 'clipboard.txt');
        const urlItem = files.find(f => f.path === 'current_url.txt');

        if (screenshotItem && screenshotItem.sha !== lastScreenshotSha) {
            lastScreenshotSha = screenshotItem.sha;
            const imgUrl = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/screenshot.png?cache=${Date.now()}`;
            document.getElementById('screenshot').src = imgUrl;
            document.getElementById('status').innerHTML = '✅ Connected';
            log('📸 Screenshot updated');
        }

        if (clipboardItem) {
            const clipRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/clipboard.txt?cache=${Date.now()}`);
            const clipText = await clipRes.text();
            if (clipText !== lastClipboardText) {
                lastClipboardText = clipText;
                document.getElementById('linkDisplay').innerText = clipText.substring(0, 70) || '(empty)';
                document.getElementById('linkDisplay').href = clipText.startsWith('http') ? clipText : '#';
                log(`📋 Clipboard: ${clipText.substring(0, 100)}`);
            }
        }

        if (urlItem) {
            const urlRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/current_url.txt?cache=${Date.now()}`);
            const currentUrl = await urlRes.text();
            document.getElementById('remoteUrlDisplay').value = currentUrl;
            log(`🌐 Remote URL: ${currentUrl}`);
        }
    } catch (err) {
        console.error(err);
        document.getElementById('status').innerHTML = '⚠️ API error';
        log(`Error: ${err.message}`);
    }
}

async function sendCommand(command) {
    if (!API_BASE) return;
    log(`📤 Sending command: ${JSON.stringify(command)}`);
    document.getElementById('status').innerHTML = '⏳ Sending...';

    try {
        const refRes = await apiFetch(`${API_BASE}/git/ref/heads/${BRANCH}`);
        if (!refRes.ok) throw new Error(`Get ref failed: ${refRes.status}`);
        const refData = await refRes.json();
        const baseSha = refData.object.sha;
        log(`Current commit SHA: ${baseSha}`);

        const cmdContent = JSON.stringify(command, null, 2);
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
                message: `Local command: ${command.action}`,
                tree: newTree.sha,
                parents: [baseSha]
            })
        });
        const newCommit = await commitRes.json();

        const updateRes = await apiFetch(`${API_BASE}/git/refs/heads/${BRANCH}`, {
            method: 'PATCH',
            body: JSON.stringify({ sha: newCommit.sha, force: true })
        });
        if (!updateRes.ok) throw new Error(`Update branch failed: ${updateRes.status}`);
        log(`Branch ${BRANCH} force‑updated to commit ${newCommit.sha.substring(0,7)}`);

        document.getElementById('status').innerHTML = '🔄 Waiting for remote...';
        log('Command pushed, waiting for execution...');

        let attempts = 0;
        const interval = setInterval(async () => {
            attempts++;
            await fetchLatestState();
            if (attempts >= 8) {
                clearInterval(interval);
                document.getElementById('status').innerHTML = '✅ Done';
            }
        }, 5000);
    } catch (err) {
        log(`❌ Send error: ${err.message}`);
        document.getElementById('status').innerHTML = '❌ Failed';
    }
}

function initEventListeners() {
    document.getElementById('screenshot').addEventListener('click', (e) => {
        const rect = e.target.getBoundingClientRect();
        const scaleX = e.target.naturalWidth / rect.width;
        const scaleY = e.target.naturalHeight / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        if (confirm(`Click at (${Math.round(x)}, ${Math.round(y)})?`))
            sendCommand({ action: 'click-coordinates', x: Math.round(x), y: Math.round(y) });
    });

    document.getElementById('screenshot').addEventListener('contextmenu', (e) => {
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
        let text = document.getElementById('typeText').value;
        if (text) sendCommand({ action: 'type', text: text });
    };
    document.getElementById('enterBtn').onclick = () => sendCommand({ action: 'press', key: 'Enter' });
    document.getElementById('scrollUpBtn').onclick = () => sendCommand({ action: 'scroll', text: '-200' });
    document.getElementById('scrollDownBtn').onclick = () => sendCommand({ action: 'scroll', text: '200' });
    document.getElementById('copyRemoteClipboardBtn').onclick = () => sendCommand({ action: 'get-clipboard' });
    document.getElementById('setRemoteClipboardBtn').onclick = () => {
        let txt = prompt('Enter text to copy to remote clipboard:');
        if (txt !== null) sendCommand({ action: 'set-clipboard', text: txt });
    };
    document.getElementById('stopBrowserBtn').onclick = () => {
        if (confirm('Stop the remote browser?')) sendCommand({ action: 'stop' });
    };
    document.getElementById('copyLinkBtn').onclick = () => {
        const link = document.getElementById('linkDisplay').href;
        if (link && link !== '#') navigator.clipboard.writeText(link);
        log(`📋 Copied link to local clipboard: ${link}`);
    };
    document.getElementById('refreshBtn').onclick = () => fetchLatestState();
    document.getElementById('sendManualBtn').onclick = () => {
        try {
            let cmd = JSON.parse(document.getElementById('manualCommand').value);
            sendCommand(cmd);
        } catch(e) { alert('Invalid JSON: ' + e.message); }
    };
}

// Initialize
(async function start() {
    if (await loadConfig()) {
        initEventListeners();
        setInterval(fetchLatestState, POLL_INTERVAL_MS);
        await fetchLatestState();
        log(`✅ Viewer started. Polling every ${POLL_INTERVAL_MS/1000}s.`);
    } else {
        log('❌ Cannot start – create config.json from config.example.json');
    }
})();