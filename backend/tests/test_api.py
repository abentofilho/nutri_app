import datetime as dt
import re

import pytest

from conftest import LEGACY_USER

ITEM_PAO = {
    "productId": "p-3256aa482572", "qty": 50, "nome": "Pão integral 52% Lekker", "unidade": "g",
    "nutr": {"kcal": 273, "carb": 42, "prot": 13, "gord": 5.7},
}
PRODUCT = {"nome": "Iogurte natural", "unidade": "g", "kcal": 60, "carb": 4.5, "prot": 3.5, "gord": 3}


# ---------- migração da v1 ----------

def test_v1_catalog_is_kept_and_typos_are_fixed(client):
    products = {p["id"]: p for p in client.get("/api/products").json()}
    queijo = products["p-2ff288fad874"]
    assert queijo["prot"] == 15 and queijo["sodio"] == 453
    assert "p-e1fb272522f4" not in products          # cópia "_" arquivada
    assert "p-852bbbca0601" not in products          # tapioca duplicada arquivada
    assert products["p-6afa05ed2f9a"]["carb"] == 0
    archived = {p["id"] for p in client.get("/api/products?archived=true").json()}
    assert {"p-e1fb272522f4", "p-852bbbca0601"} <= archived


def test_house_recipes_are_seeded_from_catalog(client):
    recipes = client.get("/api/recipes/house").json()
    assert recipes, "as Receitas da Nutri deveriam existir"
    first = recipes[0]
    assert first["nome"] == "Café com pão e queijo minas"
    # Só entram itens de produtos que existem no banco (aqui: pão, queijo e leite).
    assert {i["productId"] for i in first["items"]} == {"p-3256aa482572", "p-2ff288fad874", "seed-leite-italac"}
    assert first["totals"]["kcal"] > 0


def test_migrations_are_idempotent(client):
    import main
    before = client.get("/api/recipes/house").json()
    main.init_db()
    main.init_db()
    assert client.get("/api/recipes/house").json() == before
    names = [p["nome"] for p in client.get("/api/products").json()]
    assert len(names) == len(set(names))


def test_legacy_meals_are_claimed_on_first_login(client):
    res = client.post("/api/auth/guest", json={"nome": "Antônio", "legacy_id": LEGACY_USER})
    headers = {"Authorization": "Bearer " + res.json()["token"]}
    meals = client.get("/api/meals", headers=headers).json()
    assert [m["nome"] for m in meals] == ["Café da manhã"]


def test_legacy_claim_rejects_non_uuid_ids(client, guest):
    res = client.post("/api/auth/guest", json={"nome": "Intrusa", "legacy_id": "casa"})
    headers = {"Authorization": "Bearer " + res.json()["token"]}
    assert client.get("/api/meals", headers=headers).json() == []
    assert client.get("/api/recipes/house").json()


# ---------- contas ----------

def test_register_login_and_wrong_password(client):
    body = {"nome": "Maria", "email": "Maria@Exemplo.com ", "senha": "caju-verde-42"}
    assert client.post("/api/auth/register", json=body).status_code == 201
    assert client.post("/api/auth/register", json=body).status_code == 409
    ok = client.post("/api/auth/login", json={"email": "maria@exemplo.com", "senha": "caju-verde-42"})
    assert ok.status_code == 200 and ok.json()["user"]["nome"] == "Maria"
    bad = client.post("/api/auth/login", json={"email": "maria@exemplo.com", "senha": "errada-mesmo"})
    assert bad.status_code == 401


def test_short_password_and_bad_email_are_rejected(client):
    assert client.post("/api/auth/register", json={"nome": "A", "email": "a@b.co", "senha": "123"}).status_code == 422
    assert client.post("/api/auth/register", json={"nome": "A", "email": "sem-arroba", "senha": "caju-verde-42"}).status_code == 400


def test_endpoints_require_session(client):
    assert client.get("/api/meals").status_code == 401
    assert client.get("/api/diary", headers={"Authorization": "Bearer xyz"}).status_code == 401


def test_guest_can_upgrade_to_account(client, guest):
    headers, _ = guest
    me = client.post("/api/me/credentials", headers=headers,
                     json={"email": "convidada@exemplo.com", "senha": "senha-nova-1"}).json()
    assert me["is_guest"] is False and me["email"] == "convidada@exemplo.com"


def test_transfer_code_logs_in_once(client, guest):
    headers, user = guest
    code = client.post("/api/me/transfer-code", headers=headers).json()["code"]
    assert len(code) == 9 and code[4] == "-"
    res = client.post("/api/auth/transfer", json={"code": code.lower().replace("-", " ")})
    assert res.status_code == 200 and res.json()["user"]["id"] == user["id"]
    assert client.post("/api/auth/transfer", json={"code": code}).status_code == 404


def test_logout_invalidates_token(client):
    headers, _ = client.post("/api/auth/guest", json={"nome": "Saindo"}).json(), None
    token = headers["token"]
    h = {"Authorization": "Bearer " + token}
    assert client.get("/api/me", headers=h).status_code == 200
    client.post("/api/auth/logout", headers=h)
    assert client.get("/api/me", headers=h).status_code == 401


def test_prefs_roundtrip(client, guest):
    headers, _ = guest
    prefs = {"goals": {"kcal": 1800}, "favorites": ["p-3256aa482572"]}
    assert client.patch("/api/me", headers=headers, json={"prefs": prefs}).json()["prefs"] == prefs


def test_google_is_disabled_without_client_id(client):
    assert client.get("/api/config").json()["google_client_id"] is None
    assert client.post("/api/auth/google", json={"credential": "x"}).status_code == 501


def test_delete_account_removes_private_data(client):
    data = client.post("/api/auth/guest", json={"nome": "Temporária"}).json()
    h = {"Authorization": "Bearer " + data["token"]}
    client.post("/api/my/products", headers=h, json=PRODUCT)
    assert client.delete("/api/me", headers=h).status_code == 200
    assert client.get("/api/me", headers=h).status_code == 401


# ---------- produtos ----------

def test_catalog_is_admin_only(client, guest, admin):
    headers, _ = guest
    assert client.post("/api/products", headers=headers, json=PRODUCT).status_code == 403
    admin_headers, admin_user = admin
    assert admin_user["is_admin"] is True
    created = client.post("/api/products", headers=admin_headers, json={**PRODUCT, "nome": "  Kefir   caseiro "})
    assert created.status_code == 201 and created.json()["nome"] == "Kefir caseiro"
    dup = client.post("/api/products", headers=admin_headers, json={**PRODUCT, "nome": "kefir CASEIRO"})
    assert dup.status_code == 409


def test_impossible_values_are_rejected(client, admin):
    admin_headers, _ = admin
    for bad in ({"prot": 1515}, {"carb": -1}, {"kcal": 2000}, {"nome": " "}, {"unidade": "kg"}):
        res = client.post("/api/products", headers=admin_headers, json={**PRODUCT, **bad})
        assert res.status_code == 422, bad


def test_archive_and_restore(client, admin):
    admin_headers, _ = admin
    pid = client.post("/api/products", headers=admin_headers, json={**PRODUCT, "nome": "Para arquivar"}).json()["id"]
    client.post(f"/api/products/{pid}/archive", headers=admin_headers)
    assert pid not in {p["id"] for p in client.get("/api/products").json()}
    client.post(f"/api/products/{pid}/archive?archived=false", headers=admin_headers)
    assert pid in {p["id"] for p in client.get("/api/products").json()}


def test_private_products_are_private(client, guest):
    headers, _ = guest
    created = client.post("/api/my/products", headers=headers, json={**PRODUCT, "barcode": "7891000100103"}).json()
    assert created["id"].startswith("up-")
    other = client.post("/api/auth/guest", json={"nome": "Outra pessoa"}).json()
    other_h = {"Authorization": "Bearer " + other["token"]}
    assert client.get("/api/my/products", headers=other_h).json() == []
    assert client.delete(f"/api/my/products/{created['id']}", headers=other_h).status_code == 404
    assert created["id"] not in {p["id"] for p in client.get("/api/products").json()}
    updated = client.put(f"/api/my/products/{created['id']}", headers=headers, json={**PRODUCT, "kcal": 70}).json()
    assert updated["kcal"] == 70


# ---------- sugestões ----------

def test_suggestion_flow_new_product(client, guest, admin):
    headers, _ = guest
    admin_headers, _ = admin
    s = client.post("/api/suggestions", headers=headers, json={
        "kind": "novo", "product": {**PRODUCT, "nome": "Iogurte grego"}, "note": "Comprei no mercado"}).json()
    assert s["status"] == "pendente"
    assert client.get("/api/suggestions?scope=pending", headers=headers).status_code == 403
    pending = client.get("/api/suggestions?scope=pending", headers=admin_headers).json()
    assert s["id"] in {x["id"] for x in pending}
    approved = client.post(f"/api/suggestions/{s['id']}/approve", headers=admin_headers, json={}).json()
    assert approved["product"]["nome"] == "Iogurte grego"
    assert "Iogurte grego" in {p["nome"] for p in client.get("/api/products").json()}
    mine = client.get("/api/suggestions", headers=headers).json()
    assert mine[0]["status"] == "aprovada"
    assert client.post(f"/api/suggestions/{s['id']}/reject", headers=admin_headers, json={}).status_code == 409


def test_suggestion_flow_correction_with_admin_edit(client, guest, admin):
    headers, _ = guest
    admin_headers, _ = admin
    s = client.post("/api/suggestions", headers=headers, json={
        "kind": "correcao", "product_id": "p-6afa05ed2f9a",
        "product": {"nome": "Sardinhas Coqueiro", "unidade": "g", "kcal": 206, "prot": 23, "gord": 13}}).json()
    final = {"nome": "Sardinhas Coqueiro em óleo", "unidade": "g", "kcal": 206, "prot": 23, "gord": 12.6}
    client.post(f"/api/suggestions/{s['id']}/approve", headers=admin_headers, json={"product": final})
    sardinha = next(p for p in client.get("/api/products").json() if p["id"] == "p-6afa05ed2f9a")
    assert sardinha["nome"] == "Sardinhas Coqueiro em óleo" and sardinha["gord"] == 12.6


def test_rejected_suggestion(client, guest, admin):
    headers, _ = guest
    admin_headers, _ = admin
    s = client.post("/api/suggestions", headers=headers, json={"kind": "novo", "product": PRODUCT}).json()
    client.post(f"/api/suggestions/{s['id']}/reject", headers=admin_headers, json={"note": "Já existe"})
    mine = {x["id"]: x for x in client.get("/api/suggestions", headers=headers).json()}
    assert mine[s["id"]]["status"] == "recusada" and mine[s["id"]]["review_note"] == "Já existe"


# ---------- receitas ----------

def test_meal_totals_are_computed_by_server(client, guest):
    headers, _ = guest
    meal = client.post("/api/meals", headers=headers, json={"nome": "Lanche", "items": [ITEM_PAO]}).json()
    assert meal["totals"]["kcal"] == 136.5
    assert client.post("/api/meals", headers=headers, json={"nome": "Vazia", "items": []}).status_code == 400
    assert client.post("/api/meals", headers=headers, json={"nome": "  ", "items": [ITEM_PAO]}).status_code == 400
    bad_qty = {**ITEM_PAO, "qty": -5}
    assert client.post("/api/meals", headers=headers, json={"nome": "X", "items": [bad_qty]}).status_code == 422
    renamed = client.put(f"/api/meals/{meal['id']}", headers=headers,
                         json={"nome": "Lanche da tarde", "items": [ITEM_PAO, ITEM_PAO]}).json()
    assert renamed["nome"] == "Lanche da tarde" and renamed["totals"]["kcal"] == 273
    assert client.delete(f"/api/meals/{meal['id']}", headers=headers).status_code == 200


def test_house_recipes_are_admin_only(client, guest, admin):
    headers, _ = guest
    admin_headers, _ = admin
    body = {"nome": "Pão na chapa", "descricao": "Clássico", "items": [ITEM_PAO]}
    assert client.post("/api/recipes/house", headers=headers, json=body).status_code == 403
    created = client.post("/api/recipes/house", headers=admin_headers, json=body).json()
    assert created["user_id"] == "casa"
    assert client.delete(f"/api/meals/{created['id']}", headers=headers).status_code == 404
    assert client.delete(f"/api/recipes/house/{created['id']}", headers=admin_headers).status_code == 200


# ---------- diário ----------

def test_diary_add_edit_delete(client, guest):
    headers, _ = guest
    today = dt.date.today().isoformat()
    added = client.post("/api/diary", headers=headers, json={"day": today, "slot": "cafe", "items": [ITEM_PAO, ITEM_PAO]})
    assert added.status_code == 201 and len(added.json()) == 2
    entry = added.json()[0]
    edited = client.patch(f"/api/diary/{entry['id']}", headers=headers, json={"qty": 80, "slot": "lanche"}).json()
    assert edited["qty"] == 80 and edited["slot"] == "lanche"
    assert client.delete(f"/api/diary/{entry['id']}", headers=headers).status_code == 200
    assert len(client.get("/api/diary", headers=headers).json()) == 1


def test_diary_keeps_only_history_window(client, guest):
    import main
    from sqlalchemy import insert
    headers, user = guest
    old_day = (dt.date.today() - dt.timedelta(days=main.HISTORY_DAYS + 3)).isoformat()
    assert client.post("/api/diary", headers=headers,
                       json={"day": old_day, "slot": "cafe", "items": [ITEM_PAO]}).status_code == 400
    with main.engine.begin() as conn:      # simula um registro que envelheceu
        conn.execute(insert(main.diary_table).values(
            id="d-velho", user_id=user["id"], day=old_day, slot="cafe", product_id=None,
            nome="Antigo", unidade="g", qty=10, nutr_json="{}", created_at=0))
    days = {e["day"] for e in client.get("/api/diary", headers=headers).json()}
    assert old_day not in days


def test_diary_is_private(client, guest):
    headers, _ = guest
    today = dt.date.today().isoformat()
    entry = client.post("/api/diary", headers=headers, json={"day": today, "slot": "jantar", "items": [ITEM_PAO]}).json()[0]
    other = client.post("/api/auth/guest", json={"nome": "Curiosa"}).json()
    other_h = {"Authorization": "Bearer " + other["token"]}
    assert client.get("/api/diary", headers=other_h).json() == []
    assert client.delete(f"/api/diary/{entry['id']}", headers=other_h).status_code == 404


def test_google_login_creates_and_links_accounts(client, monkeypatch):
    import main
    monkeypatch.setattr(main, "GOOGLE_CLIENT_ID", "teste.apps.googleusercontent.com")
    fake = {"sub": "google-123", "email": "Maria.G@exemplo.com", "email_verified": True, "given_name": "Maria"}
    monkeypatch.setattr(main, "_verify_google_token", lambda credential: fake)

    first = client.post("/api/auth/google", json={"credential": "token"}).json()
    assert first["user"]["nome"] == "Maria" and first["user"]["has_google"] is True
    again = client.post("/api/auth/google", json={"credential": "token"}).json()
    assert again["user"]["id"] == first["user"]["id"]

    # Quem já tinha conta com o mesmo e-mail ganha o Google vinculado, sem conta duplicada.
    squatter = client.post("/api/auth/register", json={"nome": "Pedro", "email": "pedro@exemplo.com", "senha": "caju-verde-42"}).json()
    fake.update(sub="google-456", email="pedro@exemplo.com", given_name="Pedro G")
    linked = client.post("/api/auth/google", json={"credential": "token"}).json()["user"]
    assert linked["id"] == squatter["user"]["id"] and linked["has_google"]
    # O e-mail nunca tinha sido confirmado: quem cadastrou com senha perde o acesso.
    assert linked["has_password"] is False
    assert client.get("/api/me", headers={"Authorization": "Bearer " + squatter["token"]}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "pedro@exemplo.com", "senha": "caju-verde-42"}).status_code == 401



# ---------- administrador e segurança ----------

def test_admin_email_with_password_is_not_admin(client, monkeypatch):
    """Qualquer um pode cadastrar o e-mail do administrador com senha; isso não pode dar acesso."""
    import main
    monkeypatch.setattr(main, "ADMIN_EMAILS", {"chefe@exemplo.com"})
    res = client.post("/api/auth/register", json={"nome": "Impostor", "email": "CHEFE@exemplo.com ", "senha": "caju-verde-42"})
    headers = {"Authorization": "Bearer " + res.json()["token"]}
    assert res.json()["user"]["is_admin"] is False
    assert client.post("/api/products", headers=headers, json=PRODUCT).status_code == 403


def test_github_owner_is_admin(client, admin):
    _, user = admin
    assert user["is_admin"] is True and user["github_login"] == "abentofilho"
    again = client.post("/api/auth/github", json={"code": "codigo-antonio", "redirect_uri": "http://localhost:5500/"}).json()
    assert again["user"]["id"] == user["id"]


def test_other_github_users_are_not_admin(client):
    res = client.post("/api/auth/github", json={"code": "codigo-maria", "redirect_uri": "http://localhost:5500/"}).json()
    assert res["user"]["is_admin"] is False and res["user"]["nome"] == "Maria"


def test_github_can_be_linked_to_current_account(client, guest):
    headers, user = guest
    from conftest import GITHUB_USERS
    GITHUB_USERS["codigo-link"] = {"id": "1003", "login": "convidada", "name": "Convidada", "email": "convidada.gh@exemplo.com"}
    res = client.post("/api/auth/github", headers=headers, json={"code": "codigo-link", "redirect_uri": "http://localhost:5500/"})
    linked = res.json()["user"]
    assert linked["id"] == user["id"] and linked["github_login"] == "convidada"
    assert linked["email"] == "convidada.gh@exemplo.com" and linked["is_guest"] is False


def test_github_redirect_must_be_an_allowed_origin(client):
    res = client.post("/api/auth/github", json={"code": "codigo-maria", "redirect_uri": "https://site-estranho.com/"})
    assert res.status_code == 400


def test_cors_only_for_known_origins(client):
    ok = client.get("/api/health", headers={"Origin": "https://abentofilho.github.io"})
    assert ok.headers.get("access-control-allow-origin") == "https://abentofilho.github.io"
    other = client.get("/api/health", headers={"Origin": "https://site-estranho.com"})
    assert "access-control-allow-origin" not in other.headers


def test_security_headers(client, guest):
    headers, _ = guest
    res = client.get("/api/me", headers=headers)
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["cache-control"] == "no-store"


def test_signup_is_rate_limited_by_ip(client):
    import main
    throttle = main._Throttle(limit=2, window_s=60)
    original, main.signup_throttle = main.signup_throttle, throttle
    try:
        h = {"X-Forwarded-For": "1.2.3.4, 9.9.9.9"}
        codes = [client.post("/api/auth/guest", json={"nome": "Spam"}, headers=h).status_code for _ in range(3)]
        assert codes == [201, 201, 429]
        # outro IP real (o último da lista) não é afetado
        assert client.post("/api/auth/guest", json={"nome": "Ok"}, headers={"X-Forwarded-For": "8.8.8.8"}).status_code == 201
    finally:
        main.signup_throttle = original


def test_changing_email_drops_verification(client):
    res = client.post("/api/auth/github", json={"code": "codigo-maria", "redirect_uri": "http://localhost:5500/"}).json()
    h = {"Authorization": "Bearer " + res["token"]}
    me = client.post("/api/me/credentials", headers=h, json={"email": "maria.nova@exemplo.com", "senha": "caju-verde-42"}).json()
    assert me["has_password"] is True and me["is_admin"] is False


# ---------- porções, exclusão definitiva e água ----------

def test_catalog_portions_are_seeded(client):
    products = {p["id"]: p for p in client.get("/api/products").json()}
    assert products["p-3256aa482572"]["porcao_g"] == 25 and products["p-3256aa482572"]["porcao_nome"] == "fatia"
    assert products["seed-leite-italac"]["porcao_nome"] == "copo"


def test_product_portion_validation(client, guest):
    headers, _ = guest
    egg = client.post("/api/my/products", headers=headers,
                      json={**PRODUCT, "nome": "Ovo caipira", "porcao_g": 46, "porcao_nome": "  Unidade "}).json()
    assert egg["porcao_g"] == 46 and egg["porcao_nome"] == "unidade"
    no_name = client.post("/api/my/products", headers=headers, json={**PRODUCT, "nome": "Sem nome", "porcao_g": 30}).json()
    assert no_name["porcao_nome"] == "porção"
    no_grams = client.post("/api/my/products", headers=headers, json={**PRODUCT, "nome": "Só nome", "porcao_nome": "fatia"}).json()
    assert no_grams["porcao_nome"] is None
    assert client.post("/api/my/products", headers=headers, json={**PRODUCT, "porcao_g": 0}).status_code == 422


def test_diary_keeps_portion_count(client, guest):
    headers, _ = guest
    today = dt.date.today().isoformat()
    item = {**ITEM_PAO, "qty": 75, "porcoes": 3, "porcao_nome": "fatia"}
    entry = client.post("/api/diary", headers=headers, json={"day": today, "slot": "cafe", "items": [item]}).json()[0]
    assert entry["porcoes"] == 3 and entry["porcao_nome"] == "fatia" and entry["qty"] == 75
    grams = client.patch(f"/api/diary/{entry['id']}", headers=headers, json={"qty": 60, "porcoes": 0}).json()
    assert grams["porcoes"] is None and grams["qty"] == 60


def test_permanent_delete_requires_trash_first(client, guest, admin):
    headers, _ = guest
    admin_headers, _ = admin
    pid = client.post("/api/products", headers=admin_headers, json={**PRODUCT, "nome": "Duplicado com erro"}).json()["id"]
    assert client.delete(f"/api/products/{pid}", headers=headers).status_code == 403
    assert client.delete(f"/api/products/{pid}", headers=admin_headers).status_code == 409
    client.post(f"/api/products/{pid}/archive", headers=admin_headers)
    assert client.delete(f"/api/products/{pid}", headers=admin_headers).status_code == 200
    assert pid not in {p["id"] for p in client.get("/api/products?archived=true").json()}


def test_water_log(client, guest):
    headers, _ = guest
    today = dt.date.today().isoformat()
    assert client.put(f"/api/water/{today}", headers=headers, json={"ml": 750}).json()["ml"] == 750
    assert client.put(f"/api/water/{today}", headers=headers, json={"ml": 1000}).status_code == 200
    assert client.get("/api/water", headers=headers).json() == {today: 1000}
    assert client.put("/api/water/2001-01-01", headers=headers, json={"ml": 500}).status_code == 400
    assert client.put(f"/api/water/{today}", headers=headers, json={"ml": -1}).status_code == 422
    other = client.post("/api/auth/guest", json={"nome": "Outra"}).json()
    assert client.get("/api/water", headers={"Authorization": "Bearer " + other["token"]}).json() == {}


# ---------- e-mail: confirmação e nova senha ----------

APP = "http://localhost:5500/"


@pytest.fixture
def outbox(monkeypatch):
    """Liga o envio de e-mails e guarda as mensagens em vez de enviar."""
    import main
    sent = []
    monkeypatch.setattr(main, "MAIL_FILE", "memoria")
    monkeypatch.setattr(main, "send_mail", lambda to, subject, text, html: sent.append(
        {"to": to, "subject": subject, "text": text, "html": html}))
    monkeypatch.setattr(main, "mail_ip_throttle", main._Throttle(limit=1000, window_s=60))
    monkeypatch.setattr(main, "mail_address_throttle", main._Throttle(limit=3, window_s=3600))
    return sent


def _token(mail, kind):
    return re.search(rf"#/{kind}/([\w-]+)", mail["text"]).group(1)


def test_email_features_are_off_without_provider(client):
    assert client.get("/api/config").json()["email_enabled"] is False
    assert client.post("/api/auth/forgot", json={"email": "x@exemplo.com", "app_url": APP}).status_code == 501


def test_register_sends_verification_and_link_confirms(client, outbox):
    assert client.get("/api/config").json()["email_enabled"] is True
    res = client.post("/api/auth/register", json={"nome": "Clara", "email": "clara@exemplo.com",
                                                   "senha": "jabuticaba-77", "app_url": APP}).json()
    assert res["user"]["email_verified"] is False
    mail = outbox[-1]
    assert mail["to"] == "clara@exemplo.com" and "Confirme" in mail["subject"]
    assert f"{APP}#/confirmar/" in mail["text"] and "Clara" in mail["html"]
    token = _token(mail, "confirmar")
    assert client.post("/api/auth/verify-email", json={"token": token}).json()["email"] == "clara@exemplo.com"
    h = {"Authorization": "Bearer " + res["token"]}
    assert client.get("/api/me", headers=h).json()["email_verified"] is True
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 400     # uso único


def test_verified_admin_email_becomes_admin(client, outbox, monkeypatch):
    import main
    monkeypatch.setattr(main, "ADMIN_EMAILS", {"dona@exemplo.com"})
    res = client.post("/api/auth/register", json={"nome": "Dona", "email": "dona@exemplo.com",
                                                   "senha": "jabuticaba-77", "app_url": APP}).json()
    h = {"Authorization": "Bearer " + res["token"]}
    assert client.get("/api/me", headers=h).json()["is_admin"] is False       # ainda não confirmou
    client.post("/api/auth/verify-email", json={"token": _token(outbox[-1], "confirmar")})
    assert client.get("/api/me", headers=h).json()["is_admin"] is True


def test_forgot_password_flow(client, outbox):
    client.post("/api/auth/register", json={"nome": "Rui", "email": "rui@exemplo.com", "senha": "primeira-senha-1"})
    old = client.post("/api/auth/login", json={"email": "rui@exemplo.com", "senha": "primeira-senha-1"}).json()
    outbox.clear()

    # conta que não existe: mesma resposta, nenhum e-mail
    assert client.post("/api/auth/forgot", json={"email": "ninguem@exemplo.com", "app_url": APP}).json() == {"ok": True}
    assert outbox == []

    assert client.post("/api/auth/forgot", json={"email": " RUI@exemplo.com", "app_url": APP}).json() == {"ok": True}
    token = _token(outbox[-1], "redefinir")
    done = client.post("/api/auth/reset", json={"token": token, "senha": "segunda-senha-2"})
    assert done.status_code == 200 and done.json()["user"]["email_verified"] is True
    assert client.post("/api/auth/reset", json={"token": token, "senha": "terceira-senha-3"}).status_code == 400   # uso único
    assert client.post("/api/auth/login", json={"email": "rui@exemplo.com", "senha": "primeira-senha-1"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "rui@exemplo.com", "senha": "segunda-senha-2"}).status_code == 200
    # as sessões antigas caem
    assert client.get("/api/me", headers={"Authorization": "Bearer " + old["token"]}).status_code == 401


def test_weak_password_does_not_burn_the_reset_link(client, outbox):
    client.post("/api/auth/register", json={"nome": "Ana", "email": "ana.r@exemplo.com", "senha": "primeira-senha-1"})
    client.post("/api/auth/forgot", json={"email": "ana.r@exemplo.com", "app_url": APP})
    token = _token(outbox[-1], "redefinir")
    assert client.post("/api/auth/reset", json={"token": token, "senha": "password"}).status_code == 400
    assert client.post("/api/auth/reset", json={"token": token, "senha": "segunda-senha-2"}).status_code == 200


def test_forgot_is_limited_per_address(client, outbox):
    client.post("/api/auth/register", json={"nome": "Lia", "email": "lia@exemplo.com", "senha": "primeira-senha-1"})
    outbox.clear()
    for _ in range(5):
        assert client.post("/api/auth/forgot", json={"email": "lia@exemplo.com", "app_url": APP}).status_code == 200
    assert len(outbox) == 3


def test_email_links_only_point_to_the_app(client, outbox):
    res = client.post("/api/auth/forgot", json={"email": "rui@exemplo.com", "app_url": "https://site-falso.com/"})
    assert res.status_code == 400


def test_change_password_needs_current_and_drops_other_sessions(client):
    client.post("/api/auth/register", json={"nome": "Bia", "email": "bia@exemplo.com", "senha": "primeira-senha-1"})
    a = client.post("/api/auth/login", json={"email": "bia@exemplo.com", "senha": "primeira-senha-1"}).json()
    b = client.post("/api/auth/login", json={"email": "bia@exemplo.com", "senha": "primeira-senha-1"}).json()
    ha, hb = ({"Authorization": "Bearer " + x["token"]} for x in (a, b))
    assert client.post("/api/me/password", headers=ha, json={"atual": "errada-mesmo", "nova": "segunda-senha-2"}).status_code == 401
    assert client.post("/api/me/password", headers=ha, json={"atual": "primeira-senha-1", "nova": "password"}).status_code == 400
    assert client.post("/api/me/password", headers=ha, json={"atual": "primeira-senha-1", "nova": "segunda-senha-2"}).status_code == 200
    assert client.get("/api/me", headers=ha).status_code == 200      # este aparelho continua
    assert client.get("/api/me", headers=hb).status_code == 401      # o outro sai
    assert client.post("/api/auth/login", json={"email": "bia@exemplo.com", "senha": "segunda-senha-2"}).status_code == 200


def test_revoke_other_sessions(client, guest):
    headers, _ = guest
    code = client.post("/api/me/transfer-code", headers=headers).json()["code"]
    other = client.post("/api/auth/transfer", json={"code": code}).json()
    assert client.post("/api/me/sessions/revoke-others", headers=headers).json() == {"revoked": 1}
    assert client.get("/api/me", headers={"Authorization": "Bearer " + other["token"]}).status_code == 401
    assert client.get("/api/me", headers=headers).status_code == 200


def test_credentials_endpoint_cannot_replace_an_existing_password(client):
    res = client.post("/api/auth/register", json={"nome": "Edu", "email": "edu@exemplo.com", "senha": "primeira-senha-1"}).json()
    h = {"Authorization": "Bearer " + res["token"]}
    res = client.post("/api/me/credentials", headers=h, json={"email": "edu@exemplo.com", "senha": "outra-senha-9"})
    assert res.status_code == 409


def test_weak_passwords_are_rejected(client):
    for senha in ("12345678", "password", "aaaaaaaa", "fulana@exemplo.com"):
        res = client.post("/api/auth/register", json={"nome": "F", "email": "fulana@exemplo.com", "senha": senha})
        assert res.status_code == 400, senha
