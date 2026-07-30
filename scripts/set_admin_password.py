"""
set_admin_password.py — Rotate the dashboard's admin password.

Writes a PBKDF2-SHA256 verifier into site/.env.local, which is gitignored. The
plaintext is never stored, never echoed, and never committed.

    python scripts/set_admin_password.py

The password is read without echo. Afterwards:
  * rebuild locally      -> npm run build
  * update Netlify       -> Site settings > Environment variables >
                            VITE_ADMIN_VERIFIER = <the value printed below>

Note on what this protects. The site is static, so the verifier ships inside the
deployed JavaScript and the check runs in the browser. 210,000 PBKDF2 iterations
make guessing expensive, but this is a deterrent, not a server-side secret, and
it does not restrict the JSON under /data at all. For separation that genuinely
holds, deploy the team build (`npm run build:team`), which omits the restricted
sections and their data entirely.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import os
import re
import secrets
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
ENV_PATH = os.path.join(ROOT_DIR, "site", ".env.local")

ITERATIONS = 210_000
KEY_NAME = "VITE_ADMIN_VERIFIER"

HEADER = """\
# LOCAL ONLY — never committed (.gitignore excludes .env.local).
#
# PBKDF2-SHA256 verifier for the admin password: iterations:salt:hash
# (both base64). The plaintext password appears nowhere in this project.
#
# On Netlify, set this same key/value under
#   Site settings -> Environment variables
# for the admin site only. Without it the build disables admin unlock entirely,
# so a missing value locks people out rather than letting them in.
#
# To rotate the password, run:
#   python scripts/set_admin_password.py
"""


def build_verifier(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS, dklen=32)
    # Colon-separated on purpose: Vite runs .env through dotenv-expand, which
    # would read a "$"-prefixed segment as a variable and expand it to "".
    return f"{ITERATIONS}:{base64.b64encode(salt).decode()}:{base64.b64encode(dk).decode()}"


def main():
    if sys.stdin.isatty():
        pw = getpass.getpass("New admin password: ")
        again = getpass.getpass("Confirm: ")
        if pw != again:
            raise SystemExit("Passwords do not match — nothing written.")
    else:
        # Allows:  echo "secret" | python scripts/set_admin_password.py
        pw = sys.stdin.readline().rstrip("\n")

    if len(pw) < 8:
        raise SystemExit("Use at least 8 characters — nothing written.")

    verifier = build_verifier(pw)

    existing = ""
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, encoding="utf-8") as fh:
            existing = fh.read()

    line = f"{KEY_NAME}={verifier}\n"
    if re.search(rf"^{KEY_NAME}=", existing, flags=re.MULTILINE):
        updated = re.sub(rf"^{KEY_NAME}=.*$", line.rstrip("\n"), existing, flags=re.MULTILINE)
    else:
        updated = (existing or HEADER) + line

    os.makedirs(os.path.dirname(ENV_PATH), exist_ok=True)
    with open(ENV_PATH, "w", encoding="utf-8") as fh:
        fh.write(updated)

    print(f"\nWrote verifier to {ENV_PATH}  (gitignored)")
    print("\nSet this in Netlify -> Site settings -> Environment variables:\n")
    print(f"  {KEY_NAME}={verifier}\n")
    print("Then rebuild:  cd site && npm run build")


if __name__ == "__main__":
    main()
