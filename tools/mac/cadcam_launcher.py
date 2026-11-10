#!/usr/bin/python3
"""Runs Aquamentor CAD/CAM on this Mac. Started by "Aquamentor CADCAM.app" and a login agent; installed by tools/mac/install.sh.

  cadcam_launcher.py open "<file>"   start the local server if needed, then open the file in a CAD/CAM window
  cadcam_launcher.py app             open an empty CAD/CAM window
  cadcam_launcher.py serve           the server itself

A web page cannot read or write a file by its path, so this small server does it for the page: it serves the app on 127.0.0.1 only,
hands the page the bytes of a file Finder opened, and writes them back when the user chooses Save. It can reach only files that were
registered by this launcher, each behind a random token. Registering needs a secret kept in a private file, so a website cannot do it.

It also makes the app a real Mac app and keeps it current. The page is served with a web-app manifest, so Chrome can install it with its
own name and icon in the menu bar (a plain Chrome window always says "Chrome"). And it fetches each new build published from main
(.github/workflows/release-app.yml), checks its hash, and swaps it in. Open windows are told, and pick it up when you reload.
Standard library only, plus curl for the download.
"""
import glob, hashlib, http.server, json, math, os, plistlib, secrets, socketserver, struct, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.join(HERE, "cadcam-studio.html")
APP_NAME = "Aquamentor CADCAM"
PORT = int(os.environ.get("AQ_PORT", 8791))
RELEASE = os.environ.get("AQ_RELEASE", "https://github.com/dancynamon/DC-VCarve-Clone/releases/download/studio-latest")
SEEN_FILE = os.path.join(HERE, ".release")   # hash of the last published build applied here
CHECK_SECONDS = int(os.environ.get("AQ_CHECK_SECONDS", 300))
MIN_BUILD_BYTES = 500 * 1024
PENDING_SECONDS = 120
SECRET_FILE = os.path.join(HERE, ".secret")
LOG = os.path.expanduser("~/Library/Logs/Aquamentor CADCAM.log")
HOSTS = ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)
ORIGIN = "http://127.0.0.1:%d" % PORT
MAX_BYTES = 500 * 1024 * 1024


def secret():
    if not os.path.exists(SECRET_FILE):
        fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(24))
    with open(SECRET_FILE) as f:
        return f.read().strip()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    files = {}
    key = ""
    pending = []    # files Finder opened that no window has picked up yet: [{token, name, t}]
    update_error = ""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if self.headers.get("Host") not in HOSTS:   # stops a website reaching this through a DNS trick
            self.reply(403, b"wrong host")
            return False
        return True

    def path_of_token(self):
        return self.server.files.get(self.path[len("/file/"):].split("?")[0])

    def do_GET(self):
        if not self.allowed():
            return
        route = self.path.split("?")[0]
        if route == "/health":
            ok = self.headers.get("X-Secret") == self.server.key
            return self.reply(200 if ok else 403, b"ok" if ok else b"no")
        if route in ("/", "/cadcam-studio.html"):
            return self.reply(200, page(), "text/html; charset=utf-8")
        if route == "/manifest.webmanifest":
            return self.reply(200, manifest(), "application/manifest+json")
        if route in ("/icon-192.png", "/icon-512.png"):
            return self.reply(200, icon(int(route[6:9])), "image/png")
        if route == "/build":
            return self.reply(200, json.dumps({"build": build_id()}).encode(), "application/json")
        if route == "/next-open":   # the app's own windows only: taking a file from the queue must not be open to other sites
            if self.headers.get("Sec-Fetch-Site") != "same-origin":
                return self.reply(403, b"no")
            srv = self.server
            srv.pending[:] = [p for p in srv.pending if time.time() - p["t"] < PENDING_SECONDS]
            item = srv.pending.pop(0) if srv.pending else None
            return self.reply(200, json.dumps(item).encode(), "application/json")
        if route.startswith("/file/"):
            p = self.path_of_token()
            if not p:
                return self.reply(404, b"unknown file")
            token = self.path[len("/file/"):].split("?")[0]
            self.server.pending[:] = [q for q in self.server.pending if q["token"] != token]   # a window has it
            try:
                with open(p, "rb") as f:
                    data = f.read()
            except OSError as e:
                return self.reply(410, str(e).encode())
            return self.reply(200, data, "application/octet-stream", {"X-File-Name": urllib.parse.quote(os.path.basename(p))})
        self.reply(404, b"not found")

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != "/register" or self.headers.get("X-Secret") != self.server.key:
            return self.reply(403, b"no")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        token = secrets.token_urlsafe(24)
        self.server.files[token] = os.path.abspath(body["path"])
        self.server.pending.append({"token": token, "name": os.path.basename(body["path"]), "t": time.time()})
        self.reply(200, token.encode())

    def do_PUT(self):
        if not self.allowed():
            return
        if self.headers.get("Origin") != ORIGIN:   # only the app's own page may save
            return self.reply(403, b"wrong origin")
        p = self.path_of_token()
        size = int(self.headers.get("Content-Length", -1))
        if not p or size < 0 or size > MAX_BYTES:
            return self.reply(404 if not p else 413, b"cannot save")
        data = self.rfile.read(size)
        if len(data) != size:
            return self.reply(400, b"short body")
        try:   # written beside the original and swapped in, so a failure never leaves half a file
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".aqcam-save-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.chmod(tmp, os.stat(p).st_mode & 0o777)
            os.replace(tmp, p)
        except OSError as e:
            return self.reply(500, str(e).encode())
        self.reply(200, b"saved")


def build_id():
    with open(STUDIO, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def page():
    """The app, plus what makes it installable and lets a window notice a newer build. Added here so the HTML file itself stays plain."""
    with open(STUDIO, "rb") as f:
        html = f.read()
    tags = '<link rel="manifest" href="/manifest.webmanifest"><meta name="aq-app-build" content="%s">' % hashlib.sha256(html).hexdigest()[:16]
    return html.replace(b"</head>", tags.encode() + b"</head>", 1)


def manifest():
    return json.dumps({
        "id": "/cadcam-studio.html", "name": APP_NAME, "short_name": APP_NAME, "start_url": "/cadcam-studio.html", "scope": "/",
        "display": "standalone", "background_color": "#1c2129", "theme_color": "#1c2129",
        "icons": [{"src": "/icon-%d.png" % s, "sizes": "%dx%d" % (s, s), "type": "image/png", "purpose": "any"} for s in (192, 512)],
    }).encode()


_icons = {}


def icon(size):
    """A V-bit cutting a groove, on the app's dark blue: drawn here so the app needs no image files."""
    if size not in _icons:
        def seg(px, py, ax, ay, bx, by):
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
            return math.hypot(px - ax - t * dx, py - ay - t * dy)

        rows = bytearray()
        for j in range(size):
            rows.append(0)
            for i in range(size):
                x, y = (i + 0.5) / size, (j + 0.5) / size
                qx, qy = max(abs(x - 0.5) - 0.28, 0.0), max(abs(y - 0.5) - 0.28, 0.0)      # rounded square, radius 0.2
                a = max(0.0, min(1.0, (0.20 - math.hypot(qx, qy)) * size + 0.5))
                ink = max(0.0, min(1.0, (0.035 - min(seg(x, y, 0.27, 0.34, 0.5, 0.70), seg(x, y, 0.5, 0.70, 0.73, 0.34))) * size + 0.5))
                top = max(0.0, min(1.0, (0.022 - seg(x, y, 0.2, 0.34, 0.8, 0.34)) * size + 0.5))
                r, g, b = 24 + 8 * y, 34 + 14 * y, 92 + 60 * y
                ink = max(ink, top * 0.55)
                rows += bytes((int(r + (60 - r) * ink), int(g + (214 - g) * ink), int(b + (136 - b) * ink), int(a * 255)))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

        _icons[size] = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    return _icons[size]


def download(url):
    return subprocess.run(["/usr/bin/curl", "-fsSL", "--max-time", "120", url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def apply_update():
    """Bring in the newest published build, once per release (so a local test install is left alone until the next one). True if replaced."""
    want = json.loads(download(RELEASE + "/latest.json"))["sha256"]
    try:
        with open(SEEN_FILE) as f:
            if f.read().strip() == want:
                return False
    except OSError:
        pass
    html = download(RELEASE + "/cadcam-studio.html")
    if hashlib.sha256(html).hexdigest() != want or len(html) < MIN_BUILD_BYTES or b'id="appVer"' not in html:
        raise ValueError("the downloaded build failed its check")
    fd, tmp = tempfile.mkstemp(dir=HERE, prefix=".studio-")
    with os.fdopen(fd, "wb") as f:
        f.write(html)
    os.chmod(tmp, 0o644)
    os.replace(tmp, STUDIO)
    with open(SEEN_FILE, "w") as f:
        f.write(want)
    return True


def serve():
    srv = Server(("127.0.0.1", PORT), Handler)
    srv.key = secret()

    def updates():
        while True:
            try:
                apply_update()
                srv.update_error = ""
            except Exception as e:   # no network, or nothing published yet: the installed build keeps working
                if str(e) != srv.update_error:
                    srv.update_error = str(e)
                    print("update check failed:", e, file=sys.stderr, flush=True)
            time.sleep(CHECK_SECONDS)

    threading.Thread(target=updates, daemon=True).start()
    srv.serve_forever()


def request(path, data=None):
    q = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), data=data, headers={"X-Secret": secret()})
    with urllib.request.urlopen(q, timeout=3) as r:
        return r.read()


def ensure_server():
    try:
        request("/health")
        return
    except Exception:
        pass
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(LOG, "a"), start_new_session=True)
    for _ in range(50):
        time.sleep(0.1)
        try:
            request("/health")
            return
        except Exception:
            continue
    raise SystemExit("The CAD/CAM server did not start on port %d. Details: %s" % (PORT, LOG))


def installed_app():
    """The Chrome-installed copy of this app, if there is one: {path, id, profile}."""
    for path in glob.glob(os.path.expanduser("~/Applications/Chrome Apps*/*.app")):
        try:
            with open(os.path.join(path, "Contents", "Info.plist"), "rb") as f:
                p = plistlib.load(f)
        except (OSError, plistlib.InvalidFileException):
            continue
        if str(p.get("CrAppModeShortcutURL", "")).startswith(ORIGIN):
            app_id = p.get("CrAppModeShortcutID")
            found = glob.glob(os.path.expanduser("~/Library/Application Support/Google/Chrome/*/Web Applications/Manifest Resources/" + str(app_id)))
            return {"path": path, "id": app_id, "profile": found[0].split(os.sep)[-4] if found else "Default"}
    return None


def window(url, has_file=False):
    chrome = "/Applications/Google Chrome.app"
    app = installed_app()
    if app and os.path.isdir(chrome) and has_file:
        # a file goes to the installed app by URL; if Chrome ignores that, an open window collects it from /next-open
        subprocess.check_call(["/usr/bin/open", "-na", chrome, "--args", "--profile-directory=" + app["profile"], "--app-id=" + app["id"], "--app-launch-url-for-shortcuts-menu-item=" + url])
    elif app:
        subprocess.check_call(["/usr/bin/open", app["path"]])
    elif os.path.isdir(chrome):   # not installed yet: a normal tab, where the page offers Install
        subprocess.check_call(["/usr/bin/open", "-a", chrome, url])
    else:
        subprocess.check_call(["/usr/bin/open", url])


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "app"
    if cmd == "serve":
        return serve()
    ensure_server()
    url = "http://127.0.0.1:%d/cadcam-studio.html" % PORT
    has_file = cmd == "open"
    if cmd == "open":
        path = os.path.abspath(sys.argv[2])
        if not os.path.isfile(path):
            raise SystemExit("File not found: " + path)
        token = request("/register", json.dumps({"path": path}).encode()).decode()
        url += "?open=" + token
    window(url, has_file)


if __name__ == "__main__":
    main()
