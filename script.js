// No hardcoded secrets – config is loaded from config.json
let GITHUB_USER = "";
let GITHUB_REPO = "";
let GITHUB_TOKEN = "";
const BRANCH = "session";
let API_BASE = "";

let lastScreenshotSha = null;
let lastClipboardText = "";

function log(msg) {
    const logDiv = document.getElementById('log');
    const timestamp = new Date().toLocaleTimeString();
    logDiv.innerHTML = `[${timestamp}] ${msg}\n` + logDiv.innerHTML;
}

async function loadConfig() {
    try {
        const response = await fetch('config.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();
        GITHUB_USER = config.github_user;
        GITHUB_REPO = config.github_repo;
        GITHUB_TOKEN = config.github_token;
        API_BASE = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}`;
        log(`Config loaded – user: ${GITHUB_USER}, repo: ${GITHUB_REPO}`);
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
        const refRes = await fetch(`${API_BASE}/git/ref/heads/${BRANCH}`, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        if (!refRes.ok) throw new Error(`Branch fetch failed: ${refRes.status}`);
        const refData = await refRes.json();
        const commitSha = refData.object.sha;

        const treeRes = await fetch(`${API_BASE}/git/trees/${commitSha}?recursive=1`, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        const treeData = await treeRes.json();
        const screenshotItem = treeData.tree.find(f => f.path === 'screenshot.png');
        const clipboardItem = treeData.tree.find(f => f.path === 'clipboard.txt');

        if (screenshotItem && screenshotItem.sha !== lastScreenshotSha) {
            lastScreenshotSha = screenshotItem.sha;
            const imgUrl = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/screenshot.png?cache=${Date.now()}`;
            document.getElementById('screenshot').src = imgUrl;
            document.getElementById('status').innerHTML = '✅ Connected';
            log('Screenshot updated');
        }

        if (clipboardItem) {
            const clipRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/clipboard.txt?cache=${Date.now()}`);
            const clipText = await clipRes.text();
            if (clipText !== lastClipboardText) {
                lastClipboardText = clipText;
                document.getElementById('linkDisplay').innerText = clipText.substring(0, 70) || '(empty)';
                document.getElementById('linkDisplay').href = clipText.startsWith('http') ? clipText : '#';
                log(`Remote clipboard updated: ${clipText.substring(0, 100)}`);
            }
        }
    } catch (err) {
        console.error(err);
        document.getElementById('status').innerHTML = '⚠️ API error';
        log(`Error: ${err.message}`);
    }
}

async function sendCommand(command) {
    if (!API_BASE) return;
    log(`Sending command: ${JSON.stringify(command)}`);
    document.getElementById('status').innerHTML = '⏳ Sending...';

    try {
        const refRes = await fetch(`${API_BASE}/git/ref/heads/${BRANCH}`, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        const refData = await refRes.json();
        const baseSha = refData.object.sha;

        const commandContent = JSON.stringify(command, null, 2);
        const blobRes = await fetch(`${API_BASE}/git/blobs`, {
            method: 'POST',
            headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: btoa(commandContent), encoding: 'base64' })
        });
        const blobData = await blobRes.json();

        const treeRes = await fetch(`${API_BASE}/git/trees`, {
            method: 'POST',
            headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_tree: baseSha,
                tree: [{ path: 'command.json', mode: '100644', type: 'blob', sha: blobData.sha }]
            })
        });
        const newTree = await treeRes.json();

        const commitRes = await fetch(`${API_BASE}/git/commits`, {
            method: 'POST',
            headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Local command: ${command.action}`,
                tree: newTree.sha,
                parents: [baseSha]
            })
        });
        const newCommit = await commitRes.json();

        await fetch(`${API_BASE}/git/refs/heads/${BRANCH}`, {
            method: 'PATCH',
            headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha: newCommit.sha, force: true })
        });

        document.getElementById('status').innerHTML = '🔄 Waiting for remote...';
        log('Command pushed, waiting for remote execution...');

        let attempts = 0;
        const interval = setInterval(async () => {
            attempts++;
            await fetchLatestState();
            if (attempts >= 20) {
                clearInterval(interval);
                document.getElementById('status').innerHTML = '✅ Done (may still be processing)';
            }
        }, 2000);
    } catch (err) {
        log(`ERROR sending command: ${err.message}`);
        document.getElementById('status').innerHTML = '❌ Send failed';
    }
}

function initEventListeners() {
    document.getElementById('screenshot').addEventListener('click', (e) => {
        const rect = e.target.getBoundingClientRect();
        const scaleX = e.target.naturalWidth / rect.width;
        const scaleY = e.target.naturalHeight / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        if (confirm(`Click at (${Math.round(x)}, ${Math.round(y)})?`)) {
            sendCommand({ action: 'click-coordinates', x: Math.round(x), y: Math.round(y) });
        }
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
        if (confirm('Stop the remote browser? This will end the GitHub Actions job.')) {
            sendCommand({ action: 'stop' });
        }
    };
    document.getElementById('copyLinkBtn').onclick = () => {
        const link = document.getElementById('linkDisplay').href;
        if (link && link !== '#') navigator.clipboard.writeText(link);
    };
    document.getElementById('refreshBtn').onclick = () => fetchLatestState();
    document.getElementById('sendManualBtn').onclick = () => {
        const raw = document.getElementById('manualCommand').value;
        try {
            const cmd = JSON.parse(raw);
            sendCommand(cmd);
        } catch(e) { alert('Invalid JSON: ' + e.message); }
    };
    // NEW: URL bar handler
    document.getElementById('goBtn').onclick = () => {
        let url = document.getElementById('urlInput').value.trim();
        if (!url) return;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        sendCommand({ action: 'goto', url: url });
    };
}

// Start
(async function start() {
    const configLoaded = await loadConfig();
    if (configLoaded) {
        initEventListeners();
        setInterval(fetchLatestState, 3000);
        await fetchLatestState();
        log('Viewer started. Polling every 3s.');
    } else {
        log('Cannot start – create config.json from config.example.json');
    }
})();