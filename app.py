from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import threading
import webbrowser
from contextlib import contextmanager
from datetime import timedelta
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_file, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(BASE_DIR / "data" / "solsrng.sqlite3")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "local-development-key-change-before-publishing-7ea6a6f8"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0").lower() in {"1", "true", "yes"},
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)
# Respect HTTPS headers when deployed behind a reverse proxy.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins=None, logger=False, engineio_logger=False)

ROOMS: dict[str, dict] = {}
SOCKET_USERS: dict[str, dict] = {}
ROOM_LOCK = threading.RLock()
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
VALID_CLASSES = {
    "campones", "guerreiro", "mago", "ladino", "paladino", "arqueiro", "medica"
}


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def db_session():
    conn = db_connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db_session() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS player_saves (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                save_data TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()


init_db()


def public_user(row: sqlite3.Row | dict) -> dict:
    return {"id": row["id"], "username": row["username"], "email": row["email"]}


def current_user_id() -> str | None:
    return session.get("uid")


def get_current_user() -> dict | None:
    uid = current_user_id()
    if not uid:
        return None
    with db_session() as conn:
        row = conn.execute("SELECT id, username, email FROM users WHERE id = ?", (uid,)).fetchone()
    return public_user(row) if row else None


def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not current_user_id() or get_current_user() is None:
            return jsonify(error="Entre na sua conta para continuar."), 401
        return fn(*args, **kwargs)
    return wrapped


def json_body() -> dict:
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else {}


def clean_username(value: str) -> str:
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value[:24]


def validate_email(value: str) -> str:
    email = str(value or "").strip().lower()
    if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ValueError("Digite um e-mail válido.")
    return email


def json_error(message: str, status: int):
    return jsonify(error=message), status


@app.get("/")
def home():
    # A raiz serve diretamente o jogo; não mostra listagem de diretórios.
    return send_file(STATIC_DIR / "game.html", mimetype="text/html")


@app.get("/healthz")
def healthz():
    return jsonify(status="ok", game="Sols RNG Dark Fantasy")


@app.post("/api/auth/register")
def register():
    body = json_body()
    username = clean_username(body.get("username"))
    try:
        email = validate_email(body.get("email"))
    except ValueError as exc:
        return json_error(str(exc), 400)
    password = str(body.get("password") or "")
    if len(username) < 2:
        return json_error("Escolha um nome de jogador com pelo menos 2 caracteres.", 400)
    if len(password) < 8:
        return json_error("A senha precisa ter pelo menos 8 caracteres.", 400)
    if len(password) > 200:
        return json_error("A senha é longa demais.", 400)

    user_id = secrets.token_hex(16)
    password_hash = generate_password_hash(password, method="scrypt")
    try:
        with db_session() as conn:
            conn.execute(
                "INSERT INTO users(id, username, email, password_hash) VALUES (?, ?, ?, ?)",
                (user_id, username, email, password_hash),
            )
            conn.execute(
                "INSERT INTO player_saves(user_id, save_data) VALUES (?, ?)",
                (user_id, json.dumps({"version": 5, "save": None, "meta": None})),
            )
            conn.commit()
    except sqlite3.IntegrityError:
        return json_error("Esse e-mail já tem uma conta. Entre nela ou use outro e-mail.", 409)

    session.clear()
    session["uid"] = user_id
    session.permanent = True
    with db_session() as conn:
        row = conn.execute("SELECT id, username, email FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(user=public_user(row), message="Conta criada! Você já está conectado."), 201


@app.post("/api/auth/login")
def login():
    body = json_body()
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    if not email or not password:
        return json_error("Informe seu e-mail e sua senha.", 400)
    with db_session() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return json_error("E-mail ou senha incorretos.", 401)
    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    return jsonify(user=public_user(row), message="Login realizado.")


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    user = get_current_user()
    return jsonify(user=user), (200 if user else 200)


@app.get("/api/save")
@login_required
def get_save():
    uid = current_user_id()
    with db_session() as conn:
        row = conn.execute("SELECT save_data, updated_at FROM player_saves WHERE user_id = ?", (uid,)).fetchone()
    if not row:
        return jsonify(save_data={"version": 5, "save": None, "meta": None}, updated_at=None)
    try:
        data = json.loads(row["save_data"])
    except (TypeError, json.JSONDecodeError):
        data = {"version": 5, "save": None, "meta": None}
    return jsonify(save_data=data, updated_at=row["updated_at"])


@app.put("/api/save")
@login_required
def put_save():
    body = json_body()
    save_value = body.get("save")
    meta_value = body.get("meta")
    if save_value is not None and not isinstance(save_value, str):
        return json_error("Dados de save inválidos.", 400)
    if meta_value is not None and not isinstance(meta_value, str):
        return json_error("Dados de progresso inválidos.", 400)
    if len(save_value or "") > 1_000_000 or len(meta_value or "") > 250_000:
        return json_error("O save está maior do que o permitido.", 413)
    payload = json.dumps({"version": 5, "save": save_value, "meta": meta_value}, ensure_ascii=False)
    with db_session() as conn:
        conn.execute("""
            INSERT INTO player_saves(user_id, save_data, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET save_data=excluded.save_data, updated_at=CURRENT_TIMESTAMP
        """, (current_user_id(), payload))
        conn.commit()
    return jsonify(ok=True)


def make_player(uid: str, raw: dict | None = None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    with db_session() as conn:
        row = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    username = row["username"] if row else "Aventureiro"
    cls = str(raw.get("classId") or "campones")
    if cls not in VALID_CLASSES:
        cls = "campones"

    def bounded_int(key, default, low=0, high=100000):
        try:
            value = int(float(raw.get(key, default)))
        except (TypeError, ValueError):
            value = default
        return max(low, min(high, value))

    hp = bounded_int("hp", 100, 0, 100000)
    max_hp = max(1, bounded_int("maxHp", max(100, hp), 1, 100000))
    mp = bounded_int("mp", 30, 0, 100000)
    max_mp = max(1, bounded_int("maxMp", max(30, mp), 1, 100000))
    return {
        "userId": uid,
        "name": username,
        "classId": cls,
        "hp": min(hp, max_hp), "maxHp": max_hp,
        "mp": min(mp, max_mp), "maxMp": max_mp,
        "dmg": bounded_int("dmg", 8, 1, 100000),
        "stage": bounded_int("stage", 1, 1, 3),
        "role": str(raw.get("role") or "Aventureiro")[:32],
    }


def socket_user() -> dict | None:
    uid = session.get("uid")
    if not uid:
        return None
    with db_session() as conn:
        row = conn.execute("SELECT id, username, email FROM users WHERE id = ?", (uid,)).fetchone()
    return public_user(row) if row else None


def emit_roster(code: str) -> None:
    room = ROOMS.get(code)
    if not room:
        return
    players = []
    for p in room["players"].values():
        players.append({k: v for k, v in p.items() if k != "sid"})
    socketio.emit("room_roster", {"code": code, "hostId": room["hostId"], "players": players}, to=code)


def remove_socket_from_room(sid: str) -> None:
    info = SOCKET_USERS.get(sid)
    if not info:
        return
    code = info.get("room")
    if not code:
        return
    with ROOM_LOCK:
        room = ROOMS.get(code)
        if room:
            player = room["players"].get(info["id"])
            if player and player.get("sid") == sid:
                room["players"].pop(info["id"], None)
            if not room["players"]:
                ROOMS.pop(code, None)
            else:
                if room["hostId"] not in room["players"]:
                    room["hostId"] = next(iter(room["players"]))
                emit_roster(code)
    try:
        leave_room(code, sid=sid)
    except Exception:
        pass
    info["room"] = None


def add_player_to_room(code: str, uid: str, sid: str, raw: dict | None = None, create: bool = False) -> dict:
    user = socket_user()
    if not user:
        return {"ok": False, "error": "Entre na sua conta antes de jogar online."}
    raw = raw if isinstance(raw, dict) else {}
    with ROOM_LOCK:
        if create:
            for _ in range(20):
                candidate = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if candidate not in ROOMS:
                    code = candidate
                    break
            else:
                return {"ok": False, "error": "Não foi possível criar uma sala. Tente novamente."}
            ROOMS[code] = {"hostId": uid, "players": {}}
        room = ROOMS.get(code)
        if not room:
            return {"ok": False, "error": "Essa sala não existe mais. Peça um convite novo."}
        existing = room["players"].get(uid)
        if not existing and len(room["players"]) >= 3:
            return {"ok": False, "error": "A sala está cheia (máximo de 3 jogadores)."}

    remove_socket_from_room(sid)
    player = make_player(uid, raw)
    player.update({"name": user["username"], "sid": sid})
    with ROOM_LOCK:
        room = ROOMS.get(code)
        if not room:
            return {"ok": False, "error": "A sala fechou. Crie outra sala."}
        room["players"][uid] = player
        SOCKET_USERS[sid]["room"] = code
        if not room.get("hostId") or room["hostId"] not in room["players"]:
            room["hostId"] = uid
        join_room(code, sid=sid)
        visible = [{k: v for k, v in p.items() if k != "sid"} for p in room["players"].values()]
        result = {"ok": True, "code": code, "hostId": room["hostId"], "players": visible}
        emit_roster(code)
    return result


@socketio.on("connect")
def on_connect(auth=None):
    user = socket_user()
    if not user:
        return False
    SOCKET_USERS[request.sid] = {**user, "room": None}
    emit("server_ready", {"user": user})


@socketio.on("room_create")
def on_room_create(data=None):
    info = SOCKET_USERS.get(request.sid)
    user = socket_user()
    if not info or not user:
        return {"ok": False, "error": "Entre na sua conta primeiro."}
    body = data if isinstance(data, dict) else {}
    return add_player_to_room("", user["id"], request.sid, body.get("player"), create=True)


@socketio.on("room_join")
def on_room_join(data=None):
    info = SOCKET_USERS.get(request.sid)
    user = socket_user()
    if not info or not user:
        return {"ok": False, "error": "Entre na sua conta primeiro."}
    body = data if isinstance(data, dict) else {}
    code = re.sub(r"[^A-Z0-9]", "", str(body.get("code") or "").upper())
    if not re.fullmatch(r"[A-Z0-9]{6}", code):
        return {"ok": False, "error": "O código da sala precisa ter 6 caracteres."}
    return add_player_to_room(code, user["id"], request.sid, body.get("player"), create=False)


@socketio.on("player_update")
def on_player_update(data=None):
    info = SOCKET_USERS.get(request.sid)
    if not info or not info.get("room"):
        return
    code = info["room"]
    with ROOM_LOCK:
        room = ROOMS.get(code)
        player = room and room["players"].get(info["id"])
        if not player or player.get("sid") != request.sid:
            return
        fresh = make_player(info["id"], data if isinstance(data, dict) else {})
        fresh.update({"name": info["username"], "sid": request.sid})
        room["players"][info["id"]] = fresh
        emit_roster(code)


@socketio.on("coop_send")
def on_coop_send(data=None):
    info = SOCKET_USERS.get(request.sid)
    if not info or not info.get("room"):
        return
    code = info["room"]
    body = data if isinstance(data, dict) else {}
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    kind = str(payload.get("type") or "")
    with ROOM_LOCK:
        room = ROOMS.get(code)
        if not room or info["id"] not in room["players"]:
            return
        # Apenas o anfitrião pode enviar estados de batalha. A ação do jogador recebe o ID do servidor.
        if kind in {"boss_start", "boss_state", "boss_end"} and room["hostId"] != info["id"]:
            emit("room_error", {"message": "Somente o anfitrião pode controlar o estado da batalha."}, to=request.sid)
            return
        if kind == "player_action" and info["id"] not in room["players"]:
            return
        if kind not in {"boss_start", "boss_state", "boss_end", "player_action"}:
            return
        packet = dict(payload)
        packet["from"] = info["id"]
        packet["ts"] = __import__("time").time_ns() // 1_000_000
        socketio.emit("coop_message", packet, to=code)


@socketio.on("room_leave")
def on_room_leave():
    remove_socket_from_room(request.sid)


@socketio.on("disconnect")
def on_disconnect(reason=None):
    remove_socket_from_room(request.sid)
    SOCKET_USERS.pop(request.sid, None)


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="O pedido ficou maior do que o limite permitido."), 413


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0").lower() in {"1", "true", "yes"}
    # Inicie o servidor antes de abrir a página para evitar a primeira conexão recusada.
    if os.environ.get("OPEN_BROWSER", "1").lower() not in {"0", "false", "no"}:
        threading.Timer(1.2, lambda: webbrowser.open_new_tab(f"http://127.0.0.1:{port}")).start()
    socketio.run(app, host="0.0.0.0", port=port, debug=debug, allow_unsafe_werkzeug=True)
