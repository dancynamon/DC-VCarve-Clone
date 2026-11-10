#!/usr/bin/python3
"""Opens files from Finder in Aquamentor CAD/CAM. Run by "Aquamentor CADCAM.app"; installed by tools/mac/install.sh.

  cadcam_launcher.py open "<file>"   start the local server if needed, then open the file in a CAD/CAM window
  cadcam_launcher.py app             open an empty CAD/CAM window
  cadcam_launcher.py serve           the server itself

A web page cannot read or write a file by its path, so this small server does it for the page: it serves the app on 127.0.0.1 only,
hands the page the bytes of a file Finder opened, and writes them back when the user chooses Save. It can reach only files that were
registered by this launcher, each behind a random token. Registering needs a secret kept in a private file, so a website cannot do it.
Standard library only.
"""
import http.server, json, os, secrets, socketserver, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.join(HERE, "cadcam-studio.html")
PORT = 8791
SECRET_FILE = os.path.join(HERE, ".secret")
LOG = os.path.expanduser("~/Library/Logs/Aquamentor CADCAM.log")
HOSTS = ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)
ORIGIN = "http://127.0.0.1:%d" % PORT
MAX_BYTES = 500 * 1024 * 1024
IDLE_EXIT_SECONDS = 24 * 3600


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
    last = time.time()


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
        self.server.last = time.time()
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
            with open(STUDIO, "rb") as f:
                return self.reply(200, f.read(), "text/html; charset=utf-8")
        if route.startswith("/file/"):
            p = self.path_of_token()
            if not p:
                return self.reply(404, b"unknown file")
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


def serve():
    srv = Server(("127.0.0.1", PORT), Handler)
    srv.key = secret()

    def watch():
        while time.time() - srv.last < IDLE_EXIT_SECONDS:
            time.sleep(60)
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()
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


def window(url):
    chrome = "/Applications/Google Chrome.app"
    if os.path.isdir(chrome):
        subprocess.check_call(["/usr/bin/open", "-na", chrome, "--args", "--app=" + url])
    else:
        subprocess.check_call(["/usr/bin/open", url])


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "app"
    if cmd == "serve":
        return serve()
    ensure_server()
    url = "http://127.0.0.1:%d/cadcam-studio.html" % PORT
    if cmd == "open":
        path = os.path.abspath(sys.argv[2])
        if not os.path.isfile(path):
            raise SystemExit("File not found: " + path)
        token = request("/register", json.dumps({"path": path}).encode()).decode()
        url += "?open=" + token
    window(url)


if __name__ == "__main__":
    main()
