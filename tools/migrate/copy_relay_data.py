"""舊後台（只讀）-> 新後台 複製 relay 資料。不印任何資料內容，只印筆數。
用法：python -I copy_relay.py export|import
"""
import json, subprocess, sys, os, tempfile

OLD = "hwtahctsgjcemtwzlvnq"
NEW = "etccgmkrosbzpltudlgt"
WORK = os.path.dirname(os.path.abspath(__file__))
SQLDIR = os.path.join(tempfile.gettempdir(), "relay_dump")  # 內含 key_hash 與訊息，用完要刪
CWD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo 根目錄

# (表, where 條件)；順序即匯入順序
TABLES = [
    ("tenants", ""),
    ("nodes", ""),
    ("roster", ""),
    ("rooms", ""),
    ("room_members", ""),
    ("room_messages", "where at >= now() - interval '90 days'"),
    ("room_pins", ""),
    ("messages", "where created_at >= now() - interval '90 days'"),
    ("launches", ""),
]


def q(ref, sql):
    r = subprocess.run(
        ["npx", "supabase", "db", "query", "--project-ref", ref, "--linked", "-o", "json", sql],
        cwd=CWD, capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    if r.returncode != 0:
        print("ERR", r.stderr[-300:])
        sys.exit(1)
    return r.stdout


def export():
    os.makedirs(SQLDIR, exist_ok=True)
    for t, w in TABLES:
        # 舊後台只做 SELECT；以 jsonb_agg 取出整張表
        out = q(OLD, f"select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text as j from relay.{t} x {w}")
        data = json.loads(out)
        rows = data["rows"] if isinstance(data, dict) and "rows" in data else data
        j = rows[0]["j"]
        n = len(json.loads(j))
        with open(os.path.join(SQLDIR, t + ".json"), "w", encoding="utf-8") as f:
            f.write(j)
        print("export", t, n)


def build():
    parts = ["begin;"]
    for t, _ in TABLES:
        j = open(os.path.join(SQLDIR, t + ".json"), encoding="utf-8").read()
        assert "$J$" not in j
        parts.append(f"insert into relay.{t} select * from jsonb_populate_recordset(null::relay.{t}, $J${j}$J$::jsonb);")
    parts.append("select setval('relay.tenant_serial', greatest((select coalesce(max(serial),1) from relay.tenants),1));")
    parts.append("commit;")
    p = os.path.join(SQLDIR, "import.sql")
    open(p, "w", encoding="utf-8").write("\n".join(parts))
    return p


def do_import():
    p = build()
    r = subprocess.run(
        ["npx", "supabase", "db", "query", "--project-ref", NEW, "--linked", "-f", p],
        cwd=CWD, capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    print("import rc", r.returncode, r.stderr[-300:] if r.returncode else "")


if __name__ == "__main__":
    {"export": export, "import": do_import}[sys.argv[1]]()
