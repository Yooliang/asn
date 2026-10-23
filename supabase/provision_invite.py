"""Fallback: create a one-time relay invite directly in the DB (15 minutes). The invitee picks its own id/name.

Usage: py -3.12 provision_invite.py --by <邀請人的節點代號> [--prefix W-]   (--prefix limits the id the invitee may pick)
Prints the invite code in plaintext ONCE; only its sha256 is stored. Never commit it.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> None:
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("--prefix")
    ap.add_argument("--by", required=True)
    a = ap.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", a.by) or (a.prefix and not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", a.prefix)):
        sys.exit("bad id")
    code = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("=")
    h = hashlib.sha256(code.encode()).hexdigest()
    prefix = f"'{a.prefix}'" if a.prefix else "null"
    sql = (
        "insert into relay.invites (code_hash, prefix, created_by) "
        f"values ('{h}', {prefix}, '{a.by}') returning expires_at;"
    )
    r = subprocess.run(["npx", "supabase", "db", "query", "--linked", sql], cwd=REPO,
                       capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    if r.returncode != 0 or '"error"' in r.stdout:
        sys.exit("db query failed:\n" + r.stdout + r.stderr)
    print(json.dumps({"invite": code, "prefix": a.prefix, "valid": "15 minutes"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
