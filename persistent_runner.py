#!/usr/bin/env python3
import os
import sys
import json
import time
import hashlib
import subprocess
import traceback
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BRANCH = "session"
MAX_HOURS = float(os.environ.get("SESSION_HOURS", "6"))
START_TIME = time.time()

def log(msg):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    full = f"[{timestamp}] {msg}"
    print(full, flush=True)
    with open("remote.log", "a") as f:
        f.write(full + "\n")

def git_fetch_hard_reset():
    """Fetch latest from origin and reset local branch to match exactly."""
    try:
        subprocess.run(["git", "fetch", "origin", BRANCH], check=True, capture_output=True)
        subprocess.run(["git", "reset", "--hard", f"origin/{BRANCH}"], check=True, capture_output=True)
        log("git sync successful (fetch + reset)")
        return True
    except subprocess.CalledProcessError as e:
        log(f"git sync failed: {e.stderr.decode() if e.stderr else str(e)}")
        return False

def git_force_push():
    subprocess.run(["git", "add", "-A"], check=True)
    subprocess.run(["git", "commit", "-m", "State update [skip ci]", "--allow-empty"], check=True)
    subprocess.run(["git", "push", "origin", BRANCH, "--force"], check=True)

def read_command():
    # Ensure we have latest command.json from remote before reading
    git_fetch_hard_reset()
    cmd_path = "command.json"
    if not os.path.exists(cmd_path):
        return {}
    try:
        with open(cmd_path, "r") as f:
            content = f.read()
            if not content.strip():
                return {}
            cmd = json.loads(content)
            if cmd.get("action"):
                log(f"Read command: {cmd['action']} with data: {cmd}")
            return cmd
    except Exception as e:
        log(f"Error reading command.json: {e}")
        return {}

def write_file(path, content):
    with open(path, "w") as f:
        f.write(content)
    log(f"Wrote {path}")

def main():
    log("🚀 Persistent browser starting")
    log(f"Current working directory: {os.getcwd()}")
    subprocess.run(["git", "checkout", BRANCH], check=True)
    log(f"Checked out {BRANCH}")

    session = {}
    if os.path.exists("session.json"):
        with open("session.json") as f:
            session = json.load(f)
        log("Loaded existing session")
    else:
        session = {"cookies": [], "localStorage": {}, "lastUrl": "about:blank", "scrollY": 0}
        log("No previous session, starting fresh")

    with sync_playwright() as p:
        log("Launching Chromium...")
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        page = context.new_page()
        log("Browser launched")

        if session.get("cookies"):
            context.add_cookies(session["cookies"])
            log(f"Restored {len(session['cookies'])} cookies")
        if session.get("lastUrl") and session["lastUrl"] != "about:blank":
            log(f"Navigating to last URL: {session['lastUrl']}")
            page.goto(session["lastUrl"])
            if session.get("localStorage"):
                page.evaluate("""(storage) => { for(let [k,v] of Object.entries(storage)) localStorage.setItem(k,v); }""", session["localStorage"])
                log("Restored localStorage")
            page.evaluate(f"window.scrollTo(0, {session.get('scrollY',0)})")

        # Initial capture and push
        log("Taking initial screenshot...")
        page.screenshot(path="screenshot.png", full_page=True)
        write_file("page.html", page.content())
        write_file("clipboard.txt", "")
        write_file("current_url.txt", page.url)
        write_file("results.md", "# Ready\n![Screenshot](./screenshot.png)")
        write_file("session.json", json.dumps(session, indent=2))
        write_file("remote.log", "")
        git_force_push()
        log("✅ Initial state pushed")

        last_cmd_hash = ""
        heartbeat = 0

        while True:
            if time.time() - START_TIME > MAX_HOURS * 3600:
                log("Time limit reached, exiting")
                break

            heartbeat += 1
            if heartbeat % 30 == 0:
                log(f"Heartbeat | URL: {page.url} | uptime: {int(time.time()-START_TIME)}s")

            cmd = read_command()
            if cmd and cmd.get("action"):
                cmd_hash = hashlib.md5(json.dumps(cmd).encode()).hexdigest()
                if cmd_hash != last_cmd_hash:
                    last_cmd_hash = cmd_hash
                    log(f"📩 Executing command: {cmd['action']}")
                    try:
                        action = cmd["action"]
                        if action == "goto":
                            url = cmd["url"]
                            log(f"Navigating to {url}")
                            page.goto(url, timeout=30000)
                            result = f"Navigated to {url}"
                        elif action == "screenshot":
                            page.screenshot(path="screenshot.png", full_page=True)
                            result = "Manual screenshot taken"
                        elif action == "click-coordinates":
                            x, y = cmd["x"], cmd["y"]
                            log(f"Click at ({x},{y})")
                            page.mouse.click(x, y)
                            result = f"Clicked at ({x},{y})"
                        elif action == "rightclick-coordinates":
                            x, y = cmd["x"], cmd["y"]
                            log(f"Right click at ({x},{y})")
                            page.mouse.click(x, y, button="right")
                            info = page.evaluate(f"({{x,y}}) => {{let el=document.elementsFromPoint(x,y)[0]; return el?{{tag:el.tagName,text:el.innerText?.slice(0,200),href:el.href}}:null;}}", {"x":x,"y":y})
                            result = f"Right-click at ({x},{y})\nInfo: {json.dumps(info)}"
                            if info and info.get("href"):
                                write_file("clipboard.txt", info["href"])
                                result += f"\nCopied link: {info['href']}"
                            elif info and info.get("text"):
                                write_file("clipboard.txt", info["text"])
                                result += f"\nCopied text: {info['text'][:100]}"
                        elif action == "type":
                            text = cmd["text"]
                            log(f"Typing: {text}")
                            page.keyboard.type(text)
                            result = f"Typed '{text}'"
                        elif action == "press":
                            key = cmd["key"]
                            log(f"Pressing key: {key}")
                            page.keyboard.press(key)
                            result = f"Pressed {key}"
                        elif action == "scroll":
                            delta = int(cmd.get("text", 100))
                            log(f"Scrolling by {delta}")
                            page.evaluate(f"window.scrollBy(0, {delta})")
                            result = f"Scrolled by {delta}"
                        elif action == "copy-link-at-coordinates":
                            x, y = cmd["x"], cmd["y"]
                            link = page.evaluate(f"({{x,y}}) => {{let el=document.elementsFromPoint(x,y).find(e=>e.tagName==='A'); return el?el.href:null;}}", {"x":x,"y":y})
                            if link:
                                write_file("clipboard.txt", link)
                                result = f"Copied link: {link}"
                            else:
                                result = "No link found"
                        elif action == "get-clipboard":
                            clip = open("clipboard.txt").read() if os.path.exists("clipboard.txt") else ""
                            result = f"Remote clipboard: {clip or '(empty)'}"
                        elif action == "set-clipboard":
                            write_file("clipboard.txt", cmd.get("text", ""))
                            result = f"Clipboard set to: {cmd.get('text', '')}"
                        elif action == "eval":
                            res = page.evaluate(cmd["script"])
                            result = f"Script result: {json.dumps(res)}"
                        elif action == "stop":
                            log("Stop command received. Exiting.")
                            break
                        else:
                            raise ValueError(f"Unknown action: {action}")

                        # Post‑command capture
                        log("Capturing post‑command state...")
                        page.screenshot(path="screenshot.png", full_page=True)
                        write_file("page.html", page.content())
                        write_file("current_url.txt", page.url)
                        session["cookies"] = context.cookies()
                        session["localStorage"] = page.evaluate("() => {let i={}; for(let k=0;k<localStorage.length;k++){let key=localStorage.key(k); i[key]=localStorage.getItem(key);} return i;}")
                        session["lastUrl"] = page.url
                        session["scrollY"] = page.evaluate("window.scrollY")
                        write_file("session.json", json.dumps(session, indent=2))

                        links = page.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a=>a.href)")
                        with open("results.md","w") as f:
                            f.write(f"# Command: {action}\n**Result:** {result}\n\n**URL:** {page.url}\n\n## Links ({len(links)})\n")
                            f.write("\n".join(f"- {l}" for l in links[:100]))
                            f.write(f"\n\n![Screenshot](./screenshot.png)\n\n## Clipboard\n```\n{open('clipboard.txt').read()}\n```")

                        write_file("command.json", "{}")
                        git_force_push()
                        log(f"✅ {action} completed and pushed")

                    except PlaywrightTimeoutError as te:
                        log(f"⏱️ Timeout: {te}")
                        write_file("results.md", f"# Timeout\nAction {action} timed out.")
                        git_force_push()
                    except Exception as e:
                        log(f"❌ Command error: {e}\n{traceback.format_exc()}")
                        write_file("results.md", f"# Error\n```\n{e}\n{traceback.format_exc()}\n```")
                        git_force_push()

            time.sleep(1)

        browser.close()
        log("Browser closed. Exiting.")

if __name__ == "__main__":
    main()