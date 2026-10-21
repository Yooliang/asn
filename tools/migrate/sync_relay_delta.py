"""舊後台（只讀）-> 新後台 增量同步：以主鍵 upsert，不清空新後台（可重複執行，切換期間各台分批切換時用）。
不印任何資料內容，只印筆數。用法：python -I sync_relay_delta.py export|upsert|insert|count
upsert＝主鍵相同就以舊後台覆蓋（切換前用）；insert＝只補新後台沒有的列、已有的不動（切換後補漏用，不會把新後台已讀／已收的狀態蓋回舊值）。
先 export（重用 copy_relay_data.py 的匯出），再 upsert。中介檔在系統暫存資料夾 relay_dump，用完要刪。
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import copy_relay_data as c

PK = {"tenants": "id", "nodes": "id", "roster": "node,name", "rooms": "id", "room_members": "room_id,member",
      "room_messages": "room_id,seq", "room_pins": "room_id", "messages": "id", "launches": "id"}


def cols(t):
    out = c.q(c.NEW, f"select string_agg(column_name, ',' order by ordinal_position) as c from information_schema.columns where table_schema='relay' and table_name='{t}'")
    data = json.loads(out)
    rows = data["rows"] if isinstance(data, dict) and "rows" in data else data
    return rows[0]["c"].split(",")


def upsert(only_insert=False):
    parts = ["begin;"]
    for t, _ in c.TABLES:
        j = open(os.path.join(c.SQLDIR, t + ".json"), encoding="utf-8").read()
        assert "$J$" not in j
        pk = PK[t].split(",")
        upd = [x for x in cols(t) if x not in pk]
        sets = ", ".join(f"{x} = excluded.{x}" for x in upd) if upd else None
        conflict = f"on conflict ({PK[t]}) do " + (f"update set {sets}" if sets and not only_insert else "nothing")
        parts.append(f"insert into relay.{t} select * from jsonb_populate_recordset(null::relay.{t}, $J${j}$J$::jsonb) {conflict};")
    parts.append("select setval('relay.tenant_serial', greatest((select coalesce(max(serial),1) from relay.tenants),1));")
    parts.append("commit;")
    p = os.path.join(c.SQLDIR, "upsert.sql")
    open(p, "w", encoding="utf-8").write("\n".join(parts))
    r = subprocess.run(["npx", "supabase", "db", "query", "--project-ref", c.NEW, "--linked", "-f", p],
                       cwd=c.CWD, capture_output=True, text=True, shell=(os.name == "nt"), encoding="utf-8")
    print("upsert rc", r.returncode, r.stderr[-300:] if r.returncode else "")


def count():
    for ref, label in ((c.OLD, "舊"), (c.NEW, "新")):
        for t, w in c.TABLES:
            out = c.q(ref, f"select count(*) as n from relay.{t} x {w}")
            data = json.loads(out)
            rows = data["rows"] if isinstance(data, dict) and "rows" in data else data
            print(label, t, rows[0]["n"])


if __name__ == "__main__":
    {"export": c.export, "upsert": upsert, "insert": lambda: upsert(True), "count": count}[sys.argv[1]]()
