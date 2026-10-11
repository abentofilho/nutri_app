// Aviso de privacidade (LGPD), aberto da tela de entrada e do Perfil.

import { APP_NAME } from './config.js';
import { openSheet } from './ui.js';

export function openPrivacy() {
  openSheet({
    title: 'Privacidade',
    subtitle: APP_NAME,
    className: 'privacy-sheet',
    body: `
      <div class="prose">
        <h3>O que guardamos</h3>
        <p>Seu nome, e-mail (se criar conta), o que você registra no diário, a água,
        suas metas, seus produtos e receitas. Com login pelo Google ou GitHub,
        recebemos só o nome e o e-mail confirmado.</p>
        <h3>Para que</h3>
        <p>Só para o app funcionar e mostrar seus dados em qualquer aparelho. Não
        vendemos, não compartilhamos e não usamos para publicidade.</p>
        <h3>Por quanto tempo</h3>
        <p>O diário guarda os últimos 30 dias; o que for mais antigo é apagado
        automaticamente. O resto fica até você excluir.</p>
        <h3>Fotos e câmera</h3>
        <p>A leitura de código de barras e da tabela nutricional acontece no seu
        aparelho. As fotos não são enviadas nem guardadas. Para produtos que não
        estão no catálogo, o código de barras é consultado no Open Food Facts.</p>
        <h3>Seus direitos</h3>
        <p>Você pode baixar seus dados (Histórico › Planilha) e excluir a conta a
        qualquer momento (Perfil › Excluir conta), o que apaga tudo de forma
        definitiva. Sugestões já aprovadas continuam no catálogo, sem seu nome.</p>
        <h3>Segurança</h3>
        <p>Senhas são guardadas com criptografia de mão única e a conexão é sempre
        protegida (HTTPS).</p>
        <p class="faint">Este app dá estimativas a partir dos rótulos e não substitui
        a orientação de um nutricionista ou médico.</p>
      </div>`,
    footer: '<button class="btn primary" data-close>Entendi</button>',
  });
}
