// ------------------------------------------------------------------
// Endereço onde o backend (backend/main.py) está rodando.
// Abrindo o site em localhost, o app usa http://localhost:8000/api
// automaticamente; publicado, usa PROD_API.
// ------------------------------------------------------------------
const PROD_API = 'https://nutri-app-ne3q.onrender.com/api';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const API_BASE = isLocal ? `http://${location.hostname}:8000/api` : PROD_API;

export const APP_NAME = 'NutriApp';

// Endereço público do app, usado no rodapé da imagem de compartilhamento.
export const APP_URL = 'abentofilho.github.io/nutri_app';
