"""
Despensa & Refeições - backend
--------------------------------
API simples em FastAPI + SQLite para guardar:
  - produtos (catálogo público, só é possível adicionar, não apagar)
  - refeições (privadas por "usuário" - identificado por um id anônimo
    gerado no navegador de quem acessa, guardado em localStorage)

Rodar localmente:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

A API fica em http://localhost:8000/api
Documentação automática (Swagger) em http://localhost:8000/docs
"""

import sqlite3
import time
import uuid
import json
from contextlib import contextmanager
from typing import List, Optional, Dict

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = "nutri.db"

NUTRIENT_FIELDS = [
    "kcal", "carb", "acuc", "acucad", "prot",
    "gord", "gordsat", "gordtrans", "fibra", "sodio", "calcio",
]

DEFAULT_PRODUCTS = [
    {
        "id": "seed-leite-italac",
        "nome": "Leite Italac semidesnatado",
        "unidade": "ml",
        "kcal": 49, "carb": 5, "acuc": 4.9, "acucad": 0, "prot": 5,
        "gord": 1, "gordsat": 0.6, "gordtrans": 0, "fibra": 0,
        "sodio": 76, "calcio": 150,
    },
    {
        "id": "seed-doce-de-leite",
        "nome": "Doce de leite",
        "unidade": "g",
        "kcal": 179, "carb": 6.8, "acuc": 6.8, "acucad": 0, "prot": 11,
        "gord": 12, "gordsat": 10, "gordtrans": 0, "fibra": 0,
        "sodio": 71, "calcio": 306,
    },
]


# ---------- database setup ----------

@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                unidade TEXT NOT NULL,
                kcal REAL DEFAULT 0,
                carb REAL DEFAULT 0,
                acuc REAL DEFAULT 0,
                acucad REAL DEFAULT 0,
                prot REAL DEFAULT 0,
                gord REAL DEFAULT 0,
                gordsat REAL DEFAULT 0,
                gordtrans REAL DEFAULT 0,
                fibra REAL DEFAULT 0,
                sodio REAL DEFAULT 0,
                calcio REAL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS meals (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                nome TEXT NOT NULL,
                items_json TEXT NOT NULL,
                totals_json TEXT NOT NULL,
                saved_at INTEGER NOT NULL
            )
        """)
        count = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"]
        if count == 0:
            for p in DEFAULT_PRODUCTS:
                cols = ", ".join(p.keys())
                placeholders = ", ".join("?" for _ in p)
                conn.execute(
                    f"INSERT INTO products ({cols}) VALUES ({placeholders})",
                    tuple(p.values()),
                )


# ---------- models ----------

class ProductIn(BaseModel):
    nome: str
    unidade: str = Field(pattern="^(g|ml)$")
    kcal: float = 0
    carb: float = 0
    acuc: float = 0
    acucad: float = 0
    prot: float = 0
    gord: float = 0
    gordsat: float = 0
    gordtrans: float = 0
    fibra: float = 0
    sodio: float = 0
    calcio: float = 0


class MealItemIn(BaseModel):
    productId: str
    qty: float
    nome: str
    unidade: str


class MealIn(BaseModel):
    user_id: str
    nome: str
    items: List[MealItemIn]
    totals: Dict[str, float]


# ---------- app ----------

app = FastAPI(title="Despensa & Refeições API")

# CORS liberado para qualquer origem, já que o front-end pode ficar
# hospedado em outro endereço/domínio. Se quiser restringir, troque
# allow_origins=["*"] pela URL exata do seu front-end.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---- products ----

@app.get("/api/products")
def list_products():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM products ORDER BY nome").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/products", status_code=201)
def create_product(product: ProductIn):
    with get_conn() as conn:
        dup = conn.execute(
            "SELECT id FROM products WHERE LOWER(nome) = LOWER(?)",
            (product.nome.strip(),),
        ).fetchone()
        if dup:
            raise HTTPException(
                status_code=409,
                detail=f'Já existe um produto chamado "{product.nome}" no catálogo.',
            )
        new_id = "p-" + uuid.uuid4().hex[:12]
        data = product.dict()
        data["id"] = new_id
        data["nome"] = data["nome"].strip()
        cols = ", ".join(data.keys())
        placeholders = ", ".join("?" for _ in data)
        conn.execute(
            f"INSERT INTO products ({cols}) VALUES ({placeholders})",
            tuple(data.values()),
        )
        return data


# Nota: não existe endpoint DELETE para produtos de propósito -
# o catálogo é só de adição, para evitar que a base seja apagada
# por engano ou por má vontade de quem acessa o app publicado.


# ---- meals ----

@app.get("/api/meals")
def list_meals(user_id: str = Query(...)):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM meals WHERE user_id = ? ORDER BY saved_at DESC",
            (user_id,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["items"] = json.loads(d.pop("items_json"))
            d["totals"] = json.loads(d.pop("totals_json"))
            result.append(d)
        return result


@app.post("/api/meals", status_code=201)
def create_meal(meal: MealIn):
    if not meal.items:
        raise HTTPException(status_code=400, detail="A refeição precisa de ao menos um item.")
    if not meal.nome.strip():
        raise HTTPException(status_code=400, detail="Dê um nome para a refeição.")
    new_id = "m-" + uuid.uuid4().hex[:12]
    saved_at = int(time.time() * 1000)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO meals (id, user_id, nome, items_json, totals_json, saved_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                new_id,
                meal.user_id,
                meal.nome.strip(),
                json.dumps([i.dict() for i in meal.items]),
                json.dumps(meal.totals),
                saved_at,
            ),
        )
    return {
        "id": new_id,
        "user_id": meal.user_id,
        "nome": meal.nome.strip(),
        "items": [i.dict() for i in meal.items],
        "totals": meal.totals,
        "saved_at": saved_at,
    }


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: str, user_id: str = Query(...)):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM meals WHERE id = ? AND user_id = ?",
            (meal_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(
                status_code=404,
                detail="Refeição não encontrada (ou não pertence a este usuário).",
            )
        conn.execute("DELETE FROM meals WHERE id = ?", (meal_id,))
    return {"deleted": meal_id}
