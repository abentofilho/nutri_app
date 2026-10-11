"""
NutriApp - backend (v2)
-----------------------
API em FastAPI + SQLAlchemy. Funciona com:
  - SQLite local (padrão, sem configurar nada - bom para testar na sua máquina)
  - Postgres em nuvem (Neon, Supabase, etc.) - basta definir DATABASE_URL.

O que guarda:
  - produtos do catálogo da Nutri (públicos; só o administrador altera, os
    demais usuários enviam sugestões)
  - produtos pessoais (privados, cada usuário vê só os seus)
  - refeições/receitas (as de cada pessoa e as "Receitas da Nutri")
  - água bebida por dia
  - diário alimentar dos últimos HISTORY_DAYS dias (os mais antigos saem
    sozinhos, como uma fila FIFO)
  - contas: e-mail e senha, Google, GitHub ou convidado (só o nome)

Variáveis de ambiente (todas opcionais):
    DATABASE_URL          postgresql://usuario:senha@host/banco?sslmode=require
    GITHUB_CLIENT_ID      login com GitHub (OAuth App) - é por ele que o
    GITHUB_CLIENT_SECRET  administrador entra
    ADMIN_GITHUB          usuários do GitHub administradores (padrão: abentofilho)
    ADMIN_EMAILS          e-mails administradores; só valem se confirmados pelo
                          Google ou pelo GitHub
    GOOGLE_CLIENT_ID      habilita o botão "Continuar com o Google"
    CORS_ORIGINS          sites que podem chamar a API (padrão: o GitHub Pages
                          do app e localhost)
    HISTORY_DAYS          dias guardados no diário (padrão 30)

  E-mails (confirmação de conta e "esqueci minha senha"). Sem isso o app
  funciona, só sem esses recursos. O Render gratuito bloqueia SMTP, então o
  envio é pela API HTTP do provedor:
    MAIL_FROM             remetente, ex.: NutriApp <voce@gmail.com>
    BREVO_API_KEY         chave do Brevo (300 e-mails/dia grátis), ou
    RESEND_API_KEY        chave do Resend (exige domínio próprio)
    MAIL_FILE             só para desenvolvimento: grava os e-mails neste arquivo

Rodar localmente:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

A API fica em http://localhost:8000/api
Documentação automática (Swagger) em http://localhost:8000/docs
"""

import base64
import datetime as dt
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import time
import uuid
from urllib.parse import urlparse
from contextlib import asynccontextmanager
from typing import Dict, List, Literal, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator

from sqlalchemy import (
    create_engine, inspect, text, MetaData, Table, Column, Index, String, Float, Text,
    BigInteger, Integer, select, insert, update, delete, func,
)

NUTRIENT_FIELDS = [
    "kcal", "carb", "acuc", "acucad", "prot",
    "gord", "gordsat", "gordtrans", "fibra", "sodio", "calcio",
]

# Limites físicos por 100 g/ml - servem para barrar erros de digitação
# (ex.: 1515 g de proteína em 100 g de queijo).
NUTRIENT_MAX = {
    "kcal": 950, "carb": 100, "acuc": 100, "acucad": 100, "prot": 100,
    "gord": 100, "gordsat": 100, "gordtrans": 100, "fibra": 100,
    "sodio": 40000, "calcio": 5000,
}

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

HOUSE_USER = "casa"          # dono das "Receitas da Nutri" na tabela meals
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "30"))
SESSION_DAYS = 365
TRANSFER_MINUTES = 10


def _env_set(name: str, default: str = "") -> set:
    return {v.strip().lower() for v in os.environ.get(name, default).split(",") if v.strip()}


ADMIN_EMAILS = _env_set("ADMIN_EMAILS")
ADMIN_GITHUB = _env_set("ADMIN_GITHUB", "abentofilho")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "").strip()
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
CORS_ORIGINS = sorted(_env_set(
    "CORS_ORIGINS", "https://abentofilho.github.io,http://localhost:5500,http://127.0.0.1:5500"))

MAIL_FROM = os.environ.get("MAIL_FROM", "").strip()
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "").strip()
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
MAIL_FILE = os.environ.get("MAIL_FILE", "").strip()
APP_NAME = "NutriApp"
VERIFY_HOURS = 72
RESET_MINUTES = 30

log = logging.getLogger("nutriapp")


def now_ms() -> int:
    return int(time.time() * 1000)


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


def nutrient_columns():
    return [Column(f, Float, nullable=False, default=0) for f in NUTRIENT_FIELDS]


products_table = Table(
    "products", metadata,
    Column("id", String, primary_key=True),
    Column("nome", String, nullable=False),
    Column("unidade", String, nullable=False),
    *nutrient_columns(),
    # v2
    Column("barcode", String, nullable=True),
    Column("archived", Integer, nullable=False, default=0),
    Column("updated_at", BigInteger, nullable=True),
    # porção caseira: "1 unidade = 46 g", "1 fatia = 25 g"
    Column("porcao_g", Float, nullable=True),
    Column("porcao_nome", String, nullable=True),
)

meals_table = Table(
    "meals", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("nome", String, nullable=False),
    Column("items_json", Text, nullable=False),
    Column("totals_json", Text, nullable=False),
    Column("saved_at", BigInteger, nullable=False),
    # v2
    Column("descricao", Text, nullable=True),
)

users_table = Table(
    "users", metadata,
    Column("id", String, primary_key=True),
    Column("nome", String, nullable=False),
    Column("email", String, nullable=True, unique=True),
    Column("password_hash", String, nullable=True),
    Column("google_sub", String, nullable=True, unique=True),
    Column("is_guest", Integer, nullable=False, default=0),
    Column("prefs_json", Text, nullable=False, default="{}"),
    Column("created_at", BigInteger, nullable=False),
    # e-mail confirmado por Google/GitHub (cadastro com senha não confirma)
    Column("email_verified", Integer, nullable=False, default=0),
    Column("github_id", String, nullable=True),
    Column("github_login", String, nullable=True),
    Index("ix_users_github_id", "github_id", unique=True),
)

sessions_table = Table(
    "sessions", metadata,
    Column("token_hash", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("created_at", BigInteger, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
)

transfer_codes_table = Table(
    "transfer_codes", metadata,
    Column("code_hash", String, primary_key=True),
    Column("user_id", String, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
)

email_tokens_table = Table(
    "email_tokens", metadata,
    Column("token_hash", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("kind", String, nullable=False),          # confirmar | redefinir
    Column("email", String, nullable=False),         # e-mail para o qual o link foi enviado
    Column("expires_at", BigInteger, nullable=False),
)

user_products_table = Table(
    "user_products", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("nome", String, nullable=False),
    Column("unidade", String, nullable=False),
    *nutrient_columns(),
    Column("barcode", String, nullable=True),
    Column("porcao_g", Float, nullable=True),
    Column("porcao_nome", String, nullable=True),
    Column("created_at", BigInteger, nullable=False),
    Column("updated_at", BigInteger, nullable=False),
)

diary_table = Table(
    "diary_entries", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("day", String(10), nullable=False, index=True),   # AAAA-MM-DD (data local de quem comeu)
    Column("slot", String, nullable=False),                  # cafe | almoco | lanche | jantar
    Column("product_id", String, nullable=True),
    Column("nome", String, nullable=False),
    Column("unidade", String, nullable=False),
    Column("qty", Float, nullable=False),
    Column("nutr_json", Text, nullable=False),               # valores por 100 g/ml no momento do registro
    Column("created_at", BigInteger, nullable=False),
    # quando registrado em porções ("2 unidades"); qty continua em g/ml
    Column("porcoes", Float, nullable=True),
    Column("porcao_nome", String, nullable=True),
)

water_table = Table(
    "water_log", metadata,
    Column("user_id", String, primary_key=True),
    Column("day", String(10), primary_key=True),
    Column("ml", Integer, nullable=False),
)

suggestions_table = Table(
    "suggestions", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=False, index=True),
    Column("author_nome", String, nullable=False),
    Column("kind", String, nullable=False),                  # novo | correcao
    Column("product_id", String, nullable=True),
    Column("payload_json", Text, nullable=False),
    Column("note", Text, nullable=True),
    Column("status", String, nullable=False, default="pendente"),
    Column("review_note", Text, nullable=True),
    Column("created_at", BigInteger, nullable=False),
    Column("reviewed_at", BigInteger, nullable=True),
)

migrations_table = Table(
    "schema_migrations", metadata,
    Column("name", String, primary_key=True),
    Column("applied_at", BigInteger, nullable=False),
)


# ---------- migrations ----------
# create_all() cria tabelas novas, mas não mexe nas que já existem. Colunas e
# índices novos de tabelas antigas são adicionados aqui, sem perder nada.

def _add_missing_columns(conn):
    insp = inspect(conn)
    for table in metadata.sorted_tables:
        existing = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            col_type = col.type.compile(dialect=conn.dialect)
            default = " DEFAULT 0 NOT NULL" if isinstance(col.default and col.default.arg, int) else ""
            conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}{default}"))
        for index in table.indexes:
            index.create(conn, checkfirst=True)


def _fix_catalog_typos(conn):
    """Correções pontuais em produtos do catálogo original.

    Cada correção só é aplicada se o valor ainda for o errado - se alguém já
    tiver arrumado pela tela, nada é sobrescrito.
    """
    def fix(product_id, expect, values):
        row = conn.execute(select(products_table).where(products_table.c.id == product_id)).mappings().first()
        if row and all(row[k] == v for k, v in expect.items()):
            conn.execute(update(products_table).where(products_table.c.id == product_id)
                         .values(**values, updated_at=now_ms()))

    # Queijo minas: proteína digitada como 1515 g. O próprio autor recadastrou
    # o produto como "Queijo Minas Frescal Porto Alegre_" com os valores certos;
    # o original recebe esses valores e a cópia é arquivada.
    copy = conn.execute(select(products_table).where(products_table.c.id == "p-e1fb272522f4")).mappings().first()
    if copy:
        fix("p-2ff288fad874", {"prot": 1515}, {f: copy[f] for f in NUTRIENT_FIELDS})
        fix("p-e1fb272522f4", {"nome": "Queijo Minas Frescal Porto Alegre_"}, {"archived": 1})

    # Sardinha em conserva não tem carboidrato (441,4 g em 100 g é impossível).
    fix("p-6afa05ed2f9a", {"carb": 441.4}, {"carb": 0})

    # Mesmo produto cadastrado duas vezes (clique duplo no "Salvar").
    a = conn.execute(select(products_table).where(products_table.c.id == "p-6997c415e0f4")).mappings().first()
    b = conn.execute(select(products_table).where(products_table.c.id == "p-852bbbca0601")).mappings().first()
    if a and b and all(a[f] == b[f] for f in ["nome", "unidade", *NUTRIENT_FIELDS]):
        fix("p-852bbbca0601", {"archived": 0}, {"archived": 1})

    fix("p-217e20e2c73f", {"nome": "Cream Chease Porto Alegre"}, {"nome": "Cream Cheese Porto Alegre"})
    fix("p-e26dd5d857ed", {"nome": "Leite desnatado Leitissmo"}, {"nome": "Leite desnatado Leitíssimo"})


# Receitas da Nutri: combinações montadas com os produtos que já estavam na
# despensa. Ficam editáveis pelo administrador na tela de Receitas.
HOUSE_RECIPES = [
    ("Café com pão e queijo minas", "O café da manhã de todo dia: pão integral, queijo fresco e um copo de leite.",
     [("p-3256aa482572", 50), ("p-2ff288fad874", 30), ("seed-leite-italac", 200)]),
    ("Tapioca de frango com ricota", "Tapioca recheada com frango desfiado e creme de ricota.",
     [("p-6997c415e0f4", 60), ("p-54d85be83c4b", 80), ("p-54def243bd3a", 20)]),
    ("Granola com leite", "Lanche rápido e cheio de fibras.",
     [("p-d3cc36a82499", 40), ("p-e26dd5d857ed", 200)]),
    ("Romeu e Julieta", "Queijo minas com goiabada zero - a sobremesa mineira, sem açúcar adicionado.",
     [("p-e93be3d6fdf2", 30), ("p-95e5bd3cc4e7", 30)]),
    ("Mandioca com frango", "Almoço simples de panela: mandioca cozida e frango desfiado.",
     [("p-2a509ca04345", 150), ("p-54d85be83c4b", 100)]),
    ("Biscoito de arroz com ricota e geleia", "Lanche da tarde leve.",
     [("p-4e228ab5cbee", 20), ("p-54def243bd3a", 30), ("p-ab8eb016bbd7", 15)]),
    ("Chocolate quente", "Leite semidesnatado com chocolate em pó.",
     [("seed-leite-italac", 200), ("p-17adb4d5d02b", 20)]),
]


def _seed_house_recipes(conn):
    has_any = conn.execute(
        select(func.count()).select_from(meals_table).where(meals_table.c.user_id == HOUSE_USER)
    ).scalar()
    if has_any:
        return
    base_time = now_ms()
    for pos, (nome, descricao, parts) in enumerate(HOUSE_RECIPES):
        items = []
        for product_id, qty in parts:
            p = conn.execute(select(products_table).where(products_table.c.id == product_id)).mappings().first()
            if p:
                items.append(item_snapshot(p, qty))
        if not items:
            continue
        conn.execute(insert(meals_table).values(
            id="m-" + uuid.uuid4().hex[:12], user_id=HOUSE_USER, nome=nome, descricao=descricao,
            items_json=json.dumps(items), totals_json=json.dumps(totals_of(items)),
            saved_at=base_time - pos,   # mantém a ordem da lista acima
        ))


# Porções caseiras dos produtos que já estavam no catálogo. Só preenche se o
# produto ainda não tiver porção (o administrador pode ajustar depois).
CATALOG_PORTIONS = {
    "p-bc325a3c9f19": (46, "unidade"),      # ovo
    "p-3256aa482572": (25, "fatia"),        # pão integral
    "p-2ff288fad874": (30, "fatia"),        # queijo minas frescal
    "p-e93be3d6fdf2": (30, "fatia"),        # queijo minas padrão
    "seed-leite-italac": (200, "copo"),
    "p-e26dd5d857ed": (200, "copo"),
}


def _seed_portions(conn):
    for product_id, (grams, nome) in CATALOG_PORTIONS.items():
        conn.execute(update(products_table).where(
            products_table.c.id == product_id, products_table.c.porcao_g.is_(None),
        ).values(porcao_g=grams, porcao_nome=nome))


DATA_MIGRATIONS = [
    ("2026-10-catalog-typos", _fix_catalog_typos),
    ("2026-10-house-recipes", _seed_house_recipes),
    ("2026-10-portions", _seed_portions),
]


def init_db():
    metadata.create_all(engine)
    with engine.begin() as conn:
        _add_missing_columns(conn)
        count = conn.execute(select(func.count()).select_from(products_table)).scalar()
        if count == 0:
            conn.execute(insert(products_table), DEFAULT_PRODUCTS)
        done = set(conn.execute(select(migrations_table.c.name)).scalars())
        for name, fn in DATA_MIGRATIONS:
            if name not in done:
                fn(conn)
                conn.execute(insert(migrations_table).values(name=name, applied_at=now_ms()))


# ---------- nutrition helpers ----------

def item_snapshot(product, qty: float) -> dict:
    return {
        "productId": product["id"],
        "qty": qty,
        "nome": product["nome"],
        "unidade": product["unidade"],
        "nutr": {f: float(product[f] or 0) for f in NUTRIENT_FIELDS},
    }


def totals_of(items: List[dict]) -> Dict[str, float]:
    totals = {f: 0.0 for f in NUTRIENT_FIELDS}
    for it in items:
        factor = it["qty"] / 100
        for f in NUTRIENT_FIELDS:
            totals[f] += it["nutr"].get(f, 0) * factor
    return {f: round(v, 2) for f, v in totals.items()}


# ---------- models ----------

class Nutrients(BaseModel):
    kcal: float = Field(0, ge=0, le=NUTRIENT_MAX["kcal"])
    carb: float = Field(0, ge=0, le=NUTRIENT_MAX["carb"])
    acuc: float = Field(0, ge=0, le=NUTRIENT_MAX["acuc"])
    acucad: float = Field(0, ge=0, le=NUTRIENT_MAX["acucad"])
    prot: float = Field(0, ge=0, le=NUTRIENT_MAX["prot"])
    gord: float = Field(0, ge=0, le=NUTRIENT_MAX["gord"])
    gordsat: float = Field(0, ge=0, le=NUTRIENT_MAX["gordsat"])
    gordtrans: float = Field(0, ge=0, le=NUTRIENT_MAX["gordtrans"])
    fibra: float = Field(0, ge=0, le=NUTRIENT_MAX["fibra"])
    sodio: float = Field(0, ge=0, le=NUTRIENT_MAX["sodio"])
    calcio: float = Field(0, ge=0, le=NUTRIENT_MAX["calcio"])


class ProductIn(Nutrients):
    nome: str = Field(min_length=1, max_length=120)
    unidade: str = Field(pattern="^(g|ml)$")
    barcode: Optional[str] = Field(None, pattern=r"^\d{6,14}$")
    porcao_g: Optional[float] = Field(None, gt=0, le=2000)
    porcao_nome: Optional[str] = Field(None, max_length=30)

    @model_validator(mode="after")
    def _portion_pair(self):
        nome = " ".join((self.porcao_nome or "").split()).lower()
        if self.porcao_g is None:
            self.porcao_nome = None
        else:
            self.porcao_nome = nome or "porção"
        return self

    @field_validator("nome")
    @classmethod
    def _strip_nome(cls, v):
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Informe o nome do produto.")
        return v

    @field_validator("barcode", mode="before")
    @classmethod
    def _empty_barcode(cls, v):
        return v or None


class MealItemIn(BaseModel):
    productId: str = Field(max_length=64)
    qty: float = Field(gt=0, le=5000)
    nome: str = Field(min_length=1, max_length=120)
    unidade: str = Field(pattern="^(g|ml)$")
    nutr: Nutrients
    porcoes: Optional[float] = Field(None, gt=0, le=100)
    porcao_nome: Optional[str] = Field(None, max_length=30)


class MealIn(BaseModel):
    nome: str = Field(max_length=120)
    descricao: Optional[str] = Field(None, max_length=400)
    items: List[MealItemIn] = Field(max_length=60)


class DiaryIn(BaseModel):
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    slot: Literal["cafe", "almoco", "lanche", "jantar"]
    items: List[MealItemIn] = Field(min_length=1, max_length=60)


class DiaryPatch(BaseModel):
    qty: Optional[float] = Field(None, gt=0, le=5000)
    porcoes: Optional[float] = Field(None, ge=0, le=100)     # 0 = passou a ser em g/ml
    slot: Optional[Literal["cafe", "almoco", "lanche", "jantar"]] = None


class RegisterIn(BaseModel):
    nome: str = Field(min_length=1, max_length=60)
    email: str = Field(max_length=254)
    senha: str = Field(min_length=8, max_length=200)
    legacy_id: Optional[str] = None
    app_url: Optional[str] = Field(None, max_length=300)     # para o link do e-mail de confirmação


class ForgotIn(BaseModel):
    email: str = Field(max_length=254)
    app_url: str = Field(max_length=300)


class ResetIn(BaseModel):
    token: str = Field(max_length=200)
    senha: str = Field(min_length=8, max_length=200)


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


class AppUrlIn(BaseModel):
    app_url: str = Field(max_length=300)


class PasswordIn(BaseModel):
    atual: Optional[str] = Field(None, max_length=200)
    nova: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    senha: str = Field(max_length=200)
    legacy_id: Optional[str] = None


class GuestIn(BaseModel):
    nome: str = Field(min_length=1, max_length=60)
    legacy_id: Optional[str] = None


class GoogleIn(BaseModel):
    credential: str
    legacy_id: Optional[str] = None


class GithubIn(BaseModel):
    code: str = Field(max_length=200)
    redirect_uri: str = Field(max_length=300)
    legacy_id: Optional[str] = None


class TransferIn(BaseModel):
    code: str = Field(max_length=20)


class WaterIn(BaseModel):
    ml: int = Field(ge=0, le=10000)


class CredentialsIn(BaseModel):
    email: str = Field(max_length=254)
    senha: str = Field(min_length=8, max_length=200)
    app_url: Optional[str] = Field(None, max_length=300)


class MePatch(BaseModel):
    nome: Optional[str] = Field(None, min_length=1, max_length=60)
    prefs: Optional[dict] = None


class SuggestionIn(BaseModel):
    kind: Literal["novo", "correcao"]
    product_id: Optional[str] = None
    product: ProductIn
    note: Optional[str] = Field(None, max_length=500)


class ReviewIn(BaseModel):
    note: Optional[str] = Field(None, max_length=500)
    product: Optional[ProductIn] = None     # o admin pode ajustar antes de aprovar


# ---------- auth helpers ----------

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LEGACY_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PBKDF2_ITERATIONS = 390_000
TRANSFER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # sem 0/O, 1/I


# As senhas mais usadas no Brasil e no mundo: aceitar qualquer uma delas
# é o mesmo que não ter senha.
COMMON_PASSWORDS = {
    "12345678", "123456789", "1234567890", "password", "senha123", "senha1234", "qwertyui", "qwerty123",
    "11111111", "00000000", "87654321", "abcd1234", "abc12345", "iloveyou", "brasil123", "nutriapp",
    "12341234", "password1", "123123123", "mudar123", "teste123", "1q2w3e4r",
}


def check_password(senha: str, email: Optional[str] = None):
    weak = senha.lower() in COMMON_PASSWORDS or len(set(senha)) < 4
    if email and senha.lower() in (email, email.split("@")[0]):
        weak = True
    if weak:
        raise HTTPException(status_code=400, detail="Essa senha é fácil de adivinhar. Escolha outra.")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def verify_password(password: str, stored: Optional[str]) -> bool:
    if not stored:
        return False
    try:
        _, iterations, salt, digest = stored.split("$")
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt), int(iterations))
        return hmac.compare_digest(candidate, base64.b64decode(digest))
    except ValueError:
        return False


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def normalize_email(email: str) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="E-mail inválido.")
    return email


def clean_name(nome: str) -> str:
    nome = " ".join(nome.split())
    if not nome:
        raise HTTPException(status_code=400, detail="Informe seu nome.")
    return nome


def is_admin(u) -> bool:
    """Administrador = conta do GitHub listada em ADMIN_GITHUB, ou e-mail de
    ADMIN_EMAILS confirmado pelo Google/GitHub. Um e-mail digitado num cadastro
    com senha nunca dá acesso: qualquer pessoa poderia cadastrar o e-mail de outra."""
    if (u["github_login"] or "").lower() in ADMIN_GITHUB:
        return True
    return bool(u["email_verified"] and u["email"] in ADMIN_EMAILS)


def public_user(u) -> dict:
    return {
        "id": u["id"],
        "nome": u["nome"],
        "email": u["email"],
        "is_guest": bool(u["is_guest"]),
        "is_admin": is_admin(u),
        "has_password": bool(u["password_hash"]),
        "email_verified": bool(u["email_verified"]),
        "has_google": bool(u["google_sub"]),
        "github_login": u["github_login"],
        "prefs": json.loads(u["prefs_json"] or "{}"),
        "created_at": u["created_at"],
    }


def start_session(conn, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = now_ms()
    conn.execute(delete(sessions_table).where(sessions_table.c.expires_at < now))
    conn.execute(insert(sessions_table).values(
        token_hash=sha256(token), user_id=user_id, created_at=now,
        expires_at=now + SESSION_DAYS * 86_400_000,
    ))
    return token


def claim_legacy_meals(conn, user_id: str, legacy_id: Optional[str]):
    """Refeições da v1 ficavam presas a um id anônimo do navegador.

    Na primeira entrada pela v2, esse id é enviado junto e as refeições
    passam a pertencer à conta. Só aceita ids no formato UUID que a v1 gerava.
    """
    if legacy_id and LEGACY_ID_RE.match(legacy_id):
        conn.execute(update(meals_table).where(meals_table.c.user_id == legacy_id).values(user_id=user_id))


def auth_response(conn, user_id: str, legacy_id: Optional[str] = None) -> dict:
    claim_legacy_meals(conn, user_id, legacy_id)
    token = start_session(conn, user_id)
    u = conn.execute(select(users_table).where(users_table.c.id == user_id)).mappings().first()
    return {"token": token, "user": public_user(u)}


def new_user_row(nome: str, **extra) -> dict:
    return {
        "id": "u-" + uuid.uuid4().hex[:16], "nome": nome, "email": None,
        "password_hash": None, "google_sub": None, "is_guest": 0, "email_verified": 0,
        "github_id": None, "github_login": None,
        "prefs_json": "{}", "created_at": now_ms(), **extra,
    }


# ---------- e-mail ----------

def mail_enabled() -> bool:
    return bool(MAIL_FILE or (MAIL_FROM and (BREVO_API_KEY or RESEND_API_KEY)))


def _sender() -> dict:
    # MAIL_FROM aceita "Nome <email@dominio>" ou só o e-mail
    m = re.match(r"^\s*(.*?)\s*<([^>]+)>\s*$", MAIL_FROM)
    return {"name": (m.group(1) if m else "") or APP_NAME, "email": m.group(2) if m else MAIL_FROM}


def send_mail(to: str, subject: str, text_body: str, html_body: str):
    """Envia pela API HTTP do provedor. Roda em segundo plano: uma falha aqui
    não pode quebrar o cadastro nem revelar se o e-mail existe."""
    try:
        if MAIL_FILE:
            with open(MAIL_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps({"to": to, "subject": subject, "text": text_body}, ensure_ascii=False) + "\n")
            return
        import requests

        sender = _sender()
        if BREVO_API_KEY:
            res = requests.post(
                "https://api.brevo.com/v3/smtp/email",
                headers={"api-key": BREVO_API_KEY, "accept": "application/json"},
                json={"sender": sender, "to": [{"email": to}], "subject": subject,
                      "textContent": text_body, "htmlContent": html_body},
                timeout=15)
        else:
            res = requests.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                json={"from": f"{sender['name']} <{sender['email']}>", "to": [to], "subject": subject,
                      "text": text_body, "html": html_body},
                timeout=15)
        if res.status_code >= 300:
            log.error("Falha ao enviar e-mail (%s): %s", res.status_code, res.text[:300])
    except Exception:       # noqa: BLE001 - e-mail nunca derruba a requisição
        log.exception("Falha ao enviar e-mail")


def _mail_html(nome: str, paragraphs: List[str], button: str, link: str, footer: str) -> str:
    body = "".join(f'<p style="margin:0 0 14px">{html.escape(p)}</p>' for p in paragraphs)
    return f"""<div style="background:#f3ece0;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#2b241c">
<div style="max-width:460px;margin:0 auto;background:#fffbf4;border:1px solid #ebe1cf;border-radius:16px;padding:28px">
<div style="font-family:Georgia,serif;font-size:24px;font-weight:bold;margin-bottom:18px">Nutri<span style="color:#b8733a">App</span></div>
<p style="margin:0 0 14px">Olá, {html.escape(nome)}!</p>
{body}
<p style="margin:22px 0"><a href="{html.escape(link)}" style="background:#3f7552;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:bold;display:inline-block">{html.escape(button)}</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#5e5446">Se o botão não abrir, copie este endereço no navegador:</p>
<p style="margin:0 0 18px;font-size:12px;word-break:break-all;color:#5e5446">{html.escape(link)}</p>
<p style="margin:0;font-size:13px;color:#8e8373">{html.escape(footer)}</p>
</div></div>"""


def safe_app_url(url: Optional[str]) -> str:
    """O link do e-mail aponta para o endereço de onde o pedido veio, desde que
    seja um site autorizado. Sem isso, alguém poderia pedir um e-mail legítimo
    com link para um site falso."""
    parsed = urlparse(url or "")
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    if origin not in CORS_ORIGINS:
        raise HTTPException(status_code=400, detail="Endereço do app não permitido.")
    return origin + (parsed.path or "/")


def create_email_token(conn, user_id: str, kind: str, email: str, minutes: int) -> str:
    token = secrets.token_urlsafe(32)
    now = now_ms()
    conn.execute(delete(email_tokens_table).where(
        (email_tokens_table.c.expires_at < now)
        | ((email_tokens_table.c.user_id == user_id) & (email_tokens_table.c.kind == kind))))
    conn.execute(insert(email_tokens_table).values(
        token_hash=sha256(token), user_id=user_id, kind=kind, email=email, expires_at=now + minutes * 60_000))
    return token


def take_email_token(conn, token: str, kind: str, consume: bool = True):
    """Valida um link recebido por e-mail e, por padrão, já o consome (uso único)."""
    row = conn.execute(select(email_tokens_table).where(
        email_tokens_table.c.token_hash == sha256(token), email_tokens_table.c.kind == kind,
        email_tokens_table.c.expires_at > now_ms())).mappings().first()
    if not row:
        raise HTTPException(status_code=400, detail="Este link expirou ou já foi usado. Peça um novo.")
    if consume:
        conn.execute(delete(email_tokens_table).where(email_tokens_table.c.token_hash == row["token_hash"]))
    return row


def queue_verification(conn, tasks: BackgroundTasks, user: dict, app_url: Optional[str]):
    if not (mail_enabled() and user["email"] and app_url):
        return
    base = safe_app_url(app_url)
    token = create_email_token(conn, user["id"], "confirmar", user["email"], VERIFY_HOURS * 60)
    link = f"{base}#/confirmar/{token}"
    text_body = (f"Olá, {user['nome']}!\n\nPara confirmar que este e-mail é seu, abra o link:\n{link}\n\n"
                 f"O link vale por {VERIFY_HOURS // 24} dias. Se você não criou conta no {APP_NAME}, ignore este e-mail.")
    tasks.add_task(send_mail, user["email"], f"Confirme seu e-mail no {APP_NAME}", text_body, _mail_html(
        user["nome"], ["Falta só confirmar que este e-mail é seu."], "Confirmar e-mail", link,
        f"O link vale por {VERIFY_HOURS // 24} dias. Se você não criou conta no {APP_NAME}, ignore este e-mail."))


class _Throttle:
    """Limite simples de tentativas (em memória) contra força bruta."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window_s, self.hits = limit, window_s, {}

    def check(self, key: str):
        now = time.time()
        recent = [t for t in self.hits.get(key, []) if now - t < self.window_s]
        self.hits[key] = recent
        if len(recent) >= self.limit:
            raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde alguns minutos.")

    def fail(self, key: str):
        self.hits.setdefault(key, []).append(time.time())


login_throttle = _Throttle(limit=8, window_s=900)
transfer_throttle = _Throttle(limit=10, window_s=900)
signup_throttle = _Throttle(limit=15, window_s=3600)
mail_ip_throttle = _Throttle(limit=10, window_s=3600)
mail_address_throttle = _Throttle(limit=3, window_s=3600)

# Faz a verificação de senha levar o mesmo tempo com ou sem conta no e-mail.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def client_ip(request: Request) -> str:
    # No Render a requisição chega por um proxy. Ele acrescenta o IP real no fim
    # do X-Forwarded-For; o começo da lista pode ter sido escrito pelo cliente.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def _user_by_token(authorization: Optional[str]):
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token_hash = sha256(authorization[7:].strip())
    with engine.connect() as conn:
        row = conn.execute(
            select(users_table)
            .join(sessions_table, sessions_table.c.user_id == users_table.c.id)
            .where(sessions_table.c.token_hash == token_hash, sessions_table.c.expires_at > now_ms())
        ).mappings().first()
    return dict(row) if row else None


def current_user(authorization: Optional[str] = Header(None)) -> dict:
    user = _user_by_token(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Sessão expirada. Entre novamente.")
    return user


def optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    return _user_by_token(authorization)


def admin_user(user: dict = Depends(current_user)) -> dict:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Só o administrador pode fazer isso.")
    return user


def _external_login(conn, *, provider: str, external_id: str, email: Optional[str], nome: str,
                    current: Optional[dict], legacy_id: Optional[str], extra: Optional[dict] = None) -> dict:
    """Login (ou vínculo) por Google/GitHub. `email` só vem preenchido se o
    provedor confirmou que ele pertence à pessoa."""
    column = users_table.c.google_sub if provider == "google" else users_table.c.github_id
    values = {column.name: external_id, **(extra or {})}
    linked = conn.execute(select(users_table).where(column == external_id)).mappings().first()

    if current:
        # Já está logado: só vincula a conta externa a este usuário.
        if linked and linked["id"] != current["id"]:
            raise HTTPException(status_code=409, detail="Essa conta já está ligada a outro usuário do app.")
        if email and not current["email"]:
            taken = conn.execute(select(users_table.c.id).where(users_table.c.email == email)).first()
            if not taken:
                values.update(email=email, email_verified=1, is_guest=0)
        elif email and current["email"] == email:
            values["email_verified"] = 1
        conn.execute(update(users_table).where(users_table.c.id == current["id"]).values(**values))
        return auth_response(conn, current["id"], legacy_id)

    if linked:
        conn.execute(update(users_table).where(users_table.c.id == linked["id"]).values(**values))
        return auth_response(conn, linked["id"], legacy_id)

    same_email = email and conn.execute(select(users_table).where(users_table.c.email == email)).mappings().first()
    if same_email:
        if not same_email["email_verified"]:
            # Alguém pode ter cadastrado esse e-mail com senha antes do dono de
            # verdade. Quem confirma o e-mail pelo provedor fica com a conta, e a
            # senha e as sessões abertas por quem cadastrou deixam de valer.
            values["password_hash"] = None
            conn.execute(delete(sessions_table).where(sessions_table.c.user_id == same_email["id"]))
        values.update(email_verified=1, is_guest=0)
        conn.execute(update(users_table).where(users_table.c.id == same_email["id"]).values(**values))
        return auth_response(conn, same_email["id"], legacy_id)

    row = new_user_row(clean_name(nome), email=email or None, email_verified=1 if email else 0, **values)
    conn.execute(insert(users_table).values(**row))
    return auth_response(conn, row["id"], legacy_id)


# ---------- app ----------

@asynccontextmanager
async def lifespan(_app):
    init_db()
    yield


app = FastAPI(title="NutriApp API", version="2.0", lifespan=lifespan)

# O front-end fica em outro endereço (GitHub Pages), então a API precisa de
# CORS. A autenticação é por token no cabeçalho Authorization, não por cookie.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=86400,
)


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/") and request.url.path != "/api/products":
            response.headers["Cache-Control"] = "no-store"
        return response


app.add_middleware(SecurityHeaders)


@app.get("/api/health")
def health():
    return {"status": "ok", "db": "postgres" if not DATABASE_URL.startswith("sqlite") else "sqlite"}


@app.get("/api/config")
def config():
    return {
        "google_client_id": GOOGLE_CLIENT_ID or None,
        "github_client_id": GITHUB_CLIENT_ID if GITHUB_CLIENT_SECRET else None,
        "email_enabled": mail_enabled(),
        "history_days": HISTORY_DAYS,
    }


# ---- auth ----

@app.post("/api/auth/register", status_code=201)
def register(body: RegisterIn, request: Request, tasks: BackgroundTasks):
    signup_throttle.check(client_ip(request))
    signup_throttle.fail(client_ip(request))
    email = normalize_email(body.email)
    check_password(body.senha, email)
    with engine.begin() as conn:
        if conn.execute(select(users_table.c.id).where(users_table.c.email == email)).first():
            raise HTTPException(status_code=409, detail="Já existe uma conta com este e-mail.")
        row = new_user_row(clean_name(body.nome), email=email, password_hash=hash_password(body.senha))
        conn.execute(insert(users_table).values(**row))
        queue_verification(conn, tasks, row, body.app_url)
        return auth_response(conn, row["id"], body.legacy_id)


@app.post("/api/auth/login")
def login(body: LoginIn):
    email = body.email.strip().lower()
    login_throttle.check(email)
    with engine.begin() as conn:
        u = conn.execute(select(users_table).where(users_table.c.email == email)).mappings().first()
        if not verify_password(body.senha, u["password_hash"] if u else _DUMMY_HASH) or not u:
            login_throttle.fail(email)
            raise HTTPException(status_code=401, detail="E-mail ou senha incorretos.")
        return auth_response(conn, u["id"], body.legacy_id)


@app.post("/api/auth/guest", status_code=201)
def guest(body: GuestIn, request: Request):
    signup_throttle.check(client_ip(request))
    signup_throttle.fail(client_ip(request))
    with engine.begin() as conn:
        row = new_user_row(clean_name(body.nome), is_guest=1)
        conn.execute(insert(users_table).values(**row))
        return auth_response(conn, row["id"], body.legacy_id)


def _verify_google_token(credential: str) -> dict:
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
    except ImportError:
        raise HTTPException(status_code=501, detail="Login com Google não está instalado no servidor.")
    try:
        return id_token.verify_oauth2_token(credential, google_requests.Request(), GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(status_code=401, detail="Não foi possível confirmar o login com Google.")


@app.post("/api/auth/google")
def google_login(body: GoogleIn, current: Optional[dict] = Depends(optional_user)):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Login com Google não está configurado.")
    info = _verify_google_token(body.credential)
    email = (info.get("email") or "").lower() if info.get("email_verified") else None
    with engine.begin() as conn:
        return _external_login(
            conn, provider="google", external_id=info["sub"], email=email,
            nome=info.get("given_name") or info.get("name") or "Visitante",
            current=current, legacy_id=body.legacy_id)


def _github_identity(code: str, redirect_uri: str) -> dict:
    """Troca o código do OAuth do GitHub pelos dados da conta."""
    import requests

    try:
        token = requests.post(
            "https://github.com/login/oauth/access_token",
            data={"client_id": GITHUB_CLIENT_ID, "client_secret": GITHUB_CLIENT_SECRET,
                  "code": code, "redirect_uri": redirect_uri},
            headers={"Accept": "application/json"}, timeout=10,
        ).json().get("access_token")
        if not token:
            raise HTTPException(status_code=401, detail="O GitHub não confirmou o login. Tente de novo.")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
        user = requests.get("https://api.github.com/user", headers=headers, timeout=10).json()
        emails = requests.get("https://api.github.com/user/emails", headers=headers, timeout=10)
        emails = emails.json() if emails.ok else []
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Não foi possível falar com o GitHub agora.")
    primary = next((e["email"] for e in emails if e.get("primary") and e.get("verified")), None)
    return {"id": str(user["id"]), "login": user["login"], "name": user.get("name") or user["login"],
            "email": primary.lower() if primary else None}


@app.post("/api/auth/github")
def github_login(body: GithubIn, current: Optional[dict] = Depends(optional_user)):
    if not (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET):
        raise HTTPException(status_code=501, detail="Login com GitHub não está configurado.")
    redirect = urlparse(body.redirect_uri)
    if f"{redirect.scheme}://{redirect.netloc}".lower() not in CORS_ORIGINS:
        raise HTTPException(status_code=400, detail="Endereço de retorno não permitido.")
    info = _github_identity(body.code, body.redirect_uri)
    with engine.begin() as conn:
        return _external_login(
            conn, provider="github", external_id=info["id"], email=info["email"],
            nome=info["name"].split(" ")[0], current=current, legacy_id=body.legacy_id,
            extra={"github_login": info["login"]})


@app.post("/api/auth/transfer")
def redeem_transfer(body: TransferIn, request: Request):
    key = client_ip(request)
    transfer_throttle.check(key)
    code = re.sub(r"[^A-Z0-9]", "", body.code.upper())
    with engine.begin() as conn:
        row = conn.execute(select(transfer_codes_table).where(
            transfer_codes_table.c.code_hash == sha256(code),
            transfer_codes_table.c.expires_at > now_ms(),
        )).mappings().first()
        if not row:
            transfer_throttle.fail(key)
            raise HTTPException(status_code=404, detail="Código inválido ou expirado.")
        conn.execute(delete(transfer_codes_table).where(transfer_codes_table.c.code_hash == row["code_hash"]))
        return auth_response(conn, row["user_id"])


@app.post("/api/auth/forgot")
def forgot_password(body: ForgotIn, request: Request, tasks: BackgroundTasks):
    """Manda o link para criar uma senha nova. A resposta é sempre a mesma,
    exista a conta ou não, para ninguém descobrir quem tem cadastro."""
    if not mail_enabled():
        raise HTTPException(status_code=501, detail="O envio de e-mails não está configurado.")
    base = safe_app_url(body.app_url)
    ip = client_ip(request)
    mail_ip_throttle.check(ip)
    mail_ip_throttle.fail(ip)
    email = body.email.strip().lower()
    try:
        mail_address_throttle.check(email)
    except HTTPException:
        return {"ok": True}
    mail_address_throttle.fail(email)
    with engine.begin() as conn:
        u = conn.execute(select(users_table).where(users_table.c.email == email)).mappings().first()
        if u:
            token = create_email_token(conn, u["id"], "redefinir", email, RESET_MINUTES)
            link = f"{base}#/redefinir/{token}"
            footer = (f"O link vale por {RESET_MINUTES} minutos e só funciona uma vez. "
                      "Se não foi você, ignore este e-mail: sua senha continua a mesma.")
            tasks.add_task(
                send_mail, email, f"Nova senha no {APP_NAME}",
                f"Olá, {u['nome']}!\n\nRecebemos um pedido para criar uma nova senha. Abra o link:\n{link}\n\n{footer}",
                _mail_html(u["nome"], ["Recebemos um pedido para criar uma nova senha para a sua conta."],
                           "Criar nova senha", link, footer))
    return {"ok": True}


@app.post("/api/auth/reset")
def reset_password(body: ResetIn):
    with engine.begin() as conn:
        t = take_email_token(conn, body.token, "redefinir", consume=False)
        u = conn.execute(select(users_table).where(users_table.c.id == t["user_id"])).mappings().first()
        if not u or u["email"] != t["email"]:
            raise HTTPException(status_code=400, detail="Este link expirou ou já foi usado. Peça um novo.")
        check_password(body.senha, u["email"])      # senha fraca não queima o link
        conn.execute(delete(email_tokens_table).where(email_tokens_table.c.user_id == u["id"]))
        # Quem abriu o link provou que o e-mail é dele: a conta fica confirmada
        # e todas as sessões antigas caem (pode ter sido um acesso indevido).
        conn.execute(update(users_table).where(users_table.c.id == u["id"]).values(
            password_hash=hash_password(body.senha), email_verified=1, is_guest=0))
        conn.execute(delete(sessions_table).where(sessions_table.c.user_id == u["id"]))
        return auth_response(conn, u["id"])


@app.post("/api/auth/verify-email")
def verify_email(body: TokenIn):
    with engine.begin() as conn:
        t = take_email_token(conn, body.token, "confirmar")
        result = conn.execute(update(users_table).where(
            users_table.c.id == t["user_id"], users_table.c.email == t["email"]).values(email_verified=1))
        if result.rowcount == 0:      # o e-mail da conta mudou depois que o link foi enviado
            raise HTTPException(status_code=400, detail="Este link não vale mais. Peça um novo no Perfil.")
    return {"ok": True, "email": t["email"]}


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.lower().startswith("bearer "):
        with engine.begin() as conn:
            conn.execute(delete(sessions_table).where(
                sessions_table.c.token_hash == sha256(authorization[7:].strip())))
    return {"ok": True}


# ---- me ----

@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return public_user(user)


@app.patch("/api/me")
def update_me(body: MePatch, user: dict = Depends(current_user)):
    values = {}
    if body.nome is not None:
        values["nome"] = clean_name(body.nome)
    if body.prefs is not None:
        prefs_json = json.dumps(body.prefs)
        if len(prefs_json) > 20_000:
            raise HTTPException(status_code=413, detail="Preferências grandes demais.")
        values["prefs_json"] = prefs_json
    with engine.begin() as conn:
        if values:
            conn.execute(update(users_table).where(users_table.c.id == user["id"]).values(**values))
        u = conn.execute(select(users_table).where(users_table.c.id == user["id"])).mappings().first()
        return public_user(u)


@app.post("/api/me/credentials")
def set_credentials(body: CredentialsIn, tasks: BackgroundTasks, user: dict = Depends(current_user)):
    """Define e-mail e senha de quem ainda não tem senha (convidado virando
    conta, ou conta do Google/GitHub). Mantém todos os dados. Quem já tem
    senha troca em /api/me/password, informando a atual."""
    if user["password_hash"]:
        raise HTTPException(status_code=409, detail="Esta conta já tem senha. Use \"Trocar senha\".")
    email = normalize_email(body.email)
    check_password(body.senha, email)
    with engine.begin() as conn:
        other = conn.execute(select(users_table.c.id).where(
            users_table.c.email == email, users_table.c.id != user["id"])).first()
        if other:
            raise HTTPException(status_code=409, detail="Já existe uma conta com este e-mail.")
        conn.execute(update(users_table).where(users_table.c.id == user["id"]).values(
            email=email, password_hash=hash_password(body.senha), is_guest=0,
            email_verified=user["email_verified"] if email == user["email"] else 0))
        u = conn.execute(select(users_table).where(users_table.c.id == user["id"])).mappings().first()
        if not u["email_verified"]:
            queue_verification(conn, tasks, dict(u), body.app_url)
        return public_user(u)


@app.post("/api/me/verify-email")
def resend_verification(body: AppUrlIn, tasks: BackgroundTasks, user: dict = Depends(current_user)):
    if not mail_enabled():
        raise HTTPException(status_code=501, detail="O envio de e-mails não está configurado.")
    if not user["email"] or user["email_verified"]:
        return {"ok": True}
    mail_address_throttle.check(user["email"])
    mail_address_throttle.fail(user["email"])
    with engine.begin() as conn:
        queue_verification(conn, tasks, user, body.app_url)
    return {"ok": True}


@app.post("/api/me/password")
def change_password(body: PasswordIn, user: dict = Depends(current_user),
                    authorization: Optional[str] = Header(None)):
    if not user["email"]:
        raise HTTPException(status_code=400, detail="Crie a conta com e-mail antes de definir uma senha.")
    if user["password_hash"]:
        key = "senha:" + user["id"]
        login_throttle.check(key)
        if not verify_password(body.atual or "", user["password_hash"]):
            login_throttle.fail(key)
            raise HTTPException(status_code=401, detail="A senha atual não confere.")
    check_password(body.nova, user["email"])
    current = sha256(authorization[7:].strip())
    with engine.begin() as conn:
        conn.execute(update(users_table).where(users_table.c.id == user["id"]).values(
            password_hash=hash_password(body.nova)))
        # os outros aparelhos saem; este continua
        conn.execute(delete(sessions_table).where(
            sessions_table.c.user_id == user["id"], sessions_table.c.token_hash != current))
    return {"ok": True}


@app.post("/api/me/sessions/revoke-others")
def revoke_other_sessions(user: dict = Depends(current_user), authorization: Optional[str] = Header(None)):
    current = sha256(authorization[7:].strip())
    with engine.begin() as conn:
        result = conn.execute(delete(sessions_table).where(
            sessions_table.c.user_id == user["id"], sessions_table.c.token_hash != current))
    return {"revoked": result.rowcount}


@app.post("/api/me/transfer-code", status_code=201)
def create_transfer_code(user: dict = Depends(current_user)):
    code = "".join(secrets.choice(TRANSFER_ALPHABET) for _ in range(8))
    expires_at = now_ms() + TRANSFER_MINUTES * 60_000
    with engine.begin() as conn:
        conn.execute(delete(transfer_codes_table).where(
            (transfer_codes_table.c.user_id == user["id"]) | (transfer_codes_table.c.expires_at < now_ms())))
        conn.execute(insert(transfer_codes_table).values(
            code_hash=sha256(code), user_id=user["id"], expires_at=expires_at))
    return {"code": code[:4] + "-" + code[4:], "expires_at": expires_at}


@app.delete("/api/me")
def delete_me(user: dict = Depends(current_user)):
    """Apaga a conta e tudo que é dela. Sugestões já aprovadas continuam no catálogo."""
    uid = user["id"]
    with engine.begin() as conn:
        for table in (meals_table, user_products_table, diary_table, water_table,
                      sessions_table, transfer_codes_table, email_tokens_table):
            conn.execute(delete(table).where(table.c.user_id == uid))
        conn.execute(delete(suggestions_table).where(
            suggestions_table.c.user_id == uid, suggestions_table.c.status == "pendente"))
        # as sugestões já revisadas ficam no histórico do catálogo, sem o nome da pessoa
        conn.execute(update(suggestions_table).where(suggestions_table.c.user_id == uid)
                     .values(user_id="removido", author_nome="Usuário removido"))
        conn.execute(delete(users_table).where(users_table.c.id == uid))
    return {"deleted": uid}


# ---- products (catálogo da Nutri) ----

def _duplicate_name(conn, nome: str, ignore_id: Optional[str] = None) -> bool:
    q = select(products_table.c.id).where(
        func.lower(products_table.c.nome) == nome.lower(), products_table.c.archived == 0)
    if ignore_id:
        q = q.where(products_table.c.id != ignore_id)
    return conn.execute(q).first() is not None


@app.get("/api/products")
def list_products(archived: bool = False):
    with engine.connect() as conn:
        q = select(products_table).order_by(products_table.c.nome)
        if not archived:
            q = q.where(products_table.c.archived == 0)
        return [dict(r) for r in conn.execute(q).mappings().all()]


def _insert_catalog_product(conn, product: ProductIn) -> dict:
    if _duplicate_name(conn, product.nome):
        raise HTTPException(
            status_code=409, detail=f'Já existe um produto chamado "{product.nome}" no catálogo.')
    data = product.model_dump()
    data.update(id="p-" + uuid.uuid4().hex[:12], archived=0, updated_at=now_ms())
    conn.execute(insert(products_table).values(**data))
    return data


@app.post("/api/products", status_code=201)
def create_product(product: ProductIn, _admin: dict = Depends(admin_user)):
    with engine.begin() as conn:
        return _insert_catalog_product(conn, product)


def _update_catalog_product(conn, product_id: str, product: ProductIn) -> dict:
    exists = conn.execute(select(products_table.c.id).where(products_table.c.id == product_id)).first()
    if not exists:
        raise HTTPException(status_code=404, detail="Produto não encontrado.")
    if _duplicate_name(conn, product.nome, ignore_id=product_id):
        raise HTTPException(
            status_code=409, detail=f'Já existe um produto chamado "{product.nome}" no catálogo.')
    conn.execute(update(products_table).where(products_table.c.id == product_id)
                 .values(**product.model_dump(), updated_at=now_ms()))
    return dict(conn.execute(select(products_table).where(products_table.c.id == product_id)).mappings().first())


@app.put("/api/products/{product_id}")
def update_product(product_id: str, product: ProductIn, _admin: dict = Depends(admin_user)):
    with engine.begin() as conn:
        return _update_catalog_product(conn, product_id, product)


# Continua não existindo DELETE para produtos do catálogo: arquivar só tira o
# produto da lista, e pode ser desfeito. Receitas e diário guardam uma cópia
# dos valores, então nada que já foi registrado muda.

@app.post("/api/products/{product_id}/archive")
def archive_product(product_id: str, archived: bool = True, _admin: dict = Depends(admin_user)):
    with engine.begin() as conn:
        result = conn.execute(update(products_table).where(products_table.c.id == product_id)
                              .values(archived=1 if archived else 0, updated_at=now_ms()))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Produto não encontrado.")
    return {"id": product_id, "archived": archived}


@app.delete("/api/products/{product_id}")
def delete_product(product_id: str, _admin: dict = Depends(admin_user)):
    """Exclusão definitiva, para duplicados e cadastros com erro. Só vale para
    produtos que já estão na lixeira (arquivados), para não apagar por engano
    com um toque. Diário e receitas guardam cópia dos valores e não mudam."""
    with engine.begin() as conn:
        row = conn.execute(select(products_table.c.archived).where(products_table.c.id == product_id)).first()
        if not row:
            raise HTTPException(status_code=404, detail="Produto não encontrado.")
        if not row[0]:
            raise HTTPException(status_code=409, detail="Mova o produto para a lixeira antes de excluir de vez.")
        conn.execute(delete(products_table).where(products_table.c.id == product_id))
    return {"deleted": product_id}


# ---- my products (privados) ----

@app.get("/api/my/products")
def list_my_products(user: dict = Depends(current_user)):
    with engine.connect() as conn:
        rows = conn.execute(select(user_products_table)
                            .where(user_products_table.c.user_id == user["id"])
                            .order_by(user_products_table.c.nome)).mappings().all()
        return [dict(r) for r in rows]


@app.post("/api/my/products", status_code=201)
def create_my_product(product: ProductIn, user: dict = Depends(current_user)):
    now = now_ms()
    data = product.model_dump()
    data.update(id="up-" + uuid.uuid4().hex[:12], user_id=user["id"], created_at=now, updated_at=now)
    with engine.begin() as conn:
        conn.execute(insert(user_products_table).values(**data))
    return data


@app.put("/api/my/products/{product_id}")
def update_my_product(product_id: str, product: ProductIn, user: dict = Depends(current_user)):
    with engine.begin() as conn:
        result = conn.execute(update(user_products_table).where(
            user_products_table.c.id == product_id, user_products_table.c.user_id == user["id"],
        ).values(**product.model_dump(), updated_at=now_ms()))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Produto não encontrado.")
        return dict(conn.execute(select(user_products_table)
                                 .where(user_products_table.c.id == product_id)).mappings().first())


@app.delete("/api/my/products/{product_id}")
def delete_my_product(product_id: str, user: dict = Depends(current_user)):
    with engine.begin() as conn:
        result = conn.execute(delete(user_products_table).where(
            user_products_table.c.id == product_id, user_products_table.c.user_id == user["id"]))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Produto não encontrado.")
    return {"deleted": product_id}


# ---- meals (minhas receitas) ----

def _meal_out(row) -> dict:
    d = dict(row)
    d["items"] = json.loads(d.pop("items_json"))
    d["totals"] = json.loads(d.pop("totals_json"))
    return d


def _meal_values(meal: MealIn) -> dict:
    nome = " ".join(meal.nome.split())
    if not meal.items:
        raise HTTPException(status_code=400, detail="A refeição precisa de ao menos um item.")
    if not nome:
        raise HTTPException(status_code=400, detail="Dê um nome para a refeição.")
    items = [i.model_dump() for i in meal.items]
    return {
        "nome": nome,
        "descricao": (meal.descricao or "").strip() or None,
        "items_json": json.dumps(items),
        "totals_json": json.dumps(totals_of(items)),   # calculado aqui, não no navegador
    }


def _list_meals(owner: str) -> list:
    with engine.connect() as conn:
        rows = conn.execute(select(meals_table).where(meals_table.c.user_id == owner)
                            .order_by(meals_table.c.saved_at.desc())).mappings().all()
        return [_meal_out(r) for r in rows]


def _create_meal(owner: str, meal: MealIn) -> dict:
    row = {"id": "m-" + uuid.uuid4().hex[:12], "user_id": owner, "saved_at": now_ms(), **_meal_values(meal)}
    with engine.begin() as conn:
        conn.execute(insert(meals_table).values(**row))
    return _meal_out(row)


def _update_meal(owner: str, meal_id: str, meal: MealIn) -> dict:
    with engine.begin() as conn:
        result = conn.execute(update(meals_table).where(
            meals_table.c.id == meal_id, meals_table.c.user_id == owner).values(**_meal_values(meal)))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Refeição não encontrada.")
        return _meal_out(conn.execute(select(meals_table).where(meals_table.c.id == meal_id)).mappings().first())


def _delete_meal(owner: str, meal_id: str) -> dict:
    with engine.begin() as conn:
        result = conn.execute(delete(meals_table).where(
            meals_table.c.id == meal_id, meals_table.c.user_id == owner))
        if result.rowcount == 0:
            raise HTTPException(
                status_code=404, detail="Refeição não encontrada (ou não pertence a este usuário).")
    return {"deleted": meal_id}


@app.get("/api/meals")
def list_meals(user: dict = Depends(current_user)):
    return _list_meals(user["id"])


@app.post("/api/meals", status_code=201)
def create_meal(meal: MealIn, user: dict = Depends(current_user)):
    return _create_meal(user["id"], meal)


@app.put("/api/meals/{meal_id}")
def update_meal(meal_id: str, meal: MealIn, user: dict = Depends(current_user)):
    return _update_meal(user["id"], meal_id, meal)


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: str, user: dict = Depends(current_user)):
    return _delete_meal(user["id"], meal_id)


# ---- Receitas da Nutri ----

@app.get("/api/recipes/house")
def list_house_recipes():
    return _list_meals(HOUSE_USER)


@app.post("/api/recipes/house", status_code=201)
def create_house_recipe(meal: MealIn, _admin: dict = Depends(admin_user)):
    return _create_meal(HOUSE_USER, meal)


@app.put("/api/recipes/house/{meal_id}")
def update_house_recipe(meal_id: str, meal: MealIn, _admin: dict = Depends(admin_user)):
    return _update_meal(HOUSE_USER, meal_id, meal)


@app.delete("/api/recipes/house/{meal_id}")
def delete_house_recipe(meal_id: str, _admin: dict = Depends(admin_user)):
    return _delete_meal(HOUSE_USER, meal_id)


# ---- diário ----

def _history_cutoff() -> str:
    # Um dia de folga para não cortar o primeiro dia de quem está atrás do UTC.
    return (dt.date.today() - dt.timedelta(days=HISTORY_DAYS)).isoformat()


def _prune_diary(conn, user_id: str):
    conn.execute(delete(diary_table).where(diary_table.c.user_id == user_id, diary_table.c.day < _history_cutoff()))


def _diary_out(row) -> dict:
    d = dict(row)
    d["nutr"] = json.loads(d.pop("nutr_json"))
    d.pop("user_id", None)
    return d


@app.get("/api/diary")
def list_diary(user: dict = Depends(current_user)):
    with engine.begin() as conn:
        _prune_diary(conn, user["id"])
        rows = conn.execute(select(diary_table).where(diary_table.c.user_id == user["id"])
                            .order_by(diary_table.c.day, diary_table.c.created_at)).mappings().all()
        return [_diary_out(r) for r in rows]


@app.post("/api/diary", status_code=201)
def add_to_diary(entry: DiaryIn, user: dict = Depends(current_user)):
    try:
        day = dt.date.fromisoformat(entry.day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data inválida.")
    if day.isoformat() < _history_cutoff() or day > dt.date.today() + dt.timedelta(days=1):
        raise HTTPException(status_code=400, detail=f"O diário guarda só os últimos {HISTORY_DAYS} dias.")
    now = now_ms()
    rows = [{
        "id": "d-" + uuid.uuid4().hex[:12], "user_id": user["id"], "day": entry.day, "slot": entry.slot,
        "product_id": it.productId, "nome": it.nome, "unidade": it.unidade, "qty": it.qty,
        "nutr_json": it.nutr.model_dump_json(), "created_at": now + i,
        "porcoes": it.porcoes, "porcao_nome": it.porcao_nome if it.porcoes else None,
    } for i, it in enumerate(entry.items)]
    with engine.begin() as conn:
        conn.execute(insert(diary_table), rows)
        _prune_diary(conn, user["id"])
    return [_diary_out(r) for r in rows]


@app.patch("/api/diary/{entry_id}")
def edit_diary_entry(entry_id: str, body: DiaryPatch, user: dict = Depends(current_user)):
    values = body.model_dump(exclude_none=True)
    if values.get("porcoes") == 0:
        values["porcoes"] = None
    with engine.begin() as conn:
        if values:
            conn.execute(update(diary_table).where(
                diary_table.c.id == entry_id, diary_table.c.user_id == user["id"]).values(**values))
        row = conn.execute(select(diary_table).where(
            diary_table.c.id == entry_id, diary_table.c.user_id == user["id"])).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
        return _diary_out(row)


@app.delete("/api/diary/{entry_id}")
def delete_diary_entry(entry_id: str, user: dict = Depends(current_user)):
    with engine.begin() as conn:
        result = conn.execute(delete(diary_table).where(
            diary_table.c.id == entry_id, diary_table.c.user_id == user["id"]))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return {"deleted": entry_id}


# ---- água ----

@app.get("/api/water")
def list_water(user: dict = Depends(current_user)):
    with engine.begin() as conn:
        conn.execute(delete(water_table).where(
            water_table.c.user_id == user["id"], water_table.c.day < _history_cutoff()))
        rows = conn.execute(select(water_table.c.day, water_table.c.ml)
                            .where(water_table.c.user_id == user["id"])).all()
    return {day: ml for day, ml in rows}


@app.put("/api/water/{day}")
def set_water(day: str, body: WaterIn, user: dict = Depends(current_user)):
    try:
        parsed = dt.date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data inválida.")
    if day < _history_cutoff() or parsed > dt.date.today() + dt.timedelta(days=1):
        raise HTTPException(status_code=400, detail=f"Só dá para registrar os últimos {HISTORY_DAYS} dias.")
    key = (water_table.c.user_id == user["id"]) & (water_table.c.day == day)
    with engine.begin() as conn:
        if conn.execute(select(water_table.c.ml).where(key)).first():
            conn.execute(update(water_table).where(key).values(ml=body.ml))
        else:
            conn.execute(insert(water_table).values(user_id=user["id"], day=day, ml=body.ml))
    return {"day": day, "ml": body.ml}


# ---- sugestões para o catálogo ----

def _suggestion_out(row) -> dict:
    d = dict(row)
    d["product"] = json.loads(d.pop("payload_json"))
    return d


@app.get("/api/suggestions")
def list_suggestions(
    scope: Literal["mine", "pending"] = Query("mine"),
    user: dict = Depends(current_user),
):
    q = select(suggestions_table).order_by(suggestions_table.c.created_at.desc())
    if scope == "pending":
        admin_user(user)
        q = q.where(suggestions_table.c.status == "pendente")
    else:
        q = q.where(suggestions_table.c.user_id == user["id"]).limit(100)
    with engine.connect() as conn:
        return [_suggestion_out(r) for r in conn.execute(q).mappings().all()]


@app.post("/api/suggestions", status_code=201)
def create_suggestion(body: SuggestionIn, user: dict = Depends(current_user)):
    with engine.begin() as conn:
        if body.kind == "correcao":
            target = conn.execute(select(products_table.c.id).where(
                products_table.c.id == (body.product_id or ""))).first()
            if not target:
                raise HTTPException(status_code=404, detail="Produto do catálogo não encontrado.")
        pending = conn.execute(select(func.count()).select_from(suggestions_table).where(
            suggestions_table.c.user_id == user["id"], suggestions_table.c.status == "pendente")).scalar()
        if pending >= 30:
            raise HTTPException(status_code=429, detail="Você já tem muitas sugestões aguardando revisão.")
        row = {
            "id": "s-" + uuid.uuid4().hex[:12], "user_id": user["id"], "author_nome": user["nome"],
            "kind": body.kind, "product_id": body.product_id if body.kind == "correcao" else None,
            "payload_json": body.product.model_dump_json(), "note": (body.note or "").strip() or None,
            "status": "pendente", "created_at": now_ms(),
        }
        conn.execute(insert(suggestions_table).values(**row))
    return _suggestion_out(row)


def _get_pending(conn, suggestion_id: str):
    row = conn.execute(select(suggestions_table).where(suggestions_table.c.id == suggestion_id)).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Sugestão não encontrada.")
    if row["status"] != "pendente":
        raise HTTPException(status_code=409, detail="Esta sugestão já foi revisada.")
    return row


@app.post("/api/suggestions/{suggestion_id}/approve")
def approve_suggestion(suggestion_id: str, body: ReviewIn, _admin: dict = Depends(admin_user)):
    with engine.begin() as conn:
        s = _get_pending(conn, suggestion_id)
        product = body.product or ProductIn(**json.loads(s["payload_json"]))
        if s["kind"] == "novo":
            saved = _insert_catalog_product(conn, product)
        else:
            saved = _update_catalog_product(conn, s["product_id"], product)
        conn.execute(update(suggestions_table).where(suggestions_table.c.id == suggestion_id).values(
            status="aprovada", review_note=body.note, reviewed_at=now_ms(),
            product_id=saved["id"], payload_json=product.model_dump_json()))
    return {"suggestion": suggestion_id, "product": saved}


@app.post("/api/suggestions/{suggestion_id}/reject")
def reject_suggestion(suggestion_id: str, body: ReviewIn, _admin: dict = Depends(admin_user)):
    with engine.begin() as conn:
        _get_pending(conn, suggestion_id)
        conn.execute(update(suggestions_table).where(suggestions_table.c.id == suggestion_id).values(
            status="recusada", review_note=body.note, reviewed_at=now_ms()))
    return {"suggestion": suggestion_id, "status": "recusada"}
