# Get Aquamentor CAD/CAM onto GitHub — step by step

Run these on your Mac in **Terminal**. Two paths — **Path A (`gh` CLI) is easiest**.
Path B needs no CLI (browser + a token).

---

## Why keep the code OUT of Dropbox
Git already gives you full history/versioning. Dropbox syncs the `.git` folder
file-by-file in real time, but git writes many small files (objects, refs, locks,
index) in fast bursts. Dropbox can upload them half-written or out of order, mangle
a packfile during a rewrite, or drop "conflicted copy" files inside `.git` that git
can't read → **corrupted repo**. Standard practice: working code in a normal folder
(`~/dev`), GitHub as the cloud backup. The Dropbox copy then goes stale — that's fine,
GitHub is the source of truth from here on.

---

## Step 1 — Clone the bundle into a real dev folder (both paths)

```bash
mkdir -p ~/dev && cd ~/dev
BUNDLE="$HOME/Dropbox/DC Claude Shared/Claude Tasks and Projects/G-Code Visualizer/aquamentor-cadcam-v0.1.bundle"
git clone "$BUNDLE" aquamentor-cadcam
cd aquamentor-cadcam
git branch -M main            # standardize the branch name
node cam-engine/test.js       # should print: 27 passed, 0 failed
```
(If git prompts to install Xcode Command Line Tools, accept, then re-run.)

---

## Path A — GitHub CLI (recommended)

```bash
brew install gh               # skip if you already have gh (needs Homebrew)
gh auth login                 # GitHub.com  →  HTTPS  →  login with browser
gh repo create aquamentor-cadcam --private --source=. --push
git push --tags               # push the v0.1 tag too
```
Done — private repo created and pushed.

---

## Path B — browser + git (no CLI)

1. github.com → **New repository**. Name `aquamentor-cadcam`, set **Private**,
   and do **NOT** add a README/.gitignore (the repo already has them). Create.
2. Copy the repo URL, then:

```bash
git remote add origin https://github.com/<your-username>/aquamentor-cadcam.git
git push -u origin main
git push --tags
```

3. When prompted for a password, GitHub no longer takes your account password.
   Paste a **Personal Access Token** instead:
   github.com → Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate, scope **`repo`**. Use that token as the password.
   (macOS Keychain remembers it after the first push.)

---

## Step 3 — everyday workflow after it's up

```bash
cd ~/dev/aquamentor-cadcam
git status
git add -A
git commit -m "your message"
git push
```

---

## Open it in Claude Code to keep building
```bash
cd ~/dev/aquamentor-cadcam
claude
# then: "continue the CAD/CAM build — read cam-engine/README.md, run the tests, do TTF-outline text next"
```

## Notes
- Bundle location (the handoff file): `…/G-Code Visualizer/aquamentor-cadcam-v0.1.bundle`
- Repo contents: both apps (`cadcam-studio-*.html`, `gcode-cadcam-*.html`), the
  `cam-engine/` source + 3 Node test suites, the ShopSabre `.pp`, README roadmap.
- Tag `v0.1` = this baseline.
- Optional tidy-up: the half-initialized `.git` left in the Dropbox `G-Code Visualizer`
  folder is harmless but stuck — remove it with: `rm -rf "$HOME/Dropbox/DC Claude Shared/Claude Tasks and Projects/G-Code Visualizer/.git"`
