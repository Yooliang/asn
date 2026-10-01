"""Fallback: create a one-time relay invite directly in the DB (5 minutes, bound to for_id).

Usage: py -3.12 provision_invite.py <for_id> <for_name> [--by XISU]
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
    ap.add_argument("for_id")
    ap.add_argument("for_name")
    ap.add_argument("--by", default="XISU")
    a = ap.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", a.for_id) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", a.by):
        sys.exit("bad id")
    code = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("=")
    h = hashlib.sha256(code.encode()).hexdigest()
    name = a.for_name.replace("'", "''")
    sql = (
        "insert into relay.invites (code_hash, for_id, for_name, created_by) "
        f"values ('{h}', '{a.for_id}', '{name}', '{a.by}') returning expires_at;"
    )
    r = subprocess.run(["npx", "supabase", "db", "query", "--linked", sql], cwd=REPO,
                       capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    if r.returncode != 0 or '"error"' in r.stdout:
        sys.exit("db query failed:\n" + r.stdout + r.stderr)
    print(json.dumps({"for_id": a.for_id, "invite": code, "valid": "5 minutes"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
