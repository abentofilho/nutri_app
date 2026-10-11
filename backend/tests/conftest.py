import os
import sys
import tempfile

import pytest
from sqlalchemy import MetaData, create_engine, text

# O banco é preparado antes de importar main.py, no formato exato da v1, para
# os testes cobrirem também a migração de quem já usa o app. Por padrão usa um
# SQLite temporário; no CI, TEST_DATABASE_URL aponta para um Postgres de verdade.
DB_URL = os.environ.get("TEST_DATABASE_URL") or "sqlite:///" + os.path.join(tempfile.mkdtemp(), "nutri_test.db")
os.environ["DATABASE_URL"] = DB_URL
os.environ["ADMIN_EMAILS"] = "antonio@exemplo.com"
os.environ["ADMIN_GITHUB"] = "abentofilho"
os.environ["GITHUB_CLIENT_ID"] = "github-teste"
os.environ["GITHUB_CLIENT_SECRET"] = "segredo-teste"
os.environ.pop("GOOGLE_CLIENT_ID", None)

LEGACY_USER = "36ef23f6-0607-4f01-84f9-533602724d52"

V1_SCHEMA = [
    """CREATE TABLE products (
        id VARCHAR NOT NULL PRIMARY KEY, nome VARCHAR NOT NULL, unidade VARCHAR NOT NULL,
        kcal FLOAT NOT NULL, carb FLOAT NOT NULL, acuc FLOAT NOT NULL, acucad FLOAT NOT NULL,
        prot FLOAT NOT NULL, gord FLOAT NOT NULL, gordsat FLOAT NOT NULL, gordtrans FLOAT NOT NULL,
        fibra FLOAT NOT NULL, sodio FLOAT NOT NULL, calcio FLOAT NOT NULL)""",
    """CREATE TABLE meals (
        id VARCHAR NOT NULL PRIMARY KEY, user_id VARCHAR NOT NULL, nome VARCHAR NOT NULL,
        items_json TEXT NOT NULL, totals_json TEXT NOT NULL, saved_at BIGINT NOT NULL)""",
]

NUTRIENTS = ["kcal", "carb", "acuc", "acucad", "prot", "gord", "gordsat", "gordtrans", "fibra", "sodio", "calcio"]


def _product(pid, nome, unidade="g", **values):
    return {"id": pid, "nome": nome, "unidade": unidade, **{f: values.get(f, 0) for f in NUTRIENTS}}


V1_PRODUCTS = [
    _product("seed-leite-italac", "Leite Italac semidesnatado", "ml", kcal=49, carb=5, prot=5, gord=1),
    _product("p-2ff288fad874", "Queijo Minas Frescal Porto Alegre", kcal=220, carb=3.3, prot=1515, gord=16, sodio=473),
    _product("p-e1fb272522f4", "Queijo Minas Frescal Porto Alegre_", kcal=220, carb=3.3, prot=15, gord=16, sodio=453),
    _product("p-6afa05ed2f9a", "Sardinhas Coqueiro", kcal=206, carb=441.4, prot=23),
    _product("p-6997c415e0f4", "Tapioca Pinduca", kcal=247, carb=62),
    _product("p-852bbbca0601", "Tapioca Pinduca", kcal=247, carb=62),
    _product("p-3256aa482572", "Pão integral 52% Lekker", kcal=273, carb=42, prot=13, gord=5.7),
]


def _build_v1_database():
    engine = create_engine(DB_URL)
    with engine.begin() as conn:
        meta = MetaData()
        meta.reflect(bind=conn)
        meta.drop_all(bind=conn)
        for ddl in V1_SCHEMA:
            conn.execute(text(ddl))
        cols = ", ".join(V1_PRODUCTS[0])
        params = ", ".join(":" + k for k in V1_PRODUCTS[0])
        conn.execute(text(f"INSERT INTO products ({cols}) VALUES ({params})"), V1_PRODUCTS)
        conn.execute(text("INSERT INTO meals VALUES (:id, :user_id, :nome, :items, :totals, :saved_at)"), {
            "id": "m-legacy000001", "user_id": LEGACY_USER, "nome": "Café da manhã",
            "items": '[{"productId": "p-3256aa482572", "qty": 50, "nome": "Pão integral 52% Lekker", "unidade": "g"}]',
            "totals": '{"kcal": 136.5}', "saved_at": 1790000000000,
        })
    engine.dispose()


_build_v1_database()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402


# Os testes criam muitas contas do mesmo "IP"; o limite real é testado à parte.
main.signup_throttle.limit = 10_000

GITHUB_USERS = {
    "codigo-antonio": {"id": "1001", "login": "abentofilho", "name": "Antônio Bento", "email": "antonio@exemplo.com"},
    "codigo-maria": {"id": "1002", "login": "maria-dev", "name": "Maria", "email": None},
}
main._github_identity = lambda code, redirect_uri: GITHUB_USERS[code]
APP_URL = "http://localhost:5500/"


@pytest.fixture(scope="session")
def client():
    with TestClient(main.app) as c:
        yield c


def _auth(client, path, payload):
    res = client.post(path, json=payload)
    assert res.status_code in (200, 201), res.text
    data = res.json()
    return {"Authorization": "Bearer " + data["token"]}, data["user"]


@pytest.fixture
def guest(client):
    return _auth(client, "/api/auth/guest", {"nome": "Convidada"})


@pytest.fixture(scope="session")
def admin(client):
    return _auth(client, "/api/auth/github", {"code": "codigo-antonio", "redirect_uri": APP_URL})
