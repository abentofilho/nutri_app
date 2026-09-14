"""
Despensa & Refeições - backend
--------------------------------
API em FastAPI, agora com SQLAlchemy, para funcionar tanto com:
  - SQLite local (padrão, sem configurar nada - bom para testar na sua máquina)
  - Postgres em nuvem (Neon, Supabase, etc.) - basta definir a variável de
    ambiente DATABASE_URL, sem mudar nenhuma linha de código.

Guarda:
  - produtos (catálogo público, só é possível adicionar, não apagar)
  - refeições (privadas por "usuário" - identificado por um id anônimo
    gerado no navegador de quem acessa, guardado em localStorage)

Rodar localmente (usa SQLite, arquivo nutri.db nesta pasta):
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Rodar apontando para um Postgres externo:
    export DATABASE_URL="postgresql://usuario:senha@host/banco?sslmode=require"
    uvicorn main:app --reload --port 8000

A API fica em http://localhost:8000/api
Documentação automática (Swagger) em http://localhost:8000/docs
"""

import os
import time
import uuid
import json
from typing import List, Dict

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from sqlalchemy import (
    create_engine, MetaData, Table, Column, String, Float, Text, BigInteger,
    select, insert, delete, func,
)

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

def _normalize_db_url(url: str) -> str:
    # Alguns provedores (Neon, Supabase, Heroku antigo) entregam a URL como
    # "postgres://..." - o SQLAlchemy moderno exige "postgresql://...".
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


DATABASE_URL = _normalize_db_url(os.environ.get("DATABASE_URL", "sqlite:///nutri.db"))

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)

metadata = MetaData()

products_table = Table(
    "products", metadata,
    Column("id", String, primary_key=True),
    Column("nome", String, nullable=False),
    Column("unidade", String, nullable=False),
    *[Column(f, Float, nullable=False, default=0) for f in NUTRIENT_FIELDS],
)

meals_table = Table(
    "meals", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=False),
    Column("nome", String, nullable=False),
    Column("items_json", Text, nullable=False),
    Column("totals_json", Text, nullable=False),
    Column("saved_at", BigInteger, nullable=False),
)


def init_db():
    metadata.create_all(engine)
    with engine.begin() as conn:
        count = conn.execute(select(func.count()).select_from(products_table)).scalar()
        if count == 0:
            conn.execute(insert(products_table), DEFAULT_PRODUCTS)


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
    return {"status": "ok", "db": "postgres" if not DATABASE_URL.startswith("sqlite") else "sqlite"}


# ---- products ----

@app.get("/api/products")
def list_products():
    with engine.connect() as conn:
        rows = conn.execute(select(products_table).order_by(products_table.c.nome)).mappings().all()
        return [dict(r) for r in rows]


@app.post("/api/products", status_code=201)
def create_product(product: ProductIn):
    nome = product.nome.strip()
    with engine.begin() as conn:
        dup = conn.execute(
            select(products_table.c.id).where(func.lower(products_table.c.nome) == nome.lower())
        ).first()
        if dup:
            raise HTTPException(
                status_code=409,
                detail=f'Já existe um produto chamado "{nome}" no catálogo.',
            )
        data = product.model_dump()
        data["nome"] = nome
        data["id"] = "p-" + uuid.uuid4().hex[:12]
        conn.execute(insert(products_table).values(**data))
        return data


# Nota: não existe endpoint DELETE para produtos de propósito -
# o catálogo é só de adição, para evitar que a base seja apagada
# por engano ou por má vontade de quem acessa o app publicado.


# ---- meals ----

@app.get("/api/meals")
def list_meals(user_id: str = Query(...)):
    with engine.connect() as conn:
        rows = conn.execute(
            select(meals_table)
            .where(meals_table.c.user_id == user_id)
            .order_by(meals_table.c.saved_at.desc())
        ).mappings().all()
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
    nome = meal.nome.strip()
    if not nome:
        raise HTTPException(status_code=400, detail="Dê um nome para a refeição.")

    new_id = "m-" + uuid.uuid4().hex[:12]
    saved_at = int(time.time() * 1000)
    row = {
        "id": new_id,
        "user_id": meal.user_id,
        "nome": nome,
        "items_json": json.dumps([i.model_dump() for i in meal.items]),
        "totals_json": json.dumps(meal.totals),
        "saved_at": saved_at,
    }
    with engine.begin() as conn:
        conn.execute(insert(meals_table).values(**row))

    return {
        "id": new_id,
        "user_id": meal.user_id,
        "nome": nome,
        "items": [i.model_dump() for i in meal.items],
        "totals": meal.totals,
        "saved_at": saved_at,
    }


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: str, user_id: str = Query(...)):
    with engine.begin() as conn:
        row = conn.execute(
            select(meals_table.c.id).where(
                meals_table.c.id == meal_id, meals_table.c.user_id == user_id
            )
        ).first()
        if not row:
            raise HTTPException(
                status_code=404,
                detail="Refeição não encontrada (ou não pertence a este usuário).",
            )
        conn.execute(delete(meals_table).where(meals_table.c.id == meal_id))
    return {"deleted": meal_id}
