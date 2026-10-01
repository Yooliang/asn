"""Provision a relay node: generate key + bell topic, save key locally, insert sha256 into relay.nodes.

Usage: py -3.12 provision_node.py <node_id> <name> [--kind claude|gpt|gemini|grok|other] [--role owner|member] [--machine X] [--rotate]
Key plaintext goes to ~/.irori-relay/<node_id>.key only (never printed, never in the repo).
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
KEY_DIR = os.path.join(os.path.expanduser("~"), ".irori-relay")


def b64u(n: int) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(n)).decode().rstrip("=")


def main() -> None:
    ap = argparse.ArgumentParser(usage=__doc__)
    ap.add_argument("node_id")
    ap.add_argument("name")
    ap.add_argument("--kind", choices=["claude", "gpt", "gemini", "grok", "other"])
    ap.add_argument("--role", choices=["owner", "member"], default="member")
    ap.add_argument("--machine")
    ap.add_argument("--rotate", action="store_true")
    a = ap.parse_args()
    node_id, name, rotate = a.node_id, a.name, a.rotate
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", node_id):
        sys.exit("bad node id")
    path = os.path.join(KEY_DIR, f"{node_id}.key")
    if os.path.exists(path) and not rotate:
        sys.exit(f"{path} already exists; pass --rotate to replace the key")
    key = b64u(32)
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    topic = "relay-bell-" + b64u(18)
    esc = lambda s: s.replace("'", "''")
    q = lambda v: "null" if v is None else "'" + esc(v) + "'"
    # on conflict (rotate): new key, status back to active; bell_topic is kept
    sql = (
        "insert into relay.nodes (id, name, key_hash, bell_topic, kind, role, machine) values "
        f"({q(node_id)}, {q(name)}, '{key_hash}', '{topic}', {q(a.kind)}, '{a.role}', {q(a.machine)}) "
        "on conflict (id) do update set name = excluded.name, key_hash = excluded.key_hash, "
        "kind = excluded.kind, role = excluded.role, machine = excluded.machine, status = 'active' "
        "returning id;"
    )
    r = subprocess.run(["npx", "supabase", "db", "query", "--linked", sql],
                       cwd=REPO, capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    if r.returncode != 0 or '"error"' in r.stdout:
        sys.exit("db query failed:\n" + r.stdout + r.stderr)
    os.makedirs(KEY_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(key)
    print(json.dumps({"node": node_id, "key_file": path, "bell_topic_set": True}))


if __name__ == "__main__":
    main()
